/**
 * The mission, task, attempt and worktree lifecycles
 * (`docs/plans/intelligent-orchestration.md` §7.4, §7.5), and the guarded
 * transitions that enforce §7.2's invariants.
 *
 * Pure. Each `transition*` function takes a record and returns a new one; the
 * caller persists it. The clock is passed in.
 */
import type {
  AttemptState,
  ExecutionAttempt,
  Millis,
  Mission,
  MissionState,
  Task,
  TaskState,
  WorktreeAssignment,
  WorktreeState,
} from '../../shared/orchestration/types';
import { IllegalTransition, Machine } from './machine';

// ---- Mission (§7.4) ----

export const MISSION_STATES: readonly MissionState[] = [
  'draft', 'planning', 'planning-failed', 'plan-review', 'running', 'paused', 'finishing', 'review', 'completed', 'failed', 'cancelled',
];

export const missionMachine = new Machine<MissionState>({
  entity: 'mission',
  states: MISSION_STATES,
  edges: {
    // A single task started directly goes from draft to running (no plan, no review).
    draft: ['planning', 'plan-review', 'running'],
    planning: ['plan-review', 'planning-failed'],
    'planning-failed': ['planning', 'plan-review'],
    'plan-review': ['running', 'planning'],
    running: ['paused', 'planning', 'finishing', 'failed'],
    paused: ['running'],
    // Mission-level verification failed: a task goes back (§13.3).
    finishing: ['review', 'running'],
    review: ['completed'],
  },
  terminal: ['completed', 'failed', 'cancelled'],
  fromAnyActive: ['cancelled'],
});

// ---- Task (§7.5) ----

export const TASK_STATES: readonly TaskState[] = [
  'pending', 'ready', 'blocked', 'assessing', 'routed', 'queued', 'running', 'verifying', 'integrating', 'done',
  'needs-human', 'failed', 'cancelled', 'skipped',
];

export const taskMachine = new Machine<TaskState>({
  entity: 'task',
  states: TASK_STATES,
  edges: {
    pending: ['ready', 'blocked'],
    blocked: ['pending', 'ready', 'queued'],
    ready: ['assessing'],
    assessing: ['routed'],
    routed: ['queued', 'needs-human'],
    queued: ['running', 'blocked'],
    running: ['verifying', 'queued', 'needs-human'],
    verifying: ['integrating', 'done', 'queued', 'needs-human'],
    integrating: ['done', 'queued', 'needs-human'],
    'needs-human': ['queued', 'done', 'failed'],
    // Only when an integrated upstream was rejected or reverted and the user confirmed a rerun.
    done: ['ready'],
  },
  terminal: ['failed', 'cancelled', 'skipped'],
  fromAnyActive: ['cancelled', 'skipped'],
});

// ---- Attempt (§7.5) ----

export const ATTEMPT_STATES: readonly AttemptState[] = [
  'created', 'launching', 'running', 'waiting-human', 'finishing', 'verifying', 'succeeded', 'failed', 'cancelled', 'interrupted',
];

/** An attempt in one of these holds (or is about to hold) a session. */
export const ACTIVE_ATTEMPT_STATES: readonly AttemptState[] = ['created', 'launching', 'running', 'waiting-human', 'finishing', 'verifying'];

const LIVE_ATTEMPT_ENDS: readonly AttemptState[] = ['failed', 'cancelled', 'interrupted'];

export const attemptMachine = new Machine<AttemptState>({
  entity: 'attempt',
  states: ATTEMPT_STATES,
  edges: {
    created: ['launching', 'cancelled'],
    launching: ['running', ...LIVE_ATTEMPT_ENDS],
    running: ['waiting-human', 'finishing', ...LIVE_ATTEMPT_ENDS],
    'waiting-human': ['running', ...LIVE_ATTEMPT_ENDS],
    finishing: ['verifying', ...LIVE_ATTEMPT_ENDS],
    // A verifier cut off by a core restart is run again (verifying → verifying).
    // Cancelling a mission stops its verifiers.
    verifying: ['verifying', 'succeeded', 'failed', 'cancelled'],
  },
  terminal: ['succeeded', 'failed', 'cancelled', 'interrupted'],
});

// ---- Worktree (§13) ----

export const WORKTREE_STATES: readonly WorktreeState[] = ['creating', 'ready', 'in-use', 'retained', 'removed', 'missing'];

