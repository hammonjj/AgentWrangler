/**
 * The Missions view (#43): mission-level aggregates from attempts (§16.2),
 * the view records the host sends, the formatters, and the HTML the table
 * pane draws. Pure: no runner, no DOM.
 */
import { describe, expect, it } from 'vitest';
import { transitionMission } from '../../src/orchestration/domain/lifecycles';
import { taskFinalRecord } from '../../src/orchestration/engine/taskRunner';
import { missionMetrics, missionViewOf } from '../../src/orchestration/view/missionViews';
import { dependencyText, missionChips, modelDistributionText, taskRowFigures, type MissionsSnapshot } from '../../src/shared/orchestration/missionView';
import type { ExecutionAttempt, Mission, RoutingDecision, VerificationResult } from '../../src/shared/orchestration/types';
import { missionsHtml, newMissionsUiState } from '../../src/webview/dashboard/missions';
import { T0, assessment, attempt, mission, task } from './fixtures';

function decision(id: string, taskId: string, model: string, location: 'hosted' | 'local' = 'hosted'): RoutingDecision {
  return {
    id,
    taskId,
    attemptN: 1,
    mode: 'manual',
    policyVersion: 'manual',
    requirement: { minTier: 'standard', maxTier: 'standard', effort: 'high', needs: [], gates: [] },
    reasons: [],
    overrides: [],
    resolution: { target: { harness: 'claude-code', source: 'anthropic', model, tier: 'standard', effortNative: 'high', location }, candidates: [], catalogVersion: 'manual' },
    decidedBy: 'user',
    decidedAt: T0,
  };
}

const passed: VerificationResult[] = [{ strategy: 'command:check', state: 'finished', outcome: 'passed', startedAt: T0 }];
const failed: VerificationResult[] = [{ strategy: 'command:check', state: 'finished', outcome: 'failed', startedAt: T0, summary: 'check failed' }];
const stages = { stages: [{ strategy: 'command:check', required: true }] };

function a(id: string, taskId: string, o: Partial<ExecutionAttempt>): ExecutionAttempt {
  return attempt(id, taskId, { routingDecisionId: `d-${id}`, launchedAt: T0, ...o });
}

/** Three tasks: t1 done (after a failed first try), t2 running, t3 not started. */
function running(): Mission {
  return mission({
    state: 'running',
    planned: true,
    planApprovedAt: T0,
    integration: { branch: 'aw/m-abc123/mission', worktreeId: 'w1' },
    tasks: [
      task('t1', { state: 'done', attemptIds: ['a1', 'a2'], verification: stages, result: { branch: 'aw/m-abc123/mission', commit: 'c2', acceptedBy: 'verification' } }),
      task('t2', { state: 'running', attemptIds: ['a3'], verification: stages, dependsOn: [{ taskId: 't1', kind: 'code' }] }),
      task('t3', { dependsOn: [{ taskId: 't1', kind: 'order' }, { taskId: 't2', kind: 'code' }], escalations: [] }),
    ],
    decisions: [decision('d-a1', 't1', 'claude-sonnet-5'), decision('d-a2', 't1', 'claude-opus-5'), decision('d-a3', 't2', 'claude-sonnet-5')],
    attempts: [
      a('a1', 't1', { state: 'failed', endedAt: T0 + 60_000, verification: failed, usage: { costUsd: 0.1, costBasis: 'harness-estimate', turns: 1, inputTokens: 100, outputTokens: 50 } }),
      a('a2', 't1', { n: 2, state: 'succeeded', launchedAt: T0 + 60_000, endedAt: T0 + 120_000, verification: passed, git: { baseCommit: 'c1', headCommit: 'c2', commits: 2, filesChanged: 3, insertions: 10, deletions: 2 }, usage: { costUsd: 0.2, costBasis: 'harness-estimate', turns: 2, inputTokens: 200 } }),
      a('a3', 't2', { state: 'running', launchedAt: T0 + 120_000, assignment: { mode: 'fresh', sessionIds: ['s-3'], harness: 'claude-code' } }),
    ],
    worktrees: [{ id: 'w1', purpose: 'integration', path: '/Users/test/proj.aw/m-abc123/_integration', branch: 'aw/m-abc123/mission', baseCommit: 'c0', state: 'in-use', createdAt: T0 }],
  });
}

