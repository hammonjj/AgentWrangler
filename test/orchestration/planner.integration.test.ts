/**
 * Planned-by-the-planner missions (#44, §11) end to end: real git in a
 * temporary repository, the real worktree manager and repo policy store, the
 * real `Planner` over a simulated structured completion, and attempts played
 * by the simulated harness through the real launch path.
 *
 * What these hold to: the planner is read-only and nothing runs before the
 * plan is approved; a plan it cannot get right in two rounds is
 * `planning-failed` with the reason; and a replan of a partly done mission
 * never takes a done task away.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LaunchDefaults } from '../../src/core/launchDefaults';
import { SessionRegistry } from '../../src/core/session/sessionRegistry';
import { SimulatedCompletion } from '../../src/orchestration/completion/simulatedCompletion';
import { TaskRunner, type TaskRunnerDeps } from '../../src/orchestration/engine/taskRunner';
import { createSimulatedExecutors, SimulatedHarness } from '../../src/orchestration/harness/simulatedHarness';
import { Planner, type PlannedTask, type PlannerOutput } from '../../src/orchestration/policy/planner';
import { RepoPolicyStore, identityFor, worktreeRootPath } from '../../src/orchestration/policy/repoPolicyStore';
import { MissionStore } from '../../src/orchestration/store/missionStore';
import { missionViewOf } from '../../src/orchestration/view/missionViews';
import { WorktreeManager, canonicalPath } from '../../src/orchestration/worktrees/worktreeManager';
import type { SimAttempt, SimCompletionResponse, SimScenario } from '../../src/shared/orchestration/simulation';
import type { PlanRecord, PlanReviewRecord, TelemetryRecord } from '../../src/shared/orchestration/telemetry';
import type { Mission, Task } from '../../src/shared/orchestration/types';

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
  tmp = canonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-planner-')));
  repo = path.join(tmp, 'proj');
  dataDir = path.join(tmp, 'data');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  // The repository's one check: fails when `check.flag` is there.
  fs.writeFileSync(path.join(repo, 'check.sh'), '#!/bin/sh\nif [ -f check.flag ]; then echo " FAIL  test/a.test.ts"; exit 1; fi\nexit 0\n', { mode: 0o755 });
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

interface Rig {
  runner: TaskRunner;
  harness: SimulatedHarness;
  scenario: SimScenario;
  completion: SimulatedCompletion;
  telemetry: TelemetryRecord[];
}

function rig(responses: SimCompletionResponse[], overrides: Partial<TaskRunnerDeps> = {}): Rig {
  const registry = new SessionRegistry(memento());
  const executors = createSimulatedExecutors({ registry });
  const scenario: SimScenario = { tasks: {} };
  const harness = new SimulatedHarness({ scenario, sessions: executors.sessions });
  const completion = new SimulatedCompletion(responses);
  const telemetry: TelemetryRecord[] = [];
  const runner = new TaskRunner({
    store: new MissionStore(path.join(dataDir, 'orchestration', 'missions')),
    harnesses: new Map([['claude-code', harness]]),
    sessions: executors.sessions,
    registry,
    repoPolicies: new RepoPolicyStore(path.join(dataDir, 'repos')),
    openWorktrees: (loaded, record) => WorktreeManager.open({ repoRoot: loaded.repo.primaryRoot, root: worktreeRootPath(loaded), setup: [] }, { record }),
    launchDefaults: new LaunchDefaults({ get: <T>(_k: string, f: T) => f }),
    planner: new Planner({ completion }),
    telemetry: { append: (r) => (telemetry.push(r), true) },
    diffsDir: path.join(dataDir, 'orchestration', 'diffs'),
    logsDir: path.join(dataDir, 'orchestration', 'logs'),
    settleMs: 30,
    previewDelayMs: 10,
    ...overrides,
  });
  runners.push(runner);
  return { runner, harness, scenario, completion, telemetry };
}

const ROUTE = { harness: 'claude-code', model: 'claude-simulated', effort: 'low' } as const;
const edit = (files: Record<string, string>): SimAttempt => ({ behaviour: 'edit', files });

function planned(key: string, over: Partial<PlannedTask> = {}): PlannedTask {
  return {
    key,
    title: `Synthetic ${key}`,
    objective: `Synthetic objective for ${key}.`,
    acceptanceCriteria: [`${key} is done`],
    scope: { paths: [`src/${key}/**`], subsystems: [key] },
    dependsOn: [],
    verification: ['check'],
    assessmentHints: { kind: 'feature', complexity: 'involved', risk: 'low' },
    whySeparate: `${key} is a separate subsystem with its own check`,
    ...over,
  };
}

function output(tasks: PlannedTask[]): PlannerOutput {
  return { decomposition: tasks.length > 1 ? 'multiple' : 'single', risks: tasks.length > 1 ? ['Synthetic risk.'] : [], tasks };
}

function byKey(m: Mission, key: string): Task {
  return m.tasks.find((t) => t.key === key)!;
}

const view = (r: Rig, id: string) => missionViewOf(r.runner.get(id)!, { actions: (taskId) => r.runner.actions(id, taskId), canPlan: true });

describe('planning a mission', () => {
  it('the planner proposes a plan into review; nothing runs before approval; its telemetry is counts only', async () => {
    const two = output([planned('t1'), planned('t2', { dependsOn: [{ key: 't1', kind: 'code' }], assessmentHints: { kind: 'test', complexity: 'routine', risk: 'low' } })]);
    const r = rig([{ output: two, costUsd: 0.3 }]);
    const m = await r.runner.planMission({ folder: repo, title: 'Planned mission', objective: 'Synthetic mission objective.' });
    expect(m.state).toBe('planning');
    expect(m.planning).toEqual([expect.objectContaining({ kind: 'plan', state: 'running', model: 'opus' })]);
    await until(() => r.runner.get(m.id)?.state === 'plan-review', 5000, 'the plan');

    const cur = r.runner.get(m.id)!;
    expect(cur.tasks.map((t) => [t.key, t.createdBy, t.kindHint, t.kindDefaulted, t.scope.paths, t.scope.subsystems])).toEqual([
      ['t1', 'planner', 'feature', undefined, ['src/t1/**'], ['t1']],
      ['t2', 'planner', 'test', undefined, ['src/t2/**'], ['t2']],
    ]);
    expect(byKey(cur, 't2').dependsOn).toEqual([{ taskId: byKey(cur, 't1').id, kind: 'code' }]);
    // Verification comes from the repository's policy, not from the planner.
    expect(byKey(cur, 't1').verification.stages.map((s) => s.strategy)).toContain('command:check');
    expect(cur.planning![0]).toMatchObject({ state: 'proposed', proposed: 2, decomposition: 'multiple', risks: ['Synthetic risk.'], editsInReview: 0 });
    // The planner read the base checkout, read-only.
    expect(r.completion.calls[0].options).toMatchObject({ cwd: repo, permissionMode: 'plan', tools: ['Read', 'Grep', 'Glob'] });
    // Nothing ran: no attempt, no worktree.
    expect(r.harness.launches).toEqual([]);
    expect(cur.worktrees).toEqual([]);
    expect(fs.existsSync(path.join(tmp, 'proj.aw'))).toBe(false);

    const v = view(r, m.id);
    expect(v).toMatchObject({ state: 'plan-review', canApprove: true, canPlanAgain: true, canWritePlan: false, canReplan: false });
    expect(v.planner).toMatchObject({ kind: 'plan', state: 'proposed', text: 'Planned by opus · 2 tasks · 1 round · $0.30', risks: ['Synthetic risk.'] });

    // Edits in review are counted: the signal of plan quality.
    await r.runner.editPlan(m.id, { kind: 'update', taskId: byKey(cur, 't2').id, fields: { title: 'Synthetic, renamed' } });
    expect(r.runner.get(m.id)!.planning![0].editsInReview).toBe(1);

    const plans = r.telemetry.filter((x): x is PlanRecord => x.type === 'plan');
    expect(plans).toEqual([expect.objectContaining({ kind: 'plan', outcome: 'proposed', rounds: 1, tasks: 2, problems: 0, cost: { usd: 0.3, basis: 'harness-estimate' } })]);
    expect(JSON.stringify(plans)).not.toMatch(/Synthetic/);

    r.scenario.tasks![byKey(cur, 't1').id] = [edit({ 'src/t1/a.ts': 'export const a = 1;\n' })];
    r.scenario.tasks![byKey(cur, 't2').id] = [edit({ 'src/t2/a.test.ts': 'test\n' })];
    await r.runner.approvePlan(m.id, ROUTE);
    const reviews = r.telemetry.filter((x): x is PlanReviewRecord => x.type === 'plan-review');
    expect(reviews).toEqual([expect.objectContaining({ proposedTasks: 2, approvedTasks: 2, edits: 1 })]);
    await until(() => r.runner.get(m.id)?.state === 'review', 20_000, 'the mission to finish');
    expect(r.harness.launches).toHaveLength(2);
  });

  it('a plan still invalid after one repair is planning-failed, with the reason; then write it yourself or plan again', async () => {
    const cyclic = output([planned('t1', { dependsOn: [{ key: 't2', kind: 'code' }] }), planned('t2', { dependsOn: [{ key: 't1', kind: 'code' }] })]);
    const r = rig([{ output: cyclic }, { output: cyclic }, { output: output([planned('t1', { whySeparate: '' })]) }]);
    const m = await r.runner.planMission({ folder: repo, objective: 'Synthetic mission objective.' });
    await until(() => r.runner.get(m.id)?.state === 'planning-failed', 5000, 'planning to fail');
    let cur = r.runner.get(m.id)!;
    expect(cur.stateReason).toMatch(/still not valid after one repair: dependency cycle: t1 → t2 → t1/);
    expect(cur.planning![0]).toMatchObject({ state: 'failed', rounds: [expect.objectContaining({ n: 1, ok: false }), expect.objectContaining({ n: 2, ok: false })] });
    // The stand-in task is still the objective alone; nothing ran.
    expect(cur.tasks.map((t) => t.objective)).toEqual(['Synthetic mission objective.']);
    expect(r.harness.launches).toEqual([]);
    expect(view(r, m.id)).toMatchObject({ canPlanAgain: true, canWritePlan: true, canApprove: false });
    await expect(r.runner.approvePlan(m.id, ROUTE)).rejects.toThrow(/not waiting for approval/);

    // Plan again: a new run, this time valid.
    await r.runner.planAgain(m.id, 'Synthetic: keep it to one task.');
    await until(() => r.runner.get(m.id)?.state === 'plan-review', 5000, 'the second plan');
    cur = r.runner.get(m.id)!;
    expect(cur.planning!.map((p) => p.state)).toEqual(['failed', 'proposed']);
    expect(cur.planning![1].note).toBe('Synthetic: keep it to one task.');
    expect(r.completion.calls[2].prompt).toContain('<user_note>\nSynthetic: keep it to one task.\n</user_note>');
    expect(cur.tasks).toHaveLength(1);
    expect(r.telemetry.filter((x): x is PlanRecord => x.type === 'plan').map((p) => p.outcome)).toEqual(['failed', 'proposed']);
  });

  it('write it yourself starts plan review from the objective', async () => {
    const r = rig([{ error: 'overloaded' }]);
    const m = await r.runner.planMission({ folder: repo, objective: 'Synthetic mission objective.' });
    await until(() => r.runner.get(m.id)?.state === 'planning-failed', 5000, 'planning to fail');
    expect(r.runner.get(m.id)!.stateReason).toMatch(/the planner could not answer: API Error: 529/);
    const written = await r.runner.writePlan(m.id);
    expect(written.state).toBe('plan-review');
    expect(written.tasks[0]).toMatchObject({ key: 't1', objective: 'Synthetic mission objective.', createdBy: 'user' });
  });

  it('cancelling while the planner reads cuts the call off; no plan arrives later', async () => {
    const r = rig([{ hang: true }]);
    const m = await r.runner.planMission({ folder: repo, objective: 'Synthetic mission objective.' });
    await until(() => r.completion.calls.length === 1, 5000, 'the planner call');
    await r.runner.cancel(m.id);
    await new Promise((res) => setTimeout(res, 50));
    const cur = r.runner.get(m.id)!;
    expect(cur.state).toBe('cancelled');
    expect(cur.planning![0]).toMatchObject({ state: 'cancelled' });
    expect(r.telemetry.filter((x): x is PlanRecord => x.type === 'plan').map((p) => p.outcome)).toEqual(['cancelled']);
  });

  it('a planner call cut off by a restart is asked again', async () => {
    const first = rig([{ hang: true }]);
    const m = await first.runner.planMission({ folder: repo, objective: 'Synthetic mission objective.' });
    await until(() => first.completion.calls.length === 1, 5000, 'the planner call');
    first.runner.dispose();
    const second = rig([{ output: output([planned('t1', { whySeparate: '' })]) }]);
    await second.runner.recover();
    await until(() => second.runner.get(m.id)?.state === 'plan-review', 5000, 'the plan after the restart');
    expect(second.runner.get(m.id)!.tasks.map((t) => t.createdBy)).toEqual(['planner']);
    expect(second.harness.launches).toEqual([]);
  });
});

describe('replanning a partly done mission (§11.4)', () => {
  it('keeps done tasks exactly, sets unfinished work aside on its own branch, and the new plan is reviewed before it runs', async () => {
    const plan = output([planned('t1'), planned('t2', { dependsOn: [{ key: 't1', kind: 'code' }] }), planned('t3', { dependsOn: [{ key: 't2', kind: 'order' }] })]);
    // The replan: one new task after the done one. `t1` is kept, so the planner names its own keys.
    const replanned = output([planned('n1', { dependsOn: [{ key: 't1', kind: 'code' }], whySeparate: '' })]);
    // No automatic retry (#41): t2's failure goes straight to the user, who replans.
    const r = rig([{ output: plan }, { output: replanned }], { escalationLimits: { qualityAttempts: 1 } });
    const m = await r.runner.planMission({ folder: repo, title: 'Replan mission', objective: 'Synthetic mission objective.' });
    await until(() => r.runner.get(m.id)?.state === 'plan-review', 5000, 'the plan');
    let cur = r.runner.get(m.id)!;
    r.scenario.tasks![byKey(cur, 't1').id] = [edit({ 'src/t1/a.ts': 'export const a = 1;\n' })];
    // t2 leaves the check failing: it waits for the user.
    r.scenario.tasks![byKey(cur, 't2').id] = [edit({ 'src/t2/b.ts': 'b\n', 'check.flag': 'x\n' })];
    await r.runner.approvePlan(m.id, ROUTE);
    await until(() => byKey(r.runner.get(m.id)!, 't2').state === 'needs-human', 20_000, 't2 to wait on the user');
    cur = r.runner.get(m.id)!;
    const t1Before = byKey(cur, 't1');
    expect(t1Before.state).toBe('done');
    expect(view(r, m.id).canReplan).toBe(true);
    const tree = cur.worktrees.find((w) => w.purpose === 'integration')!;

    await r.runner.replan(m.id, 'Synthetic: drop t3, fix t2 differently.');
    await until(() => r.runner.get(m.id)?.state === 'plan-review', 5000, 'the replan');
    cur = r.runner.get(m.id)!;

    // Done tasks are never replanned away: t1 is there, unchanged.
    expect(byKey(cur, 't1')).toEqual(t1Before);
    // t2 started and did not finish: skipped, its work kept on a branch of its own and off the mission branch.
    expect(byKey(cur, 't2')).toMatchObject({ state: 'skipped' });
    expect(fs.existsSync(path.join(tree.path, 'check.flag'))).toBe(false);
    expect(git(repo, 'branch', '--list', 'aw/*/t2*')).not.toBe('');
    // t3 never started: replaced. The new task depends on the done one, with a fresh key.
    expect(cur.tasks.map((t) => [t.key, t.state])).toEqual([
      ['t1', 'done'],
      ['t2', 'skipped'],
      ['t4', 'pending'],
    ]);
    expect(byKey(cur, 't4').dependsOn).toEqual([{ taskId: t1Before.id, kind: 'code' }]);
    expect(cur.planning![1]).toMatchObject({ kind: 'replan', state: 'proposed', diff: { kept: ['t1'], setAside: ['t2'], removed: ['t3'], added: ['t4'] } });
    expect(cur.planApprovedAt).toBeUndefined();
    expect(view(r, m.id).planner).toMatchObject({ kind: 'replan', diff: 'kept t1 · set aside t2 · replaced t3 · added t4' });

    // The replan saw the mission so far, in the mission's tree, and the note.
    const call = r.completion.calls[1];
    expect(call.options.cwd).toBe(tree.path);
    expect(call.prompt).toMatch(/<done_tasks>\nt1: Synthetic t1/);
    expect(call.prompt).toMatch(/<replaced_tasks>\nt2: Synthetic t2 \(needs-human\)/);
    expect(call.prompt).toMatch(/<dropped_tasks>\nt3: Synthetic t3/);
    expect(call.prompt).toContain('At most 6 tasks.');

    // Nothing ran for the new plan until it was approved.
    const launched = r.harness.launches.length;
    await new Promise((res) => setTimeout(res, 50));
    expect(r.harness.launches).toHaveLength(launched);
    // Plan review cannot touch the tasks that ran.
    await expect(r.runner.editPlan(m.id, { kind: 'delete', taskId: t1Before.id })).rejects.toThrow(/t1 has started/);

    r.scenario.tasks![byKey(cur, 't4').id] = [edit({ 'src/n1/c.ts': 'c\n' })];
    await r.runner.approvePlan(m.id, ROUTE);
    await until(() => r.runner.get(m.id)?.state === 'review', 20_000, 'the replanned mission to finish');
    cur = r.runner.get(m.id)!;
    expect(byKey(cur, 't1')).toEqual(t1Before);
    expect(byKey(cur, 't4').state).toBe('done');
    // t4 started from t1's result: the set-aside work never reached it.
    const a4 = cur.attempts.find((a) => a.id === byKey(cur, 't4').attemptIds[0])!;
    expect(a4.startCommit).toBe(t1Before.result!.commit);
  });

  it('is refused while an attempt is running, and for a mission not yet started', async () => {
    const r = rig([{ output: output([planned('t1', { whySeparate: '' })]) }]);
    const m = await r.runner.planMission({ folder: repo, objective: 'Synthetic mission objective.' });
    await until(() => r.runner.get(m.id)?.state === 'plan-review', 5000, 'the plan');
    await expect(r.runner.replan(m.id)).rejects.toThrow(/Only a planned mission that is running can be replanned/);
    r.scenario.tasks![r.runner.get(m.id)!.tasks[0].id] = [{ behaviour: 'timeout' }];
    await r.runner.approvePlan(m.id, ROUTE);
    await until(() => r.harness.launches.length === 1, 5000, 'the launch');
    await expect(r.runner.replan(m.id)).rejects.toThrow(/t1 is running; stop it/);
    expect(view(r, m.id).canReplan).toBe(false);
  });
});
