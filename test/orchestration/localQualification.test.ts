/**
 * Qualification stage 2's rules (plan §19.6, §19.9): the three checks, the
 * porcelain parser, the summary, and the shipped fixtures themselves — each
 * fails on its seeded bugs and passes once they are fixed, deterministically.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFixtures } from '../../src/orchestration/local/taskQualifier';
import {
  changedPaths,
  diffInsideAllowed,
  judgeRun,
  parseFixture,
  parseTaskQualification,
  pathMatches,
  summariseTaskRuns,
  taskQualificationText,
  testsPass,
  testsUntouched,
  type TaskFixture,
  type TaskRun,
} from '../../src/shared/orchestration/localQualification';

import { FIXTURES_DIR, REFERENCE_FIXES } from './qualificationFixtures';

const FIXTURE: TaskFixture = { id: 'f', title: 'F', prompt: 'Fix it.', check: ['node', 'test/check.js'], protected: ['test/**'], allowed: ['src/**'] };

describe('pathMatches', () => {
  it('exact, dir/** and * within one segment', () => {
    expect(pathMatches('src/a.js', 'src/a.js')).toBe(true);
    expect(pathMatches('src/a.js', 'src/**')).toBe(true);
    expect(pathMatches('src/deep/a.js', 'src/**')).toBe(true);
    expect(pathMatches('srcx/a.js', 'src/**')).toBe(false);
    expect(pathMatches('src/a.js', 'src/*.js')).toBe(true);
    expect(pathMatches('src/deep/a.js', 'src/*.js')).toBe(false);
    expect(pathMatches('./test/check.js', 'test/**')).toBe(true);
    expect(pathMatches('README.md', 'src/**')).toBe(false);
  });
});

describe('changedPaths', () => {
  it('reads modified, added, deleted and untracked paths; a rename contributes both', () => {
    const z = [' M src/a.js', '?? src/new.js', ' D test/check.js', 'R  src/b.js', 'test/old.js', 'A  lib/x.js', ''].join('\0');
    expect(changedPaths(z)).toEqual(['lib/x.js', 'src/a.js', 'src/b.js', 'src/new.js', 'test/check.js', 'test/old.js']);
    expect(changedPaths('')).toEqual([]);
  });
});

describe('the three checks', () => {
  it('tests pass: exit 0 only; a timeout or a check that never started is not a pass', () => {
    expect(testsPass({ code: 0 })).toEqual({ ok: true });
    expect(testsPass({ code: 1 })).toEqual({ ok: false, detail: 'the check exited 1' });
    expect(testsPass({ code: -1, failure: 'timeout' })).toEqual({ ok: false, detail: 'the check timed out' });
    expect(testsPass({ code: -1, failure: 'spawn' })).toEqual({ ok: false, detail: 'the check could not be started' });
  });

  it('tests untouched: a modified, added or deleted test path fails', () => {
    expect(testsUntouched(['src/a.js'], ['test/**'])).toEqual({ ok: true });
    expect(testsUntouched(['src/a.js', 'test/check.js'], ['test/**'])).toEqual({ ok: false, detail: 'changed a test file: test/check.js' });
    expect(testsUntouched([], ['test/**']).ok).toBe(true);
  });

  it('diff inside the allowed paths: anything else changed fails', () => {
    expect(diffInsideAllowed(['src/a.js', 'src/b/c.js'], ['src/**'])).toEqual({ ok: true });
    expect(diffInsideAllowed(['src/a.js', 'package.json'], ['src/**'])).toEqual({ ok: false, detail: 'changed outside the allowed paths: package.json' });
  });

  it('judgeRun: a pass needs all three; the failure is the first that failed', () => {
    expect(judgeRun(FIXTURE, { check: { code: 0 }, changed: ['src/a.js'] })).toEqual({ pass: true, testsPass: true, testsUntouched: true, diffInside: true });
    // Editing the test to make it pass is not a pass.
    expect(judgeRun(FIXTURE, { check: { code: 0 }, changed: ['test/check.js'] })).toMatchObject({
      pass: false,
      testsPass: true,
      testsUntouched: false,
      diffInside: false,
      failure: 'changed a test file: test/check.js',
    });
    expect(judgeRun(FIXTURE, { check: { code: 1 }, changed: [] })).toMatchObject({ pass: false, failure: 'the check exited 1' });
  });
});

describe('fixtures', () => {
  it('parseFixture refuses a manifest without a check, protected or allowed paths, or with a path out of the repo', () => {
    const ok = { title: 't', prompt: 'p', check: ['node', 'x.js'], protected: ['test/**'], allowed: ['src/**'] };
    expect(parseFixture(ok, 'a').ok).toBe(true);
    expect(parseFixture({ ...ok, check: [] }, 'a').ok).toBe(false);
    expect(parseFixture({ ...ok, protected: undefined }, 'a').ok).toBe(false);
    expect(parseFixture({ ...ok, allowed: ['../elsewhere'] }, 'a').ok).toBe(false);
    expect(parseFixture({ ...ok, allowed: ['/abs'] }, 'a').ok).toBe(false);
    expect(parseFixture(ok, 'Bad Id').ok).toBe(false);
  });

  it('ships 3–5 fixtures, each with a check, protected tests and allowed paths', async () => {
    const { fixtures, errors } = await loadFixtures(FIXTURES_DIR);
    expect(errors).toEqual([]);
    expect(fixtures.length).toBeGreaterThanOrEqual(3);
    expect(fixtures.length).toBeLessThanOrEqual(5);
    expect(fixtures.map((f) => f.id).sort()).toEqual(Object.keys(REFERENCE_FIXES).sort());
    for (const f of fixtures) {
      expect(f.check[0]).toBe('node');
      expect(f.protected).toEqual(['test/**']);
      expect(f.allowed).toEqual(['src/**']);
    }
  });

  it('each fails on its seeded bugs and passes with them fixed, the same way every time', async () => {
    const { fixtures } = await loadFixtures(FIXTURES_DIR);
    for (const f of fixtures) {
      const dir = mkdtempSync(path.join(tmpdir(), 'aw-fixture-test-'));
      try {
        cpSync(path.join(FIXTURES_DIR, f.id, 'repo'), dir, { recursive: true });
        const run = () => spawnSync(process.execPath, f.check.slice(1), { cwd: dir, encoding: 'utf8' });
        const seeded = [run(), run()];
        for (const r of seeded) expect(r.status, `${f.id} seeded`).toBe(1);
        expect(seeded[0].stdout).toBe(seeded[1].stdout);
        // More than one seeded bug in each.
        expect((seeded[0].stdout.match(/failed:/g) ?? []).length, `${f.id} failing cases`).toBeGreaterThanOrEqual(3);
        const fix = REFERENCE_FIXES[f.id];
        writeFileSync(path.join(dir, fix.file), fix.text);
        const fixed = run();
        expect(fixed.status, `${f.id} fixed: ${fixed.stdout}`).toBe(0);
        expect(fixed.stdout.trim()).toBe('ok');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('contain no absolute paths', () => {
    // grep exits 1 when nothing matches.
    const r = spawnSync('grep', ['-rlE', '/Users/|/home/|/private/', FIXTURES_DIR], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout.trim()).toBe('');
  });
});

describe('results', () => {
  const run = (o: Partial<TaskRun>): TaskRun => ({
    fixture: 'a',
    n: 1,
    pass: true,
    testsPass: true,
    testsUntouched: true,
    diffInside: true,
    turns: 1,
    toolCalls: 4,
    wallMs: 20_000,
    inputTokens: 1000,
    outputTokens: 200,
    ...o,
  });

  it('summarise: pass count, mean turns and wall time, summed tokens; text says measured', () => {
    const q = summariseTaskRuns('m', 5, 3, [run({}), run({ n: 2, pass: false, failure: 'the check exited 1', turns: 2 }), run({ n: 3, fixture: 'a' })]);
    expect(q).toMatchObject({ runnable: true, passed: 2, k: 3, avgTurns: 1.3, avgWallMs: 20_000, inputTokens: 3000, outputTokens: 600 });
    expect(taskQualificationText(q)).toBe('Tasks 2/3 passed (k=3, measured) · a 2/3 · 1.3 turns · 20 s · 3600 tokens · first failure: a #2, the check exited 1');
  });

  it('not runnable: no pass rate', () => {
    const q = { model: 'm', at: 1, runnable: false as const, reason: 'no /v1/responses' };
    expect(taskQualificationText(q)).toBe('Tasks: not runnable: no /v1/responses');
    expect('passed' in q).toBe(false);
  });

  it('a stored result is read back only when well formed', () => {
    const good = summariseTaskRuns('m', 5, 3, [run({})]);
    expect(parseTaskQualification(JSON.parse(JSON.stringify(good)))).toEqual(good);
    expect(parseTaskQualification({ model: 'm', at: 1, runnable: false, reason: 'no /v1/responses' })).toMatchObject({ runnable: false });
    expect(parseTaskQualification({ model: 'm', at: 1, runnable: true })).toBeUndefined();
    expect(parseTaskQualification('x')).toBeUndefined();
  });

  it('the fixture files are what the runner copies', () => {
    expect(readFileSync(path.join(FIXTURES_DIR, 'text-utils', 'repo', 'test', 'check.js'), 'utf8')).toMatch(/console\.log\('ok'\)/);
  });
});