describe('mission-level aggregates (§16.2)', () => {
  it('counts tasks by state and sums cost and tokens over every attempt', () => {
    const m = missionMetrics(running());
    expect(m).toMatchObject({
      total: 3,
      done: 1,
      running: 1,
      pending: 1,
      waiting: 0,
      activeAgents: 1,
      attempts: 3,
      startedAt: T0,
      costUsd: 0.3,
      costBasis: 'harness-estimate',
      tokens: 350,
      escalations: 0,
      // A failure earlier, a pass since: mixed, not bad.
      health: 'mixed',
    });
    // Still running, so it has not ended.
    expect(m.endedAt).toBeUndefined();
    expect(m.models).toEqual([
      { label: 'Sonnet 5', count: 2 },
      { label: 'Opus 5', count: 1 },
    ]);
  });

  const health: { name: string; verdicts: (typeof passed)[]; want: string }[] = [
    { name: 'no checks yet', verdicts: [], want: 'none' },
    { name: 'every check passed', verdicts: [passed, passed], want: 'good' },
    { name: 'the latest failed', verdicts: [passed, failed], want: 'bad' },
    { name: 'a failure, then a pass', verdicts: [failed, passed], want: 'mixed' },
  ];
  for (const h of health) {
    it(`verification health: ${h.name}`, () => {
      const m = mission({
        tasks: [task('t1', { verification: stages, attemptIds: h.verdicts.map((_, i) => `x${i}`) })],
        attempts: h.verdicts.map((v, i) => a(`x${i}`, 't1', { n: i + 1, state: 'succeeded', verification: v, endedAt: T0 + i })),
      });
      expect(missionMetrics(m).health).toBe(h.want);
    });
  }

  it('says nothing about cost when no attempt reported one, never zero', () => {
    const m = mission({ tasks: [task('t1', { attemptIds: ['x'] })], attempts: [a('x', 't1', { state: 'succeeded', endedAt: T0 + 5 })] });
    const metrics = missionMetrics(m);
    expect(metrics.costUsd).toBeUndefined();
    expect(metrics.costBasis).toBe('none');
    expect(metrics.tokens).toBeUndefined();
    expect(metrics.endedAt).toBe(T0 + 5);
  });

  it('marks local models in the distribution', () => {
    const m = mission({ tasks: [task('t1', { attemptIds: ['x'] })], attempts: [a('x', 't1', {})], decisions: [decision('d-x', 't1', 'qwen', 'local')] });
    expect(modelDistributionText(missionMetrics(m).models)).toBe('local:qwen 1');
  });
});

describe('task-final records (§16.2)', () => {
  it('sums a done task’s attempts, says who accepted it and whether the first attempt passed', () => {
    const r = taskFinalRecord(running(), 't1', T0 + 1)!;
    expect(r).toMatchObject({
      type: 'task-final',
      id: 'task-final:t1',
      missionTasks: 3,
      outcome: 'done',
      acceptedBy: 'verification',
      attempts: 2,
      firstAttemptPass: false,
      cost: { usd: 0.3, basis: 'harness-estimate' },
      tokens: 350,
      elapsedMs: 120_000,
    });
    expect(JSON.stringify(r)).not.toContain('Synthetic');
  });

  it('is not written for a task that is still going, or one that never ran and was cancelled', () => {
    expect(taskFinalRecord(running(), 't2', T0)).toBeUndefined();
    const m = mission({ tasks: [task('t1', { state: 'cancelled' })] });
    expect(taskFinalRecord(m, 't1', T0)).toBeUndefined();
  });
});