export const worktreeMachine = new Machine<WorktreeState>({
  entity: 'worktree',
  states: WORKTREE_STATES,
  edges: {
    creating: ['ready', 'missing', 'removed'],
    ready: ['in-use', 'retained', 'removed', 'missing'],
    // Never removed while in use (§7.2): it has to be let go of first.
    'in-use': ['ready', 'retained', 'missing'],
    retained: ['in-use', 'removed', 'missing'],
    // Recreated from its branch (§23.3 step 5).
    missing: ['ready', 'removed'],
  },
  terminal: ['removed'],
});

// ---- Guarded transitions ----

export interface TransitionOptions {
  now: Millis;
  reason?: string;
}

/**
 * Move a mission, enforcing §7.2: `running` only after the user approved the
 * plan (or for a single task started directly), `completed` only after the
 * user chose how to finish.
 */
export function transitionMission(mission: Mission, to: MissionState, opts: TransitionOptions): Mission {
  missionMachine.check(mission.state, to);
  if (to === 'running' && mission.state === 'draft') {
    if (mission.tasks.length !== 1 || mission.plannerAttemptId !== undefined) {
      throw new IllegalTransition('mission', mission.state, to, 'only a single task may start without a reviewed plan');
    }
  }
  if (to === 'running' && mission.state === 'plan-review' && mission.planApprovedAt === undefined) {
    throw new IllegalTransition('mission', mission.state, to, 'the plan has not been approved');
  }
  if (to === 'finishing') {
    const open = mission.tasks.filter((t) => t.state !== 'done' && t.state !== 'skipped');
    if (open.length > 0) throw new IllegalTransition('mission', mission.state, to, `tasks not finished: ${open.map((t) => t.key).join(', ')}`);
  }
  if (to === 'completed' && (mission.finish === undefined || mission.finish === 'discard')) {
    throw new IllegalTransition('mission', mission.state, to, 'the user has not chosen merge, pull request or keep');
  }
  return { ...mission, state: to, stateReason: opts.reason, updatedAt: opts.now };
}

/** Whether every dependency of `task` lets it start (§12.3): `code` upstreams done (and so integrated), `order` upstreams done. */
export function dependenciesSatisfied(mission: Pick<Mission, 'tasks'>, task: Task): boolean {
  return task.dependsOn.every((d) => mission.tasks.find((t) => t.id === d.taskId)?.state === 'done');
}

/**
 * Move a task within its mission, enforcing §7.2: never `ready` or `running`
 * before its dependencies are done; `done` only with a passed verification
 * or an explicit user acceptance; back from `done` only when invalidated.
 */
export function transitionTask(mission: Pick<Mission, 'tasks'>, task: Task, to: TaskState, opts: TransitionOptions): Task {
  taskMachine.check(task.state, to);
  if ((to === 'ready' || to === 'running') && !dependenciesSatisfied(mission, task)) {
    throw new IllegalTransition('task', task.state, to, 'a dependency is not done');
  }
  if (to === 'done' && !task.result) {
    throw new IllegalTransition('task', task.state, to, 'no result accepted by verification or by the user');
  }
  if (task.state === 'done' && to === 'ready' && !task.invalidated) {
    throw new IllegalTransition('task', task.state, to, 'only an invalidated task goes back to ready');
  }
  return { ...task, state: to, stateReason: opts.reason };
}

/**
 * Move an attempt. Leaving `created` for `launching` requires that its task
 * has no other attempt holding a session (§7.2: at most one active attempt).
 */
export function transitionAttempt(
  mission: Pick<Mission, 'attempts'>,
  attempt: ExecutionAttempt,
  to: AttemptState,
  opts: TransitionOptions,
): ExecutionAttempt {
  attemptMachine.check(attempt.state, to);
  if (to === 'launching') {
    const other = mission.attempts.find(
      (a) => a.taskId === attempt.taskId && a.id !== attempt.id && ACTIVE_ATTEMPT_STATES.includes(a.state) && a.state !== 'created',
    );
    if (other) throw new IllegalTransition('attempt', attempt.state, to, `attempt ${other.id} of this task is still active`);
  }
  const ended = attemptMachine.isTerminal(to);
  return {
    ...attempt,
    state: to,
    stateReason: opts.reason,
    launchedAt: to === 'launching' ? opts.now : attempt.launchedAt,
    endedAt: ended ? opts.now : attempt.endedAt,
  };
}

export function transitionWorktree(worktree: WorktreeAssignment, to: WorktreeState, opts: TransitionOptions): WorktreeAssignment {
  worktreeMachine.check(worktree.state, to);
  return { ...worktree, state: to, removedAt: to === 'removed' ? opts.now : worktree.removedAt };
}
