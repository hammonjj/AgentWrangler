/**
 * A mission's plan (#43): DAG validation on every edit (§12.1), §11.2's
 * checks, and plan review's edits — as tables. Pure: no runner, no git.
 */
import { describe, expect, it } from 'vitest';
import {
  applyPlanEdit,
  canApprove,
  cycleText,
  executionOrder,
  findCycle,
  graphIssues,
  nextTaskKey,
  planIssues,
  taskCap,
  tasksFromDraft,
  type PlanContext,
} from '../../src/orchestration/domain/plan';
import { DEFAULT_MAX_TASKS, HARD_MAX_TASKS, type PlanEdit } from '../../src/shared/orchestration/plan';
import type { DependencyKind, Mission, Task } from '../../src/shared/orchestration/types';
import { T0, mission, task } from './fixtures';

/** `dep('a')` is a `code` edge to task `a`. */
const dep = (taskId: string, kind: DependencyKind = 'code') => ({ taskId, kind });

function ctx(): PlanContext {
  let n = 0;
  return {
    newId: () => `new${++n}`,
    verification: (kind, criteria) => ({ stages: [{ strategy: 'diff-sanity', required: true }, ...(criteria > 0 ? [{ strategy: 'review', required: false }] : []), { strategy: `kind:${kind}`, required: false }] }),
    now: T0 + 1,
  };
}

/** A plan under review: `t1` → `t2` → `t3` by `code`, each with a criterion. */
function plan(overrides: Partial<Mission> = {}, tasks?: Task[]): Mission {
  return mission({
    state: 'plan-review',
    planned: true,
    tasks: tasks ?? [task('t1'), task('t2', { dependsOn: [dep('t1')] }), task('t3', { dependsOn: [dep('t2')] })],
    ...overrides,
  });
}

function keys(m: Mission): string[] {
  return m.tasks.map((t) => t.key);
}

function edit(m: Mission, e: PlanEdit) {
  return applyPlanEdit(m, e, ctx());
}

describe('findCycle', () => {
  const cases: { name: string; tasks: Task[]; cycle?: string[] }[] = [
    { name: 'no edges', tasks: [task('a'), task('b')] },
    { name: 'a chain', tasks: [task('a'), task('b', { dependsOn: [dep('a')] }), task('c', { dependsOn: [dep('b')] })] },
    {
      name: 'the diamond A → B, A → C, B + C → D',
      tasks: [task('a'), task('b', { dependsOn: [dep('a')] }), task('c', { dependsOn: [dep('a')] }), task('d', { dependsOn: [dep('b'), dep('c', 'order')] })],
    },
    { name: 'two tasks needing each other', tasks: [task('a', { dependsOn: [dep('b')] }), task('b', { dependsOn: [dep('a')] })], cycle: ['a', 'b', 'a'] },
    {
      name: 'a three-task loop, shown in run order',
      tasks: [task('t1', { dependsOn: [dep('t3')] }), task('t2', { dependsOn: [dep('t1')] }), task('t3', { dependsOn: [dep('t2', 'order')] })],
      cycle: ['t1', 't2', 't3', 't1'],
    },
    { name: 'a loop behind a valid head', tasks: [task('a'), task('b', { dependsOn: [dep('a'), dep('c')] }), task('c', { dependsOn: [dep('b')] })], cycle: ['b', 'c', 'b'] },
    { name: 'a self edge is not a cycle here (reported on its own)', tasks: [task('a', { dependsOn: [dep('a')] })] },
    { name: 'a dangling edge is not a cycle', tasks: [task('a', { dependsOn: [dep('zz')] })] },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(findCycle(c.tasks)).toEqual(c.cycle);
    });
  }

  it('is written as a path', () => {
    expect(cycleText(['t1', 't2', 't3', 't1'])).toBe('t1 → t2 → t3 → t1');
  });
});

