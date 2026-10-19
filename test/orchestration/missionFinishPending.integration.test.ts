/**
 * Merge locally as one operation, whatever asks for it and whatever happens
 * to the app meanwhile (docs/plans/pending-actions.md): real git in a
 * temporary repository, the real worktree manager and mission store, and the
 * simulated harness.
 *
 * What these hold to:
 * - the core answers at once that a finish is under way, and records it
 *   before git is touched;
 * - a repeated request joins the one under way (at most one merge), and a
 *   conflicting finish is refused while it runs;
 * - a refusal leaves a readable reason and the buttons back;
 * - a fault after the merge but before its record — in this run, or a
 *   restart — is settled by reading git back, never by running it again;
 * - an outcome that cannot be read back keeps the buttons off.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LaunchDefaults } from '../../src/core/launchDefaults';
import { SessionRegistry } from '../../src/core/session/sessionRegistry';
import { MissionFinisher } from '../../src/orchestration/engine/missionFinish';
import { FinishRefused, TaskRunner, type TaskRunnerDeps } from '../../src/orchestration/engine/taskRunner';
import { createSimulatedExecutors, SimulatedHarness } from '../../src/orchestration/harness/simulatedHarness';
import { RepoPolicyStore, identityFor, worktreeRootPath } from '../../src/orchestration/policy/repoPolicyStore';
import { MissionStore } from '../../src/orchestration/store/missionStore';
import { missionViewOf } from '../../src/orchestration/view/missionViews';
import { nodeExec, type Exec } from '../../src/orchestration/worktrees/exec';
import { WorktreeManager, canonicalPath } from '../../src/orchestration/worktrees/worktreeManager';
import type { SimScenario } from '../../src/shared/orchestration/simulation';
import type { Mission } from '../../src/shared/orchestration/types';

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

function memento() {
  const doc: Record<string, unknown> = {};
  return {
    get: <T>(key: string, fallback: T): T => (key in doc ? (doc[key] as T) : fallback),
    update: (key: string, value: unknown) => {
      doc[key] = value;
    },
  };
}

async function until(cond: () => boolean, ms = 10_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

let tmp: string;
let repo: string;
let dataDir: string;
let runners: TaskRunner[];

beforeEach(() => {
  tmp = canonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-finish-')));
  repo = path.join(tmp, 'proj');
  dataDir = path.join(tmp, 'data');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  fs.writeFileSync(path.join(repo, 'check.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const saved = new RepoPolicyStore(path.join(dataDir, 'repos')).save(identityFor(repo), {
    verification: { check: { run: ['/bin/sh', 'check.sh'] } },
    review: { when: 'never' },
  });
  expect(saved.ok).toBe(true);
  runners = [];
});

afterEach(() => {
  for (const r of runners) r.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const missionsDir = () => path.join(dataDir, 'orchestration', 'missions');

function rig(overrides: Partial<TaskRunnerDeps> = {}): { runner: TaskRunner; scenario: SimScenario } {
  const registry = new SessionRegistry(memento());
  const executors = createSimulatedExecutors({ registry });
  const scenario: SimScenario = { tasks: {} };
  const harness = new SimulatedHarness({ scenario, sessions: executors.sessions });
  const runner = new TaskRunner({
    store: new MissionStore(missionsDir()),
    harnesses: new Map([['claude-code', harness]]),
    sessions: executors.sessions,
    registry,
    repoPolicies: new RepoPolicyStore(path.join(dataDir, 'repos')),
    openWorktrees: (loaded, record) => WorktreeManager.open({ repoRoot: loaded.repo.primaryRoot, root: worktreeRootPath(loaded) }, { record }),
    launchDefaults: new LaunchDefaults({ get: <T>(_k: string, f: T) => f }),
    telemetry: { append: () => true },
    diffsDir: path.join(dataDir, 'orchestration', 'diffs'),
    logsDir: path.join(dataDir, 'orchestration', 'logs'),
    settleMs: 30,
    previewDelayMs: 10,
    ...overrides,
  });
  runners.push(runner);
  return { runner, scenario };
}

const ROUTE = { harness: 'claude-code', model: 'claude-simulated', effort: 'low' } as const;

/** A one-task planned mission, run to review: its result is the mission branch. */
async function toReview(r: { runner: TaskRunner; scenario: SimScenario }): Promise<Mission> {
  const m = await r.runner.createMission({ folder: repo, title: 'Finish mission', objective: 'Synthetic.', tasks: [{ title: 'One', objective: 'Synthetic.', acceptanceCriteria: ['x'] }] });
  r.scenario.tasks![m.tasks[0].id] = [{ behaviour: 'edit', files: { 'one.txt': '1\n' } }];
  await r.runner.approvePlan(m.id, ROUTE);
  await until(() => r.runner.get(m.id)?.state === 'review', 20_000, 'review');
  return r.runner.get(m.id)!;
}

