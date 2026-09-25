import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_STATES,
  MISSION_STATES,
  TASK_STATES,
  WORKTREE_STATES,
  attemptMachine,
  missionMachine,
  taskMachine,
  transitionAttempt,
  transitionMission,
  transitionTask,
  transitionWorktree,
  worktreeMachine,
} from '../../src/orchestration/domain/lifecycles';
import { IllegalTransition, type Machine } from '../../src/orchestration/domain/machine';
import { T0, attempt, mission, task } from './fixtures';

const opts = { now: T0 + 1 };

/** The full allowed-edge set of a machine, as `from→to` strings. */
function edges<S extends string>(m: Machine<S>, states: readonly S[]): string[] {
  return states.flatMap((from) => m.next(from).map((to) => `${from}→${to}`)).sort();
}

/**
 * The tables are pinned edge for edge against plan §7.4/§7.5: anything not
 * listed is illegal, which is what "every illegal transition is rejected"
 * means once it is checked for every pair below.
 */
describe('transition tables', () => {
  it('mission (§7.4)', () => {
    const cancel = MISSION_STATES.filter((s) => !['completed', 'failed', 'cancelled'].includes(s)).map((s) => `${s}→cancelled`);
    expect(edges(missionMachine, MISSION_STATES)).toEqual(
      [
        'draft→planning', 'draft→plan-review', 'draft→running',
        'planning→plan-review', 'planning→planning-failed',
        'planning-failed→planning', 'planning-failed→plan-review',
        'plan-review→running', 'plan-review→planning',
        'running→paused', 'running→planning', 'running→finishing', 'running→failed',
        'paused→running',
        'finishing→review', 'finishing→running',
        'review→completed',
        ...cancel,
      ].sort(),
    );
  });

  it('task (§7.5)', () => {
    const active = TASK_STATES.filter((s) => !['failed', 'cancelled', 'skipped'].includes(s));
    expect(edges(taskMachine, TASK_STATES)).toEqual(
      [
        'pending→ready', 'pending→blocked',
        'blocked→pending', 'blocked→ready', 'blocked→queued',
        'ready→assessing', 'assessing→routed',
        'routed→queued', 'routed→needs-human',
        'queued→running', 'queued→blocked',
        'running→verifying', 'running→queued', 'running→needs-human',
        'verifying→integrating', 'verifying→done', 'verifying→queued', 'verifying→needs-human',
        'integrating→done', 'integrating→queued', 'integrating→needs-human',
        'needs-human→queued', 'needs-human→done', 'needs-human→failed',
        'done→ready',
        ...active.flatMap((s) => [`${s}→cancelled`, `${s}→skipped`]),
      ].sort(),
    );
  });

  it('attempt (§7.5)', () => {
    const ends = (s: string) => ['failed', 'cancelled', 'interrupted'].map((e) => `${s}→${e}`);
    expect(edges(attemptMachine, ATTEMPT_STATES)).toEqual(
      [
        'created→launching', 'created→cancelled',
        'launching→running', ...ends('launching'),
        'running→waiting-human', 'running→finishing', ...ends('running'),
        'waiting-human→running', ...ends('waiting-human'),
        'finishing→verifying', ...ends('finishing'),
        'verifying→verifying', 'verifying→succeeded', 'verifying→failed', 'verifying→cancelled',
      ].sort(),
    );
  });

  it('every state is either terminal or has a way out, in every machine', () => {
    const all: [Machine<string>, readonly string[]][] = [
      [missionMachine as Machine<string>, MISSION_STATES],
      [taskMachine as Machine<string>, TASK_STATES],
      [attemptMachine as Machine<string>, ATTEMPT_STATES],
      [worktreeMachine as Machine<string>, WORKTREE_STATES],
    ];
    for (const [m, states] of all) {
      for (const s of states) expect(m.isTerminal(s) || m.next(s).length > 0, `${m.spec.entity} ${s}`).toBe(true);
      for (const s of states.filter((x) => m.isTerminal(x))) expect(m.next(s)).toEqual([]);
    }
  });

  it('check() throws for every pair the table does not list', () => {
    let rejected = 0;
    for (const from of ATTEMPT_STATES) {
      for (const to of ATTEMPT_STATES) {
        if (attemptMachine.can(from, to)) continue;
        expect(() => attemptMachine.check(from, to)).toThrow(IllegalTransition);
        rejected++;
      }
    }
    expect(rejected).toBeGreaterThan(50);
  });

  it('an attempt is never reopened once it has ended', () => {
    for (const end of ['succeeded', 'failed', 'cancelled', 'interrupted'] as const) {
      for (const to of ATTEMPT_STATES) expect(attemptMachine.can(end, to)).toBe(false);
    }
  });

  it('a worktree in use cannot be removed', () => {
    expect(worktreeMachine.can('in-use', 'removed')).toBe(false);
  });
});

