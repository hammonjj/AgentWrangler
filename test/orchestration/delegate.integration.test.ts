/**
 * Delegate (#82) end to end: real git in a temporary repository, the real
 * worktree manager and repo policy store, the real `Planner` and `Assessor`
 * over simulated structured completions, the real router over a synthetic
 * catalog, and attempts played by the simulated harness.
 *
 * What these hold to: the caller never chooses a task or a mission; the
 * planner's `single` becomes the one-task proposal `aw task` makes (assisted
 * route, its card), and `multiple` a planned mission in plan review, both
 * drawn in the delegating conversation; nothing runs before the user
 * approves; and the delegating conversation is never the worker.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LaunchDefaults } from '../../src/core/launchDefaults';
import { SessionRegistry } from '../../src/core/session/sessionRegistry';
import { SimulatedCompletion } from '../../src/orchestration/completion/simulatedCompletion';
import { TaskRunner, mergeCriteria, type TaskRunnerDeps } from '../../src/orchestration/engine/taskRunner';
import { createSimulatedExecutors, SimulatedHarness } from '../../src/orchestration/harness/simulatedHarness';
import { Assessor } from '../../src/orchestration/policy/assessor';
import { Planner, type PlannedTask, type PlannerOutput } from '../../src/orchestration/policy/planner';
import { RepoPolicyStore, identityFor, worktreeRootPath } from '../../src/orchestration/policy/repoPolicyStore';
import { MissionStore } from '../../src/orchestration/store/missionStore';
import { delegationOutcome, delegationViewOf, isOpenDelegation, isOpenProposal, proposalViewOf } from '../../src/orchestration/view/proposalView';
import { WorktreeManager, canonicalPath } from '../../src/orchestration/worktrees/worktreeManager';
import type { SimCompletionResponse, SimScenario } from '../../src/shared/orchestration/simulation';
import type { PlanRecord, TelemetryRecord } from '../../src/shared/orchestration/telemetry';
import { isOrchestrationOrigin, type Mission } from '../../src/shared/orchestration/types';
import { catalog, snapshot } from './routingFixtures';

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
  tmp = canonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-delegate-')));
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

/** The assessor's answer: routine and clear, so the router proposes a standard model at medium. */
const ANSWER = {
  complexity: { value: 'routine', confidence: 'high', evidence: 'one constant' },
  breadth: { value: 'single-file', confidence: 'high', evidence: 'one file' },
  risk: { value: 'low', confidence: 'high', evidence: 'nothing depends on it' },
  ambiguity: { value: 'clear', confidence: 'high', evidence: 'the criterion is testable' },
  verifiability: { value: 'strong', confidence: 'high', evidence: 'a check covers it' },
  kind: { value: 'feature', confidence: 'high', evidence: 'it adds a constant' },
  domains: ['typescript'],
  requires: ['edit'],
};

/** A conversation that delegates. Synthetic. */
const ORIGIN = { provider: 'claude', sessionId: 'origin-0001-synthetic' } as const;

interface Rig {
  runner: TaskRunner;
  harness: SimulatedHarness;
  scenario: SimScenario;
  planner: SimulatedCompletion;
  registry: SessionRegistry;
  telemetry: TelemetryRecord[];
  notices: { title: string; body: string; onClick?: () => void }[];
  shown: unknown[];
}

