import type { ExecutionAttempt, Mission, Task } from '../../src/shared/orchestration/types';

export const T0 = 1_790_000_000_000;

export function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    key: id,
    title: `Task ${id}`,
    objective: 'Synthetic objective',
    acceptanceCriteria: ['tests pass'],
    scope: { paths: ['src/**'], subsystems: [], confidence: 'medium' },
    dependsOn: [],
    verification: { stages: [] },
    revision: 1,
    state: 'pending',
    assessmentIds: [],
    attemptIds: [],
    escalations: [],
    createdBy: 'user',
    ...overrides,
  };
}

export function attempt(id: string, taskId: string, overrides: Partial<ExecutionAttempt> = {}): ExecutionAttempt {
  return {
    id,
    taskId,
    n: 1,
    assignment: { mode: 'fresh', sessionIds: [], harness: 'claude-code' },
    state: 'created',
    verification: [],
    flags: {},
    createdAt: T0,
    ...overrides,
  };
}

export function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: '01J0000000000000000000000A',
    v: 1,
    title: 'Synthetic mission',
    objective: 'Synthetic objective',
    repoRoot: '/Users/test/proj',
    base: { ref: 'main', commit: 'abc123' },
    integration: 'none',
    policy: {},
    policyChanges: [],
    state: 'draft',
    source: { kind: 'user', trusted: true },
    tasks: [task('t1')],
    assessments: [],
    decisions: [],
    attempts: [],
    worktrees: [],
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}