describe('mission guards (§7.2)', () => {
  it('a single task may start directly from draft', () => {
    const m = transitionMission(mission(), 'running', opts);
    expect(m.state).toBe('running');
    expect(m.updatedAt).toBe(T0 + 1);
  });

  it('several tasks may not start without a reviewed plan', () => {
    expect(() => transitionMission(mission({ tasks: [task('t1'), task('t2')] }), 'running', opts)).toThrow(/reviewed plan/);
  });

  it('plan review → running needs an approved plan', () => {
    const m = mission({ state: 'plan-review', tasks: [task('t1'), task('t2')] });
    expect(() => transitionMission(m, 'running', opts)).toThrow(/not been approved/);
    expect(transitionMission({ ...m, planApprovedAt: T0 }, 'running', opts).state).toBe('running');
  });

  it('finishing needs every task done or skipped', () => {
    const m = mission({ state: 'running', tasks: [task('t1', { state: 'done' }), task('t2', { state: 'running' })], planApprovedAt: T0 });
    expect(() => transitionMission(m, 'finishing', opts)).toThrow(/t2/);
  });

  it('completed needs a finish choice other than discard', () => {
    const m = mission({ state: 'review' });
    expect(() => transitionMission(m, 'completed', opts)).toThrow(/not chosen/);
    expect(() => transitionMission({ ...m, finish: 'discard' }, 'completed', opts)).toThrow(IllegalTransition);
    expect(transitionMission({ ...m, finish: 'merge-local' }, 'completed', opts).state).toBe('completed');
    expect(transitionMission({ ...m, finish: 'discard' }, 'cancelled', opts).state).toBe('cancelled');
  });

  it('nothing leaves a terminal mission', () => {
    expect(() => transitionMission(mission({ state: 'cancelled' }), 'running', opts)).toThrow(/terminal/);
  });
});

describe('task guards (§7.2)', () => {
  const up = task('t1', { state: 'running' });
  const down = task('t2', { state: 'pending', dependsOn: [{ taskId: 't1', kind: 'code' }] });

  it('never ready before its dependencies are done', () => {
    const m = mission({ tasks: [up, down] });
    expect(() => transitionTask(m, down, 'ready', opts)).toThrow(/dependency/);
    const done = { ...m, tasks: [{ ...up, state: 'done' as const }, down] };
    expect(transitionTask(done, down, 'ready', opts).state).toBe('ready');
  });

  it('never running before its dependencies are done', () => {
    const queued = { ...down, state: 'queued' as const };
    expect(() => transitionTask(mission({ tasks: [up, queued] }), queued, 'running', opts)).toThrow(/dependency/);
  });

  it('done only with an accepted result', () => {
    const t = task('t1', { state: 'verifying' });
    expect(() => transitionTask(mission({ tasks: [t] }), t, 'done', opts)).toThrow(/no result/);
    const accepted = { ...t, result: { branch: 'aw/x/t1', commit: 'def', acceptedBy: 'verification' as const } };
    expect(transitionTask(mission({ tasks: [accepted] }), accepted, 'done', opts).state).toBe('done');
  });

  it('back from done only when invalidated', () => {
    const t = task('t1', { state: 'done', result: { branch: 'b', commit: 'c', acceptedBy: 'user' } });
    expect(() => transitionTask(mission({ tasks: [t] }), t, 'ready', opts)).toThrow(/invalidated/);
    const inv = { ...t, invalidated: true };
    expect(transitionTask(mission({ tasks: [inv] }), inv, 'ready', opts).state).toBe('ready');
  });
});

describe('attempt guards (§7.2)', () => {
  it('at most one active attempt per task', () => {
    const running = attempt('a1', 't1', { state: 'running' });
    const next = attempt('a2', 't1', { n: 2 });
    expect(() => transitionAttempt(mission({ attempts: [running, next] }), next, 'launching', opts)).toThrow(/a1/);
    const ended = { ...running, state: 'interrupted' as const };
    const launched = transitionAttempt(mission({ attempts: [ended, next] }), next, 'launching', opts);
    expect(launched.state).toBe('launching');
    expect(launched.launchedAt).toBe(T0 + 1);
  });

  it('records when it ended', () => {
    const a = attempt('a1', 't1', { state: 'running' });
    expect(transitionAttempt(mission({ attempts: [a] }), a, 'interrupted', opts).endedAt).toBe(T0 + 1);
  });

  it('a verifier cut off by a restart runs again', () => {
    const a = attempt('a1', 't1', { state: 'verifying' });
    expect(transitionAttempt(mission({ attempts: [a] }), a, 'verifying', opts).state).toBe('verifying');
  });
});

describe('worktree transitions', () => {
  it('stamps the removal time', () => {
    const w = { id: 'w1', purpose: 'task' as const, path: '/Users/test/proj.aw/m/t1', branch: 'aw/m/t1', baseCommit: 'abc', state: 'ready' as const, createdAt: T0 };
    expect(transitionWorktree(w, 'removed', opts).removedAt).toBe(T0 + 1);
    expect(() => transitionWorktree({ ...w, state: 'in-use' }, 'removed', opts)).toThrow(IllegalTransition);
  });
});
