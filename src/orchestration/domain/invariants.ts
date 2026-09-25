/**
 * Whole-mission invariants (`docs/plans/intelligent-orchestration.md` §7.2,
 * §12.1): what must hold of a mission record no matter how it was reached.
 *
 * Pure. `validateMission` lists every violation rather than stopping at the
 * first, so plan review and the store can say everything that is wrong.
 */
import type { Mission, Task } from '../../shared/orchestration/types';
import { ACTIVE_ATTEMPT_STATES } from './lifecycles';

/** The hard cap on tasks per mission (§11.2); a mission's own `maxTasks` may only be lower. */
export const HARD_MAX_TASKS = 12;
export const DEFAULT_MAX_TASKS = 8;

/**
 * Problems with the dependency graph: dangling or self references, and every
 * cycle's members (Kahn's algorithm: whatever cannot be ordered is in or
 * behind a cycle).
 */
export function graphProblems(tasks: Pick<Task, 'id' | 'key' | 'dependsOn'>[]): string[] {
  const problems: string[] = [];
  const ids = new Set(tasks.map((t) => t.id));
  const indegree = new Map<string, number>(tasks.map((t) => [t.id, 0]));
  const downstream = new Map<string, string[]>(tasks.map((t) => [t.id, []]));
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (d.taskId === t.id) {
        problems.push(`${t.key} depends on itself`);
        continue;
      }
      if (!ids.has(d.taskId)) {
        problems.push(`${t.key} depends on a task that does not exist`);
        continue;
      }
      indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
      downstream.get(d.taskId)!.push(t.id);
    }
  }
  const queue = [...indegree].filter(([, n]) => n === 0).map(([id]) => id);
  let ordered = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    ordered++;
    for (const next of downstream.get(id) ?? []) {
      const n = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, n);
      if (n === 0) queue.push(next);
    }
  }
  if (ordered < tasks.length) {
    const stuck = tasks.filter((t) => (indegree.get(t.id) ?? 0) > 0).map((t) => t.key);
    problems.push(`dependency cycle among ${stuck.join(', ')}`);
  }
  return problems;
}

/** Every §7.2 invariant the mission breaks. Empty means valid. */
export function validateMission(mission: Mission): string[] {
  const problems: string[] = [];
  const cap = Math.min(mission.policy.maxTasks ?? DEFAULT_MAX_TASKS, HARD_MAX_TASKS);
  if (mission.tasks.length > cap) problems.push(`${mission.tasks.length} tasks, more than the cap of ${cap}`);

  const keys = new Set<string>();
  for (const t of mission.tasks) {
    if (keys.has(t.key)) problems.push(`task key ${t.key} is used twice`);
    keys.add(t.key);
  }
  problems.push(...graphProblems(mission.tasks));

  const tasks = new Map(mission.tasks.map((t) => [t.id, t]));
  const activeByTask = new Map<string, number>();
  for (const a of mission.attempts) {
    const task = tasks.get(a.taskId);
    if (!task) {
      problems.push(`attempt ${a.id} belongs to no task`);
      continue;
    }
    if (ACTIVE_ATTEMPT_STATES.includes(a.state) && a.state !== 'created') {
      activeByTask.set(a.taskId, (activeByTask.get(a.taskId) ?? 0) + 1);
    }
  }
  for (const [taskId, n] of activeByTask) {
    if (n > 1) problems.push(`task ${tasks.get(taskId)?.key} has ${n} active attempts`);
  }

  for (const t of mission.tasks) {
    if ((t.state === 'running' || t.state === 'ready') && !t.dependsOn.every((d) => tasks.get(d.taskId)?.state === 'done')) {
      problems.push(`${t.key} is ${t.state} before its dependencies are done`);
    }
    if (t.state === 'done' && !t.result) problems.push(`${t.key} is done with no accepted result`);
  }

  if ((mission.state === 'running' || mission.state === 'paused' || mission.state === 'finishing' || mission.state === 'review') &&
      mission.planApprovedAt === undefined && mission.tasks.length !== 1) {
    problems.push(`mission is ${mission.state} without an approved plan`);
  }
  if (mission.state === 'completed' && (mission.finish === undefined || mission.finish === 'discard')) {
    problems.push('mission is completed without a finish choice');
  }
  return problems;
}
