/**
 * The verifier against real git and real child processes (#35).
 *
 * Every case here is one of §14.3's rows: a clean pass, a failure, a failure
 * the base commit already had, a flake, a timeout, a command the policy does
 * not define, and a repository with no checks at all. The "commands" are
 * throwaway shell scripts in the repository, so a test can make one fail once
 * and then pass, which is the only way to exercise the flaky path honestly.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_REPO_POLICY, type RepoPolicy } from '../../src/shared/orchestration/repoPolicy';
import type { Task, WorktreeAssignment } from '../../src/shared/orchestration/types';
import { nodeExec } from '../../src/orchestration/worktrees/exec';
import { WorktreeManager, canonicalPath } from '../../src/orchestration/worktrees/worktreeManager';
import { Verifier } from '../../src/orchestration/verify/verifier';
import { buildVerificationPlan, summariseVerification } from '../../src/shared/orchestration/verification';
import { task } from './fixtures';

const savedEnv: Record<string, string | undefined> = {};
let gitConfig: string;

beforeAll(() => {
  gitConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-gitcfg-')), 'config');
  fs.writeFileSync(gitConfig, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
  for (const [k, v] of Object.entries({ GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' })) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(path.dirname(gitConfig), { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let tmp: string;
let repo: string;
let base: string;
let logs: string;
let manager: WorktreeManager;
let wt: WorktreeAssignment;

/** A script in the repository that a policy command can run. `sh` keeps it portable enough for CI. */
function script(name: string, body: string): string[] {
  const file = path.join(repo, `${name}.sh`);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return ['/bin/sh', file];
}

function policyWith(commands: Record<string, { run: string[]; timeoutSec?: number }>): RepoPolicy {
  return {
    ...DEFAULT_REPO_POLICY,
    verification: {
      commands: Object.fromEntries(Object.entries(commands).map(([k, v]) => [k, { run: v.run, timeoutSec: v.timeoutSec ?? 600 }])),
      missionDefault: [],
    },
  };
}

function verifier(policy: RepoPolicy) {
  return new Verifier({
    exec: nodeExec,
    logsDir: logs,
    withBaseCheckout: (commit, fn) => manager.withBaseCheckout(commit, fn),
    diffText: () => manager.diffText(wt),
    changedFiles: () => manager.changedFiles(wt),
  });
}

const t = (overrides: Partial<Task> = {}): Task => task('t1', { kindHint: 'feature', ...overrides });

const ctx = (policy: RepoPolicy, overrides: Partial<Task> = {}) => ({
  attemptId: 'a1',
  task: t(overrides),
  policy,
  worktree: wt,
});

beforeEach(async () => {
  tmp = canonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-verify-')));
  repo = path.join(tmp, 'proj');
  logs = path.join(tmp, 'logs');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  base = git(repo, 'rev-parse', 'HEAD');
  // A dependency directory the setup step links, so a base checkout gets the
  // same one the attempt's tree had.
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'marker'), 'present\n');

  manager = await WorktreeManager.open(
    { repoRoot: repo, root: path.join(tmp, 'proj.aw'), setup: [{ link: 'node_modules' }] },
    { record: async () => undefined },
  );
  wt = await manager.create(manager.plan({ id: 'w1', missionSlug: 'm', purpose: 'task', taskKey: 't1', taskId: 't1', baseCommit: base }));
  wt = await manager.markInUse(wt);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Make the attempt look like it did some work, and commit it on its branch. */
async function attemptChanged(files: Record<string, string> = { 'src/a.ts': 'export const a = 1;\n' }): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(wt.path, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  await manager.commitAll(wt, 'aw: t1: attempt 1');
}

