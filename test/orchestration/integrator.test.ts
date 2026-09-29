/**
 * The Integrator and the gated local merge (#46, §13.3, §23.2–23.3), against
 * real git in temporary repositories: a clean merge verified after each merge,
 * a conflict, a semantic break reverted, write-ahead, recovery from a crash at
 * each point of a merge, and `MissionFinisher.mergeLocalGated`.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Integrator, type MissionVerifier, type PendingMergeRecord } from '../../src/orchestration/integration/integrator';
import { MissionFinisher } from '../../src/orchestration/engine/missionFinish';
import { nodeExec } from '../../src/orchestration/worktrees/exec';

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
let tree: string;
let base: string;
const MISSION = 'aw/m/mission';

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-integrator-')));
  repo = path.join(tmp, 'proj');
  tree = path.join(tmp, 'proj.aw', 'm', '_integration');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'worktree', 'add', '-q', '-b', MISSION, tree, base);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A task branch cut from `from`, with one commit writing `files`. */
function taskBranch(name: string, files: Record<string, string>, from = base): string {
  const branch = `aw/m/${name}`;
  const dir = path.join(tmp, 'proj.aw', 'm', name);
  git(repo, 'worktree', 'add', '-q', '-b', branch, dir, from);
  for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), content);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', `${name} work`);
  return branch;
}

interface Calls {
  heads: string[];
  /** Files present in the tree at each check. */
  seen: string[][];
}

/** A verifier that fails whenever `broken` is in the tree, as a semantic break would. */
function verifier(calls: Calls): MissionVerifier {
  return {
    verifyMission: async ({ worktreePath, headCommit }) => {
      calls.heads.push(headCommit);
      calls.seen.push(fs.readdirSync(worktreePath).filter((f) => !f.startsWith('.')).sort());
      if (fs.existsSync(path.join(worktreePath, 'broken'))) return { passed: false, failure: { stage: 'command:check', summary: 'check failed: test/a.test.ts', failingTests: ['test/a.test.ts'] } };
      return { passed: true };
    },
  };
}

function integrator(calls: Calls, written: PendingMergeRecord[] = []) {
  return new Integrator({
    exec: nodeExec,
    verifier: verifier(calls),
    missionBranch: MISSION,
    worktreePath: tree,
    baseCommit: base,
    beforeMerge: (r) => {
      // Write-ahead: the mission branch has not moved yet when the record is written.
      expect(git(tree, 'rev-parse', 'HEAD')).toBe(r.preMergeHead);
      written.push(r);
    },
  });
}

function status(): string {
  return git(tree, 'status', '--porcelain=v1', '--untracked-files=no');
}

