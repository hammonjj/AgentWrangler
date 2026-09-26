/**
 * The formatters and the view builder behind the row chips and the task strip
 * (#34). Pure: no runner, no store, no DOM.
 */
import { describe, expect, it } from 'vitest';
import {
  attemptLine,
  diffStatText,
  routeChipText,
  routeChipTitle,
  routeIsLoud,
  routeModeMarker,
  taskChipText,
  taskChips,
  taskStateLabel,
  taskSummaryLine,
  type TaskRouteView,
} from '../../src/shared/orchestration/taskView';
import { currentAttemptOf, sessionKeyFor, taskBadges, taskViewOf } from '../../src/orchestration/view/taskViews';
import type { Mission, RoutingDecision } from '../../src/shared/orchestration/types';
import { attempt, mission, task, T0 } from './fixtures';

const route = (o: Partial<TaskRouteView> = {}): TaskRouteView => ({
  harness: 'claude-code',
  model: 'Sonnet 5',
  effort: 'high',
  tier: 'standard',
  mode: 'manual',
  location: 'hosted',
  ...o,
});

/** A routing decision whose target is what actually ran. */
function decision(id: string, o: Partial<RoutingDecision['resolution']['target']> = {}, extra: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    id,
    taskId: 't1',
    attemptN: 1,
    mode: 'manual',
    policyVersion: '1',
    requirement: { minTier: 'standard', maxTier: 'standard', effort: 'high', needs: [], gates: [] },
    reasons: [],
    overrides: [],
    resolution: {
      target: {
        harness: 'claude-code',
        source: 'anthropic',
        model: 'claude-sonnet-5',
        tier: 'standard',
        effortNative: 'high',
        location: 'hosted',
        ...o,
      },
      candidates: [],
      catalogVersion: '1',
    },
    decidedBy: 'user',
    decidedAt: T0,
    ...extra,
  };
}

describe('route chips', () => {
  it('leads with the model, then the effort', () => {
    expect(routeChipText(route())).toBe('Sonnet 5 · high');
  });

  it('names the harness when no model was reported', () => {
    expect(routeChipText(route({ model: undefined }))).toBe('Claude Code · high');
    expect(routeChipText({ harness: 'codex', effort: 'low', mode: 'manual' })).toBe('Codex · low');
  });

  it('marks a local model as local', () => {
    expect(routeChipText(route({ model: 'qwen', effort: 'low', location: 'local' }))).toBe('local:qwen · low');
  });

  it('draws the expensive routes loudly and nothing else', () => {
    expect(routeIsLoud(route())).toBe(false);
    expect(routeIsLoud(route({ effort: 'max' }))).toBe(true);
    expect(routeIsLoud(route({ tier: 'expert' }))).toBe(true);
    expect(routeIsLoud(route({ tier: 'Expert' }))).toBe(true);
    expect(routeIsLoud(undefined)).toBe(false);
  });

  it('marks routed modes and leaves manual unmarked', () => {
    expect(routeModeMarker('manual')).toBeUndefined();
    expect(routeModeMarker('auto')).toBe('A');
    expect(routeModeMarker('assisted')).toBe('a');
  });

  it('keeps everything the chip left out in its tooltip', () => {
    const title = routeChipTitle(route({ tier: 'expert', mode: 'auto' }));
    expect(title).toContain('Claude Code');
    expect(title).toContain('expert tier');
    expect(title).toContain('high effort');
    expect(title).toContain('auto routing');
  });
});

describe('task chips', () => {
  it('says "Task" in a single-task mission and the key in a multi-task one', () => {
    expect(taskChipText({ taskKey: 't1' })).toBe('Task');
    expect(taskChipText({ taskKey: 't2', multiTask: true })).toBe('t2');
  });

  it('only shows the attempt count once there has been more than one', () => {
    expect(taskChipText({ taskKey: 't1', attempt: { n: 1, of: 1 } })).toBe('Task');
    expect(taskChipText({ taskKey: 't1', attempt: { n: 2, of: 3 } })).toBe('Task · 2/3');
  });

  it('is a task chip alone when nothing has been routed yet', () => {
    const chips = taskChips({ missionId: 'm', taskKey: 't1', title: 'Do it', state: 'running' });
    expect(chips.map((c) => c.kind)).toEqual(['task']);
  });

  it('appends the mode marker to the route chip and flags the loud ones', () => {
    const chips = taskChips({
      missionId: 'm',
      taskKey: 't1',
      title: 'Do it',
      state: 'running',
      route: route({ mode: 'auto', effort: 'max' }),
    });
    expect(chips[1].text).toBe('Sonnet 5 · max · A');
    expect(chips[1].emphasis).toBe(true);
  });
});

