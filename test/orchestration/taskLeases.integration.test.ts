/**
 * Exclusive resources through the real task runner (#47 over #68): real git,
 * the real worktree manager, attempts played by the simulated harness, and the
 * real file-backed `LeaseService` in a temp directory.
 *
 * - A task needing `exclusive:unity-editor:Game` waits while someone else
 *   holds the lease, says by whom, and starts once it is released.
 * - The attempt holds the lease while it runs, bound to its session, and gives
 *   it back when it ends.
 * - A restart (a second `TaskRunner` and a second lease service over the same
 *   files, the first core's pid now dead) keeps the attempt's lease, and
 *   releases it when the attempt ends.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LaunchDefaults } from '../../src/core/launchDefaults';
import { FileLeaseService } from '../../src/core/leases/leaseService';
import { isSameProcessAlive, startTimeOf } from '../../src/core/procStart';
import { SessionRegistry } from '../../src/core/session/sessionRegistry';
import { TaskRunner, type NewTask } from '../../src/orchestration/engine/taskRunner';
import { createSimulatedExecutors, SimulatedHarness } from '../../src/orchestration/harness/simulatedHarness';
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

/** A pid nothing runs as: the first core, after it is gone. */
const GONE_PID = 999_999;
const RESOURCE = 'unity-editor:Game';

let tmp: string;
let repo: string;
let dataDir: string;
let leaseDir: string;
let runners: TaskRunner[];
let services: FileLeaseService[];

beforeEach(() => {
  tmp = canonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-task-leases-')));
  repo = path.join(tmp, 'proj');
  dataDir = path.join(tmp, 'data');
  leaseDir = path.join(tmp, 'leases');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const saved = new RepoPolicyStore(path.join(dataDir, 'repos')).save(identityFor(repo), {
    // Every attempt in this repository needs the Editor (no paths).
    exclusive: [{ id: RESOURCE, why: 'one Unity Editor per project' }],
  });
  expect(saved.ok).toBe(true);
  runners = [];
  services = [];
});