/** The gated merge's last step moves the base: `git merge --ff-only` in the primary checkout. */
const isBaseMove = (file: string, args: readonly string[], cwd: string) => file === 'git' && args.includes('--ff-only') && cwd === repo;

/** Merge commits on main since `from`. */
const mergesSince = (from: string) => git(repo, 'rev-list', '--merges', '--first-parent', `${from}..main`).split('\n').filter(Boolean);

/** What the mission store on disk says, as a fresh read would after a restart. */
const onDisk = (id: string): Mission => {
  const loaded = new MissionStore(missionsDir()).load(id);
  if (!('mission' in loaded)) throw new Error('unreadable');
  return loaded.mission;
};

describe('Merge locally: one merge, recorded before git is touched', () => {
  it('says at once that it is under way; a repeat joins it; a conflicting finish is refused; one merge happens', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let baseMoves = 0;
    const exec: Exec = async (file, args, opts) => {
      if (isBaseMove(file, args, opts.cwd)) {
        baseMoves++;
        await held;
      }
      return nodeExec(file, args, opts);
    };
    const r = rig({ exec });
    const m = await toReview(r);
    const start = git(repo, 'rev-parse', 'main');

    const first = r.runner.finishMission(m.id, 'merge-local');
    // Immediate: before the queue has done anything, every surface hears a finish is under way.
    expect(r.runner.finishingOf(m.id)).toEqual({ how: 'merge-local' });
    expect(missionViewOf(r.runner.get(m.id)!, { actions: () => [], finishing: r.runner.finishingOf(m.id) }).finishing).toEqual({ how: 'merge-local' });

    // A double click, a keyboard repeat, another surface, a replayed request: the same operation.
    const again = r.runner.finishMission(m.id, 'merge-local');
    expect(again).toBe(first);
    await expect(r.runner.finishMission(m.id, 'discard')).rejects.toThrow(/Merge is already under way/);
    await expect(r.runner.finishMission(m.id, 'pull-request')).rejects.toThrow(/already under way/);

    // Write-ahead: on disk before the base moves, with the base's tip it started from.
    await until(() => baseMoves === 1, 20_000, 'the base to be about to move');
    expect(onDisk(m.id).pendingFinish).toMatchObject({ how: 'merge-local', into: 'main', baseTip: start, branch: m.integration !== 'none' ? m.integration.branch : '' });
    expect(onDisk(m.id).state).toBe('review');

    release();
    const [a, b] = await Promise.all([first, again]);
    expect(a).toMatchObject({ state: 'completed', finish: 'merge-local' });
    expect(b).toBe(a);
    expect(a.pendingFinish).toBeUndefined();
    expect(onDisk(m.id).pendingFinish).toBeUndefined();
    expect(r.runner.finishingOf(m.id)).toBeUndefined();
    expect(baseMoves).toBe(1);
    expect(mergesSince(start)).toHaveLength(1);

    // A request replayed after it finished: the same answer, nothing merged again.
    const replay = await r.runner.finishMission(m.id, 'merge-local');
    expect(replay).toMatchObject({ state: 'completed', finish: 'merge-local' });
    expect(baseMoves).toBe(1);
    expect(mergesSince(start)).toHaveLength(1);
  });

  it('a refusal leaves the reason on the mission, the base alone, and every finish available again', async () => {
    const r = rig();
    const m = await toReview(r);
    const start = git(repo, 'rev-parse', 'main');
    fs.writeFileSync(path.join(repo, 'README.md'), 'edited by the user\n');
    const refused = r.runner.finishMission(m.id, 'merge-local');
    await expect(refused).rejects.toBeInstanceOf(FinishRefused);
    await expect(refused).rejects.toThrow(/uncommitted changes on main/);
    const cur = r.runner.get(m.id)!;
    expect(cur.state).toBe('review');
    expect(cur.pendingFinish).toBeUndefined();
    expect(cur.finishFailure).toMatchObject({ how: 'merge-local', why: expect.stringContaining('uncommitted changes on main') });
    expect(r.runner.finishingOf(m.id)).toBeUndefined();
    const view = missionViewOf(cur, { actions: () => [] });
    expect(view.finishFailure).toMatchObject({ how: 'merge-local' });
    expect(view.finishing).toBeUndefined();
    expect(view.review?.finishes).toEqual(['merge-local', 'pull-request', 'keep', 'discard']);
    expect(git(repo, 'rev-parse', 'main')).toBe(start);

    // Recovery: fix it and merge; the old reason goes.
    git(repo, 'checkout', '-q', '--', 'README.md');
    const done = await r.runner.finishMission(m.id, 'merge-local');
    expect(done).toMatchObject({ state: 'completed' });
    expect(done.finishFailure).toBeUndefined();
  });
});