function hasMergeHead(): boolean {
  try {
    git(tree, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD');
    return true;
  } catch {
    return false;
  }
}

describe('Integrator', () => {
  it('merges two branches one at a time with --no-ff, verifying the mission branch after each merge', async () => {
    const calls: Calls = { heads: [], seen: [] };
    const written: PendingMergeRecord[] = [];
    const t1 = taskBranch('t1', { 'a.txt': 'a\n' });
    const t2 = taskBranch('t2', { 'b.txt': 'b\n' });
    const i = integrator(calls, written);
    const r1 = await i.integrate({ taskBranch: t1, message: 'Merge t1' });
    const r2 = await i.integrate({ taskBranch: t2, message: 'Merge t2' });
    expect(r1).toMatchObject({ ok: true, outcome: 'merged', preMergeHead: base });
    expect(r2).toMatchObject({ ok: true, outcome: 'merged' });
    if (!r1.ok || !r2.ok) throw new Error('unreachable');
    expect(r2.preMergeHead).toBe(r1.mergeCommit);
    // Verified after each merge, on the merged tree.
    expect(calls.heads).toEqual([r1.mergeCommit, r2.mergeCommit]);
    expect(calls.seen[0]).toContain('a.txt');
    expect(calls.seen[0]).not.toContain('b.txt');
    expect(calls.seen[1]).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
    // --no-ff: each is a merge commit whose first parent is the pre-merge head.
    expect(git(tree, 'rev-list', '--parents', '-n', '1', r2.mergeCommit).split(' ')).toEqual([r2.mergeCommit, r1.mergeCommit, git(repo, 'rev-parse', t2)]);
    expect(written.map((w) => w.preMergeHead)).toEqual([base, r1.mergeCommit]);
    // The base never moved.
    expect(git(repo, 'rev-parse', 'main')).toBe(base);
  });

  it('a conflict is aborted and returns the conflicting files; the mission branch is untouched', async () => {
    const calls: Calls = { heads: [], seen: [] };
    const t1 = taskBranch('t1', { 'shared.txt': 'from t1\n' });
    const t2 = taskBranch('t2', { 'shared.txt': 'from t2\n', 'c.txt': 'c\n' });
    const i = integrator(calls);
    const r1 = await i.integrate({ taskBranch: t1, message: 'Merge t1' });
    const head = git(tree, 'rev-parse', 'HEAD');
    const r2 = await i.integrate({ taskBranch: t2, message: 'Merge t2' });
    expect(r1.outcome).toBe('merged');
    expect(r2).toEqual({ ok: false, outcome: 'conflict', preMergeHead: head, conflictingFiles: ['shared.txt'] });
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(head);
    expect(hasMergeHead()).toBe(false);
    expect(status()).toBe('');
    expect(calls.heads).toHaveLength(1);
  });

  it('a semantic break caught by mission verification is reverted with a revert commit, keeping the earlier merge', async () => {
    const calls: Calls = { heads: [], seen: [] };
    const t1 = taskBranch('t1', { 'a.txt': 'a\n' });
    const t2 = taskBranch('t2', { broken: 'x\n' });
    const i = integrator(calls);
    const r1 = await i.integrate({ taskBranch: t1, message: 'Merge t1' });
    const r2 = await i.integrate({ taskBranch: t2, message: 'Merge t2' });
    expect(r2).toMatchObject({ ok: false, outcome: 'reverted', evidence: { stage: 'command:check', failingTests: ['test/a.test.ts'] } });
    if (r2.outcome !== 'reverted' || !r1.ok) throw new Error('unreachable');
    // History is kept: base → t1 merge → t2 merge → revert.
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(r2.revertCommit);
    expect(git(tree, 'rev-parse', `${r2.revertCommit}^`)).toBe(r2.mergeCommit);
    expect(git(tree, 'rev-parse', `${r2.mergeCommit}^1`)).toBe(r1.mergeCommit);
    expect(fs.existsSync(path.join(tree, 'broken'))).toBe(false);
    expect(fs.existsSync(path.join(tree, 'a.txt'))).toBe(true);
    expect(status()).toBe('');
  });

  it('merges nothing when the write-ahead record cannot be written', async () => {
    const t1 = taskBranch('t1', { 'a.txt': 'a\n' });
    const i = new Integrator({
      exec: nodeExec,
      verifier: verifier({ heads: [], seen: [] }),
      missionBranch: MISSION,
      worktreePath: tree,
      baseCommit: base,
      beforeMerge: () => {
        throw new Error('disk full');
      },
    });
    const r = await i.integrate({ taskBranch: t1, message: 'Merge t1' });
    expect(r).toMatchObject({ ok: false, outcome: 'error' });
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(base);
  });

  it('refuses a branch Agent Wrangler did not make, and a merge already in progress', async () => {
    const i = integrator({ heads: [], seen: [] });
    expect(await i.integrate({ taskBranch: 'main', message: 'x' })).toMatchObject({ outcome: 'error' });
    const t1 = taskBranch('t1', { 'a.txt': 'a\n' });
    git(tree, 'merge', '--no-ff', '--no-commit', t1);
    expect(await i.integrate({ taskBranch: t1, message: 'x' })).toMatchObject({ outcome: 'error', error: expect.stringContaining('recover') });
  });

  describe('recovery (a quit or crash mid-merge)', () => {
    it('a merge left in progress is aborted and made again, then verified', async () => {
      const calls: Calls = { heads: [], seen: [] };
      const t1 = taskBranch('t1', { 'a.txt': 'a\n' });
      // The core died between `git merge` starting and the merge commit.
      git(tree, 'merge', '--no-ff', '--no-commit', t1);
      expect(hasMergeHead()).toBe(true);
      const r = await integrator(calls).recover({ taskBranch: t1, message: 'Merge t1', preMergeHead: base });
      expect(r).toMatchObject({ ok: true, outcome: 'merged', preMergeHead: base });
      if (!r.ok) throw new Error('unreachable');
      expect(git(tree, 'rev-parse', `${r.mergeCommit}^1`)).toBe(base);
      expect(git(tree, 'log', '-1', '--format=%s')).toBe('Merge t1');
      expect(calls.heads).toEqual([r.mergeCommit]);
      expect(hasMergeHead()).toBe(false);
      expect(status()).toBe('');
    });

    it('a conflicted merge left in progress is aborted and reported as a conflict again', async () => {
      const t1 = taskBranch('t1', { 'shared.txt': 'from t1\n' });
      const t2 = taskBranch('t2', { 'shared.txt': 'from t2\n' });
      const i = integrator({ heads: [], seen: [] });
      await i.integrate({ taskBranch: t1, message: 'Merge t1' });
      const head = git(tree, 'rev-parse', 'HEAD');
      try {
        git(tree, 'merge', '--no-ff', '--no-commit', t2);
      } catch {
        // conflicted, as expected
      }
      expect(hasMergeHead()).toBe(true);
      const r = await i.recover({ taskBranch: t2, message: 'Merge t2', preMergeHead: head });
      expect(r).toMatchObject({ outcome: 'conflict', conflictingFiles: ['shared.txt'] });
      expect(git(tree, 'rev-parse', 'HEAD')).toBe(head);
      expect(status()).toBe('');
    });

    it('a merge committed but never verified is verified now, and reverted if it fails', async () => {
      const calls: Calls = { heads: [], seen: [] };
      const t1 = taskBranch('t1', { broken: 'x\n' });
      git(tree, 'merge', '--no-ff', '-m', 'Merge t1', t1);
      const merged = git(tree, 'rev-parse', 'HEAD');
      const r = await integrator(calls).recover({ taskBranch: t1, message: 'Merge t1', preMergeHead: base });
      expect(calls.heads).toEqual([merged]);
      expect(r).toMatchObject({ outcome: 'reverted', mergeCommit: merged });
      expect(fs.existsSync(path.join(tree, 'broken'))).toBe(false);
    });

    it('a revert already made is reported as reverted, without verifying again', async () => {
      const calls: Calls = { heads: [], seen: [] };
      const t1 = taskBranch('t1', { broken: 'x\n' });
      git(tree, 'merge', '--no-ff', '-m', 'Merge t1', t1);
      const merged = git(tree, 'rev-parse', 'HEAD');
      git(tree, 'revert', '-m', '1', '--no-edit', merged);
      const r = await integrator(calls).recover({ taskBranch: t1, message: 'Merge t1', preMergeHead: base });
      expect(r).toMatchObject({ outcome: 'reverted', mergeCommit: merged, revertCommit: git(tree, 'rev-parse', 'HEAD') });
      expect(calls.heads).toEqual([]);
    });

    it('a record the branch cannot explain is an error, and nothing is changed', async () => {
      const t1 = taskBranch('t1', { 'a.txt': 'a\n' });
      fs.writeFileSync(path.join(tree, 'other.txt'), 'x\n');
      git(tree, 'add', '.');
      git(tree, 'commit', '-q', '-m', 'unrelated');
      const head = git(tree, 'rev-parse', 'HEAD');
      const r = await integrator({ heads: [], seen: [] }).recover({ taskBranch: t1, message: 'Merge t1', preMergeHead: base });
      expect(r.outcome).toBe('error');
      expect(git(tree, 'rev-parse', 'HEAD')).toBe(head);
    });
  });
});

describe('MissionFinisher.mergeLocalGated', () => {
  async function missionWith(files: Record<string, string>): Promise<string> {
    const t1 = taskBranch('t1', files);
    const r = await integrator({ heads: [], seen: [] }).integrate({ taskBranch: t1, message: 'Merge t1' });
    if (!r.ok) throw new Error(`setup: ${r.outcome}`);
    return r.mergeCommit;
  }

  const finisher = () => new MissionFinisher({ exec: nodeExec, repoRoot: repo });

  it('builds the merge in the integration worktree, gates it, and fast-forwards the base to exactly that commit', async () => {
    const missionHead = await missionWith({ 'a.txt': 'a\n' });
    // The base moved on since the mission started: the gate must see both.
    fs.writeFileSync(path.join(repo, 'later.txt'), 'later\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'later on main');
    const tip = git(repo, 'rev-parse', 'main');
    const gated: { tree: string; commit: string; files: string[] }[] = [];
    const r = await finisher().mergeLocalGated({
      branch: MISSION,
      baseRef: 'main',
      message: 'Merge the mission',
      integrationPath: tree,
      gate: async (t, commit) => {
        gated.push({ tree: t, commit, files: fs.readdirSync(t).filter((f) => !f.startsWith('.')).sort() });
        // The base has not moved while the gate runs.
        expect(git(repo, 'rev-parse', 'main')).toBe(tip);
        return { passed: true, summary: 'check passed' };
      },
    });
    expect(r).toMatchObject({ ok: true, into: 'main', gate: 'check passed' });
    if (!r.ok) throw new Error('unreachable');
    expect(gated).toHaveLength(1);
    expect(gated[0].commit).toBe(r.mergeCommit);
    expect(gated[0].files).toEqual(expect.arrayContaining(['a.txt', 'later.txt']));
    // Main is at the gated commit, a --no-ff merge of the mission branch onto the old tip.
    expect(git(repo, 'rev-parse', 'main')).toBe(r.mergeCommit);
    expect(git(repo, 'rev-list', '--parents', '-n', '1', r.mergeCommit).split(' ')).toEqual([r.mergeCommit, tip, missionHead]);
    expect(fs.existsSync(path.join(repo, 'a.txt'))).toBe(true);
    // The integration worktree is back on the mission branch, which did not move.
    expect(git(tree, 'symbolic-ref', '--short', 'HEAD')).toBe(MISSION);
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(missionHead);
  });

  it('a failing gate leaves the base where it was, and says why', async () => {
    const missionHead = await missionWith({ 'a.txt': 'a\n' });
    const r = await finisher().mergeLocalGated({
      branch: MISSION,
      baseRef: 'main',
      message: 'Merge the mission',
      integrationPath: tree,
      gate: async () => ({ passed: false, summary: 'typecheck failed' }),
    });
    expect(r).toEqual({ ok: false, why: expect.stringContaining('typecheck failed') });
    expect(git(repo, 'rev-parse', 'main')).toBe(base);
    expect(git(tree, 'symbolic-ref', '--short', 'HEAD')).toBe(MISSION);
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(missionHead);
    expect(status()).toBe('');
  });

  it('refuses a dirty primary checkout or one on another branch without running the gate', async () => {
    await missionWith({ 'a.txt': 'a\n' });
    let ran = 0;
    const gate = async () => {
      ran++;
      return { passed: true, summary: 'ok' };
    };
    fs.writeFileSync(path.join(repo, 'README.md'), 'edited\n');
    const dirty = await finisher().mergeLocalGated({ branch: MISSION, baseRef: 'main', message: 'm', integrationPath: tree, gate });
    expect(dirty).toEqual({ ok: false, why: expect.stringContaining('uncommitted changes') });
    git(repo, 'checkout', '-q', '--', 'README.md');
    git(repo, 'checkout', '-q', '-b', 'elsewhere');
    const other = await finisher().mergeLocalGated({ branch: MISSION, baseRef: 'main', message: 'm', integrationPath: tree, gate });
    expect(other).toEqual({ ok: false, why: expect.stringContaining('not main') });
    expect(ran).toBe(0);
    expect(git(repo, 'rev-parse', 'main')).toBe(base);
  });

  it('a mission branch that conflicts with the base is refused, and the base is left alone', async () => {
    await missionWith({ 'shared.txt': 'mission\n' });
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'main\n');
    git(repo, 'commit', '-q', '-am', 'main edits shared');
    const tip = git(repo, 'rev-parse', 'main');
    const r = await finisher().mergeLocalGated({ branch: MISSION, baseRef: 'main', message: 'm', integrationPath: tree, gate: async () => ({ passed: true, summary: 'ok' }) });
    expect(r).toEqual({ ok: false, why: expect.stringContaining('does not merge cleanly') });
    expect(git(repo, 'rev-parse', 'main')).toBe(tip);
    expect(git(tree, 'symbolic-ref', '--short', 'HEAD')).toBe(MISSION);
    expect(status()).toBe('');
  });

  it('refuses when the base moved while the gate ran', async () => {
    await missionWith({ 'a.txt': 'a\n' });
    const r = await finisher().mergeLocalGated({
      branch: MISSION,
      baseRef: 'main',
      message: 'm',
      integrationPath: tree,
      gate: async () => {
        fs.writeFileSync(path.join(repo, 'meanwhile.txt'), 'x\n');
        git(repo, 'add', '.');
        git(repo, 'commit', '-q', '-m', 'meanwhile');
        return { passed: true, summary: 'ok' };
      },
    });
    expect(r).toEqual({ ok: false, why: expect.stringContaining('moved while the check ran') });
    expect(git(repo, 'log', '-1', '--format=%s', 'main')).toBe('meanwhile');
  });
});
