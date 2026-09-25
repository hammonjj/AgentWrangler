import { describe, expect, it } from 'vitest';
import { HARD_MAX_TASKS, graphProblems, validateMission } from '../../src/orchestration/domain/invariants';
import { ulid } from '../../src/orchestration/domain/ids';
import { isOrchestrationOrigin } from '../../src/shared/orchestration/types';
import { T0, attempt, mission, task } from './fixtures';

describe('graphProblems', () => {
  it('accepts the A → B, A → C, B + C → D diamond', () => {
    const tasks = [
      task('a'),
      task('b', { dependsOn: [{ taskId: 'a', kind: 'code' }] }),
      task('c', { dependsOn: [{ taskId: 'a', kind: 'code' }] }),
      task('d', { dependsOn: [{ taskId: 'b', kind: 'code' }, { taskId: 'c', kind: 'order' }] }),
    ];
    expect(graphProblems(tasks)).toEqual([]);
  });

  it('names a cycle, a self edge and a dangling edge', () => {
    const tasks = [
      task('a', { dependsOn: [{ taskId: 'c', kind: 'code' }] }),
      task('b', { dependsOn: [{ taskId: 'a', kind: 'code' }, { taskId: 'b', kind: 'order' }] }),
      task('c', { dependsOn: [{ taskId: 'b', kind: 'code' }, { taskId: 'zz', kind: 'code' }] }),
    ];
    const problems = graphProblems(tasks);
    expect(problems).toContain('b depends on itself');
    expect(problems).toContain('c depends on a task that does not exist');
    expect(problems.find((p) => p.startsWith('dependency cycle'))).toMatch(/a, b, c/);
  });
});

describe('validateMission', () => {
  it('a fresh single-task mission is valid', () => {
    expect(validateMission(mission())).toEqual([]);
  });

  it('caps tasks at the mission limit, never above the hard cap', () => {
    const many = Array.from({ length: HARD_MAX_TASKS + 1 }, (_, i) => task(`t${i}`));
    expect(validateMission(mission({ tasks: many, policy: { maxTasks: 99 } }))[0]).toMatch(/cap of 12/);
    expect(validateMission(mission({ tasks: many.slice(0, 4), policy: { maxTasks: 3 } }))[0]).toMatch(/cap of 3/);
  });

  it('flags two active attempts on one task, and orphan attempts', () => {
    const m = mission({ attempts: [attempt('a1', 't1', { state: 'running' }), attempt('a2', 't1', { state: 'launching' }), attempt('a3', 'nope')] });
    const problems = validateMission(m);
    expect(problems).toContain('task t1 has 2 active attempts');
    expect(problems).toContain('attempt a3 belongs to no task');
  });

  it('flags a task running ahead of its dependency and a done task with no result', () => {
    const m = mission({
      state: 'running',
      planApprovedAt: T0,
      tasks: [task('t1', { state: 'done' }), task('t2', { state: 'running', dependsOn: [{ taskId: 't3', kind: 'code' }] }), task('t3')],
    });
    const problems = validateMission(m);
    expect(problems).toContain('t1 is done with no accepted result');
    expect(problems).toContain('t2 is running before its dependencies are done');
  });

  it('flags a running multi-task mission with no approved plan', () => {
    expect(validateMission(mission({ state: 'running', tasks: [task('t1'), task('t2')] }))).toContain('mission is running without an approved plan');
  });
});

describe('ulid', () => {
  const zero = (n: number) => new Uint8Array(n);
  it('is 26 characters and sorts by time', () => {
    const a = ulid(T0, zero);
    const b = ulid(T0 + 1, zero);
    expect(a).toHaveLength(26);
    expect(a < b).toBe(true);
    expect(ulid(0, zero)).toBe('0'.repeat(26));
    expect(ulid(T0, (n) => new Uint8Array(n).fill(255)).slice(10)).toBe('Z'.repeat(16));
  });
});

describe('isOrchestrationOrigin', () => {
  it('recognises the registry tag and nothing else', () => {
    expect(isOrchestrationOrigin({ kind: 'orchestration', missionId: 'm', taskId: 't', attemptId: 'a' })).toBe(true);
    expect(isOrchestrationOrigin({ kind: 'orchestration', missionId: 'm' })).toBe(false);
    expect(isOrchestrationOrigin(undefined)).toBe(false);
  });
});
