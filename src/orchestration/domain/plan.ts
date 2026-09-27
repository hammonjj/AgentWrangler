/**
 * A mission's plan: its task graph, the checks it must pass, and the edits
 * plan review makes to it (`docs/plans/intelligent-orchestration.md` §11.2,
 * §12.1; #43).
 *
 * Pure. The graph is validated **on every edit**: an edit that would leave a
 * cycle, a dangling or self edge, or more tasks than the cap is refused with
 * the reason (a cycle is shown as its path, `t1 → t2 → t3 → t1`), and the
 * plan is left as it was. Problems that only stop the plan from *starting*
 * (a task with no acceptance criteria, an empty objective) are allowed while
 * the user is still writing, and block Approve instead.
 *
 * The list order is the run order. Every edit but `move` re-sorts the list
 * stably into dependency order (a task moves below what it needs, and nothing
 * else moves), and `move` is refused when it would put a task above something
 * it needs. In P8 tasks run one at a time, so what the user sees top to bottom
 * is what happens.
 */
import {
  DEFAULT_MAX_TASKS,
  HARD_MAX_TASKS,
  type PlanEdit,
  type PlanIssueLevel,
  type PlanOverrides,
  type PlanTaskDraft,
  type PlanTaskFields,
} from '../../shared/orchestration/plan';
import {
  EFFORT_LEVELS,
  type DependencyKind,
  type EffortLevel,
  type ExecutionPolicy,
  type Millis,
  type Mission,
  type Task,
  type TaskKind,
  type TaskOverrides,
  type VerificationPlan,
} from '../../shared/orchestration/types';
import { globsOverlap } from '../policy/globs';

type GraphTask = Pick<Task, 'id' | 'key' | 'dependsOn'>;

export type { PlanIssueLevel };

export interface PlanIssue {
  level: PlanIssueLevel;
  text: string;
  /** The task it is about, when it is about one. */
  taskId?: string;
}

/** The task cap for this policy: its own `maxTasks`, never above the hard cap (§11.2). */
export function taskCap(policy: Pick<ExecutionPolicy, 'maxTasks'>): number {
  const own = policy.maxTasks;
  const cap = typeof own === 'number' && Number.isInteger(own) && own > 0 ? own : DEFAULT_MAX_TASKS;
  return Math.min(cap, HARD_MAX_TASKS);
}

/**
 * One cycle in the graph, as the keys along it in run order and back to the
 * start (`['t1', 't2', 't3', 't1']`), or undefined when there is none.
 * Self edges are reported separately and skipped here.
 */
export function findCycle(tasks: readonly GraphTask[]): string[] | undefined {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // upstream → downstream, the direction work flows.
  const next = new Map<string, string[]>(tasks.map((t) => [t.id, []]));
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (d.taskId !== t.id && byId.has(d.taskId)) next.get(d.taskId)!.push(t.id);
    }
  }
  const colour = new Map<string, 'grey' | 'black'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    colour.set(id, 'grey');
    stack.push(id);
    for (const n of next.get(id) ?? []) {
      const c = colour.get(n);
      if (c === 'grey') {
        const loop = stack.slice(stack.indexOf(n));
        return [...loop, n].map((x) => byId.get(x)!.key);
      }
      if (c === undefined) {
        const found = visit(n);
        if (found) return found;
      }
    }
    stack.pop();
    colour.set(id, 'black');
    return undefined;
  };
  for (const t of tasks) {
    if (colour.has(t.id)) continue;
    const found = visit(t.id);
    if (found) return found;
  }
  return undefined;
}

/** `t1 → t2 → t3 → t1`. */
export function cycleText(cycle: readonly string[]): string {
  return cycle.join(' → ');
}

/**
 * The order tasks run in: dependency order, and list order among tasks that
 * do not depend on each other (a stable Kahn's algorithm). Tasks caught in a
 * cycle, or behind one, are left out; validate first.
 */
