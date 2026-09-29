/**
 * A task routed to a local model, end to end (#51): real git, the real task
 * runner, verification and telemetry, with attempts played by the simulated
 * harness through the real launch path. The local endpoint's health is a
 * switch the test flips, which is how "the server went away mid-attempt" is
 * simulated: the runner hears `onDown`, or finds out when a turn fails.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Emitter } from '../../src/core/events';
import { LaunchDefaults } from '../../src/core/launchDefaults';
import { SessionRegistry } from '../../src/core/session/sessionRegistry';
import { TelemetryLog } from '../../src/core/telemetry/telemetryLog';
import { TurnTelemetry } from '../../src/core/telemetry/turnTelemetry';
import { LOCAL_SERVER_LOST, TaskRunner, type NewTask } from '../../src/orchestration/engine/taskRunner';
import { createSimulatedExecutors, SimulatedHarness } from '../../src/orchestration/harness/simulatedHarness';
import { RepoPolicyStore, identityFor, worktreeRootPath } from '../../src/orchestration/policy/repoPolicyStore';
import { MissionStore } from '../../src/orchestration/store/missionStore';
import { WorktreeManager, canonicalPath } from '../../src/orchestration/worktrees/worktreeManager';
import { buildCatalog, known, UNKNOWN } from '../../src/shared/orchestration/catalog';
import type { LocalModelReport } from '../../src/shared/orchestration/localModels';
import { summariseLocal } from '../../src/shared/orchestration/localMetrics';
import type { HealthState, SourceStatus } from '../../src/shared/orchestration/sourceHealth';
import type { SimAttempt } from '../../src/shared/orchestration/simulation';
import type { AttemptRecord, TelemetryRecord, TurnRecord } from '../../src/shared/orchestration/telemetry';
import type { Mission, ModelSourceId } from '../../src/shared/orchestration/types';

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
const cleanups: (() => void | Promise<void>)[] = [];

beforeEach(() => {
  tmp = canonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-local-task-')));
  repo = path.join(tmp, 'proj');
  dataDir = path.join(tmp, 'data');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  fs.writeFileSync(path.join(repo, 'check.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const saved = new RepoPolicyStore(path.join(dataDir, 'repos')).save(identityFor(repo), { verification: { check: { run: ['/bin/sh', 'check.sh'] } } });
  expect(saved.ok).toBe(true);
});

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const LOCAL = 'local:box';

function localReport(): LocalModelReport {
  return {
    descriptor: {
      source: LOCAL,
      modelId: 'coder',
      label: 'coder · Box',
      location: 'local',
      contextWindow: known(65536, 'probed'),
      maxOutputTokens: UNKNOWN,
      toolCalling: known('basic', 'measured'),
      structuredOutput: known('json', 'measured'),
      vision: UNKNOWN,
      streaming: known(true, 'measured'),
      nativeEffort: known([], 'probed'),
      maxConcurrency: known(2, 'probed'),
      throughput: UNKNOWN,
      costBasis: 'none',
      qualifiedHarnesses: ['codex'],
    },
    harnesses: ['codex'],
    endpointEnabled: true,
    external: false,
  };
}

/** The pool: the local model and one hosted model, both `standard`; the hosted one priced, for the estimate. */
const CATALOG = buildCatalog({
  reported: [{ source: 'anthropic', models: [{ value: 'claude-simulated', label: 'Simulated', resolved: 'claude-simulated' }] }],
  local: [localReport()],
  policy: { [`${LOCAL}:coder`]: { tier: 'standard' }, 'anthropic:claude-simulated': { tier: 'standard' } },
  prices: { 'claude-simulated': { inPerMTok: 3, outPerMTok: 15 } },
});

interface Rig {
  runner: TaskRunner;
  telemetry: TelemetryRecord[];
  notices: { title: string; body: string }[];
  local: { health: HealthState; down: Emitter<ModelSourceId> };
  codex: SimulatedHarness;
  claude: SimulatedHarness;
}