afterEach(() => {
  for (const r of runners) r.dispose();
  for (const s of services) s.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface Shared {
  registry: SessionRegistry;
  executors: ReturnType<typeof createSimulatedExecutors>;
  store: MissionStore;
  telemetry: TelemetryRecord[];
}

function shared(): Shared {
  const registry = new SessionRegistry(memento());
  return { registry, executors: createSimulatedExecutors({ registry }), store: new MissionStore(path.join(dataDir, 'orchestration', 'missions')), telemetry: [] };
}

function leaseService(pid = process.pid): FileLeaseService {
  const s = new FileLeaseService({
    dir: leaseDir,
    settings: () => ({ enabled: false, resources: undefined }),
    startTimeOf,
    alive: isSameProcessAlive,
    sessionState: () => undefined,
    holdAttemptLeases: () => true,
    pid,
  });
  services.push(s);
  return s;
}

function rig(attempt: SimAttempt, s: Shared, leases: FileLeaseService): TaskRunner {
  const harness = new SimulatedHarness({ scenario: { default: attempt }, sessions: s.executors.sessions });
  const runner = new TaskRunner({
    store: s.store,
    harnesses: new Map([['claude-code', harness]]),
    sessions: s.executors.sessions,
    registry: s.registry,
    repoPolicies: new RepoPolicyStore(path.join(dataDir, 'repos')),
    openWorktrees: (loaded, record) =>
      WorktreeManager.open({ repoRoot: loaded.repo.primaryRoot, root: worktreeRootPath(loaded), setup: loaded.policy.worktrees.setup }, { record }),
    launchDefaults: new LaunchDefaults({ get: <T>(_k: string, f: T) => f }),
    telemetry: { append: (r) => (s.telemetry.push(r), true) },
    diffsDir: path.join(dataDir, 'orchestration', 'diffs'),
    logsDir: path.join(dataDir, 'orchestration', 'logs'),
    settleMs: 30,
    leases: {
      service: leases,
      setAttemptActive: (fn) => {
        leases.attemptActive = fn;
      },
    },
  });
  runners.push(runner);
  return runner;
}

const TASK: Omit<NewTask, 'folder'> = {
  title: 'Play the level',
  objective: 'Synthetic objective: change the level.',
  acceptanceCriteria: ['level.txt says 2'],
  route: { harness: 'claude-code', model: 'claude-simulated', effort: 'low' },
};

const EDIT: SimAttempt = { behaviour: 'edit', files: { 'level.txt': '2\n' } };

const attemptOf = (m: Mission | undefined) => m?.attempts[0];

describe('exclusive resources through the task runner', () => {
  it('waits while another session holds the Editor, starts once it is released, holds it while running and gives it back', async () => {
    const s = shared();
    const leases = leaseService();
    // Someone else's session has the Editor (the hook took it for them).
    const other = leases.acquire(RESOURCE, { kind: 'session', sessionId: 'other-session' }, { cwd: repo });
    expect(other.ok).toBe(true);

    const runner = rig({ ...EDIT, delayMs: 300 }, s, leases);
    const m = await runner.start({ ...TASK, folder: repo });
    // Nothing started, nothing failed: it waits, saying for what.
    expect(runner.get(m.id)!.attempts).toEqual([]);
    expect(runner.get(m.id)!.state).toBe('running');
    expect(runner.get(m.id)!.tasks[0].stateReason).toBe(`waiting: ${RESOURCE} is in use by another agent session (${RESOURCE})`);

    // Released: the change event steps the scheduler, and the task starts.
    leases.forceRelease(other.ok ? other.lease.key : '');
    await until(() => attemptOf(runner.get(m.id))?.state === 'running', 5000, 'the attempt to start');
    const a = attemptOf(runner.get(m.id))!;
    expect(a.leases).toHaveLength(1);
    const held = leases.list();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ key: a.leases![0], holder: { kind: 'attempt', attemptId: a.id, sessionId: a.assignment.sessionIds[0] }, scope: 'session' });

    await until(() => attemptOf(runner.get(m.id))?.state === 'succeeded', 8000, 'the attempt to finish');
    expect(leases.list()).toEqual([]);
  });

  it('two tasks needing the Editor never run together: the second starts when the first ends', async () => {
    const s = shared();
    const leases = leaseService();
    const runner = rig({ ...EDIT, delayMs: 400 }, s, leases);
    const first = await runner.start({ ...TASK, folder: repo });
    const second = await runner.start({ ...TASK, title: 'Play another level', folder: repo });
    expect(attemptOf(runner.get(first.id))?.state).toBe('running');
    expect(runner.get(second.id)!.attempts).toEqual([]);
    expect(runner.get(second.id)!.tasks[0].stateReason).toBe(`waiting: ${RESOURCE} is in use by t1 of “Play the level”`);

    await until(() => attemptOf(runner.get(second.id))?.state === 'running', 10_000, 'the second to start');
    // By then the first had finished.
    expect(attemptOf(runner.get(first.id))?.state).toBe('succeeded');
    await until(() => attemptOf(runner.get(second.id))?.state === 'succeeded', 10_000, 'the second to finish');
    expect(leases.list()).toEqual([]);
  });

  it('keeps an attempt’s lease across a core restart, and releases it when the attempt ends', async () => {
    const s = shared();
    // The first core: its pid is one nothing runs as, so after "the restart" the lease's pid is dead.
    const before = leaseService(GONE_PID);
    const a = rig({ behaviour: 'timeout' }, s, before);
    const m = await a.start({ ...TASK, folder: repo });
    const attempt = attemptOf(a.get(m.id))!;
    expect(attempt.state).toBe('running');
    expect(before.list()).toHaveLength(1);
    a.dispose();
    before.dispose();

    // The second core, before orchestration has recovered: it does not judge the lease by the dead pid.
    const after = leaseService();
    const b = rig({ behaviour: 'timeout' }, s, after);
    expect(after.reap()).toEqual([]);
    await b.recover();
    expect(attemptOf(b.get(m.id))!.state).toBe('running');
    // Recovered and still running: kept, and rebound to this core.
    expect(after.reap()).toEqual([]);
    expect(after.list()).toEqual([expect.objectContaining({ holder: { kind: 'attempt', attemptId: attempt.id, sessionId: attempt.assignment.sessionIds[0] }, pid: process.pid })]);

    // Another task meanwhile waits for it.
    const waiting = await b.start({ ...TASK, title: 'Another', folder: repo });
    expect(b.get(waiting.id)!.attempts).toEqual([]);

    await b.cancel(m.id);
    expect(after.list().filter((l) => l.holder.kind === 'attempt' && l.holder.attemptId === attempt.id)).toEqual([]);
  });

  it('records scopeAccuracy for an attempt whose task predicted a scope', async () => {
    const s = shared();
    const leases = leaseService();
    const runner = rig({ behaviour: 'edit', files: { 'src/a.ts': 'export const a = 1;\n', 'docs/x.md': 'x\n' } }, s, leases);
    const m = await runner.createMission({
      folder: repo,
      title: 'Scoped',
      objective: 'Synthetic.',
      tasks: [{ title: 'Add a', objective: 'Synthetic: add a.', acceptanceCriteria: ['a.ts exports a'], scopePaths: ['src/**'] }],
    });
    await runner.approvePlan(m.id, TASK.route);
    await until(() => !!attemptOf(runner.get(m.id))?.scope, 8000, 'the attempt to be measured');
    const a = attemptOf(runner.get(m.id))!;
    expect(a.scope).toEqual({ accuracy: 0.5, changed: 2, outside: ['docs/x.md'], outsideCount: 1 });
    expect(a.flags.outOfScope).toBe(true);
    await until(() => s.telemetry.some((r) => r.type === 'attempt'), 8000, 'the attempt record');
    const record = s.telemetry.find((r): r is AttemptRecord => r.type === 'attempt');
    expect(record?.scopeAccuracy).toBe(0.5);
    expect(record?.flags).toMatchObject({ outOfScope: true });
  });
});