export function executionOrder<T extends GraphTask>(tasks: readonly T[]): T[] {
  const ids = new Set(tasks.map((t) => t.id));
  const emitted = new Set<string>();
  const out: T[] = [];
  let progress = true;
  while (progress && out.length < tasks.length) {
    progress = false;
    for (const t of tasks) {
      if (emitted.has(t.id)) continue;
      if (t.dependsOn.every((d) => d.taskId === t.id || !ids.has(d.taskId) || emitted.has(d.taskId))) {
        emitted.add(t.id);
        out.push(t);
        progress = true;
        // Back to the top: an earlier task that was waiting on this one comes first.
        break;
      }
    }
  }
  return out;
}

/** Every task this one needs, directly or through others. */
export function upstreamOf(tasks: readonly GraphTask[], taskId: string): Set<string> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const walk = (id: string) => {
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (seen.has(d.taskId) || d.taskId === taskId) continue;
      seen.add(d.taskId);
      walk(d.taskId);
    }
  };
  walk(taskId);
  return seen;
}

/** Whether one of the two needs the other, directly or not. */
function ordered(tasks: readonly GraphTask[], a: string, b: string): boolean {
  return upstreamOf(tasks, a).has(b) || upstreamOf(tasks, b).has(a);
}

/** The graph's hard problems (§12.1): self, dangling and cyclic edges, duplicate keys, a done task after a live one. */
export function graphIssues(tasks: readonly Pick<Task, 'id' | 'key' | 'dependsOn' | 'state'>[]): PlanIssue[] {
  const out: PlanIssue[] = [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const keys = new Set<string>();
  for (const t of tasks) {
    if (keys.has(t.key)) out.push({ level: 'error', text: `task key ${t.key} is used twice`, taskId: t.id });
    keys.add(t.key);
    const seen = new Set<string>();
    for (const d of t.dependsOn) {
      if (d.taskId === t.id) out.push({ level: 'error', text: `${t.key} depends on itself`, taskId: t.id });
      else if (!byId.has(d.taskId)) out.push({ level: 'error', text: `${t.key} depends on a task that does not exist`, taskId: t.id });
      else if (seen.has(d.taskId)) out.push({ level: 'error', text: `${t.key} depends on ${byId.get(d.taskId)!.key} twice`, taskId: t.id });
      else if (t.state === 'done' && byId.get(d.taskId)!.state !== 'done') {
        out.push({ level: 'error', text: `${t.key} is done but depends on ${byId.get(d.taskId)!.key}, which is not`, taskId: t.id });
      }
      seen.add(d.taskId);
    }
  }
  const cycle = findCycle(tasks);
  if (cycle) out.push({ level: 'error', text: `dependency cycle: ${cycleText(cycle)}` });
  return out;
}

/**
 * Everything plan review shows about a plan: the graph (§12.1), the cap, and
 * §11.2's checks — every task has an objective and at least one acceptance
 * criterion, scope paths stay inside the repository, and two tasks with no
 * order between them whose scopes overlap are flagged.
 */
export function planIssues(m: Pick<Mission, 'tasks' | 'policy'>): PlanIssue[] {
  const out: PlanIssue[] = [];
  const cap = taskCap(m.policy);
  if (m.tasks.length === 0) out.push({ level: 'blocker', text: 'the plan has no tasks' });
  if (m.tasks.length > cap) out.push({ level: 'error', text: `${m.tasks.length} tasks, more than the cap of ${cap}` });
  out.push(...graphIssues(m.tasks));
  for (const t of m.tasks) {
    if (!t.objective.trim()) out.push({ level: 'blocker', text: `${t.key} has no objective`, taskId: t.id });
    if (t.acceptanceCriteria.length === 0) out.push({ level: 'blocker', text: `${t.key} has no acceptance criteria`, taskId: t.id });
    for (const p of t.scope.paths) {
      if (!insideRepo(p)) out.push({ level: 'blocker', text: `${t.key}: scope path ${p} is not inside the repository`, taskId: t.id });
    }
  }
  for (let i = 0; i < m.tasks.length; i++) {
    for (let j = i + 1; j < m.tasks.length; j++) {
      const a = m.tasks[i];
      const b = m.tasks[j];
      if (ordered(m.tasks, a.id, b.id)) continue;
      const hit = a.scope.paths.find((p) => b.scope.paths.some((q) => globsOverlap(p, q)));
      if (hit) {
        out.push({
          level: 'warning',
          text: `${a.key} and ${b.key} may touch the same files (${hit}) with no order between them: merge them, or add a dependency`,
          taskId: b.id,
        });
      }
    }
  }
  return out;
}

/** Whether the plan can be approved: no errors and no blockers. */
export function canApprove(m: Pick<Mission, 'tasks' | 'policy'>): boolean {
  return !planIssues(m).some((i) => i.level !== 'warning');
}

function insideRepo(p: string): boolean {
  const s = p.trim();
  if (s === '' || s.startsWith('/') || s.startsWith('~') || /^[A-Za-z]:[\\/]/.test(s)) return false;
  return !s.split(/[\\/]/).includes('..');
}

// ---------------------------------------------------------------------------
// Building and editing
// ---------------------------------------------------------------------------

export interface PlanContext {
  /** A fresh task id. */
  newId: () => string;
  /** The verification plan a task of this kind with this many criteria gets under the repository's policy (#35). */
  verification: (kind: TaskKind, criteria: number) => VerificationPlan;
  now: Millis;
}

export type PlanEditResult = { ok: true; mission: Mission; changed: string[] } | { ok: false; problems: string[] };

/** The next free key: one past the highest `t<n>` in the plan. */
export function nextTaskKey(tasks: readonly Pick<Task, 'key'>[]): string {
  let max = 0;
  for (const t of tasks) {
    const n = /^t(\d+)$/.exec(t.key);
    if (n) max = Math.max(max, Number(n[1]));
  }
  return `t${max + 1}`;
}

function clean(list: readonly string[] | undefined): string[] {
  return (list ?? []).map((s) => s.trim()).filter(Boolean);
}

/** A new task in a plan, written by the user. */
export function planTask(key: string, fields: PlanTaskFields, ctx: PlanContext): Task {
  const criteria = clean(fields.acceptanceCriteria);
  const kind = fields.kind ?? undefined;
  return {
    id: ctx.newId(),
    key,
    title: fields.title?.trim() || 'New task',
    objective: fields.objective?.trim() ?? '',
    acceptanceCriteria: criteria,
    scope: { paths: clean(fields.scopePaths), subsystems: [], confidence: 'medium' },
    // As the task runner does: `feature` until someone says otherwise, so an empty diff still fails.
    kindHint: kind ?? 'feature',
    ...(kind ? {} : { kindDefaulted: true }),
    dependsOn: [],
    verification: ctx.verification(kind ?? 'feature', criteria.length),
    revision: 1,
    state: 'pending',
    assessmentIds: [],
    attemptIds: [],
    escalations: [],
    createdBy: 'user',
  };
}

/**
 * Tasks from a hand-written plan: keys `t1`… in the order given, dependencies
 * by those keys. Refused, with every problem, if the graph or the cap is broken.
 */
export function tasksFromDraft(
  drafts: readonly PlanTaskDraft[],
  policy: Pick<ExecutionPolicy, 'maxTasks'>,
  ctx: PlanContext,
): { ok: true; tasks: Task[] } | { ok: false; problems: string[] } {
  const tasks = drafts.map((d, i) => planTask(`t${i + 1}`, d, ctx));
  const byKey = new Map(tasks.map((t) => [t.key, t.id]));
  const problems: string[] = [];
  drafts.forEach((d, i) => {
    tasks[i].dependsOn = (d.dependsOn ?? []).map((dep) => {
      const id = byKey.get(dep.key);
      if (!id) problems.push(`t${i + 1} depends on ${dep.key}, which is not in the plan`);
      return { taskId: id ?? `missing:${dep.key}`, kind: dep.kind };
    });
  });
  const cap = taskCap(policy);
  if (tasks.length > cap) problems.push(`${tasks.length} tasks, more than the cap of ${cap}`);
  if (tasks.length === 0) problems.push('the plan has no tasks');
  problems.push(...graphIssues(tasks).filter((i) => !i.text.includes('does not exist')).map((i) => i.text));
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, tasks: executionOrder(tasks) };
}