describe('executionOrder', () => {
  const cases: { name: string; tasks: Task[]; order: string[] }[] = [
    { name: 'list order when nothing depends on anything', tasks: [task('c'), task('a'), task('b')], order: ['c', 'a', 'b'] },
    { name: 'a task moves below what it needs, nothing else moves', tasks: [task('b', { dependsOn: [dep('a')] }), task('x'), task('a')], order: ['x', 'a', 'b'] },
    {
      name: 'the diamond runs A, then B and C in list order, then D',
      tasks: [task('d', { dependsOn: [dep('b'), dep('c')] }), task('c', { dependsOn: [dep('a')] }), task('b', { dependsOn: [dep('a')] }), task('a')],
      order: ['a', 'c', 'b', 'd'],
    },
    { name: 'order edges order too', tasks: [task('b', { dependsOn: [dep('a', 'order')] }), task('a')], order: ['a', 'b'] },
    { name: 'leaves out what a cycle holds up', tasks: [task('a'), task('b', { dependsOn: [dep('c')] }), task('c', { dependsOn: [dep('b')] })], order: ['a'] },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(executionOrder(c.tasks).map((t) => t.id)).toEqual(c.order);
    });
  }
});

describe('graphIssues', () => {
  const cases: { name: string; tasks: Task[]; expect: string[] }[] = [
    { name: 'a valid chain', tasks: [task('a'), task('b', { dependsOn: [dep('a')] })], expect: [] },
    { name: 'a self edge', tasks: [task('a', { dependsOn: [dep('a')] })], expect: ['a depends on itself'] },
    { name: 'a dangling edge', tasks: [task('a', { dependsOn: [dep('gone')] })], expect: ['a depends on a task that does not exist'] },
    { name: 'the same edge twice', tasks: [task('a'), task('b', { dependsOn: [dep('a'), dep('a', 'order')] })], expect: ['b depends on a twice'] },
    { name: 'a duplicate key', tasks: [task('a', { key: 't1' }), task('b', { key: 't1' })], expect: ['task key t1 is used twice'] },
    {
      name: 'a done task after one that is not (§12.1)',
      tasks: [task('a'), task('b', { state: 'done', dependsOn: [dep('a')] })],
      expect: ['b is done but depends on a, which is not'],
    },
    { name: 'a cycle, with its path', tasks: [task('a', { dependsOn: [dep('b')] }), task('b', { dependsOn: [dep('a')] })], expect: ['dependency cycle: a → b → a'] },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const issues = graphIssues(c.tasks);
      expect(issues.map((i) => i.text)).toEqual(c.expect);
      expect(issues.every((i) => i.level === 'error')).toBe(true);
    });
  }
});

describe('task cap', () => {
  it('is 8 by default, the mission’s own when lower, and never above 12', () => {
    expect(DEFAULT_MAX_TASKS).toBe(8);
    expect(HARD_MAX_TASKS).toBe(12);
    expect(taskCap({})).toBe(8);
    expect(taskCap({ maxTasks: 3 })).toBe(3);
    expect(taskCap({ maxTasks: 12 })).toBe(12);
    expect(taskCap({ maxTasks: 99 })).toBe(12);
    expect(taskCap({ maxTasks: 0 })).toBe(8);
    expect(taskCap({ maxTasks: 2.5 })).toBe(8);
  });
});

describe('planIssues (§11.2)', () => {
  const cases: { name: string; m: Mission; levels: string[]; texts: RegExp[]; approvable: boolean }[] = [
    { name: 'a clean three-task chain', m: plan(), levels: [], texts: [], approvable: true },
    { name: 'no tasks', m: plan({}, []), levels: ['blocker'], texts: [/no tasks/], approvable: false },
    {
      name: 'a task with no acceptance criteria and no objective',
      m: plan({}, [task('t1', { acceptanceCriteria: [], objective: '  ' })]),
      levels: ['blocker', 'blocker'],
      texts: [/t1 has no objective/, /t1 has no acceptance criteria/],
      approvable: false,
    },
    {
      name: 'a scope path outside the repository',
      m: plan({}, [task('t1', { scope: { paths: ['../other/**', '/etc/x'], subsystems: [], confidence: 'medium' } })]),
      levels: ['blocker', 'blocker'],
      texts: [/\.\.\/other/, /\/etc\/x/],
      approvable: false,
    },
    {
      name: 'two unordered tasks whose scopes overlap: a warning, not a stop',
      m: plan({}, [task('t1', { scope: { paths: ['src/a/**'], subsystems: [], confidence: 'medium' } }), task('t2', { scope: { paths: ['src/a/b.ts'], subsystems: [], confidence: 'medium' } })]),
      levels: ['warning'],
      texts: [/t1 and t2 may touch the same files/],
      approvable: true,
    },
    {
      name: 'overlap between ordered tasks is fine',
      m: plan({}, [task('t1', { scope: { paths: ['src/**'], subsystems: [], confidence: 'medium' } }), task('t2', { dependsOn: [dep('t1', 'order')], scope: { paths: ['src/x.ts'], subsystems: [], confidence: 'medium' } })]),
      levels: [],
      texts: [],
      approvable: true,
    },
    {
      name: 'more tasks than the cap',
      m: plan({ policy: { maxTasks: 2 } }),
      levels: ['error'],
      texts: [/3 tasks, more than the cap of 2/],
      approvable: false,
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const issues = planIssues(c.m);
      expect(issues.map((i) => i.level)).toEqual(c.levels);
      c.texts.forEach((re, i) => expect(issues[i].text).toMatch(re));
      expect(canApprove(c.m)).toBe(c.approvable);
    });
  }
});