describe('missionViewOf', () => {
  it('lists tasks in run order with their route, attempt, dependencies and the session to open', () => {
    const v = missionViewOf(running(), { actions: (id) => (id === 't2' ? ['show-session', 'cancel'] : []) });
    expect(v).toMatchObject({ planned: true, state: 'running', repo: 'proj', branch: 'aw/m-abc123/mission', canApprove: false, canCancel: true, issues: [] });
    expect(v.tasks.map((t) => t.key)).toEqual(['t1', 't2', 't3']);
    const [t1, t2, t3] = v.tasks;
    expect(t1).toMatchObject({ state: 'done', attempt: { n: 2, of: 2 }, route: { model: 'Opus 5' }, costUsd: 0.3, verification: { verdict: 'passed' }, editable: false });
    expect(t2).toMatchObject({ state: 'running', sessionKey: 'claude:s-3', actions: ['show-session', 'cancel'], deps: [{ key: 't1', kind: 'code' }] });
    expect(t2.endedAt).toBeUndefined();
    expect(t3.deps.map((d) => `${d.key}:${d.kind}`)).toEqual(['t1:order', 't2:code']);
    expect(t3.attempt).toBeUndefined();
  });

  it('in plan review: every task editable, the plan’s issues, and Approve only when it can start', () => {
    const m = mission({
      state: 'plan-review',
      planned: true,
      tasks: [task('t1', { acceptanceCriteria: [], assessmentIds: ['s1'], revision: 1 }), task('t2', { dependsOn: [{ taskId: 't1', kind: 'code' }] })],
      assessments: [assessment('s1', 't1')],
    });
    const v = missionViewOf(m, { actions: () => [] });
    expect(v.tasks.every((t) => t.editable)).toBe(true);
    expect(v.issues).toEqual([{ level: 'blocker', text: 't1 has no acceptance criteria', taskId: 't1' }]);
    expect(v.canApprove).toBe(false);
    expect(v.tasks[0].preview).toMatchObject({ summary: 'feature · involved · risk moderate', confidence: 'medium' });
    const fixed = missionViewOf({ ...m, tasks: [{ ...m.tasks[0], acceptanceCriteria: ['x'] }, m.tasks[1]] }, { actions: () => [] });
    expect(fixed.canApprove).toBe(true);
  });

  it('in review: the result adds up the done tasks, with the four finish buttons', () => {
    const m = { ...running(), state: 'review' as const };
    m.tasks = m.tasks.map((t) => (t.id === 't1' ? t : { ...t, state: 'skipped' as const }));
    const v = missionViewOf(m, { actions: () => [], finishDefault: 'pull-request' });
    expect(v.review).toEqual({ commits: 2, insertions: 10, deletions: 2, finishes: ['merge-local', 'pull-request', 'keep', 'discard'], recommended: 'pull-request' });
    expect(v.canCancel).toBe(false);
  });

  it('a single task started directly shows unchanged, as a one-task mission', () => {
    const m = mission({ state: 'running', tasks: [task('t1', { state: 'needs-human', attemptIds: ['x'] })], attempts: [a('x', 't1', { state: 'succeeded', endedAt: T0 + 1 })] });
    const v = missionViewOf(m, { actions: () => ['accept', 'retry', 'cancel'] });
    expect(v.planned).toBe(false);
    expect(v.tasks).toHaveLength(1);
    expect(v.tasks[0].actions).toEqual(['accept', 'retry', 'cancel']);
  });
});

describe('formatters', () => {
  it('the header chips: state, counts, agents, elapsed, cost, health, models', () => {
    const v = missionViewOf(running(), { actions: () => [] });
    const chips = missionChips(v, T0 + 5 * 60_000);
    expect(chips.map((c) => [c.kind, c.text])).toEqual([
      ['state', 'running'],
      ['counts', '1/3 done · 1 running'],
      ['agents', '1 agent'],
      ['elapsed', expect.stringMatching(/^5m/)],
      ['cost', '$0.30'],
      ['health', '●'],
      ['models', 'Sonnet 5 2 · Opus 5 1'],
    ]);
    expect(chips.find((c) => c.kind === 'cost')!.title).toMatch(/harness’s estimate/);
  });

  it('dependency lines and row figures', () => {
    expect(dependencyText([])).toBe('');
    expect(dependencyText([{ taskId: 'a', key: 't1', kind: 'code' }, { taskId: 'b', key: 't2', kind: 'order' }])).toBe('after t1, t2 (order)');
    const v = missionViewOf(running(), { actions: () => [] });
    expect(taskRowFigures(v.tasks[0], T0)).toMatch(/^2\/2 · Opus 5 · high · 2m/);
  });
});