function rig(localAttempt: SimAttempt, hostedAttempt: SimAttempt = EDIT): Rig {
  const registry = new SessionRegistry(memento());
  const { sessions } = createSimulatedExecutors({ registry });
  const telemetry: TelemetryRecord[] = [];
  const notices: { title: string; body: string }[] = [];
  const turns = new Emitter<TurnRecord>();
  const turnTelemetry = new TurnTelemetry({
    sessions,
    log: new TelemetryLog(path.join(dataDir, 'telemetry')),
    enabled: () => true,
    registry,
    onRecord: (r) => turns.fire(r),
  });
  const local = { health: 'reachable' as HealthState, down: new Emitter<ModelSourceId>() };
  // The local harness: Codex by id, played by the simulated agent (a local model is a Codex thread).
  const codex = new SimulatedHarness({ id: 'codex', scenario: { default: localAttempt }, sessions });
  const claude = new SimulatedHarness({ scenario: { default: hostedAttempt }, sessions });
  const status = (): SourceStatus => ({
    source: LOCAL,
    health: { state: local.health, reason: local.health === 'reachable' ? 'ok' : 'Not answering' },
    capacity: { windowPercent: UNKNOWN, freeSlots: known(2, 'probed') },
  });
  const runner = new TaskRunner({
    store: new MissionStore(path.join(dataDir, 'orchestration', 'missions')),
    harnesses: new Map([
      ['codex', codex],
      ['claude-code', claude],
    ]),
    sessions,
    registry,
    repoPolicies: new RepoPolicyStore(path.join(dataDir, 'repos')),
    openWorktrees: (loaded, record) => WorktreeManager.open({ repoRoot: loaded.repo.primaryRoot, root: worktreeRootPath(loaded), setup: [] }, { record }),
    launchDefaults: new LaunchDefaults({ get: <T>(_k: string, f: T) => f }),
    routing: { snapshot: () => ({ catalog: CATALOG, sources: { [LOCAL]: status() }, now: Date.now() }) },
    local: {
      check: async () => local.health,
      onDown: (l) => local.down.event(l),
      facts: () => ({ runtime: 'llama.cpp', device: 'Test device', contextWindow: 65536 }),
    },
    telemetry: { append: (r) => (telemetry.push(r), true) },
    onTurnRecord: (l) => turns.event(l),
    notify: (n) => notices.push(n),
    diffsDir: path.join(dataDir, 'orchestration', 'diffs'),
    logsDir: path.join(dataDir, 'orchestration', 'logs'),
    settleMs: 30,
  });
  cleanups.push(() => {
    runner.dispose();
    turnTelemetry.dispose();
  });
  return { runner, telemetry, notices, local, codex, claude };
}

const EDIT: SimAttempt = { behaviour: 'edit', files: { 'src/a.ts': 'export const a = 1;\n' }, usage: { in: 20_000, out: 2_000 } };

const TASK: Omit<NewTask, 'folder'> = {
  title: 'Add a constant',
  objective: 'Synthetic objective: add a constant.',
  acceptanceCriteria: ['a.ts exports a'],
  route: { harness: 'codex', source: LOCAL, model: 'coder' },
};

const attemptOf = (m: Mission | undefined, n: number) => m?.attempts.find((a) => a.n === n);
const records = (r: Rig) => r.telemetry.filter((t): t is AttemptRecord => t.type === 'attempt');