describe('tasksFromDraft: a hand-written plan', () => {
  it('keys the tasks t1… in order, resolves dependencies by key, and sorts them into run order', () => {
    const r = tasksFromDraft(
      [
        { title: 'Docs', objective: 'Document it', acceptanceCriteria: ['README says so'], dependsOn: [{ key: 't2', kind: 'order' }] },
        { title: 'Build', objective: 'Build it', acceptanceCriteria: ['tests pass'] },
      ],
      {},
      ctx(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tasks.map((t) => `${t.key}:${t.title}`)).toEqual(['t2:Build', 't1:Docs']);
    expect(r.tasks[1].dependsOn).toEqual([{ taskId: r.tasks[0].id, kind: 'order' }]);
    expect(r.tasks.every((t) => t.state === 'pending' && t.createdBy === 'user' && t.revision === 1)).toBe(true);
    // The checks come from the repository's policy (here, the test's), never from the draft.
    expect(r.tasks[0].verification.stages.map((s) => s.strategy)).toContain('kind:feature');
  });

  const refused: { name: string; drafts: Parameters<typeof tasksFromDraft>[0]; policy?: { maxTasks?: number }; problem: RegExp }[] = [
    {
      name: 'a cycle, shown as its path',
      drafts: [
        { title: 'A', objective: 'a', acceptanceCriteria: ['x'], dependsOn: [{ key: 't3', kind: 'code' }] },
        { title: 'B', objective: 'b', acceptanceCriteria: ['x'], dependsOn: [{ key: 't1', kind: 'code' }] },
        { title: 'C', objective: 'c', acceptanceCriteria: ['x'], dependsOn: [{ key: 't2', kind: 'code' }] },
      ],
      problem: /dependency cycle: t1 → t2 → t3 → t1/,
    },
    { name: 'a key that is not in the plan', drafts: [{ title: 'A', objective: 'a', acceptanceCriteria: ['x'], dependsOn: [{ key: 't9', kind: 'code' }] }], problem: /t1 depends on t9, which is not in the plan/ },
    { name: 'a task that needs itself', drafts: [{ title: 'A', objective: 'a', acceptanceCriteria: ['x'], dependsOn: [{ key: 't1', kind: 'order' }] }], problem: /t1 depends on itself/ },
    {
      name: 'more than the default cap of 8',
      drafts: Array.from({ length: 9 }, (_, i) => ({ title: `T${i}`, objective: 'o', acceptanceCriteria: ['x'] })),
      problem: /9 tasks, more than the cap of 8/,
    },
    {
      name: 'more than the hard cap of 12, whatever the policy says',
      drafts: Array.from({ length: 13 }, (_, i) => ({ title: `T${i}`, objective: 'o', acceptanceCriteria: ['x'] })),
      policy: { maxTasks: 50 },
      problem: /13 tasks, more than the cap of 12/,
    },
    { name: 'no tasks', drafts: [], problem: /no tasks/ },
  ];
  for (const c of refused) {
    it(`refuses ${c.name}`, () => {
      const r = tasksFromDraft(c.drafts, c.policy ?? {}, ctx());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problems.join('\n')).toMatch(c.problem);
    });
  }
});