/** Only a plan still under review is edited, and only tasks nothing has run yet (§12.1). */
function editable(m: Mission, taskIds: readonly string[]): string | undefined {
  if (m.state !== 'plan-review' && m.state !== 'draft') return `the plan is ${m.state}; it can only be edited in review`;
  for (const id of taskIds) {
    const t = m.tasks.find((x) => x.id === id);
    if (!t) return 'that task is no longer in the plan';
    if (t.attemptIds.length > 0 || t.state !== 'pending') return `${t.key} has started; it cannot be changed`;
  }
  return undefined;
}

/** A task that changed: a new revision (so its preview assessment is redone) and no stale proposal. */
function bumped(t: Task, patch: Partial<Task>, ctx: PlanContext): Task {
  const next: Task = { ...t, ...patch, revision: t.revision + 1 };
  delete next.recommendation;
  // Kind and criteria decide the checks (#35); rebuild them from the policy, never from the edit.
  next.verification = ctx.verification(next.kindHint ?? 'feature', next.acceptanceCriteria.length);
  return next;
}

function withFields(t: Task, f: PlanTaskFields, ctx: PlanContext): Task {
  const patch: Partial<Task> = {};
  if (f.title !== undefined) patch.title = f.title.trim() || t.title;
  if (f.objective !== undefined) patch.objective = f.objective.trim();
  if (f.acceptanceCriteria !== undefined) patch.acceptanceCriteria = clean(f.acceptanceCriteria);
  if (f.scopePaths !== undefined) patch.scope = { ...t.scope, paths: clean(f.scopePaths), confidence: 'medium' };
  if (f.kind !== undefined) {
    patch.kindHint = f.kind ?? 'feature';
    patch.kindDefaulted = f.kind === null ? true : undefined;
  }
  const next = bumped(t, patch, ctx);
  if (next.kindDefaulted === undefined) delete next.kindDefaulted;
  return next;
}

