/**
 * The task runner's restart story against real session hosts (#33, plan
 * §23.3): detached host processes over real sockets with the fake agent
 * (`AW_SESSION_HOST_FAKE=1`), and a "restart" done the way `createApp` does
 * it: a new registry startup from the host scan, a new `RunnerService` that
 * adopts the surviving hosts, then the task runner's recovery.
 *
 * This is the automated half of "quitting or reinstalling mid-attempt leaves
 * the attempt running; on relaunch it is reattached and completes", and of
 * "a killed host yields an interrupted attempt; Resume continues the same id".
 * macOS and Linux only, like the other host tests.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunnerService } from '../../src/claude/runner/runnerService';
import { LaunchDefaults } from '../../src/core/launchDefaults';
import type { HostSupervisor } from '../../src/core/session/hostSupervisor';
import { outcomesFromDeadHosts } from '../../src/core/session/recovery';
import { SessionExecutors } from '../../src/core/session/sessionExecutors';
import { SessionRegistry } from '../../src/core/session/sessionRegistry';
import { TaskRunner } from '../../src/orchestration/engine/taskRunner';
import { SimulatedHarness } from '../../src/orchestration/harness/simulatedHarness';
import { RepoPolicyStore, identityFor, worktreeRootPath } from '../../src/orchestration/policy/repoPolicyStore';
import { MissionStore } from '../../src/orchestration/store/missionStore';
import { WorktreeManager } from '../../src/orchestration/worktrees/worktreeManager';
import type { SimAttempt } from '../../src/shared/orchestration/simulation';
import type { Mission } from '../../src/shared/orchestration/types';
import { HostHarness, noHistory, until } from '../support/hostHarness';

const h = new HostHarness();
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  await h.build();
  const cfg = path.join(h.root, 'gitconfig');
  fs.writeFileSync(cfg, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
  for (const [k, v] of Object.entries({ GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1' })) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
}, 60_000);

afterEach(async () => {
  for (const d of disposers.splice(0)) d();
  await h.cleanup();
});

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await h.dispose();
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function memento() {
  const doc: Record<string, unknown> = {};
  return {
    get: <T>(key: string, fallback: T): T => (key in doc ? (doc[key] as T) : fallback),
    update: (key: string, value: unknown) => {
      doc[key] = value;
    },
  };
}

let n = 0;
let repo: string;
let dataDir: string;
let store: MissionStore;
let registryDoc: ReturnType<typeof memento>;
const disposers: (() => void)[] = [];

beforeEach(() => {
  const base = path.join(h.root, `t${++n}`);
  repo = path.join(base, 'proj');
  dataDir = path.join(base, 'data');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  store = new MissionStore(path.join(dataDir, 'missions'));
  registryDoc = memento();
});

/** One run of the app's core: a registry started from the host scan, a hosted Claude executor, a task runner. */
function core(attempt: SimAttempt, opts: { adopt?: boolean } = {}) {
  const sup: HostSupervisor = h.supervisor();
  const scan = sup.scan();
  const registry = new SessionRegistry(registryDoc);
  registry.startup(new Set(scan.alive.map((m) => m.sessionId!).filter(Boolean)), outcomesFromDeadHosts(scan.dead));
  const runners = new RunnerService({
    query: () => {
      throw new Error('hosted sessions never run in-process');
    },
    binary: () => '/fake',
    log: () => undefined,
    registry,
    hosts: { supervisor: sup, enabled: () => true },
    loadHistory: noHistory,
  });
  if (opts.adopt) for (const m of scan.alive) runners.adopt(m, registry.get(m.sessionId));
  const sessions = new SessionExecutors([runners]);
  const harness = new SimulatedHarness({ scenario: { default: attempt }, sessions });
  const runner = new TaskRunner({
    store,
    harnesses: new Map([['claude-code', harness]]),
    sessions,
    registry,
    repoPolicies: new RepoPolicyStore(path.join(dataDir, 'repos')),
    openWorktrees: (loaded, record) => WorktreeManager.open({ repoRoot: loaded.repo.primaryRoot, root: worktreeRootPath(loaded) }, { record }),
    launchDefaults: new LaunchDefaults({ get: <T>(_k: string, f: T) => f }),
    diffsDir: path.join(dataDir, 'diffs'),
    settleMs: 50,
  });
  const quit = () => {
    runner.dispose();
    // What ⌘Q does with hosts on: hosted sessions are let go of, not ended.
    runners.dispose();
  };
  disposers.push(quit);
  return { runner, runners, registry, harness, quit };
}

const current = (m: Mission | undefined) => m?.attempts.at(-1);

