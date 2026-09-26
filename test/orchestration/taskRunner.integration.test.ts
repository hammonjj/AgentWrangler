/**
 * The task runner (#33) end to end: real git in a temporary repository, the
 * real worktree manager and repo policy store, and attempts played by the
 * simulated harness through the real launch path (`SessionExecutors` →
 * `RunnerService` → `RunnerView`, with `simulatedQuery` in place of the SDK).
 *
 * A "restart" here is a second `TaskRunner` over the same store, registry and
 * executors: to orchestration that is what an app restart with session hosts
 * looks like (the sessions outlive the core, the core comes back and looks).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LaunchDefaults } from '../../src/core/launchDefaults';
import { SessionRegistry } from '../../src/core/session/sessionRegistry';
import { TaskRunner, type NewTask, type TaskRunnerDeps } from '../../src/orchestration/engine/taskRunner';
import { createSimulatedExecutors, SimulatedHarness } from '../../src/orchestration/harness/simulatedHarness';
import type { AgentHarness } from '../../src/orchestration/harness/types';
import { SimulatedCompletion } from '../../src/orchestration/completion/simulatedCompletion';
import { Assessor } from '../../src/orchestration/policy/assessor';
import { RepoPolicyStore, identityFor, worktreeRootPath } from '../../src/orchestration/policy/repoPolicyStore';
import { MissionStore } from '../../src/orchestration/store/missionStore';
import { WorktreeManager, canonicalPath } from '../../src/orchestration/worktrees/worktreeManager';
import type { SimAttempt } from '../../src/shared/orchestration/simulation';
import type { AttemptRecord, TelemetryRecord } from '../../src/shared/orchestration/telemetry';
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

async function until(cond: () => boolean, ms = 8000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

let tmp: string;
let repo: string;
let dataDir: string;
let rigs: Rig[];

beforeEach(() => {
  tmp = canonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-task-')));
  repo = path.join(tmp, 'proj');
  dataDir = path.join(tmp, 'data');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  // No trailing slash, as in this repository: the rule then matches the setup link too,
  // which is the case that once made the finishing commit fail.
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(repo, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  // A check the repository actually defines, so every task here is verified
  // for real (#35). A script rather than `npm run typecheck`: these tests run
  // it on every attempt, and twice more against the base commit when it fails.
  // `check.flag` is what a test writes to make it fail.
  fs.writeFileSync(path.join(repo, 'check.sh'), '#!/bin/sh\nif [ -f check.flag ]; then echo " FAIL  test/a.test.ts"; exit 1; fi\nexit 0\n', { mode: 0o755 });
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'check');
  const policies = new RepoPolicyStore(path.join(dataDir, 'repos'));
  const saved = policies.save(identityFor(repo), {
    worktrees: { setup: [{ link: 'node_modules' }] },
    verification: { check: { run: ['/bin/sh', 'check.sh'] } },
  });
  expect(saved.ok).toBe(true);
  rigs = [];
});

afterEach(async () => {
  for (const r of rigs) r.runner.dispose();
  // Worktrees first: git refuses nothing here, it is all ours and all temporary.
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface Shared {
  registry: SessionRegistry;
  executors: ReturnType<typeof createSimulatedExecutors>;
  store: MissionStore;
  telemetry: TelemetryRecord[];
  notices: { title: string; body: string }[];
}

interface Rig extends Shared {
  runner: TaskRunner;
  harness: SimulatedHarness;
}

function shared(): Shared {
  const registry = new SessionRegistry(memento());
  return {
    registry,
    executors: createSimulatedExecutors({ registry }),
    store: new MissionStore(path.join(dataDir, 'orchestration', 'missions')),
    telemetry: [],
    notices: [],
  };
}

function rig(attempt: SimAttempt, s: Shared = shared(), overrides: Partial<TaskRunnerDeps> & { harness?: AgentHarness } = {}): Rig {
  const harness = new SimulatedHarness({ scenario: { default: attempt }, sessions: s.executors.sessions });
  const runner = new TaskRunner({
    store: s.store,
    harnesses: new Map([['claude-code', overrides.harness ?? harness]]),
    sessions: s.executors.sessions,
    registry: s.registry,
    repoPolicies: new RepoPolicyStore(path.join(dataDir, 'repos')),
    openWorktrees: (loaded, record) =>
      WorktreeManager.open({ repoRoot: loaded.repo.primaryRoot, root: worktreeRootPath(loaded), setup: loaded.policy.worktrees.setup }, { record }),
    launchDefaults: new LaunchDefaults({ get: <T>(_k: string, f: T) => f }),
    telemetry: { append: (r) => (s.telemetry.push(r), true) },
    notify: (n) => s.notices.push(n),
    diffsDir: path.join(dataDir, 'orchestration', 'diffs'),
    logsDir: path.join(dataDir, 'orchestration', 'logs'),
    settleMs: 30,
    ...overrides,
  });
  const r = { ...s, runner, harness };
  rigs.push(r);
  return r;
}

const TASK: Omit<NewTask, 'folder'> = {
  title: 'Add a constant',
  objective: 'Synthetic objective: add a constant.',
  acceptanceCriteria: ['a.ts exports a'],
  route: { harness: 'claude-code', model: 'claude-simulated', effort: 'low' },
};

const EDIT: SimAttempt = { behaviour: 'edit', files: { 'src/a.ts': 'export const a = 1;\n' } };

function attemptOf(m: Mission | undefined, n = 1) {
  return m?.attempts.find((a) => a.n === n);
}

describe('TaskRunner', () => {
  it('runs a task in its own worktree and branch, with setup applied, and ends with a diff', async () => {
    const r = rig(EDIT);
    const started = await r.runner.start({ ...TASK, folder: path.join(repo) });
    const id = started.id;
    await until(() => attemptOf(r.runner.get(id))?.state === 'succeeded', 8000, 'the attempt to finish');
    const m = r.runner.get(id)!;
    const a = attemptOf(m)!;
    const wt = m.worktrees[0];

    // Its own tree and branch, as §13.2 lays them out, with node_modules linked in.
    expect(wt.path).toBe(path.join(tmp, 'proj.aw', wt.path.split('/').at(-2)!, 't1'));
    expect(wt.branch).toMatch(/^aw\/add-a-constant-[a-z0-9]{6}\/t1$/);
    expect(fs.lstatSync(path.join(wt.path, 'node_modules')).isSymbolicLink()).toBe(true);
    // The primary checkout is untouched.
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'branch', '--show-current')).toBe('main');

    // The core committed what the agent left, and not the setup link.
    expect(git(repo, 'show', '--name-only', '--format=', wt.branch).split('\n')).toEqual(['src/a.ts']);
    expect(a.git).toMatchObject({ baseCommit: m.base.commit, commits: 1, filesChanged: 1, insertions: 1, deletions: 0 });

    // Unverified until #35: the task waits for the user's review.
    expect(m.state).toBe('running');
    expect(m.tasks[0].state).toBe('needs-human');
    expect(a.outcome).toEqual({ status: 'succeeded' });
    expect(r.runner.actions(id)).toEqual(expect.arrayContaining(['open-diff', 'accept', 'retry', 'show-session']));
    const diff = fs.readFileSync(await r.runner.diff(id), 'utf8');
    expect(diff).toContain('+export const a = 1;');

    // The session: pre-assigned id, tagged with its origin, launched on the route and the attempt policy.
    const sid = a.assignment.sessionIds[0];
    const record = r.registry.get(sid)!;
    expect(record.origin).toEqual({ kind: 'orchestration', missionId: id, taskId: m.tasks[0].id, attemptId: a.id });
    expect(record.cwd).toBe(wt.path);
    expect(record.launch).toMatchObject({ model: 'claude-simulated', effort: 'low', permissionMode: 'auto' });
    expect(record.launch.policy?.claude?.allowedTools).toEqual(expect.arrayContaining(['Bash(/bin/sh check.sh:*)', 'Bash(git commit:*)']));
    expect(record.launch.policy?.claude?.disallowedTools).toEqual(
      expect.arrayContaining(['Bash(git push:*)', 'Bash(npm run app:install:*)', `Edit(/${repo}/**)`]),
    );
    // The prompt's own id came back on its turn: not the user's.
    expect(a.flags.userIntervened).toBeUndefined();

    // Telemetry: one attempt record, metadata only.
    const rec = r.telemetry.find((t): t is AttemptRecord => t.type === 'attempt')!;
    expect(rec).toMatchObject({ missionId: id, attemptId: a.id, n: 1, mode: 'manual', outcome: 'succeeded', git: { filesChanged: 1, commits: 1 } });
    expect(rec.target).toMatchObject({ harness: 'claude-code', model: 'claude-simulated', effortNative: 'low' });
    expect(JSON.stringify(rec)).not.toContain('Synthetic objective');

    // Accept: done, to review, session ended.
    await r.runner.accept(id);
    const done = r.runner.get(id)!;
    expect(done.tasks[0]).toMatchObject({ state: 'done', result: { branch: wt.branch, acceptedBy: 'user' } });
    expect(done.state).toBe('review');
    await until(() => r.executors.sessions.get(sid) === undefined, 3000, 'the session to end');
    await expect(r.runner.accept(id)).rejects.toThrow(/no finished attempt/);

    // Everything is on disk: a new store read gives the same mission.
    const reread = new MissionStore(path.join(dataDir, 'orchestration', 'missions')).load(id);
    expect('mission' in reread && reread.mission.tasks[0].state).toBe('done');
  });

  it('the finishing commit runs no hook the agent wrote, and the link setup made is never committed', async () => {
    // A repository whose hooks live in the tree (Husky's relative `core.hooksPath`).
    git(repo, 'config', 'core.hooksPath', '.hooks');
    const marker = path.join(tmp, 'hook-ran');
    const r = rig({ behaviour: 'edit', delayMs: 300, files: { 'src/a.ts': 'export const a = 1;\n' } });
    const started = await r.runner.start({ ...TASK, folder: repo });
    const wt = r.runner.get(started.id)!.worktrees[0];
    // What the agent writes while it works: executable hooks in its own tree.
    fs.mkdirSync(path.join(wt.path, '.hooks'), { recursive: true });
    for (const h of ['post-commit', 'prepare-commit-msg', 'pre-commit']) {
      fs.writeFileSync(path.join(wt.path, '.hooks', h), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    }
    await until(() => attemptOf(r.runner.get(started.id))?.state === 'succeeded', 8000, 'the attempt to finish');
    expect(fs.existsSync(marker)).toBe(false);
    // …and they would have run: a plain commit in that tree fires them.
    fs.writeFileSync(path.join(wt.path, 'probe.txt'), 'x\n');
    git(wt.path, 'add', 'probe.txt');
    git(wt.path, 'commit', '-q', '--no-verify', '-m', 'probe');
    expect(fs.existsSync(marker)).toBe(true);
    expect(git(repo, 'show', '--name-only', '--format=', wt.branch).split('\n')).not.toContain('node_modules');
  });

  it('writes the attempt, its session id and origin to disk before anything is launched', async () => {
    const s = shared();
    let onDisk: Mission | undefined;
    const inner = new SimulatedHarness({ scenario: { default: EDIT }, sessions: s.executors.sessions });
    const spy: AgentHarness = {
      id: 'claude-code',
      capabilities: () => inner.capabilities(),
      models: () => inner.models(),
      launch: async (req) => {
        const loaded = s.store.load(req.origin.missionId);
        onDisk = 'mission' in loaded ? loaded.mission : undefined;
        throw new Error('simulated crash before the session started');
      },
    };
    const r = rig(EDIT, s, { harness: spy });
    await expect(r.runner.start({ ...TASK, folder: repo })).rejects.toThrow(/Could not start the attempt/);
    const a = onDisk!.attempts[0];
    expect(a.state).toBe('launching');
    expect(a.assignment.sessionIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(onDisk!.worktrees[0].state).toBe('in-use');
    expect(onDisk!.tasks[0].state).toBe('running');
    // …and the failure is recorded, so nothing is left unowned.
    const m = r.runner.list()[0];
    expect(attemptOf(m)!.state).toBe('failed');
    expect(m.tasks[0].state).toBe('needs-human');
    expect(s.registry.all()).toEqual([]);
  });

  it('after a crash between "decided" and "started", recovery finds the record: nothing ran, retry only', async () => {
    const s = shared();
    const inner = new SimulatedHarness({ scenario: { default: EDIT }, sessions: s.executors.sessions });
    // A launch that never returns stands for the core dying mid-launch.
    const hang: AgentHarness = { id: 'claude-code', capabilities: () => inner.capabilities(), models: () => inner.models(), launch: () => new Promise(() => undefined) };
    const a = rig(EDIT, s, { harness: hang });
    void a.runner.start({ ...TASK, folder: repo });
    await until(() => attemptOf(a.runner.list()[0])?.state === 'launching', 5000, 'the write-ahead');
    a.runner.dispose();

    const b = rig(EDIT, s);
    await b.runner.recover();
    const m = b.runner.list()[0];
    expect(attemptOf(m)).toMatchObject({ state: 'interrupted', stateReason: 'nothing ran', resumable: false });
    expect(m.tasks[0].state).toBe('needs-human');
    expect(b.runner.actions(m.id)).toContain('retry');
    expect(b.runner.actions(m.id)).not.toContain('resume');
    expect(s.registry.all()).toEqual([]);

    // Retry fresh: a second tree and branch, the first kept.
    await b.runner.retry(m.id);
    await until(() => attemptOf(b.runner.get(m.id), 2)?.state === 'succeeded', 8000, 'the retry to finish');
    const after = b.runner.get(m.id)!;
    expect(after.worktrees.map((w) => [w.branch.split('/').at(-1), w.state])).toEqual([
      ['t1', 'retained'],
      ['t1-a2', 'ready'],
    ]);
  });

  it('reattaches a live attempt after a restart and completes it', async () => {
    const s = shared();
    const a = rig({ ...EDIT, delayMs: 400 }, s);
    const started = await a.runner.start({ ...TASK, folder: repo });
    expect(attemptOf(a.runner.get(started.id))!.state).toBe('running');
    // The core goes away; the session (a host, in the app) keeps working.
    a.runner.dispose();

    const b = rig(EDIT, s);
    await b.runner.recover();
    expect(attemptOf(b.runner.get(started.id))!.state).toBe('running');
    await until(() => attemptOf(b.runner.get(started.id))?.state === 'succeeded', 8000, 'the reattached attempt to finish');
    expect(attemptOf(b.runner.get(started.id))!.git?.filesChanged).toBe(1);
  });

  it('a lost host yields an interrupted attempt; Resume continues the same session id', async () => {
    const s = shared();
    const a = rig({ behaviour: 'timeout' }, s);
    const started = await a.runner.start({ ...TASK, folder: repo });
    const first = attemptOf(a.runner.get(started.id))!;
    const sid = first.assignment.sessionIds[0];
    a.runner.dispose();
    // The host dies while the app is quit: its session is gone, its record says so.
    const view = s.executors.runners.get(sid)!;
    await s.executors.runners.end(view);
    s.registry.setState(sid, 'interrupted', 'host lost');
    // It had written something before it died.
    fs.mkdirSync(path.join(a.runner.get(started.id)!.worktrees[0].path, 'src'), { recursive: true });
    fs.writeFileSync(path.join(a.runner.get(started.id)!.worktrees[0].path, 'src', 'b.ts'), 'export const b = 2;\n');

    const b = rig({ behaviour: 'no-diff' }, s);
    await b.runner.recover();
    const m = b.runner.get(started.id)!;
    expect(attemptOf(m)).toMatchObject({ state: 'interrupted', resumable: true, outcome: { status: 'interrupted', category: 'lost' } });
    expect(m.tasks[0].state).toBe('needs-human');
    expect(b.runner.actions(m.id)).toEqual(expect.arrayContaining(['resume', 'retry']));
    // Never resumed by itself after a host crash.
    expect(b.harness.launches).toHaveLength(0);
    const partial = s.telemetry.find((t): t is AttemptRecord => t.type === 'attempt' && t.outcome === 'interrupted');
    expect(partial?.partial).toBe(true);

    await b.runner.resume(m.id);
    expect(b.harness.launches[0].request.resume).toBe(sid);
    await until(() => attemptOf(b.runner.get(m.id), 2)?.state === 'succeeded', 8000, 'the resumed attempt to finish');
    const second = attemptOf(b.runner.get(m.id), 2)!;
    expect(second).toMatchObject({ resumeOf: first.id, assignment: { mode: 'continue', sessionIds: [sid] }, worktreeId: first.worktreeId });
    expect(second.git?.filesChanged).toBe(1);
    // The resumed session keeps its origin (the new attempt's) and its policy.
    expect(s.registry.get(sid)?.origin).toMatchObject({ attemptId: second.id });
    expect(s.registry.get(sid)?.launch.policy?.claude?.disallowedTools).toContain('Bash(git push:*)');
  });

  it('autoRecover resumes once after an app restart, never after a lost host', async () => {
    const s = shared();
    const a = rig({ behaviour: 'timeout' }, s);
    const started = await a.runner.start({ ...TASK, folder: repo });
    const sid = attemptOf(a.runner.get(started.id))!.assignment.sessionIds[0];
    a.runner.dispose();
    await s.executors.runners.end(s.executors.runners.get(sid)!);
    s.registry.setState(sid, 'interrupted', 'app-restart');
    // Opt in, as a mission's policy would.
    const m0 = s.store.load(started.id);
    s.store.save({ ...(m0 as { mission: Mission }).mission, policy: { autoRecover: true } });

    const b = rig(EDIT, s);
    await b.runner.recover();
    await until(() => attemptOf(b.runner.get(started.id), 2)?.state === 'succeeded', 8000, 'the automatic resume');
    expect(attemptOf(b.runner.get(started.id), 2)).toMatchObject({ autoResumed: true, assignment: { sessionIds: [sid] } });
  });

  it('an ask moves the attempt to waiting-human; answering it counts as the user taking part', async () => {
    const r = rig({ behaviour: 'question', files: { 'src/q.ts': 'export const q = 1;\n' } });
    const started = await r.runner.start({ ...TASK, folder: repo });
    await until(() => attemptOf(r.runner.get(started.id))?.state === 'waiting-human', 5000, 'the question');
    expect(r.notices.some((n) => /needs you/.test(n.title))).toBe(true);
    const handle = r.runner.handleOf(started.id)!;
    const q = handle.pendingQuestion!;
    await handle.answer(q.requestId, { [q.questions[0].question]: 'Yes' });
    await until(() => attemptOf(r.runner.get(started.id))?.state === 'succeeded', 8000, 'the attempt to finish');
    const a = attemptOf(r.runner.get(started.id))!;
    expect(a.flags.userIntervened).toBe(true);
    expect(a.timing?.waitedOnHumanMs).toBeGreaterThanOrEqual(0);
    expect(a.timing?.waitingSince).toBeUndefined();
  });

  it('an attempt that changes nothing fails as empty; one whose turn errors fails with its category', async () => {
    const empty = rig({ behaviour: 'no-diff' });
    const e = await empty.runner.start({ ...TASK, folder: repo });
    await until(() => attemptOf(empty.runner.get(e.id))?.state === 'failed', 8000, 'the empty attempt');
    expect(attemptOf(empty.runner.get(e.id))!.outcome).toMatchObject({ category: 'empty' });

    const limited = rig({ behaviour: 'rate-limit' });
    const l = await limited.runner.start({ ...TASK, title: 'Rate limited', folder: repo });
    await until(() => attemptOf(limited.runner.get(l.id))?.state === 'failed', 8000, 'the rate-limited attempt');
    expect(attemptOf(limited.runner.get(l.id))!.outcome).toMatchObject({ category: 'capacity' });
  });

  it('an agent that crashes fails the attempt; its work stays in the tree', async () => {
    const r = rig({ behaviour: 'crash', files: { 'src/half.ts': 'export const half = 1;\n' } });
    const started = await r.runner.start({ ...TASK, folder: repo });
    await until(() => attemptOf(r.runner.get(started.id))?.state === 'failed', 8000, 'the crash');
    const m = r.runner.get(started.id)!;
    expect(attemptOf(m)!.outcome).toMatchObject({ status: 'failed', category: 'infra' });
    expect(fs.existsSync(path.join(m.worktrees[0].path, 'src', 'half.ts'))).toBe(true);
    expect(r.runner.actions(m.id)).toContain('retry');
  });

  it('a worktree deleted while the app was away is reported missing, and can be recreated from its branch', async () => {
    const s = shared();
    const a = rig({ behaviour: 'no-diff' }, s);
    const started = await a.runner.start({ ...TASK, folder: repo });
    await until(() => attemptOf(a.runner.get(started.id))?.state === 'failed', 8000, 'the attempt to end');
    const wt = a.runner.get(started.id)!.worktrees[0];
    a.runner.dispose();
    fs.rmSync(wt.path, { recursive: true, force: true });

    const b = rig(EDIT, s);
    await b.runner.recover();
    const m = b.runner.get(started.id)!;
    expect(m.worktrees[0].state).toBe('missing');
    expect(m.tasks[0].stateReason).toMatch(/worktree has gone/);
    expect(b.runner.actions(m.id)).toContain('recreate-worktree');
    await b.runner.recreateWorktree(m.id);
    expect(b.runner.get(m.id)!.worktrees[0].state).toBe('ready');
    expect(fs.existsSync(wt.path)).toBe(true);
  });

  it('cancel ends the session and keeps the branch', async () => {
    const r = rig({ behaviour: 'timeout' });
    const started = await r.runner.start({ ...TASK, folder: repo });
    const sid = attemptOf(r.runner.get(started.id))!.assignment.sessionIds[0];
    await r.runner.cancel(started.id);
    const m = r.runner.get(started.id)!;
    expect(m.state).toBe('cancelled');
    expect(m.tasks[0].state).toBe('cancelled');
    expect(attemptOf(m)!.state).toBe('cancelled');
    expect(m.worktrees[0].state).toBe('retained');
    expect(git(repo, 'branch', '--list', m.worktrees[0].branch)).not.toBe('');
    await until(() => r.executors.sessions.get(sid) === undefined, 3000, 'the session to end');
  });

  // #37: the assessment is recorded beside the attempt, and never in its way.
  it('assesses the task beside the running attempt, and puts the snapshot on its telemetry', async () => {
    const answer = {
      complexity: { value: 'routine', confidence: 'high', evidence: 'one constant' },
      breadth: { value: 'single-file', confidence: 'high', evidence: 'one file' },
      risk: { value: 'low', confidence: 'high', evidence: 'nothing depends on it' },
      ambiguity: { value: 'clear', confidence: 'high', evidence: 'the criterion is testable' },
      verifiability: { value: 'strong', confidence: 'high', evidence: 'typecheck covers it' },
      kind: { value: 'feature', confidence: 'high', evidence: 'it adds a constant' },
      domains: ['typescript'],
      requires: ['edit'],
    };
    const r = rig(EDIT, shared(), { assessor: new Assessor({ completion: new SimulatedCompletion([{ output: answer }]) }) });
    const started = await r.runner.start({ ...TASK, folder: repo });
    const id = started.id;
    await until(() => (r.runner.get(id)?.assessments.length ?? 0) > 0, 8000, 'the assessment');
    const m = r.runner.get(id)!;
    const a = m.assessments[0];
    expect(m.tasks[0].assessmentIds).toEqual([a.id]);
    expect(a.dimensions.complexity).toMatchObject({ value: 'routine', from: 'model' });
    // The task plans one behavioural check (#35), so the model's `strong` is capped at `partial`.
    expect(a.dimensions.verifiability).toMatchObject({ value: 'partial', from: 'rule' });

    await until(() => attemptOf(r.runner.get(id))?.state === 'succeeded', 8000, 'the attempt to finish');
    const rec = r.telemetry.find((t): t is AttemptRecord => t.type === 'attempt')!;
    expect(rec.assessment).toMatchObject({ assessorVersion: 'asm-1', dimensions: { complexity: { value: 'routine' } } });
    expect(JSON.stringify(rec)).not.toContain('Synthetic objective');
  });

  it('runs the task anyway when the assessment model never answers usably', async () => {
    const r = rig(EDIT, shared(), {
      assessor: new Assessor({ completion: new SimulatedCompletion([{ raw: 'nonsense' }, { raw: 'still nonsense' }]) }),
    });
    const started = await r.runner.start({ ...TASK, folder: repo });
    const id = started.id;
    await until(() => attemptOf(r.runner.get(id))?.state === 'succeeded', 8000, 'the attempt to finish');
    await until(() => (r.runner.get(id)?.assessments.length ?? 0) > 0, 8000, 'the assessment');
    const a = r.runner.get(id)!.assessments[0];
    expect(a.confidence).toBe('low');
    expect(a.llm).toBeUndefined();
    expect(r.runner.get(id)!.tasks[0].state).toBe('needs-human');
  });

  it('refuses a folder outside git, and records nothing', async () => {
    const r = rig(EDIT);
    const outside = path.join(tmp, 'not-a-repo');
    fs.mkdirSync(outside);
    await expect(r.runner.start({ ...TASK, folder: outside })).rejects.toThrow(/not in a git repository/);
    expect(r.runner.list()).toEqual([]);
  });

  // ---- verification (#35) ----

  describe('verification', () => {
    /** Run a task to its terminal state and hand back the mission. */
    async function runToEnd(r: Rig): Promise<Mission> {
      const started = await r.runner.start({ ...TASK, folder: repo });
      await until(
        () => ['succeeded', 'failed'].includes(attemptOf(r.runner.get(started.id))?.state ?? ''),
        20_000,
        'the attempt to finish',
      );
      return r.runner.get(started.id)!;
    }

    it('passes a result that passes the repository’s checks, and records the stages', async () => {
      const m = await runToEnd(rig(EDIT));
      const a = attemptOf(m)!;

      expect(a.state).toBe('succeeded');
      expect(a.verification.map((v) => [v.strategy, v.outcome])).toEqual([
        ['diff-sanity', 'passed'],
        ['command:check', 'passed'],
      ]);
      expect(m.tasks[0].state).toBe('needs-human');
      expect(m.tasks[0].stateReason).toContain('passed');
    });

    it('fails the attempt when a required check fails, and says which test', async () => {
      // The agent's edit trips the repository's own check.
      const r = rig({ behaviour: 'edit', files: { 'src/a.ts': 'export const a = 1;\n', 'check.flag': 'x\n' } });
      const m = await runToEnd(r);
      const a = attemptOf(m)!;

      expect(a.state).toBe('failed');
      expect(a.outcome).toMatchObject({ status: 'failed', category: 'quality-new' });
      expect(a.outcome?.signature).toBeDefined();
      const check = a.verification.find((v) => v.strategy === 'command:check')!;
      expect(check.outcome).toBe('failed');
      expect(check.evidence?.failing).toEqual(['test/a.test.ts']);
      // The log is on disk for the user to open.
      expect(fs.readFileSync(check.evidence!.logPath!, 'utf8')).toContain('FAIL');
      expect(m.tasks[0].state).toBe('needs-human');
      expect(r.notices.some((n) => n.title.includes('failed verification'))).toBe(true);
    });

    it('carries the stage results into the attempt’s telemetry record', async () => {
      const r = rig(EDIT);
      await runToEnd(r);
      const rec = r.telemetry.find((t): t is AttemptRecord => t.type === 'attempt')!;

      expect(rec.verification).toEqual([
        { strategy: 'diff-sanity', outcome: 'passed', flaky: undefined, preExisting: undefined, durationMs: expect.any(Number) },
        { strategy: 'command:check', outcome: 'passed', flaky: undefined, preExisting: undefined, durationMs: expect.any(Number) },
      ]);
    });

    it('a repository with no checks produces a result nothing vouched for', async () => {
      // Replace the policy with one that defines no commands at all.
      const policies = new RepoPolicyStore(path.join(dataDir, 'repos'));
      expect(policies.save(identityFor(repo), { worktrees: { setup: [{ link: 'node_modules' }] } }).ok).toBe(true);

      const m = await runToEnd(rig(EDIT));
      const a = attemptOf(m)!;

      // It still succeeds — nothing said it was wrong — but it is explicitly
      // unverified, and only the user can turn that into `done`.
      expect(a.state).toBe('succeeded');
      expect(m.tasks[0].state).toBe('needs-human');
      expect(m.tasks[0].stateReason).toContain('unverified');
      expect(a.verification.map((v) => v.strategy)).toEqual(['diff-sanity']);
    });

    it('does not fail an attempt for a check that was already failing on the base commit', async () => {
      // The check is red at the base commit: the flag is committed before the task starts.
      fs.writeFileSync(path.join(repo, 'check.flag'), 'x\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'break the check');

      const m = await runToEnd(rig(EDIT));
      const a = attemptOf(m)!;
      const check = a.verification.find((v) => v.strategy === 'command:check')!;

      expect(check).toMatchObject({ outcome: 'inconclusive', preExisting: true });
      expect(a.state).toBe('succeeded');
      expect(a.outcome?.category).toBeUndefined();
      expect(m.tasks[0].stateReason).toContain('base commit');
    });

    it('fails an attempt whose diff would not survive review, before running any command', async () => {
      const r = rig({ behaviour: 'edit', files: { 'src/a.ts': '<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> other\n' } });
      const m = await runToEnd(r);
      const a = attemptOf(m)!;

      expect(a.state).toBe('failed');
      expect(a.verification.map((v) => v.strategy)).toEqual(['diff-sanity']);
      expect(a.outcome?.signature).toBe('diff-sanity:conflict-markers');
    });
  });
});