describe('command stages', () => {
  it('passes a command that exits 0, and writes its log', async () => {
    const policy = policyWith({ test: { run: script('ok', 'echo all good; exit 0') } });
    await attemptChanged();
    const results = await verifier(policy).run({ stages: [{ strategy: 'command:test', required: true }] }, ctx(policy));

    expect(results[0]).toMatchObject({ strategy: 'command:test', outcome: 'passed', evidence: { exitCode: 0 } });
    const log = results[0].evidence?.logPath as string;
    expect(fs.readFileSync(log, 'utf8')).toContain('all good');
  });

  it('fails a command that exits non-zero, naming the failing tests and keeping the log', async () => {
    // Fails only once the attempt's file exists, so the base commit is green
    // and the failure is genuinely this attempt's.
    const policy = policyWith({
      test: { run: script('bad', 'if [ ! -f src/a.ts ]; then exit 0; fi\necho " FAIL  test/a.test.ts > thing > works"\nexit 1') },
    });
    await attemptChanged();
    const results = await verifier(policy).run({ stages: [{ strategy: 'command:test', required: true }] }, ctx(policy));

    expect(results[0]).toMatchObject({
      outcome: 'failed',
      evidence: { exitCode: 1, failing: ['test/a.test.ts > thing > works'] },
    });
    expect(results[0].summary).toContain('test/a.test.ts');
    expect(results[0].evidence?.signature).toBeDefined();
    expect(fs.existsSync(results[0].evidence!.logPath!)).toBe(true);
  });

  it('marks a test flaky when it fails once and passes on a re-run of the same tree', async () => {
    // Fails the first time it is run and passes afterwards, via a stamp file
    // outside the tree so committing does not disturb it.
    const stamp = path.join(tmp, 'ran-once');
    const policy = policyWith({
      test: { run: script('flake', `if [ -f "${stamp}" ]; then exit 0; fi\ntouch "${stamp}"\necho " FAIL  test/a.test.ts"\nexit 1`) },
    });
    await attemptChanged();
    const results = await verifier(policy).run({ stages: [{ strategy: 'command:test', required: true }] }, ctx(policy));

    expect(results[0]).toMatchObject({ outcome: 'passed', flaky: true });
    expect(results[0].summary).toContain('re-run');
  });

  it('does not blame the attempt for a failure the base commit has too', async () => {
    // Fails everywhere, base included.
    const policy = policyWith({ test: { run: script('always-bad', 'echo broken; exit 1') } });
    await attemptChanged();
    const results = await verifier(policy).run({ stages: [{ strategy: 'command:test', required: true }] }, ctx(policy));

    expect(results[0]).toMatchObject({ outcome: 'inconclusive', preExisting: true });
    expect(results[0].summary).toContain('base commit');
  });

  it('blames the attempt when the base commit is green', async () => {
    // Fails only when the attempt's file is there, so the base passes.
    const policy = policyWith({ test: { run: script('newly-bad', 'if [ -f src/a.ts ]; then echo broke it; exit 1; fi\nexit 0') } });
    await attemptChanged();
    const results = await verifier(policy).run({ stages: [{ strategy: 'command:test', required: true }] }, ctx(policy));

    expect(results[0]).toMatchObject({ outcome: 'failed' });
    expect(results[0].preExisting).toBeUndefined();
  });

  it('gives the base checkout the same setup, so a missing dependency is not mistaken for a red base', async () => {
    // Fails unless `node_modules` is linked in — which only the setup step does.
    const policy = policyWith({ test: { run: script('needs-deps', 'if [ -f node_modules/marker ]; then exit 0; fi\necho no deps; exit 1') } });
    await attemptChanged({ 'src/a.ts': 'export const a = 1;\n' });
    const results = await verifier(policy).run({ stages: [{ strategy: 'command:test', required: true }] }, ctx(policy));

    // The attempt's own tree has the link, so it passes and the base is never consulted.
    expect(results[0].outcome).toBe('passed');

    // And a base checkout on its own gets the link too.
    const sawMarker = await manager.withBaseCheckout(base, async (tree) => fs.existsSync(path.join(tree, 'node_modules', 'marker')));
    expect(sawMarker).toBe(true);
  });

  it('calls a timeout an error rather than a failure', async () => {
    const policy = policyWith({ test: { run: script('slow', 'sleep 30'), timeoutSec: 1 } });
    await attemptChanged();
    const results = await verifier(policy).run({ stages: [{ strategy: 'command:test', required: true, timeoutSec: 1 }] }, ctx(policy));

    expect(results[0]).toMatchObject({ outcome: 'error' });
    expect(results[0].summary).toContain('timed out');
  });

  it('calls a program that does not exist an error, not a failing test suite', async () => {
    const policy = policyWith({ test: { run: ['/nonexistent/please-no', '--version'] } });
    await attemptChanged();
    const results = await verifier(policy).run({ stages: [{ strategy: 'command:test', required: true }] }, ctx(policy));

    expect(results[0].outcome).toBe('error');
  });

  it('is unavailable — never a pass — for a command the policy does not define', async () => {
    const policy = policyWith({});
    await attemptChanged();
    const results = await verifier(policy).run({ stages: [{ strategy: 'command:deploy', required: true }] }, ctx(policy));

    expect(results[0]).toMatchObject({ outcome: 'unavailable' });
    expect(summariseVerification({ stages: [{ strategy: 'command:deploy', required: true }] }, results).verdict).toBe('unverified');
  });

  it('checks a base commit once however many stages ask about it', async () => {
    const counter = path.join(tmp, 'base-runs');
    const policy = policyWith({
      test: { run: script('count', `if [ -f src/a.ts ]; then echo broke; exit 1; fi\necho x >> "${counter}"\nexit 1`) },
    });
    await attemptChanged();
    const v = verifier(policy);
    const plan = { stages: [{ strategy: 'command:test', required: true }] };
    await v.run(plan, ctx(policy));
    await v.run(plan, { ...ctx(policy), attemptId: 'a2' });

    // Two attempts, one base check: the second reads the cache.
    expect(fs.readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('the plan as a whole', () => {
  it('stops after a required stage fails, and does not pay for the rest', async () => {
    const ran = path.join(tmp, 'second-ran');
    const policy = policyWith({
      first: { run: script('first', 'exit 1') },
      second: { run: script('second', `touch "${ran}"`) },
    });
    await attemptChanged();
    const results = await verifier(policy).run(
      { stages: [{ strategy: 'command:first', required: true }, { strategy: 'command:second', required: true }] },
      ctx(policy),
    );

    expect(results).toHaveLength(1);
    expect(fs.existsSync(ran)).toBe(false);
  });

  it('carries on past an advisory failure', async () => {
    const policy = policyWith({
      lint: { run: script('lint', 'if [ -f src/a.ts ]; then exit 1; fi\nexit 0') },
      test: { run: script('t', 'exit 0') },
    });
    await attemptChanged();
    const results = await verifier(policy).run(
      { stages: [{ strategy: 'command:lint', required: false }, { strategy: 'command:test', required: true }] },
      ctx(policy),
    );

    expect(results.map((r) => r.outcome)).toEqual(['failed', 'passed']);
  });

  it('a repository with no checks verifies nothing, and says so', async () => {
    const policy = policyWith({});
    const plan = buildVerificationPlan({ kind: 'feature', policy });
    await attemptChanged();
    const results = await verifier(policy).run(plan, ctx(policy));

    const summary = summariseVerification(plan, results);
    expect(summary.verdict).toBe('unverified');
  });
});

describe('diff-sanity against a real diff', () => {
  it('passes a diff that changed something and looks ordinary', async () => {
    const policy = policyWith({});
    await attemptChanged();
    const results = await verifier(policy).run({ stages: [{ strategy: 'diff-sanity', required: true }] }, ctx(policy));

    expect(results[0].outcome).toBe('passed');
  });

  it('fails an empty diff for a kind that was supposed to change something', async () => {
    const policy = policyWith({});
    const results = await verifier(policy).run({ stages: [{ strategy: 'diff-sanity', required: true }] }, ctx(policy));

    expect(results[0]).toMatchObject({ outcome: 'failed', evidence: { signature: 'diff-sanity:no-diff' } });
  });

  it('fails a diff that committed conflict markers', async () => {
    const policy = policyWith({});
    await attemptChanged({ 'src/a.ts': '<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> other\n' });
    const results = await verifier(policy).run({ stages: [{ strategy: 'diff-sanity', required: true }] }, ctx(policy));

    expect(results[0]).toMatchObject({ outcome: 'failed', evidence: { signature: 'diff-sanity:conflict-markers' } });
  });

  it('warns without failing when a change lands outside the predicted scope', async () => {
    const policy = policyWith({});
    await attemptChanged({ 'other/x.ts': 'export const x = 1;\n' });
    const results = await verifier(policy).run(
      { stages: [{ strategy: 'diff-sanity', required: true }] },
      ctx(policy, { scope: { paths: ['src/**'], subsystems: [], confidence: 'medium' } }),
    );

    expect(results[0].outcome).toBe('passed');
    expect(results[0].summary).toContain('outside the task');
  });
});

describe('withBaseCheckout', () => {
  it('leaves nothing behind, and never registers a branch of its own', async () => {
    const before = await manager.list();
    const seen = await manager.withBaseCheckout(base, async (tree) => fs.existsSync(path.join(tree, 'README.md')));
    expect(seen).toBe(true);

    const after = await manager.list();
    expect(after.map((w) => w.path).sort()).toEqual(before.map((w) => w.path).sort());
    expect(git(repo, 'branch', '--list').includes('base')).toBe(false);
  });

  it('clears the tree even when the work throws', async () => {
    await expect(manager.withBaseCheckout(base, async () => {
      throw new Error('nope');
    })).rejects.toThrow('nope');

    const trees = await manager.list();
    expect(trees.some((w) => path.basename(w.path).startsWith('.base-'))).toBe(false);
  });
});