describe('MissionFinisher read-back', () => {
  it('a plain merge cut off half-made in the primary checkout is aborted and reads as not merged', async () => {
    git(repo, 'switch', '-q', '-c', 'aw/x/t1');
    fs.writeFileSync(path.join(repo, 'README.md'), 'branch\n');
    git(repo, 'commit', '-q', '-am', 'branch');
    git(repo, 'switch', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'README.md'), 'main\n');
    git(repo, 'commit', '-q', '-am', 'main');
    const start = git(repo, 'rev-parse', 'main');
    // The app died with the merge in conflict: MERGE_HEAD is the branch's tip.
    try {
      git(repo, 'merge', '--no-ff', 'aw/x/t1');
    } catch {
      /* conflict, as intended */
    }
    expect(git(repo, 'rev-parse', 'MERGE_HEAD')).toBe(git(repo, 'rev-parse', 'aw/x/t1'));
    const finisher = new MissionFinisher({ exec: nodeExec, repoRoot: repo });
    const out = await finisher.reconcileMerge({ branch: 'aw/x/t1', baseRef: 'main', baseTip: start });
    expect(out).toMatchObject({ state: 'not-done' });
    expect(() => git(repo, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD')).toThrow();
    expect(git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(git(repo, 'rev-parse', 'main')).toBe(start);
  });

  it('a merge that went through reads as done, with its merge commit, even once the branch is deleted', async () => {
    git(repo, 'switch', '-q', '-c', 'aw/x/t1');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    git(repo, 'add', 'b.txt');
    git(repo, 'commit', '-q', '-m', 'b');
    const tip = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'switch', '-q', 'main');
    const start = git(repo, 'rev-parse', 'main');
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', 'aw/x/t1');
    const made = git(repo, 'rev-parse', 'main');
    git(repo, 'branch', '-q', '-D', 'aw/x/t1');
    const finisher = new MissionFinisher({ exec: nodeExec, repoRoot: repo });
    expect(await finisher.reconcileMerge({ branch: 'aw/x/t1', branchTip: tip, baseRef: 'main', baseTip: start })).toEqual({ state: 'done', into: 'main', mergeCommit: made });
  });

  it('a pull request is read back from gh; no answer from gh is unknown, never "not opened"', async () => {
    const answer = { code: 0, stdout: 'https://github.com/test/proj/pull/7\n', stderr: '' };
    const gh = (r: typeof answer | { code: number; stdout: string; stderr: string; failure: 'spawn' }): Exec => async (file, args, opts) => (file === 'gh' ? r : nodeExec(file, args, opts));
    const read = (exec: Exec) => new MissionFinisher({ exec, repoRoot: repo }).reconcilePullRequest({ branch: 'aw/x/mission' });
    expect(await read(gh(answer))).toEqual({ state: 'done', url: 'https://github.com/test/proj/pull/7' });
    expect(await read(gh({ code: 0, stdout: '\n', stderr: '' }))).toMatchObject({ state: 'not-done' });
    expect(await read(gh({ code: -1, stdout: '', stderr: '', failure: 'spawn' }))).toMatchObject({ state: 'unknown', why: expect.stringContaining('gh') });
  });
});

describe('Merge locally: an uncertain outcome is read back from git', () => {
  it('an error after the base moved, in this run: read back as merged, not merged again', async () => {
    let baseMoves = 0;
    const exec: Exec = async (file, args, opts) => {
      if (isBaseMove(file, args, opts.cwd)) {
        baseMoves++;
        await nodeExec(file, args, opts);
        throw new Error('the connection to git was lost');
      }
      return nodeExec(file, args, opts);
    };
    const r = rig({ exec });
    const m = await toReview(r);
    const start = git(repo, 'rev-parse', 'main');
    const done = await r.runner.finishMission(m.id, 'merge-local');
    expect(done).toMatchObject({ state: 'completed', finish: 'merge-local', finishResult: { note: expect.stringContaining('confirmed from git') } });
    expect(done.finishResult!.mergeCommit).toBe(git(repo, 'rev-parse', 'main'));
    expect(baseMoves).toBe(1);
    expect(mergesSince(start)).toHaveLength(1);
    expect(onDisk(m.id).pendingFinish).toBeUndefined();
  });

  it('a fault after the merge but before its record survives a restart, and recovery completes it without merging again', async () => {
    const r1 = rig();
    const m = await toReview(r1);
    const start = git(repo, 'rev-parse', 'main');
    // The disk refuses the record of the outcome (twice: the read-back's own write fails too).
    const store = (r1.runner as unknown as { deps: { store: MissionStore } }).deps.store;
    const save = store.save.bind(store);
    store.save = (x: Mission) => {
      if (x.state === 'completed') throw new Error('disk full');
      save(x);
    };
    await expect(r1.runner.finishMission(m.id, 'merge-local')).rejects.toThrow(/disk full/);
    // The merge happened; the record still says it is under way, so nothing re-enables the buttons.
    expect(mergesSince(start)).toHaveLength(1);
    const merged = git(repo, 'rev-parse', 'main');
    expect(onDisk(m.id)).toMatchObject({ state: 'review', pendingFinish: { how: 'merge-local', baseTip: start } });
    expect(r1.runner.finishingOf(m.id)).toMatchObject({ how: 'merge-local', uncertain: expect.any(String) });
    r1.runner.dispose();

    // Relaunch: recovery reads git back and completes the mission as merged.
    const r2 = rig();
    await r2.runner.recover();
    const after = r2.runner.get(m.id)!;
    expect(after).toMatchObject({ state: 'completed', finish: 'merge-local', finishResult: { mergeCommit: merged } });
    expect(after.pendingFinish).toBeUndefined();
    expect(mergesSince(start)).toHaveLength(1);
    expect(git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  });

  it('a restart before the base moved: read back as not merged, the integration tree is put back, and the buttons return', async () => {
    let cut = false;
    const exec: Exec = async (file, args, opts) => {
      if (isBaseMove(file, args, opts.cwd)) {
        // The app dies here: the checked merge exists in the integration tree, the base has not moved.
        cut = true;
        return new Promise(() => undefined);
      }
      return nodeExec(file, args, opts);
    };
    const r1 = rig({ exec });
    const m = await toReview(r1);
    const start = git(repo, 'rev-parse', 'main');
    void r1.runner.finishMission(m.id, 'merge-local').catch(() => undefined);
    await until(() => cut, 20_000, 'the merge to be cut off');
    r1.runner.dispose();
    expect(onDisk(m.id).pendingFinish).toMatchObject({ how: 'merge-local' });

    const r2 = rig();
    // Before recovery has read it back, the record keeps every finish off.
    expect(missionViewOf(onDisk(m.id), { actions: () => [] }).finishing).toEqual({ how: 'merge-local' });
    await r2.runner.recover();
    const back = r2.runner.get(m.id)!;
    expect(back.state).toBe('review');
    expect(back.pendingFinish).toBeUndefined();
    expect(back.finishFailure).toMatchObject({ how: 'merge-local', why: expect.stringContaining('interrupted') });
    expect(git(repo, 'rev-parse', 'main')).toBe(start);
    const tree = back.worktrees.find((w) => w.purpose === 'integration')!;
    expect(git(tree.path, 'branch', '--show-current')).toBe(back.integration !== 'none' ? back.integration.branch : '');

    // And the merge can be made, once.
    const done = await r2.runner.finishMission(m.id, 'merge-local');
    expect(done.state).toBe('completed');
    expect(mergesSince(start)).toHaveLength(1);
  });

  it('when git cannot answer, the finish stays off (marked uncertain) until a check settles it', async () => {
    let gitDown = false;
    const exec: Exec = async (file, args, opts) => {
      if (gitDown && file === 'git' && args[0] === 'merge-base') return { code: -1, stdout: '', stderr: 'git: cannot run', failure: 'spawn' };
      if (isBaseMove(file, args, opts.cwd)) {
        await nodeExec(file, args, opts);
        gitDown = true;
        throw new Error('the connection to git was lost');
      }
      return nodeExec(file, args, opts);
    };
    const r = rig({ exec });
    const m = await toReview(r);
    const start = git(repo, 'rev-parse', 'main');
    await expect(r.runner.finishMission(m.id, 'merge-local')).rejects.toThrow(/could not be read back/);
    let cur = r.runner.get(m.id)!;
    expect(cur.state).toBe('review');
    expect(cur.pendingFinish?.uncertain?.why).toMatch(/Could not compare/);
    expect(r.runner.finishingOf(m.id)).toMatchObject({ how: 'merge-local', uncertain: expect.stringMatching(/Could not compare/) });
    // Nothing new starts on a guess: not the merge again, not a different finish.
    await expect(r.runner.finishMission(m.id, 'merge-local')).rejects.toThrow(/Could not tell whether the earlier merge went through/);
    await expect(r.runner.finishMission(m.id, 'discard')).rejects.toThrow(/Could not tell/);
    expect(mergesSince(start)).toHaveLength(1);

    // git is back: Check again settles it as merged.
    gitDown = false;
    cur = await r.runner.recheckFinish(m.id);
    expect(cur).toMatchObject({ state: 'completed', finish: 'merge-local' });
    expect(cur.pendingFinish).toBeUndefined();
    expect(mergesSince(start)).toHaveLength(1);
  });
});