describe('a task on a local model', () => {
  it('runs, verifies and records local metrics', async () => {
    const r = rig(EDIT);
    const m0 = await r.runner.start({ ...TASK, folder: repo });
    await until(() => attemptOf(r.runner.get(m0.id), 1)?.state === 'succeeded', 10_000, 'the attempt to succeed');
    const m = r.runner.get(m0.id)!;
    const d = m.decisions[0];
    expect(d.resolution.target).toMatchObject({ harness: 'codex', source: LOCAL, model: 'coder', tier: 'standard', location: 'local', effortNative: 'none' });
    // The launch carried the local source, which is what gives Codex its model provider.
    expect(r.codex.launches[0].request.target).toMatchObject({ source: LOCAL, model: 'coder' });
    expect(attemptOf(m, 1)!.verification.some((v) => v.strategy === 'command:check' && v.outcome === 'passed')).toBe(true);

    const [rec] = records(r);
    expect(rec).toMatchObject({ outcome: 'succeeded', target: { source: LOCAL, location: 'local' }, cost: { basis: 'none' } });
    expect(rec.cost.usd).toBe(0);
    expect(rec.local).toMatchObject({ source: LOCAL, runtime: 'llama.cpp', device: 'Test device', contextWindow: 65536, tokPerSecFrom: 'attempt' });
    expect(rec.local!.outTokPerSec).toBeGreaterThan(0);
    expect(rec.local!.queueMs).toBeGreaterThanOrEqual(0);
    // Labelled estimate: the hosted standard model's price for the same tokens.
    expect(rec.local!.apiEquivalentModel).toBe('claude-simulated');
    expect(rec.local!.apiEquivalentUsd).toBeCloseTo((20_000 * 3 + 2_000 * 15) / 1e6, 6);
    expect(rec.local!.ttftMs).toBeUndefined();

    const [summary] = summariseLocal(r.telemetry);
    expect(summary).toMatchObject({ source: LOCAL, model: 'coder', executions: 1, attempts: 1, succeeded: 1, verifiedFirstTime: 1, escalated: 0, outputTokens: 2_000 });
  });

  it('losing the server mid-attempt is infra, and fails over within the tier when the mission allows', async () => {
    const r = rig({ behaviour: 'timeout' });
    const m0 = await r.runner.start({ ...TASK, folder: repo, policy: { autoRecover: true } });
    await until(() => attemptOf(r.runner.get(m0.id), 1)?.state === 'running', 8000, 'the attempt to run');
    r.local.health = 'down';
    r.local.down.fire(LOCAL);
    await until(() => attemptOf(r.runner.get(m0.id), 2)?.state === 'succeeded', 10_000, 'the failover attempt to succeed');
    const m = r.runner.get(m0.id)!;
    expect(attemptOf(m, 1)!.outcome).toEqual({ status: 'failed', category: 'infra', signature: LOCAL_SERVER_LOST });
    const d2 = m.decisions.find((d) => d.id === attemptOf(m, 2)!.routingDecisionId)!;
    // Same tier, another source; decided by the router, and it says why.
    expect(d2.resolution.target).toMatchObject({ harness: 'claude-code', source: 'anthropic', model: 'claude-simulated', tier: 'standard' });
    expect(d2.requirement).toMatchObject({ minTier: 'standard', maxTier: 'standard' });
    expect(d2.decidedBy).toBe('router');
    expect(d2.reasons[0].ruleId).toBe('failover.infra');
    expect(r.notices.some((n) => /failed over/.test(n.title))).toBe(true);
    // The first worktree is kept for comparison.
    expect(m.worktrees.find((w) => w.id === attemptOf(m, 1)!.worktreeId)?.state).toBe('retained');

    const recs = records(r);
    expect(recs[0]).toMatchObject({ outcome: 'failed', category: 'infra', signature: LOCAL_SERVER_LOST, local: { source: LOCAL } });
    const [summary] = summariseLocal(r.telemetry);
    expect(summary).toMatchObject({ attempts: 1, succeeded: 0, escalated: 1 });
  });

  it('a hand-picked route is not changed behind the user: infra, then the user decides', async () => {
    const r = rig({ behaviour: 'timeout' });
    const m0 = await r.runner.start({ ...TASK, folder: repo });
    await until(() => attemptOf(r.runner.get(m0.id), 1)?.state === 'running', 8000, 'the attempt to run');
    r.local.health = 'down';
    r.local.down.fire(LOCAL);
    await until(() => attemptOf(r.runner.get(m0.id), 1)?.state === 'failed', 8000, 'the attempt to fail');
    const m = r.runner.get(m0.id)!;
    expect(attemptOf(m, 1)!.outcome).toMatchObject({ category: 'infra', signature: LOCAL_SERVER_LOST });
    expect(m.tasks[0].state).toBe('needs-human');
    expect(m.attempts).toHaveLength(1);
    expect(r.runner.actions(m0.id)).toContain('retry');
    expect(r.claude.launches).toHaveLength(0);
  });

  it('a turn that fails while the server is gone is classified the same way', async () => {
    const r = rig({ behaviour: 'fail' });
    r.local.health = 'down';
    const m0 = await r.runner.start({ ...TASK, folder: repo, policy: { autoRecover: true } });
    await until(() => attemptOf(r.runner.get(m0.id), 2)?.state === 'succeeded', 10_000, 'the failover attempt');
    expect(attemptOf(r.runner.get(m0.id), 1)!.outcome).toMatchObject({ category: 'infra', signature: LOCAL_SERVER_LOST });
  });

  it('a turn that fails with the server up is not a lost server, and does not fail over', async () => {
    const r = rig({ behaviour: 'fail' });
    const m0 = await r.runner.start({ ...TASK, folder: repo, policy: { autoRecover: true } });
    await until(() => attemptOf(r.runner.get(m0.id), 1)?.state === 'failed', 8000, 'the attempt to fail');
    await new Promise((res) => setTimeout(res, 100));
    const m = r.runner.get(m0.id)!;
    expect(attemptOf(m, 1)!.outcome?.signature).not.toBe(LOCAL_SERVER_LOST);
    expect(m.attempts).toHaveLength(1);
  });

  it('no failover when nothing else serves the tier', async () => {
    const r = rig({ behaviour: 'timeout' });
    const m0 = await r.runner.start({ ...TASK, folder: repo, policy: { autoRecover: true, exclusions: { sources: ['anthropic'] } } });
    await until(() => attemptOf(r.runner.get(m0.id), 1)?.state === 'running', 8000, 'the attempt to run');
    r.local.health = 'down';
    r.local.down.fire(LOCAL);
    await until(() => attemptOf(r.runner.get(m0.id), 1)?.state === 'failed', 8000, 'the attempt to fail');
    await new Promise((res) => setTimeout(res, 100));
    expect(r.runner.get(m0.id)!.attempts).toHaveLength(1);
    expect(r.runner.get(m0.id)!.tasks[0].state).toBe('needs-human');
  });
});