describe('lines and labels', () => {
  it('reads task states as English where the machine name would not do', () => {
    expect(taskStateLabel('needs-human')).toBe('needs you');
    expect(taskStateLabel('pending')).toBe('not started');
    expect(taskStateLabel('running')).toBe('running');
  });

  it('summarises an attempt on one line', () => {
    const line = attemptLine(
      { id: 'a', n: 2, state: 'succeeded', route: route(), startedAt: T0, endedAt: T0 + 240_000, tokens: 12_300, costUsd: 0.42 },
      3,
      T0,
    );
    expect(line).toBe('2/3 · Sonnet 5 · high · succeeded · 4m · 12k · $0.42');
  });

  it('times a running attempt against now, and says why a failure failed', () => {
    const line = attemptLine({ id: 'a', n: 1, state: 'failed', category: 'context', startedAt: T0 }, 1, T0 + 60_000);
    expect(line).toBe('1/1 · failed (context) · 1m');
  });

  it('never shows an unreported figure as a zero', () => {
    expect(attemptLine({ id: 'a', n: 1, state: 'running' }, 1, T0)).toBe('1/1 · running');
  });

  it('says when a branch has no changes yet rather than "0 files"', () => {
    expect(diffStatText(undefined)).toBeUndefined();
    expect(diffStatText({ filesChanged: 0, insertions: 0, deletions: 0, commits: 0 })).toBe('no changes yet');
    expect(diffStatText({ filesChanged: 1, insertions: 8, deletions: 2, commits: 1 })).toBe('1 file, +8 −2');
    expect(diffStatText({ filesChanged: 3, insertions: 81, deletions: 12, commits: 2 })).toBe('3 files, +81 −12');
  });
});

describe('sessionKeyFor', () => {
  it('keys a session the way the table does', () => {
    expect(sessionKeyFor('claude-code', 'abc')).toBe('claude:abc');
    expect(sessionKeyFor('codex', 'abc')).toBe('codex:abc');
  });

  it('has no key for an attempt that has not been given a session', () => {
    expect(sessionKeyFor('claude-code', undefined)).toBeUndefined();
    expect(sessionKeyFor('some-future-harness', 'abc')).toBeUndefined();
  });
});

/** A mission with two attempts, the second still running. */
function twoAttempts(): Mission {
  const a1 = attempt('a1', 't1', {
    n: 1,
    state: 'failed',
    outcome: { status: 'failed', category: 'quality-new' },
    routingDecisionId: 'd1',
    assignment: { mode: 'fresh', sessionIds: ['s1'], harness: 'claude-code' },
    worktreeId: 'w1',
    launchedAt: T0,
    endedAt: T0 + 60_000,
    usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.1, costBasis: 'price-table', turns: 2 },
  });
  const a2 = attempt('a2', 't1', {
    n: 2,
    state: 'running',
    routingDecisionId: 'd2',
    assignment: { mode: 'fresh', sessionIds: ['s2'], harness: 'claude-code' },
    worktreeId: 'w1',
    launchedAt: T0 + 120_000,
    git: { baseCommit: 'abc', commits: 1, filesChanged: 3, insertions: 81, deletions: 12 },
  });
  return mission({
    state: 'running',
    tasks: [task('t1', { title: 'Widen the gutter', state: 'running', attemptIds: ['a1', 'a2'] })],
    attempts: [a1, a2],
    decisions: [decision('d1'), decision('d2', { model: 'claude-opus-5', tier: 'expert' })],
    worktrees: [
      {
        id: 'w1',
        purpose: 'task',
        taskId: 't1',
        path: '/Users/test/proj-t1',
        branch: 'aw/t1-widen',
        baseCommit: 'abc',
        state: 'in-use',
        createdAt: T0,
      },
    ],
  });
}

