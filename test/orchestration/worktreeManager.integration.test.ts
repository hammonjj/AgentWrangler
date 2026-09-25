/**
 * WorktreeManager against real git, in temporary repositories (#31).
 * Every test gets a fresh `<tmp>/proj` with its trees in `<tmp>/proj.aw`.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SetupStep as WorktreeSetupStep } from '../../src/shared/orchestration/repoPolicy';
import type { WorktreeAssignment } from '../../src/shared/orchestration/types';
import { nodeExec, type Exec } from '../../src/orchestration/worktrees/exec';
import { WorktreeError, WorktreeManager, canonicalPath, type WorktreeFailureCategory } from '../../src/orchestration/worktrees/worktreeManager';

const savedEnv: Record<string, string | undefined> = {};
let gitConfig: string;

beforeAll(() => {
  // Isolate from the machine's git config (hooks, signing, templates), for us and for the manager.
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
let records: WorktreeAssignment[];
let failures: WorktreeFailureCategory[];
let children: ChildProcess[];

beforeEach(() => {
  tmp = canonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-wt-')));
  repo = path.join(tmp, 'proj');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n*.env\n.setup-ran\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  base = git(repo, 'rev-parse', 'HEAD');
  fs.mkdirSync(path.join(repo, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, 'local.env'), 'KEY=value\n');
  records = [];
  failures = [];
  children = [];
});

afterEach(() => {
  for (const c of children) c.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
});

const SETUP: WorktreeSetupStep[] = [{ link: 'node_modules' }, { copy: 'local.env' }, { run: ['touch', '.setup-ran'] }];

async function open(opts: { setup?: WorktreeSetupStep[]; allowed?: string[][]; exec?: Exec; processesUsing?: (d: string) => Promise<number[]> } = {}) {
  return WorktreeManager.open(
    { repoRoot: repo, setup: opts.setup ?? SETUP, allowedCommands: opts.allowed ?? [['touch', '.setup-ran']] },
    {
      exec: opts.exec,
      processesUsing: opts.processesUsing,
      record: (a) => void records.push(a),
      onFailure: (c) => void failures.push(c),
      now: () => 1_790_000_000_000,
    },
  );
}

function planT1(m: WorktreeManager, overrides: Partial<Parameters<WorktreeManager['plan']>[0]> = {}) {
  return m.plan({ id: 'w1', missionSlug: 'm', purpose: 'task', taskKey: 't1', taskId: 't1', baseCommit: base, ...overrides });
}

function commitIn(tree: string, file: string, msg: string): string {
  fs.writeFileSync(path.join(tree, file), `${msg}\n`);
  git(tree, 'add', file);
  git(tree, 'commit', '-q', '-m', msg);
  return git(tree, 'rev-parse', 'HEAD');
}

const branchExists = (b: string) => {
  try {
    git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`);
    return true;
  } catch {
    return false;
  }
};

describe('open', () => {
  it('accepts a primary checkout and derives <repo>.aw', async () => {
    const m = await open();
    expect(m.repoRoot).toBe(repo);
    expect(m.root).toBe(path.join(tmp, 'proj.aw'));
  });

  it('refuses a linked worktree, a subdirectory and a non-repository', async () => {
    git(repo, 'worktree', 'add', '-q', path.join(tmp, 'linked'), '-b', 'other');
    fs.mkdirSync(path.join(repo, 'sub'));
    fs.mkdirSync(path.join(tmp, 'plain'));
    for (const r of [path.join(tmp, 'linked'), path.join(repo, 'sub'), path.join(tmp, 'plain')]) {
      await expect(WorktreeManager.open({ repoRoot: r }, { record: () => undefined })).rejects.toMatchObject({ category: 'not-a-repository' });
    }
  });

  it('refuses a root inside the primary checkout', async () => {
    await expect(WorktreeManager.open({ repoRoot: repo, root: '.aw' }, { record: () => undefined })).rejects.toMatchObject({ category: 'invalid-name' });
  });
});

describe('create → setup → commit → remove', () => {
  it('works end to end, and leaves the primary checkout alone', async () => {
    const m = await open();
    const planned = planT1(m);
    expect(planned).toMatchObject({ state: 'creating', branch: 'aw/m/t1', path: path.join(m.root, 'm', 't1'), lastKnownHead: base });

    const ready = await m.create(planned);
    expect(ready.state).toBe('ready');
    expect(records.map((r) => r.state)).toEqual(['creating', 'ready']);
    const tree = ready.path;
    expect(git(tree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('aw/m/t1');
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(base);
    // Setup: the link points into the primary checkout, the copy is a copy, the command ran.
    expect(fs.readlinkSync(path.join(tree, 'node_modules'))).toBe(path.join(repo, 'node_modules'));
    expect(fs.lstatSync(path.join(tree, 'local.env')).isFile()).toBe(true);
    expect(fs.existsSync(path.join(tree, '.setup-ran'))).toBe(true);
    expect(await m.exists(ready)).toBe(true);
    expect((await m.list()).filter((w) => w.ours).map((w) => w.branch)).toEqual(['aw/m/t1']);

    // An attempt works in it.
    const inUse = await m.markInUse(ready);
    const sha = commitIn(tree, 'feature.txt', 'feature');
    const released = await m.release(inUse, 'ready');
    expect(released.lastKnownHead).toBe(sha);

    // Not merged yet: refused.
    const refused = await m.remove(released, { mergedInto: 'main' });
    expect(refused).toMatchObject({ removed: false, refusals: [{ reason: 'unmerged' }] });

    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge t1', 'aw/m/t1');
    const out = await m.remove(released, { mergedInto: 'main' });
    expect(out.removed).toBe(true);
    if (out.removed) expect(out.assignment).toMatchObject({ state: 'removed', removedAt: 1_790_000_000_000 });
    expect(fs.existsSync(tree)).toBe(false);
    expect(branchExists('aw/m/t1')).toBe(false);
    // The linked directory's contents are untouched.
    expect(fs.readFileSync(path.join(repo, 'node_modules', 'dep', 'index.js'), 'utf8')).toContain('module.exports');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('proj.aw');
  });

  it('records the intent before any git work (write-ahead)', async () => {
    const events: string[] = [];
    const exec: Exec = (file, args, opts) => {
      events.push(`${file} ${args.slice(0, 2).join(' ')}`);
      return nodeExec(file, args, opts);
    };
    const m = await WorktreeManager.open(
      { repoRoot: repo },
      { exec, record: (a) => void events.push(`record ${a.state}`) },
    );
    events.length = 0;
    await m.create(planT1(m));
    expect(events[0]).toBe('record creating');
    expect(events.findIndex((e) => e.startsWith('git worktree add'))).toBeGreaterThan(0);
    expect(events.at(-1)).toBe('record ready');
  });

  it('keeps a failed attempt branch and puts the retry on -a2', async () => {
    const m = await open();
    const first = await m.create(planT1(m));
    commitIn(first.path, 'try1.txt', 'try 1');
    await m.release(await m.markInUse(first), 'retained');
    // Planning the same name again cannot silently reuse it: it has the first attempt's work.
    await expect(m.create(planT1(m, { id: 'w1b' }))).rejects.toMatchObject({ category: 'unexpected-commits' });
    const second = await m.create(planT1(m, { id: 'w2', attempt: 2 }));
    expect(second.branch).toBe('aw/m/t1-a2');
    expect(second.path).toBe(path.join(m.root, 'm', 't1-a2'));
    expect(branchExists('aw/m/t1')).toBe(true);
  });

  it('creates the mission integration tree on aw/<mission>/mission beside task branches', async () => {
    const m = await open({ setup: [] });
    const integ = await m.create(m.plan({ id: 'wi', missionSlug: 'm', purpose: 'integration', baseCommit: base }));
    const t1 = await m.create(planT1(m));
    expect(integ).toMatchObject({ branch: 'aw/m/mission', path: path.join(m.root, 'm', '_integration') });
    expect(t1.branch).toBe('aw/m/t1');
  });

  it('refuses a setup command that is not allowlisted, and counts it', async () => {
    const m = await open({ setup: [{ run: ['rm', '-rf', '/'] }], allowed: [['touch', '.setup-ran']] });
    await expect(m.create(planT1(m))).rejects.toMatchObject({ category: 'setup-not-allowed' });
    expect(failures).toContain('setup-not-allowed');
    expect(m.failureCounts()['setup-not-allowed']).toBe(1);
  });

  it('refuses a path that is already occupied, a bad base, and names outside the rules', async () => {
    const m = await open();
    fs.mkdirSync(path.join(m.root, 'm', 't1'), { recursive: true });
    fs.writeFileSync(path.join(m.root, 'm', 't1', 'someone-elses.txt'), 'x');
    await expect(m.create(planT1(m))).rejects.toMatchObject({ category: 'path-occupied' });
    expect(fs.readFileSync(path.join(m.root, 'm', 't1', 'someone-elses.txt'), 'utf8')).toBe('x');

    expect(() => planT1(m, { baseCommit: 'main' })).toThrow(WorktreeError);
    await expect(m.create(planT1(m, { id: 'x', taskKey: 't9', baseCommit: 'f'.repeat(40) }))).rejects.toMatchObject({ category: 'bad-base' });
    expect(() => planT1(m, { missionSlug: '../escape' })).toThrow(/mission slug/);
    await expect(m.resolveCommit('main')).resolves.toBe(base);
    await expect(m.resolveCommit('--output=x')).rejects.toMatchObject({ category: 'bad-base' });
  });

  it('refuses a branch that already exists with other commits', async () => {
    git(repo, 'branch', 'aw/m/t1', base);
    const other = path.join(tmp, 'elsewhere');
    git(repo, 'worktree', 'add', '-q', other, 'aw/m/t1');
    commitIn(other, 'x.txt', 'someone else');
    git(repo, 'worktree', 'remove', other);
    const m = await open();
    await expect(m.create(planT1(m))).rejects.toMatchObject({ category: 'branch-exists' });
  });
});

describe('remove refuses, and changes nothing when it does', () => {
  async function readyMerged(m: WorktreeManager) {
    const a = await m.create(planT1(m));
    return a;
  }

  function snapshot(a: WorktreeAssignment) {
    return {
      exists: fs.existsSync(a.path),
      branch: branchExists(a.branch),
      status: fs.existsSync(a.path) ? git(a.path, 'status', '--porcelain') : '',
      link: fs.existsSync(a.path) ? fs.readlinkSync(path.join(a.path, 'node_modules')) : '',
    };
  }

  it('a dirty tree (modified tracked file)', async () => {
    const m = await open();
    const a = await readyMerged(m);
    fs.appendFileSync(path.join(a.path, 'README.md'), 'edit\n');
    const before = snapshot(a);
    records.length = 0;
    const out = await m.remove(a, { mergedInto: 'main' });
    expect(out).toMatchObject({ removed: false, refusals: [{ reason: 'dirty' }] });
    expect(snapshot(a)).toEqual(before);
    expect(records).toEqual([]);
    expect(failures).toContain('refused-dirty');
  });

  it('a dirty tree (untracked file)', async () => {
    const m = await open();
    const a = await readyMerged(m);
    fs.writeFileSync(path.join(a.path, 'notes.txt'), 'wip');
    const before = snapshot(a);
    const out = await m.remove(a, { mergedInto: 'main' });
    expect(out.removed).toBe(false);
    if (!out.removed) expect(out.refusals[0].detail).toContain('notes.txt');
    expect(snapshot(a)).toEqual(before);
  });

  it('an unmerged branch', async () => {
    const m = await open();
    const a = await readyMerged(m);
    commitIn(a.path, 'work.txt', 'work');
    const before = snapshot(a);
    const out = await m.remove(a, { mergedInto: 'main' });
    expect(out).toMatchObject({ removed: false, refusals: [{ reason: 'unmerged' }] });
    expect(snapshot(a)).toEqual(before);
    // A merge target that does not exist is not "merged".
    const out2 = await m.remove(a, { mergedInto: 'no-such-branch' });
    expect(out2).toMatchObject({ removed: false, refusals: [{ reason: 'unmerged' }] });
  });

  it('a tree an attempt holds', async () => {
    const m = await open();
    const a = await m.markInUse(await readyMerged(m));
    const before = snapshot(a);
    const out = await m.remove(a, { mergedInto: 'main' });
    expect(out).toMatchObject({ removed: false, refusals: [{ reason: 'in-use', detail: 'an attempt holds it' }] });
    expect(snapshot(a)).toEqual(before);
  });

  it('a tree a process is working in (real lsof)', async () => {
    const m = await open();
    const a = await readyMerged(m);
    const child = spawn('sleep', ['30'], { cwd: path.join(a.path), stdio: 'ignore' });
    children.push(child);
    await new Promise((r) => setTimeout(r, 200));
    const before = snapshot(a);
    const out = await m.remove(a, { mergedInto: 'main' });
    expect(out.removed).toBe(false);
    if (!out.removed) {
      expect(out.refusals).toHaveLength(1);
      expect(out.refusals[0]).toMatchObject({ reason: 'in-use' });
      expect(out.refusals[0].detail).toContain(String(child.pid));
    }
    expect(snapshot(a)).toEqual(before);
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    expect((await m.remove(a, { mergedInto: 'main' })).removed).toBe(true);
  });

  it('when it cannot tell whether a process is using it', async () => {
    const m = await open({ processesUsing: async () => { throw new Error('lsof missing'); } });
    const a = await readyMerged(m);
    const out = await m.remove(a, { mergedInto: 'main' });
    expect(out).toMatchObject({ removed: false, refusals: [{ reason: 'in-use' }] });
    expect(fs.existsSync(a.path)).toBe(true);
  });

  it('a locked tree, and one that is not ours', async () => {
    const m = await open();
    const a = await readyMerged(m);
    git(repo, 'worktree', 'lock', '--reason', 'keep', a.path);
    expect(await m.remove(a, { mergedInto: 'main' })).toMatchObject({ removed: false, refusals: [{ reason: 'locked' }] });
    git(repo, 'worktree', 'unlock', a.path);

    const foreign = { ...a, path: path.join(tmp, 'elsewhere') };
    expect(await m.remove(foreign, { mergedInto: 'main' })).toMatchObject({ removed: false, refusals: [{ reason: 'not-ours' }] });
    const userBranch = { ...a, branch: 'main' };
    const out = await m.remove(userBranch, { mergedInto: 'main' });
    expect(out.removed).toBe(false);
    if (!out.removed) expect(out.refusals.map((r) => r.reason)).toContain('not-ours');
    expect(branchExists('main')).toBe(true);
    expect(fs.existsSync(a.path)).toBe(true);
  });

  it('keeps the branch when asked, and is idempotent', async () => {
    const m = await open();
    const a = await readyMerged(m);
    const out = await m.remove(a, { mergedInto: 'main', deleteBranch: false });
    expect(out.removed).toBe(true);
    expect(branchExists('aw/m/t1')).toBe(true);
    if (out.removed) expect(await m.remove(out.assignment, { mergedInto: 'main' })).toEqual(out);
  });
});

describe('recovery', () => {
  it('finishes an assignment recorded as creating where nothing happened yet', async () => {
    const m = await open();
    const a = planT1(m);
    const [item] = await m.reconcile([a]);
    expect(item).toMatchObject({ action: 'finished', assignment: { state: 'ready' } });
    expect(fs.readlinkSync(path.join(a.path, 'node_modules'))).toBe(path.join(repo, 'node_modules'));
  });

  it('finishes one where the branch was made but not the tree', async () => {
    const m = await open();
    const a = planT1(m);
    git(repo, 'branch', a.branch, base);
    const [item] = await m.reconcile([a]);
    expect(item.action).toBe('finished');
    expect(git(a.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('aw/m/t1');
  });

  it('finishes one that git left half-populated (locked "initializing")', async () => {
    const m = await open();
    const a = planT1(m);
    fs.mkdirSync(path.dirname(a.path), { recursive: true });
    git(repo, 'worktree', 'add', '-q', '-b', a.branch, a.path, base);
    git(repo, 'worktree', 'lock', '--reason', 'initializing', a.path);
    fs.rmSync(path.join(a.path, 'README.md')); // the checkout never finished
    const [item] = await m.reconcile([a]);
    expect(item.action).toBe('finished');
    expect(fs.readFileSync(path.join(a.path, 'README.md'), 'utf8')).toBe('hello\n');
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('locked');
    // Only the setup link shows: `node_modules/` (trailing slash) matches directories, not a symlink.
    // `remove` treats an intact setup link as clean for exactly this reason.
    expect(git(a.path, 'status', '--porcelain')).toBe('?? node_modules');
    expect((await m.remove(item.assignment, { mergedInto: 'main' })).removed).toBe(true);
  });

  it('finishes one where git finished but setup did not', async () => {
    const m = await open();
    const a = planT1(m);
    fs.mkdirSync(path.dirname(a.path), { recursive: true });
    git(repo, 'worktree', 'add', '-q', '-b', a.branch, a.path, base);
    const [item] = await m.reconcile([a]);
    expect(item.action).toBe('finished');
    expect(fs.existsSync(path.join(a.path, '.setup-ran'))).toBe(true);
  });

  it('reports an externally deleted worktree as missing, recreatable while its branch survives', async () => {
    const m = await open();
    const a = await m.create(planT1(m));
    const sha = commitIn(a.path, 'kept.txt', 'kept');
    const idle = await m.release(await m.markInUse(a), 'retained');
    fs.rmSync(a.path, { recursive: true, force: true });

    const [item] = await m.reconcile([idle]);
    expect(item).toMatchObject({ action: 'missing', recreatable: true, assignment: { state: 'missing' } });
    expect(failures).toContain('missing');

    const back = await m.recreate(item.assignment);
    expect(back).toMatchObject({ state: 'ready', lastKnownHead: sha });
    expect(fs.readFileSync(path.join(a.path, 'kept.txt'), 'utf8')).toBe('kept\n');
    expect(fs.existsSync(path.join(a.path, 'node_modules'))).toBe(true);
  });

  it('says a missing worktree cannot be recreated once its branch is gone', async () => {
    const m = await open();
    const a = await m.create(planT1(m));
    fs.rmSync(a.path, { recursive: true, force: true });
    git(repo, 'worktree', 'prune');
    git(repo, 'branch', '-D', a.branch);
    const [item] = await m.reconcile([a]);
    expect(item).toMatchObject({ action: 'missing', recreatable: false });
    await expect(m.recreate(item.assignment)).rejects.toMatchObject({ category: 'branch-missing' });
  });

  it('a missing worktree can still be removed', async () => {
    const m = await open();
    const a = await m.create(planT1(m));
    fs.rmSync(a.path, { recursive: true, force: true });
    const [item] = await m.reconcile([a]);
    const out = await m.remove(item.assignment, { mergedInto: 'main' });
    expect(out.removed).toBe(true);
    expect(branchExists(a.branch)).toBe(false);
  });

  it('detects commits made outside any attempt, but not an attempt’s own', async () => {
    const m = await open();
    const a = await m.create(planT1(m));
    // An attempt's commits are expected once it lets go.
    const held = await m.markInUse(a);
    commitIn(a.path, 'mine.txt', 'attempt work');
    const released = await m.release(held, 'ready');
    expect((await m.reconcile([released]))[0].action).toBe('ok');

    // Someone commits while no attempt holds it.
    const stray = commitIn(a.path, 'theirs.txt', 'outside');
    const [item] = await m.reconcile([released]);
    expect(item).toMatchObject({ action: 'unexpected-commits', unexpectedCommits: [stray], rewritten: false });

    // Accepting the head clears it.
    const noted = await m.noteHead(released);
    expect((await m.reconcile([noted]))[0].action).toBe('ok');
  });

  it('flags a branch whose history was rewritten outside any attempt', async () => {
    const m = await open();
    const a = await m.create(planT1(m));
    const held = await m.markInUse(a);
    commitIn(a.path, 'one.txt', 'one');
    const released = await m.release(held, 'ready');
    git(a.path, 'reset', '-q', '--hard', base);
    commitIn(a.path, 'two.txt', 'two');
    const [item] = await m.reconcile([released]);
    expect(item).toMatchObject({ action: 'unexpected-commits', rewritten: true });
  });
});