function rig(plans: SimCompletionResponse[], overrides: Partial<TaskRunnerDeps> = {}): Rig {
  const registry = new SessionRegistry(memento());
  const executors = createSimulatedExecutors({ registry });
  const scenario: SimScenario = { default: { behaviour: 'edit', files: { 'src/a.ts': 'export const a = 1;\n' } }, tasks: {} };
  const harness = new SimulatedHarness({ scenario, sessions: executors.sessions });
  const planner = new SimulatedCompletion(plans);
  const telemetry: TelemetryRecord[] = [];
  const notices: Rig['notices'] = [];
  const shown: unknown[] = [];
  const runner = new TaskRunner({
    store: new MissionStore(path.join(dataDir, 'orchestration', 'missions')),
    harnesses: new Map([['claude-code', harness]]),
    sessions: executors.sessions,
    registry,
    repoPolicies: new RepoPolicyStore(path.join(dataDir, 'repos')),
    openWorktrees: (loaded, record) => WorktreeManager.open({ repoRoot: loaded.repo.primaryRoot, root: worktreeRootPath(loaded), setup: [] }, { record }),
    launchDefaults: new LaunchDefaults({ get: <T>(_k: string, f: T) => f }),
    planner: new Planner({ completion: planner }),
    assessor: new Assessor({ completion: new SimulatedCompletion([{ output: ANSWER }, { output: ANSWER }, { output: ANSWER }]) }),
    routing: { snapshot: () => snapshot({ catalog: catalog({ openai: false }) }) },
    telemetry: { append: (r) => (telemetry.push(r), true) },
    notify: (n) => notices.push(n),
    showOrigin: (o) => shown.push(o),
    diffsDir: path.join(dataDir, 'orchestration', 'diffs'),
    logsDir: path.join(dataDir, 'orchestration', 'logs'),
    settleMs: 30,
    previewDelayMs: 10,
    ...overrides,
  });
  runners.push(runner);
  return { runner, harness, scenario, planner, registry, telemetry, notices, shown };
}

function planned(key: string, over: Partial<PlannedTask> = {}): PlannedTask {
  return {
    key,
    title: `Synthetic ${key}`,
    objective: `Synthetic objective for ${key}.`,
    acceptanceCriteria: [`${key} is done`],
    scope: { paths: [`src/${key}/**`], subsystems: [key] },
    dependsOn: [],
    verification: ['check'],
    assessmentHints: { kind: 'feature', complexity: 'routine', risk: 'low' },
    whySeparate: '',
    ...over,
  };
}

function output(tasks: PlannedTask[]): PlannerOutput {
  return { decomposition: tasks.length > 1 ? 'multiple' : 'single', risks: tasks.length > 1 ? ['Synthetic risk.'] : [], tasks };
}

const DELEGATION = {
  objective: 'Synthetic outcome: add a constant.',
  acceptanceCriteria: ['The synthetic check passes'],
  origin: ORIGIN,
  policy: { preferences: { harness: 'claude-code' as const } },
};

const settled = (r: Rig, id: string) => () => {
  const m = r.runner.get(id);
  return !!m && delegationOutcome(m).decision !== 'planning';
};

