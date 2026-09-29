import type { Assessed, ExecutionAttempt, Mission, Task, TaskAssessment } from '../../src/shared/orchestration/types';

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

/** An assessment as the assessor writes one (#37): every dimension, with how sure it is and who said so. */
export function assessment(id: string, taskId: string, overrides: Partial<TaskAssessment> = {}): TaskAssessment {
  const d = <T extends string>(value: T, from: TaskAssessment['kind']['from'] = 'model'): Assessed<T> => ({
    value,
    confidence: 'medium',
    from,
    evidence: `because ${value}`,
  });
  return {
    id,
    taskId,
    taskRevision: 1,
    inputsHash: 'asm-00000000',
    assessorVersion: 'asm-1',
    dimensions: {
      complexity: d('involved'),
      breadth: d('few-files'),
      risk: d('moderate'),
      ambiguity: d('clear'),
      verifiability: d('partial', 'rule'),
      contextLoad: d('small', 'rule'),
    },
    kind: d('feature'),
    domains: ['typescript'],
    requires: ['edit', 'shell'],
    confidence: 'medium',
    evidence: [],
    createdAt: T0,
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