function dedupeEdges(t: Task): Task {
  const best = new Map<string, DependencyKind>();
  for (const d of t.dependsOn) {
    if (d.taskId === t.id) continue;
    // `code` carries more than `order`, so it wins a tie.
    best.set(d.taskId, best.get(d.taskId) === 'code' ? 'code' : d.kind);
  }
  return { ...t, dependsOn: [...best].map(([taskId, kind]) => ({ taskId, kind })) };
}

function applyOverrides(current: TaskOverrides | undefined, o: PlanOverrides): TaskOverrides | undefined {
  const pins = { ...current?.pins };
  const caps = { ...current?.caps };
  const effort = (v: string | undefined): EffortLevel | undefined => ((EFFORT_LEVELS as readonly string[]).includes(v ?? '') ? (v as EffortLevel) : undefined);
  if (o.pins) {
    if ('harness' in o.pins) {
      if (o.pins.harness) pins.harness = o.pins.harness;
      else delete pins.harness;
    }
    if ('model' in o.pins) {
      const model = o.pins.model?.trim();
      if (model) pins.model = model;
      else delete pins.model;
    }
    if ('effort' in o.pins) {
      const e = effort(o.pins.effort);
      if (e) pins.effort = e;
      else delete pins.effort;
    }
  }
  if (o.caps) {
    if ('maxTier' in o.caps) {
      const tier = o.caps.maxTier?.trim();
      if (tier) caps.maxTier = tier;
      else delete caps.maxTier;
    }
    if ('maxEffort' in o.caps) {
      const e = effort(o.caps.maxEffort);
      if (e) caps.maxEffort = e;
      else delete caps.maxEffort;
    }
  }
  const next: TaskOverrides = { ...current };
  if (Object.keys(pins).length > 0) next.pins = pins;
  else delete next.pins;
  if (Object.keys(caps).length > 0) next.caps = caps;
  else delete next.caps;
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Apply one edit and validate the whole plan. Refused, with the reasons and
 * nothing changed, when the edit is not allowed now or leaves an error the
 * plan did not already have. `changed` lists the tasks whose content changed,
 * whose preview assessment is now out of date.
 */
export function applyPlanEdit(m: Mission, edit: PlanEdit, ctx: PlanContext): PlanEditResult {
  const refuse = (...problems: string[]): PlanEditResult => ({ ok: false, problems });
  const find = (id: string) => m.tasks.find((t) => t.id === id);
  let tasks = m.tasks;
  let changed: string[] = [];
  let reorder = true;

  switch (edit.kind) {
    case 'add': {
      const why = editable(m, []);
      if (why) return refuse(why);
      const cap = taskCap(m.policy);
      if (m.tasks.length >= cap) return refuse(`a mission may have at most ${cap} tasks`);
      const t = planTask(nextTaskKey(m.tasks), edit.fields ?? {}, ctx);
      const at = edit.after ? m.tasks.findIndex((x) => x.id === edit.after) + 1 : m.tasks.length;
      tasks = [...m.tasks.slice(0, at || m.tasks.length), t, ...m.tasks.slice(at || m.tasks.length)];
      changed = [t.id];
      break;
    }
    case 'update': {
      const why = editable(m, [edit.taskId]);
      if (why) return refuse(why);
      tasks = m.tasks.map((t) => (t.id === edit.taskId ? withFields(t, edit.fields, ctx) : t));
      changed = [edit.taskId];
      break;
    }
    case 'overrides': {
      const why = editable(m, [edit.taskId]);
      if (why) return refuse(why);
      const t = find(edit.taskId)!;
      const overrides = applyOverrides(t.overrides, edit.overrides);
      // Pins and caps change the route, not the work: no new assessment, same revision.
      tasks = m.tasks.map((x) => {
        if (x.id !== edit.taskId) return x;
        const next: Task = { ...x, overrides };
        if (!overrides) delete next.overrides;
        delete next.recommendation;
        return next;
      });
      break;
    }
    case 'delete': {
      const why = editable(m, [edit.taskId]);
      if (why) return refuse(why);
      tasks = m.tasks
        .filter((t) => t.id !== edit.taskId)
        .map((t) => (t.dependsOn.some((d) => d.taskId === edit.taskId) ? bumped(t, { dependsOn: t.dependsOn.filter((d) => d.taskId !== edit.taskId) }, ctx) : t));
      changed = tasks.filter((t) => t.revision !== find(t.id)?.revision).map((t) => t.id);
      break;
    }
    case 'merge': {
      if (edit.taskId === edit.into) return refuse('a task cannot be merged into itself');
      const why = editable(m, [edit.taskId, edit.into]);
      if (why) return refuse(why);
      const gone = find(edit.taskId)!;
      const keep = find(edit.into)!;
      const merged = dedupeEdges(
        bumped(
          keep,
          {
            objective: [keep.objective, gone.objective].map((s) => s.trim()).filter(Boolean).join('\n\n'),
            acceptanceCriteria: [...keep.acceptanceCriteria, ...gone.acceptanceCriteria.filter((c) => !keep.acceptanceCriteria.includes(c))],
            scope: { ...keep.scope, paths: [...new Set([...keep.scope.paths, ...gone.scope.paths])], subsystems: [...new Set([...keep.scope.subsystems, ...gone.scope.subsystems])] },
            dependsOn: [...keep.dependsOn, ...gone.dependsOn].filter((d) => d.taskId !== keep.id && d.taskId !== gone.id),
          },
          ctx,
        ),
      );
      tasks = m.tasks
        .filter((t) => t.id !== gone.id)
        .map((t) => {
          if (t.id === keep.id) return merged;
          if (!t.dependsOn.some((d) => d.taskId === gone.id)) return t;
          // Whatever needed the folded task now needs the task it went into.
          return dedupeEdges(bumped(t, { dependsOn: t.dependsOn.map((d) => (d.taskId === gone.id ? { ...d, taskId: keep.id } : d)) }, ctx));
        });
      changed = tasks.filter((t) => t.revision !== find(t.id)?.revision).map((t) => t.id);
      break;
    }
    case 'split': {
      const why = editable(m, [edit.taskId]);
      if (why) return refuse(why);
      const cap = taskCap(m.policy);
      if (m.tasks.length >= cap) return refuse(`a mission may have at most ${cap} tasks`);
      const first = find(edit.taskId)!;
      const all = first.acceptanceCriteria;
      const at = Math.min(Math.max(edit.at ?? Math.ceil(all.length / 2), all.length > 1 ? 1 : 0), all.length);
      const second = planTask(
        nextTaskKey(m.tasks),
        { title: `${first.title} (part 2)`, objective: first.objective, acceptanceCriteria: all.slice(at), scopePaths: first.scope.paths, kind: first.kindDefaulted ? undefined : first.kindHint },
        ctx,
      );
      second.dependsOn = [{ taskId: first.id, kind: 'code' }];
      const head = bumped(first, { acceptanceCriteria: all.slice(0, at) }, ctx);
      const i = m.tasks.findIndex((t) => t.id === first.id);
      tasks = [...m.tasks.slice(0, i), head, second, ...m.tasks.slice(i + 1)].map((t) => {
        if (t.id === first.id || t.id === second.id || !t.dependsOn.some((d) => d.taskId === first.id)) return t;
        // Downstream work needed the whole task, and the whole task is now both parts.
        return bumped(t, { dependsOn: t.dependsOn.map((d) => (d.taskId === first.id ? { ...d, taskId: second.id } : d)) }, ctx);
      });
      changed = tasks.filter((t) => t.revision !== find(t.id)?.revision).map((t) => t.id);
      break;
    }
    case 'move': {
      const why = editable(m, [edit.taskId]);
      if (why) return refuse(why);
      const from = m.tasks.findIndex((t) => t.id === edit.taskId);
      const to = Math.min(Math.max(Math.trunc(edit.to), 0), m.tasks.length - 1);
      if (from === to) return { ok: true, mission: m, changed: [] };
      const moved = [...m.tasks];
      const [t] = moved.splice(from, 1);
      moved.splice(to, 0, t);
      const pos = new Map(moved.map((x, i) => [x.id, i]));
      for (const x of moved) {
        for (const d of x.dependsOn) {
          const up = moved.find((y) => y.id === d.taskId);
          if (up && pos.get(up.id)! > pos.get(x.id)!) return refuse(`${x.key} needs ${up.key}, so it cannot run before it`);
        }
      }
      tasks = moved;
      reorder = false;
      break;
    }
    case 'depend': {
      const why = editable(m, [edit.taskId]);
      if (why) return refuse(why);
      const t = find(edit.taskId)!;
      const on = find(edit.on);
      if (!on) return refuse('that task is no longer in the plan');
      if (on.id === t.id) return refuse(`${t.key} cannot depend on itself`);
      const rest = t.dependsOn.filter((d) => d.taskId !== on.id);
      const deps = edit.dep === 'none' ? rest : [...rest, { taskId: on.id, kind: edit.dep }];
      tasks = m.tasks.map((x) => (x.id === t.id ? bumped(x, { dependsOn: deps }, ctx) : x));
      changed = [t.id];
      break;
    }
  }

  const before = new Set(planIssues(m).filter((i) => i.level === 'error').map((i) => i.text));
  const draft: Mission = { ...m, tasks, updatedAt: ctx.now };
  const introduced = planIssues(draft).filter((i) => i.level === 'error' && !before.has(i.text));
  if (introduced.length > 0) return refuse(...introduced.map((i) => i.text));
  if (reorder && !findCycle(tasks)) draft.tasks = executionOrder(tasks);
  return { ok: true, mission: draft, changed };
}