describe('delegate: the planner decides single', () => {
  it('becomes the one-task proposal with an assisted route, on the delegating conversation’s card; nothing runs until it is started', async () => {
    const r = rig([{ output: output([planned('t1', { acceptanceCriteria: ['the synthetic check passes', 'a.ts exports a'] })]) }]);
    const d = await r.runner.delegate({ ...DELEGATION, folder: repo });
    expect(d).toMatchObject({ state: 'planning', planned: true, origin: ORIGIN, delegation: { acceptanceCriteria: ['The synthetic check passes'] } });
    expect(isOpenDelegation(d)).toBe(true);
    expect(delegationViewOf(d, { canPlan: true })).toMatchObject({ state: 'planning', tasks: [], canApprove: false });
    // The planner was told the user's criteria.
    await until(settled(r, d.id), 5000, 'the decision');
    expect(r.planner.calls[0].prompt).toContain('<acceptance_criteria>\n- The synthetic check passes\n</acceptance_criteria>');

    const m = r.runner.get(d.id)!;
    expect(m).toMatchObject({ state: 'draft', planned: undefined, origin: ORIGIN, policy: { mode: 'assisted' } });
    expect(m.tasks).toHaveLength(1);
    // The user's criteria first, then the planner's that say something else; the planner's scope and kind.
    expect(m.tasks[0]).toMatchObject({ key: 't1', state: 'routed', createdBy: 'planner', acceptanceCriteria: ['The synthetic check passes', 'a.ts exports a'], scope: { paths: ['src/t1/**'] } });
    expect(m.tasks[0].recommendation).toMatchObject({ verdict: 'route', resolution: { target: { model: 'sonnet' } } });
    expect(m.planning![0]).toMatchObject({ state: 'proposed', decomposition: 'single', proposed: 1 });
    expect(isOpenProposal(m)).toBe(true);
    expect(isOpenDelegation(m)).toBe(false);
    expect(proposalViewOf(m, m.tasks[0].recommendation!, catalog({ openai: false }))).toMatchObject({ delegated: true, verdict: 'route' });
    expect(delegationOutcome(m)).toMatchObject({ decision: 'single', verdict: 'route', route: expect.stringContaining('Sonnet') });
    const plans = r.telemetry.filter((x): x is PlanRecord => x.type === 'plan');
    expect(plans).toEqual([expect.objectContaining({ outcome: 'proposed', decomposition: 'single', tasks: 1 })]);

    // Nothing ran: no attempt, no worktree, no session.
    expect(r.harness.launches).toEqual([]);
    expect(m.attempts).toEqual([]);
    expect(m.worktrees).toEqual([]);
    // The notification's click brings up the delegating conversation.
    const notice = r.notices.find((n) => n.title.startsWith('Delegated:'))!;
    expect(notice.body).toMatch(/One task, proposed on sonnet/);
    notice.onClick?.();
    expect(r.shown).toEqual([ORIGIN]);

    // Approve (one click on the card): it runs in its own worktree and session, never the origin's.
    await r.runner.startProposed(d.id);
    const started = r.runner.get(d.id)!;
    expect(started.decisions[0]).toMatchObject({ mode: 'assisted', decidedBy: 'router', agreement: 'accepted' });
    expect(r.harness.launches).toHaveLength(1);
    const worker = started.attempts[0].assignment.sessionIds[0];
    expect(worker).not.toBe(ORIGIN.sessionId);
    expect(isOrchestrationOrigin(r.registry.get(worker)?.origin)).toBe(true);
    expect(started.worktrees[0].path).not.toBe(repo);
    expect(started.origin).toEqual(ORIGIN);
    expect(isOpenProposal(started)).toBe(false);
  });

  it('with no planner, it is one task straight away', async () => {
    const r = rig([], { planner: undefined });
    const m = await r.runner.delegate({ ...DELEGATION, folder: repo });
    expect(m).toMatchObject({ state: 'draft', origin: ORIGIN, delegation: { acceptanceCriteria: ['The synthetic check passes'] } });
    expect(m.planned).toBeUndefined();
    expect(m.tasks[0]).toMatchObject({ state: 'routed', acceptanceCriteria: ['The synthetic check passes'] });
    expect(isOpenProposal(m)).toBe(true);
    expect(r.harness.launches).toEqual([]);
  });
});