describe('the Missions view HTML', () => {
  const snap = (missions: Mission[]): MissionsSnapshot => ({
    missions: missions.map((m) => missionViewOf(m, { actions: (id) => (id === 't2' ? ['show-session', 'cancel'] : []) })),
    tiers: ['basic', 'standard', 'expert'],
    harnesses: [{ id: 'claude-code', label: 'Claude Code' }],
  });

  it('shows the mission header and every task’s state, with no inline styles', () => {
    const html = missionsHtml(snap([running()]), newMissionsUiState(), T0 + 60_000);
    expect(html).toContain('Synthetic mission');
    expect(html).toContain('1/3 done · 1 running');
    for (const state of ['ts-done', 'ts-running', 'ts-pending']) expect(html).toContain(state);
    expect(html).toContain('after t1');
    expect(html).toContain('data-task-open');
    expect(html).not.toMatch(/style=/);
  });

  it('plan review draws Approve and start, disabled until the plan can start, and one editor at a time', () => {
    const m = mission({ state: 'plan-review', planned: true, tasks: [task('t1', { acceptanceCriteria: [] }), task('t2')] });
    const ui = newMissionsUiState();
    let html = missionsHtml(snap([m]), ui, T0);
    expect(html).toMatch(/data-mission-op="approve" disabled/);
    expect(html).toContain('t1 has no acceptance criteria');
    expect(html).not.toContain('class="peditor"');
    ui.editing = 't2';
    html = missionsHtml(snap([m]), ui, T0);
    expect(html.match(/class="peditor"/g)).toHaveLength(1);
    expect(html).toContain('data-dep="t1"');
    expect(html).toContain('data-cap="maxTier"');
    expect(html).toContain('<option value="expert">expert</option>');
  });

  it('a finished mission is folded until opened', () => {
    const done = mission({ state: 'completed', finish: 'keep', finishResult: { note: 'kept on aw/x/mission' } });
    const ui = newMissionsUiState();
    expect(missionsHtml(snap([done]), ui, T0)).toContain('mission m-completed shut');
    ui.expanded.add(done.id);
    expect(missionsHtml(snap([done]), ui, T0)).toContain('kept on aw/x/mission');
  });
});