describe.runIf(process.platform !== 'win32')('TaskRunner with real session hosts', () => {
  it('an attempt keeps running through a quit, and the relaunched core reattaches and completes it', async () => {
    expect(identityFor(repo).primaryRoot).toBe(repo);
    const a = core({ behaviour: 'edit', delayMs: 2500, files: { 'src/a.ts': 'export const a = 1;\n' } });
    const started = await a.runner.start({ folder: repo, objective: 'Synthetic', acceptanceCriteria: [], route: { harness: 'claude-code' } });
    const sid = current(started)!.assignment.sessionIds[0];
    // Mid-attempt: the host's agent is up, the prompt has reached it, and its turn is under way.
    await h.manifestWithAgent(sid);
    await until(() => a.runners.get(sid)?.lifecycle === 'running', 10_000, 'the turn to start');
    await new Promise((r) => setTimeout(r, 500));
    expect(a.runners.get(sid)?.lifecycle).toBe('running');
    a.quit();
    expect(a.runners.list()).toEqual([]);

    // Relaunch: the host is still there, the record is still live.
    const b = core({ behaviour: 'no-diff' }, { adopt: true });
    expect(b.registry.get(sid)?.state).toBe('live');
    await b.runner.recover();
    expect(current(b.runner.get(started.id))?.state).toBe('running');
    await until(() => current(b.runner.get(started.id))?.state === 'succeeded', 20_000, 'the reattached attempt to finish');
    const m = b.runner.get(started.id)!;
    // (The fake agent also leaves `agent-env-<pid>.json` in its cwd, which is committed with the rest.)
    const files = git(repo, 'show', '--name-only', '--format=', m.worktrees[0].branch).split('\n');
    expect(files).toContain('src/a.ts');
    expect(current(m)!.git).toMatchObject({ commits: 1, filesChanged: files.length });
    // Nothing was launched again: the same session finished the work.
    expect(b.harness.launches).toHaveLength(0);
  }, 60_000);

  it('a quit before the prompt reached the host: the relaunched core sends it again, once', async () => {
    const a = core({ behaviour: 'edit', files: { 'src/a.ts': 'export const a = 1;\n' } });
    const started = await a.runner.start({ folder: repo, objective: 'Synthetic', acceptanceCriteria: [], route: { harness: 'claude-code' } });
    const sid = current(started)!.assignment.sessionIds[0];
    // Straight away: the first send is still on its way to a host that is starting.
    a.quit();
    await h.manifestWithAgent(sid);

    const b = core({ behaviour: 'no-diff' }, { adopt: true });
    await b.runner.recover();
    // The re-sent prompt carries no simulation script, so the fake agent plays
    // whatever its words suggest: what matters is that the prompt arrived, once.
    await until(() => current(b.runner.get(started.id))?.state !== 'running', 20_000, 'the attempt to move on');
    const handle = b.runners.get(sid)!;
    expect(handle.lifecycle).not.toBe('starting');
    expect(handle.blocks.filter((x) => x.kind === 'user')).toHaveLength(1);
  }, 60_000);

  it('a host killed while the app is quit gives an interrupted attempt; Resume continues the same session id', async () => {
    const a = core({ behaviour: 'timeout' });
    const started = await a.runner.start({ folder: repo, objective: 'Synthetic', acceptanceCriteria: [], route: { harness: 'claude-code' } });
    const sid = current(started)!.assignment.sessionIds[0];
    const manifest = await h.manifestWithAgent(sid);
    a.quit();
    process.kill(manifest.hostPid, 'SIGKILL');
    process.kill(manifest.agentPid!, 'SIGKILL');
    await until(() => h.supervisor().scan().alive.every((m) => m.sessionId !== sid), 10_000, 'the host to be gone');

    const b = core({ behaviour: 'edit', files: { 'src/b.ts': 'export const b = 2;\n' } }, { adopt: true });
    expect(b.registry.get(sid)).toMatchObject({ state: 'interrupted', endedReason: 'host lost' });
    await b.runner.recover();
    const m = b.runner.get(started.id)!;
    expect(current(m)).toMatchObject({ state: 'interrupted', resumable: true });
    expect(b.runner.actions(m.id)).toEqual(expect.arrayContaining(['resume', 'retry']));
    expect(b.harness.launches).toHaveLength(0);

    await b.runner.resume(m.id);
    expect(b.harness.launches[0].request.resume).toBe(sid);
    await until(() => current(b.runner.get(m.id))?.state === 'succeeded', 20_000, 'the resumed attempt to finish');
    const done = b.runner.get(m.id)!;
    expect(current(done)!.assignment).toMatchObject({ mode: 'continue', sessionIds: [sid] });
    expect(h.manifest(sid)?.sessionId).toBe(sid);
  }, 60_000);
});