describe('taskViewOf', () => {
  it('describes the current attempt, its worktree and its diff', () => {
    const v = taskViewOf(twoAttempts(), ['retry', 'cancel'])!;
    expect(v.title).toBe('Widen the gutter');
    expect(v.state).toBe('running');
    expect(v.attempt).toEqual({ n: 2, of: 2 });
    expect(v.branch).toBe('aw/t1-widen');
    expect(v.worktreePath).toBe('/Users/test/proj-t1');
    expect(v.diff).toEqual({ filesChanged: 3, insertions: 81, deletions: 12, commits: 1 });
    expect(v.actions).toEqual(['retry', 'cancel']);
  });

  it('shortens the model and takes the effort from the requirement', () => {
    const v = taskViewOf(twoAttempts(), [])!;
    expect(v.route).toMatchObject({ model: 'Opus 5', tier: 'expert', effort: 'high', harness: 'claude-code' });
    expect(routeIsLoud(v.route)).toBe(true);
  });

  it('lists every attempt in order, each with the session that opens it', () => {
    const v = taskViewOf(twoAttempts(), [])!;
    expect(v.attempts.map((a) => [a.n, a.sessionKey, a.current])).toEqual([
      [1, 'claude:s1', undefined],
      [2, 'claude:s2', true],
    ]);
    expect(v.attempts[0].outcome).toBe('failed');
    expect(v.attempts[0].category).toBe('quality-new');
    expect(v.attempts[0].tokens).toBe(1200);
    expect(v.attempts[0].costUsd).toBe(0.1);
  });

  it('has no route and no diff before anything has run', () => {
    const v = taskViewOf(mission(), [])!;
    expect(v.route).toBeUndefined();
    expect(v.attempt).toBeUndefined();
    expect(v.diff).toBeUndefined();
    expect(v.attempts).toEqual([]);
  });

  it('gives an attempt with no reported usage no figure at all', () => {
    const v = taskViewOf(twoAttempts(), [])!;
    expect(v.attempts[1].tokens).toBeUndefined();
    expect(v.attempts[1].costUsd).toBeUndefined();
  });

  it('summarises itself on one line', () => {
    const v = taskViewOf(twoAttempts(), [])!;
    expect(taskSummaryLine(v)).toBe('running · attempt 2/2 · Opus 5 · high · aw/t1-widen · 3 files, +81 −12');
  });
});

describe('taskBadges', () => {
  it('badges every session the task has used, not only the current one', () => {
    const badges = taskBadges([twoAttempts()]);
    expect([...badges.keys()].sort()).toEqual(['claude:s1', 'claude:s2']);
    expect(badges.get('claude:s1')!.attempt).toEqual({ n: 1, of: 2 });
    expect(badges.get('claude:s2')!.attempt).toEqual({ n: 2, of: 2 });
  });

  it('gives the later attempt the row when two attempts shared a session', () => {
    const m = twoAttempts();
    m.attempts[1].assignment.sessionIds = ['s1'];
    const badges = taskBadges([m]);
    expect(badges.get('claude:s1')!.attempt).toEqual({ n: 2, of: 2 });
  });

  it('follows a session whose id changed mid-life', () => {
    const m = twoAttempts();
    m.attempts[1].assignment.sessionIds = ['s2', 's2-after-clear'];
    const badges = taskBadges([m]);
    expect(badges.get('claude:s2-after-clear')!.attempt).toEqual({ n: 2, of: 2 });
    // The id it had before is still that attempt's, so an older row still says so.
    expect(badges.get('claude:s2')).toBeDefined();
  });

  it('badges nothing for a mission that has not launched anything', () => {
    expect(taskBadges([mission()]).size).toBe(0);
  });

  it('marks a multi-task mission so its chips name the task', () => {
    const m = twoAttempts();
    m.tasks.push(task('t2'));
    expect(taskBadges([m]).get('claude:s2')!.multiTask).toBe(true);
    expect(taskBadges([twoAttempts()]).get('claude:s2')!.multiTask).toBeUndefined();
  });
});

describe('currentAttemptOf', () => {
  it('is the task’s latest attempt', () => {
    expect(currentAttemptOf(twoAttempts())?.id).toBe('a2');
    expect(currentAttemptOf(mission())).toBeUndefined();
  });
});