describe('delegate: the planner decides multiple', () => {
  it('stays a planned mission, shown as a plan to review on the delegating conversation’s card; nothing runs before approval', async () => {
    const two = output([
      planned('t1', { whySeparate: 't1 is its own subsystem with its own check' }),
      planned('t2', { dependsOn: [{ key: 't1', kind: 'code' }], whySeparate: 't2 is its own subsystem with its own check' }),
    ]);
    const r = rig([{ output: two }]);
    const d = await r.runner.delegate({ ...DELEGATION, folder: repo });
    await until(settled(r, d.id), 5000, 'the decision');

    const m = r.runner.get(d.id)!;
    expect(m).toMatchObject({ state: 'plan-review', planned: true, origin: ORIGIN, policy: { mode: 'manual' } });
    expect(isOpenDelegation(m)).toBe(true);
    expect(isOpenProposal(m)).toBe(false);
    expect(delegationOutcome(m)).toEqual({ decision: 'multiple', tasks: [{ key: 't1', title: 'Synthetic t1' }, { key: 't2', title: 'Synthetic t2' }] });
    const view = delegationViewOf(m, { canPlan: true, route: 'Synthetic model · low (Claude Code)' });
    expect(view).toMatchObject({
      state: 'review',
      acceptanceCriteria: ['The synthetic check passes'],
      risks: ['Synthetic risk.'],
      blockers: [],
      canApprove: true,
      canPlanAgain: true,
      canRunAsTask: false,
      route: 'Synthetic model · low (Claude Code)',
    });
    expect(view.tasks.map((t) => [t.key, t.after])).toEqual([['t1', []], ['t2', ['t1']]]);
    expect(r.notices.find((n) => n.title.startsWith('Delegated:'))?.body).toMatch(/A plan of 2 tasks to review/);
    expect(r.harness.launches).toEqual([]);
    expect(m.worktrees).toEqual([]);
    // Approval is the only way in.
    await expect(r.runner.startProposed(d.id)).rejects.toThrow(/no proposal waiting/);

    for (const t of m.tasks) r.scenario.tasks![t.id] = [{ behaviour: 'edit', files: { [`src/${t.key}/a.ts`]: `export const ${t.key} = 1;\n` } }];
    await r.runner.approvePlan(d.id, { harness: 'claude-code', model: 'claude-simulated', effort: 'low' });
    const running = r.runner.get(d.id)!;
    expect(isOpenDelegation(running)).toBe(false);
    await until(() => r.harness.launches.length > 0, 10_000, 'the first task to start');
    expect(running.attempts.concat(r.runner.get(d.id)!.attempts).every((a) => !a.assignment.sessionIds.includes(ORIGIN.sessionId))).toBe(true);
    await until(() => r.runner.get(d.id)?.state === 'review', 20_000, 'the mission to finish');
    expect(r.harness.launches).toHaveLength(2);
  });

  it('a delegation that cannot be planned can be run as the one task it was given as; still nothing runs until it is started', async () => {
    const cyclic = output([planned('t1', { dependsOn: [{ key: 't2', kind: 'code' }], whySeparate: 'x' }), planned('t2', { dependsOn: [{ key: 't1', kind: 'code' }], whySeparate: 'x' })]);
    const r = rig([{ output: cyclic }, { output: cyclic }]);
    const d = await r.runner.delegate({ ...DELEGATION, folder: repo });
    await until(settled(r, d.id), 5000, 'the decision');
    let m = r.runner.get(d.id)!;
    expect(m.state).toBe('planning-failed');
    expect(delegationOutcome(m)).toMatchObject({ decision: 'failed', note: expect.stringMatching(/cycle/) });
    expect(delegationViewOf(m, { canPlan: true })).toMatchObject({ state: 'failed', canRunAsTask: true, canPlanAgain: true, canApprove: false });

    await r.runner.delegateAsTask(d.id);
    m = r.runner.get(d.id)!;
    expect(m).toMatchObject({ state: 'draft', planned: undefined, policy: { mode: 'assisted' } });
    expect(m.tasks[0]).toMatchObject({ key: 't1', objective: 'Synthetic outcome: add a constant.', acceptanceCriteria: ['The synthetic check passes'], state: 'routed' });
    expect(isOpenProposal(m)).toBe(true);
    expect(r.harness.launches).toEqual([]);
    await expect(r.runner.delegateAsTask(d.id)).rejects.toThrow(/could not be planned/);
  });
});

describe('what delegation leaves alone', () => {
  it('a mission planned by hand from the Missions view stays a plan, even of one task', async () => {
    const r = rig([{ output: output([planned('t1')]) }]);
    const m = await r.runner.planMission({ folder: repo, objective: 'Synthetic mission objective.' });
    await until(() => r.runner.get(m.id)?.state === 'plan-review', 5000, 'the plan');
    const cur: Mission = r.runner.get(m.id)!;
    expect(cur.planned).toBe(true);
    expect(cur.delegation).toBeUndefined();
    expect(isOpenDelegation(cur)).toBe(false);
  });

  it('aw task still proposes one task directly, without the planner', async () => {
    const r = rig([]);
    const { mission } = await r.runner.propose({ ...DELEGATION, folder: repo });
    expect(mission.delegation).toBeUndefined();
    expect(r.planner.calls).toEqual([]);
    expect(isOpenProposal(mission)).toBe(true);
  });

  it('merges criteria case- and space-insensitively, the user’s first', () => {
    expect(mergeCriteria(['Tests pass', ' '], ['tests  pass', 'Docs updated'])).toEqual(['Tests pass', 'Docs updated']);
  });
});