describe('plan review edits', () => {
  it('nextTaskKey is one past the highest', () => {
    expect(nextTaskKey([{ key: 't1' }, { key: 't7' }, { key: 'x' }])).toBe('t8');
    expect(nextTaskKey([])).toBe('t1');
  });

  interface Row {
    name: string;
    m?: Mission;
    edit: PlanEdit;
    /** Keys in list order afterwards. */
    keys?: string[];
    check?: (m: Mission) => void;
    /** Refused, with this problem. */
    refused?: RegExp;
  }
  const rows: Row[] = [
    {
      name: 'add appends a new task with the next key',
      edit: { kind: 'add' },
      keys: ['t1', 't2', 't3', 't4'],
      check: (m) => expect(m.tasks[3]).toMatchObject({ title: 'New task', objective: '', acceptanceCriteria: [], state: 'pending', kindDefaulted: true }),
    },
    { name: 'add after a task puts it there', edit: { kind: 'add', after: 't1', fields: { title: 'Between' } }, keys: ['t1', 't4', 't2', 't3'] },
    {
      name: 'update changes the fields, trims the criteria and bumps the revision',
      edit: { kind: 'update', taskId: 't2', fields: { title: ' Renamed ', acceptanceCriteria: [' one ', '', 'two'], kind: 'refactor', scopePaths: ['src/**'] } },
      check: (m) => {
        const t = m.tasks.find((x) => x.id === 't2')!;
        expect(t).toMatchObject({ title: 'Renamed', acceptanceCriteria: ['one', 'two'], kindHint: 'refactor', revision: 2 });
        expect(t.kindDefaulted).toBeUndefined();
        expect(t.scope.paths).toEqual(['src/**']);
        expect(t.verification.stages.map((s) => s.strategy)).toContain('kind:refactor');
      },
    },
    {
      name: 'clearing the kind gives it back to the assessor',
      edit: { kind: 'update', taskId: 't1', fields: { kind: null } },
      check: (m) => expect(m.tasks[0]).toMatchObject({ kindHint: 'feature', kindDefaulted: true }),
    },
    {
      name: 'delete removes the task and every edge to it',
      edit: { kind: 'delete', taskId: 't2' },
      keys: ['t1', 't3'],
      check: (m) => expect(m.tasks.find((t) => t.id === 't3')!.dependsOn).toEqual([]),
    },
    {
      name: 'merge folds one task into another, joining work and moving edges',
      edit: { kind: 'merge', taskId: 't3', into: 't2' },
      keys: ['t1', 't2'],
      check: (m) => {
        const t = m.tasks.find((x) => x.id === 't2')!;
        expect(t.objective).toBe('Synthetic objective\n\nSynthetic objective');
        expect(t.acceptanceCriteria).toEqual(['tests pass']);
        expect(t.dependsOn).toEqual([dep('t1')]);
      },
    },
    {
      name: 'merging two ends of a chain around a middle task is refused as a cycle',
      edit: { kind: 'merge', taskId: 't3', into: 't1' },
      refused: /dependency cycle: t1 → t2 → t1/,
    },
    {
      name: 'split makes a second part that needs the first and takes its downstream',
      m: plan({}, [task('t1', { acceptanceCriteria: ['a', 'b', 'c'] }), task('t2', { dependsOn: [dep('t1')] })]),
      edit: { kind: 'split', taskId: 't1' },
      keys: ['t1', 't3', 't2'],
      check: (m) => {
        const [first, second, down] = m.tasks;
        expect(first.acceptanceCriteria).toEqual(['a', 'b']);
        expect(second).toMatchObject({ title: 'Task t1 (part 2)', acceptanceCriteria: ['c'], dependsOn: [dep('t1')] });
        expect(down.dependsOn).toEqual([dep(second.id)]);
      },
    },
    { name: 'move up within the order is kept', m: plan({}, [task('t1'), task('t2'), task('t3')]), edit: { kind: 'move', taskId: 't3', to: 0 }, keys: ['t3', 't1', 't2'] },
    { name: 'move above something it needs is refused', edit: { kind: 'move', taskId: 't3', to: 0 }, refused: /t3 needs t2, so it cannot run before it/ },
    {
      name: 'depend adds an edge and moves the task below what it now needs',
      m: plan({}, [task('t1'), task('t2'), task('t3')]),
      edit: { kind: 'depend', taskId: 't1', on: 't3', dep: 'order' },
      keys: ['t2', 't3', 't1'],
      check: (m) => expect(m.tasks[2].dependsOn).toEqual([dep('t3', 'order')]),
    },
    { name: 'depend closing a loop is refused with the cycle shown', edit: { kind: 'depend', taskId: 't1', on: 't3', dep: 'code' }, refused: /dependency cycle: t1 → t2 → t3 → t1/ },
    { name: 'depend on itself is refused', edit: { kind: 'depend', taskId: 't1', on: 't1', dep: 'code' }, refused: /t1 cannot depend on itself/ },
    {
      name: 'depend none removes the edge',
      edit: { kind: 'depend', taskId: 't2', on: 't1', dep: 'none' },
      check: (m) => expect(m.tasks.find((t) => t.id === 't2')!.dependsOn).toEqual([]),
    },
    {
      name: 'overrides set pins and caps, and an empty value clears one',
      m: plan({}, [task('t1', { overrides: { pins: { model: 'old' } } })]),
      edit: { kind: 'overrides', taskId: 't1', overrides: { pins: { harness: 'codex', model: '', effort: 'high' }, caps: { maxTier: 'standard', maxEffort: 'bogus' as never } } },
      check: (m) => {
        expect(m.tasks[0].overrides).toEqual({ pins: { harness: 'codex', effort: 'high' }, caps: { maxTier: 'standard' } });
        // Pins change the route, not the work: no new revision, no new assessment.
        expect(m.tasks[0].revision).toBe(1);
      },
    },
    {
      name: 'adding a ninth task is refused (default cap 8)',
      m: plan({}, Array.from({ length: 8 }, (_, i) => task(`t${i + 1}`))),
      edit: { kind: 'add' },
      refused: /at most 8 tasks/,
    },
    {
      name: 'splitting at the cap is refused',
      m: plan({ policy: { maxTasks: 3 } }),
      edit: { kind: 'split', taskId: 't1' },
      refused: /at most 3 tasks/,
    },
    {
      name: 'a mission that is running is not edited',
      m: plan({ state: 'running', planApprovedAt: T0 }),
      edit: { kind: 'update', taskId: 't3', fields: { title: 'x' } },
      refused: /the plan is running; it can only be edited in review/,
    },
    {
      name: 'a task that has started is not edited',
      m: plan({}, [task('t1', { state: 'running', attemptIds: ['a1'] })]),
      edit: { kind: 'delete', taskId: 't1' },
      refused: /t1 has started/,
    },
    { name: 'a task that is gone', edit: { kind: 'delete', taskId: 'nope' }, refused: /no longer in the plan/ },
  ];
  for (const r of rows) {
    it(r.name, () => {
      const before = r.m ?? plan();
      const out = edit(before, r.edit);
      if (r.refused) {
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.problems.join('\n')).toMatch(r.refused);
        return;
      }
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      if (r.keys) expect(keys(out.mission)).toEqual(r.keys);
      r.check?.(out.mission);
      // Whatever the edit, what comes out is a valid graph.
      expect(graphIssues(out.mission.tasks)).toEqual([]);
    });
  }

  it('marks the tasks whose content changed, whose preview is out of date', () => {
    const r = edit(plan(), { kind: 'delete', taskId: 't2' });
    expect(r.ok && r.changed).toEqual(['t3']);
    const u = edit(plan(), { kind: 'update', taskId: 't1', fields: { title: 'x' } });
    expect(u.ok && u.changed).toEqual(['t1']);
  });

  it('drops a stale route proposal when a task changes', () => {
    const rec = { assessmentId: 'x' } as unknown as Task['recommendation'];
    const r = edit(plan({}, [task('t1', { recommendation: rec })]), { kind: 'update', taskId: 't1', fields: { objective: 'new' } });
    expect(r.ok && r.mission.tasks[0].recommendation).toBeUndefined();
  });

  it('allows an edit that fixes a plan which already had an error', () => {
    // A cycle that got in some other way: deleting one of its tasks is allowed, and fixes it.
    const broken = plan({}, [task('a', { dependsOn: [dep('b')] }), task('b', { dependsOn: [dep('a')] })]);
    const r = edit(broken, { kind: 'delete', taskId: 'a' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(planIssues(r.mission).filter((i) => i.level === 'error')).toEqual([]);
  });
});