describe('the planner in the Missions view (#44)', () => {
  const run = (over: Partial<NonNullable<Mission['planning']>[number]> = {}): NonNullable<Mission['planning']>[number] => ({
    id: 'run1',
    kind: 'plan',
    state: 'proposed',
    startedAt: T0,
    endedAt: T0 + 30_000,
    model: 'opus',
    effort: 'high',
    rounds: [{ n: 1, ok: false, problems: ['x'], model: 'opus', durationMs: 1, costUsd: 0.2 }, { n: 2, ok: true, problems: [], model: 'opus', durationMs: 1, costUsd: 0.1 }],
    proposed: 1,
    decomposition: 'single',
    risks: ['Synthetic risk.'],
    warnings: ['t1 and t2 may touch the same files'],
    editsInReview: 0,
    ...over,
  });
  const snapOf = (m: Mission, canPlan = true): MissionsSnapshot => ({
    missions: [missionViewOf(m, { actions: () => [], canPlan })],
    tiers: [],
    harnesses: [],
  });

  it('a proposal says who planned it, how, what it cost, and its risks and warnings; Plan again is offered', () => {
    const m = mission({ state: 'plan-review', planned: true, tasks: [task('t1')], planning: [run()] });
    const v = missionViewOf(m, { actions: () => [], canPlan: true });
    expect(v.planner).toMatchObject({ kind: 'plan', state: 'proposed', text: 'Planned by opus · 1 task · 2 rounds · $0.30', risks: ['Synthetic risk.'] });
    expect(v).toMatchObject({ canPlanAgain: true, canWritePlan: false, canReplan: false });
    const html = missionsHtml(snapOf(m), newMissionsUiState(), T0);
    expect(html).toContain('Planned by opus · 1 task · 2 rounds · $0.30');
    expect(html).toContain('Synthetic risk.');
    expect(html).toContain('may touch the same files');
    expect(html).toContain('data-mission-op="plan-again"');
    expect(html).not.toMatch(/style=/);
    // Without a planner running here, there is nothing to ask again.
    expect(missionViewOf(m, { actions: () => [] }).canPlanAgain).toBe(false);
  });

  it('a local planner is named by its model, not its path; the tooltip keeps the path (#99)', () => {
    const path = '/Users/test/Models/Qwen3.5-4B-MLX-4bit';
    const m = mission({ state: 'plan-review', planned: true, tasks: [task('t1')], planning: [run({ model: path, source: 'local:mlx' })] });
    const v = missionViewOf(m, { actions: () => [], canPlan: true });
    expect(v.planner?.text).toBe('Planned by Qwen3.5-4B-MLX-4bit (local) · 1 task · 2 rounds · $0.30');
    expect(v.planner?.title).toContain(path);
    const running = mission({ state: 'planning', planned: true, tasks: [task('t1')], planning: [run({ model: path, state: 'running', rounds: [], endedAt: undefined })] });
    expect(missionViewOf(running, { actions: () => [] }).planner?.text).toBe('Planning with Qwen3.5-4B-MLX-4bit…');
  });

  it('while planning, the stand-in task is not drawn; a failure offers Plan again and Write it myself', () => {
    const planning = mission({ state: 'planning', planned: true, tasks: [task('t1')], planning: [run({ state: 'running', rounds: [], endedAt: undefined })] });
    let html = missionsHtml(snapOf(planning), newMissionsUiState(), T0);
    expect(html).toContain('Planning with opus…');
    expect(html).toContain('The planner is reading the repository');
    expect(html).not.toContain('class="mtasks"');
    const failed = { ...planning, state: 'planning-failed' as const, planning: [run({ state: 'failed', reason: 'the plan was still not valid after one repair' })] };
    html = missionsHtml(snapOf(failed), newMissionsUiState(), T0);
    expect(html).toContain('Planning failed');
    expect(html).toContain('data-mission-op="plan-again"');
    expect(html).toContain('data-mission-op="write-plan"');
  });

  it('Replan is offered for a started mission with nothing running, and a replan shows its diff', () => {
    const m = mission({ state: 'running', planned: true, planApprovedAt: T0, tasks: [task('t1', { state: 'done' }), task('t2', { state: 'needs-human' })] });
    expect(missionViewOf(m, { actions: () => [], canPlan: true }).canReplan).toBe(true);
    expect(missionsHtml(snapOf(m), newMissionsUiState(), T0)).toContain('data-mission-op="replan"');
    const replanned = { ...m, state: 'plan-review' as const, planning: [run({ kind: 'replan', diff: { kept: ['t1'], setAside: ['t2'], removed: [], added: ['t3'] } })] };
    expect(missionViewOf(replanned, { actions: () => [], canPlan: true }).planner).toMatchObject({ text: expect.stringMatching(/^Replanned by opus · 1 new task/), diff: 'kept t1 · set aside t2 · added t3' });
  });
});

describe('the approval gate (§7.2)', () => {
  it('a planned mission never goes from draft to running, however few tasks it has', () => {
    const m = mission({ planned: true, tasks: [task('t1')] });
    expect(() => transitionMission(m, 'running', { now: T0 })).toThrow(/without a reviewed plan/);
    const review = transitionMission(m, 'plan-review', { now: T0 });
    expect(() => transitionMission(review, 'running', { now: T0 })).toThrow(/not been approved/);
    expect(transitionMission({ ...review, planApprovedAt: T0 }, 'running', { now: T0 }).state).toBe('running');
  });
});
