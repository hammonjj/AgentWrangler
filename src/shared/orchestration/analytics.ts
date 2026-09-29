/**
 * Routing analytics (`docs/plans/intelligent-orchestration.md` §17, §29 P10;
 * #49): one query layer over the telemetry log, one definition of each §17
 * metric, and the calibration report.
 *
 * Pure functions over telemetry records, like `autoRouting.ts`, which reads
 * its route direction and under-routing rule from here. Nothing here reads a
 * file or the DOM: the main process builds the dataset from the log, the
 * table pane draws what `analyticsView.ts` makes of it, and a test feeds
 * fixtures straight in. Later views (#86–#90) filter and group through the
 * same functions rather than defining their own numbers.
 *
 * **Units.** Task-level metrics (success, escalation, cost per success,
 * rescue) count tasks and classify each by its **first attempt's route**:
 * the route the task was given, not the one the ladder ended on. Attempt-level
 * metrics (verification, model and effort distribution, times, crashes,
 * permission asks) count attempts and classify each by its own route. Either
 * way the task's kind, assessment, repository and mission come from the task.
 *
 * **Repository.** No record carries a repository (telemetry is metadata, and
 * a path is not). It is joined through `missionId` to the mission store's
 * `repoRoot` (`repoOf`); a mission the store no longer has is `unknown`.
 *
 * **Not reported.** A provider field a harness did not report (§16.4) is
 * absent from the record. Here it stays absent: a metric that needs it lists
 * the records without it and the harnesses that wrote them, and a metric
 * every record lacks is `NotReported`, which renders as "not reported by
 * <harness>" — never 0.
 */
import { harnessLabel } from '../harness';
import type {
  AttemptRecord,
  EscalationRecord,
  IntegrationRecord,
  LocalCallRecord,
  OverrideRecord,
  PlanRecord,
  PlanReviewRecord,
  RoutingRecord,
  TaskFinalRecord,
  TelemetryRecord,
  TurnRecord,
} from './telemetry';
import { EFFORT_LEVELS, type EffortLevel, type OutcomeCategory, type RouteDimension, type TierName } from './types';

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** The records analytics reads. Turns only when they belong to an attempt. */
export type AnalyticsRecord =
  | AttemptRecord
  | RoutingRecord
  | EscalationRecord
  | TaskFinalRecord
  | IntegrationRecord
  | OverrideRecord
  | TurnRecord
  | LocalCallRecord
  | PlanRecord
  | PlanReviewRecord;

const ANALYTICS_TYPES: ReadonlySet<string> = new Set([
  'attempt',
  'routing',
  'escalation',
  'task-final',
  'integration',
  'override',
  'turn',
  'local-call',
  'plan',
  'plan-review',
]);

/** Every record type analytics reads, as it appears in a JSONL line (`"type":"…"`). */
export const ANALYTICS_RECORD_TYPES: readonly string[] = [...ANALYTICS_TYPES];

export function isAnalyticsRecord(r: TelemetryRecord): r is AnalyticsRecord {
  if (!ANALYTICS_TYPES.has(r.type)) return false;
  return r.type !== 'turn' || typeof r.attemptId === 'string';
}

// ---------------------------------------------------------------------------
// Not reported
// ---------------------------------------------------------------------------

/** A value no record had: the harnesses whose records lacked it. */
export interface NotReported {
  notReported: true;
  harnesses: string[];
}

export function notReported(harnesses: Iterable<string>): NotReported {
  return { notReported: true, harnesses: [...new Set(harnesses)].sort() };
}

export function isNotReported(v: unknown): v is NotReported {
  return !!v && typeof v === 'object' && (v as NotReported).notReported === true;
}

/** "not reported by Codex", or "not reported by Claude Code or Codex". */
export function notReportedText(harnesses: readonly string[]): string {
  const names = [...new Set(harnesses)].map((h) => harnessLabel(h));
  if (names.length === 0) return 'not reported';
  return `not reported by ${names.join(' or ')}`;
}

/** A value, its not-reported text, or `none` when there was nothing to measure. */
export function formatReported<T>(v: T | NotReported | undefined, format: (v: T) => string, none = 'no data'): string {
  if (v === undefined) return none;
  if (isNotReported(v)) return notReportedText(v.harnesses);
  return format(v);
}

// ---------------------------------------------------------------------------
// Route direction and outcome (shared with `autoRouting.ts`)
// ---------------------------------------------------------------------------

/**
 * How the route that ran compares with the router's, in cost:
 * `router-cheaper` — the router wanted a lower tier (or the same tier with
 * less effort) than ran; `router-dearer` the reverse; `sideways` — same tier
 * and effort, another model or harness; `agreed` — the same route.
 */
export type RouteDirection = 'agreed' | 'router-cheaper' | 'router-dearer' | 'sideways' | 'unknown';

/** How a task went from one decision. */
export type DecisionOutcome = 'passed-first' | 'needed-escalation' | 'failed-other' | 'cancelled' | 'interrupted' | 'running';

/**
 * A failure that says the route was too weak for the work: the result was
 * wrong, empty, went round in circles, or did not fit the context window.
 * Infrastructure, capacity, budget and policy stops say nothing about the
 * route; ambiguity is the task's, not the model's.
 */
export const ROUTE_FAILURES: readonly OutcomeCategory[] = ['quality-new', 'quality-repeat', 'empty', 'stuck', 'context'];

export function isRouteFailure(category: OutcomeCategory | undefined): boolean {
  return category !== undefined && ROUTE_FAILURES.includes(category);
}

/** A value's place in an ordered list, or -1. */
export function rankIn(list: readonly string[], v: string | undefined): number {
  return v === undefined ? -1 : list.indexOf(v);
}

export function routeDirection(
  tiers: readonly TierName[],
  predicted: { tier: TierName; effort: EffortLevel },
  ran: { tier: TierName; effort?: EffortLevel },
  changed: readonly RouteDimension[],
): RouteDirection {
  const pt = rankIn(tiers, predicted.tier);
  const rt = rankIn(tiers, ran.tier);
  if (pt < 0 || rt < 0) return predicted.tier === ran.tier ? (changed.length > 0 ? 'sideways' : 'agreed') : 'unknown';
  if (pt < rt) return 'router-cheaper';
  if (pt > rt) return 'router-dearer';
  const pe = rankIn(EFFORT_LEVELS, predicted.effort);
  const re = rankIn(EFFORT_LEVELS, ran.effort);
  if (pe >= 0 && re >= 0 && pe !== re) return pe < re ? 'router-cheaper' : 'router-dearer';
  return changed.length > 0 ? 'sideways' : 'agreed';
}

/** How the attempt a decision launched went. No record yet: still running. */
export function decisionOutcome(a: AttemptRecord | undefined): DecisionOutcome {
  if (!a) return 'running';
  if (a.outcome === 'succeeded') return 'passed-first';
  if (a.outcome === 'cancelled') return 'cancelled';
  if (a.outcome === 'interrupted') return 'interrupted';
  return isRouteFailure(a.category) ? 'needed-escalation' : 'failed-other';
}

/**
 * Each task's own decision: the routing record of the first attempt it was
 * started on, with that attempt's record once it has ended. One per task, so
 * a resume, a retry or an escalation step does not count the same judgement
 * twice; a record from an escalation step is never a task's first.
 */
export function ownDecisions(records: readonly AnalyticsRecord[]): { routing: RoutingRecord; attempt?: AttemptRecord }[] {
  const attempts = new Map<string, AttemptRecord>();
  const first = new Map<string, RoutingRecord>();
  for (const r of records) {
    if (r.type === 'attempt') attempts.set(`${r.missionId}|${r.taskId}|${r.n}`, r);
  }
  for (const r of records) {
    if (r.type !== 'routing' || r.escalationStep !== undefined) continue;
    if (attempts.get(`${r.missionId}|${r.taskId}|${r.attemptN}`)?.escalationStep !== undefined) continue;
    const key = `${r.missionId}|${r.taskId}`;
    const had = first.get(key);
    if (!had || r.attemptN < had.attemptN) first.set(key, r);
  }
  return [...first.values()]
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .map((routing) => ({ routing, attempt: attempts.get(`${routing.missionId}|${routing.taskId}|${routing.attemptN}`) }));
}

/** One own decision compared with what ran (§27.3). */
export interface DecisionComparison {
  routing: RoutingRecord;
  attempt?: AttemptRecord;
  kind?: string;
  predicted: { tier: TierName; effort: EffortLevel; model?: string };
  ran: { tier: TierName; effort?: EffortLevel; model: string };
  direction: RouteDirection;
  outcome: DecisionOutcome;
}

/**
 * Every own decision that carried a route recommendation, compared with the
 * route that ran. Decisions the router made itself count as agreeing; a
 * `needs-human` or `blocked` verdict has nothing to compare and is left out.
 */
export function compareDecisions(records: readonly AnalyticsRecord[], tiers: readonly TierName[]): DecisionComparison[] {
  const out: DecisionComparison[] = [];
  for (const { routing: r, attempt: a } of ownDecisions(records)) {
    if (r.verdict !== 'route' || r.agreement === 'no-recommendation') continue;
    const ranEffort = a?.target.effortRequested ?? r.ranEffort;
    const ran = { tier: r.ran.tier, ...(ranEffort ? { effort: ranEffort } : {}), model: r.ran.model };
    // The requirement's tier is the floor the router asked for; the tier it resolved to is what it picked.
    const predicted = { tier: r.recommended?.tier ?? r.requirement.minTier, effort: r.requirement.effort, ...(r.recommended ? { model: r.recommended.model } : {}) };
    out.push({
      routing: r,
      ...(a ? { attempt: a } : {}),
      ...(a?.assessment?.dimensions.kind ? { kind: a.assessment.dimensions.kind.value } : {}),
      predicted,
      ran,
      direction: routeDirection(tiers, predicted, ran, r.changed),
      outcome: decisionOutcome(a),
    });
  }
  return out;
}

/**
 * The router under-routes a kind when it wanted a cheaper route than ran and
 * the route that ran still needed escalation (§27.3's gate, check 4).
 */
export function isRouterUnderRouting(row: { direction: RouteDirection; outcome: DecisionOutcome }): boolean {
  return row.direction === 'router-cheaper' && row.outcome === 'needed-escalation';
}

export function underRoutedKinds(rows: readonly { direction: RouteDirection; outcome: DecisionOutcome; kind?: string }[]): string[] {
  return [...new Set(rows.filter(isRouterUnderRouting).map((r) => r.kind ?? 'not yet assessed'))].sort();
}

// ---------------------------------------------------------------------------
// The dataset: records folded per task
// ---------------------------------------------------------------------------

export interface TaskFacts {
  /** `missionId|taskId`. */
  key: string;
  missionId: string;
  taskId: string;
  /** By attempt number. */
  attempts: AttemptRecord[];
  first?: AttemptRecord;
  final?: TaskFinalRecord;
  routings: RoutingRecord[];
  escalations: EscalationRecord[];
  integrations: IntegrationRecord[];
  /** Task-scoped overrides of this task. */
  overrides: OverrideRecord[];
  /** When the task ended, or its latest record. */
  at: number;
  /** Assessment dimension values (kind included) from its latest assessed attempt. */
  dims: Record<string, string>;
  assessorVersion?: string;
  /** The first attempt's route (the first routing record's, until an attempt has ended). */
  route: { tier?: string; effort?: string; model?: string; harness?: string; location?: 'hosted' | 'local' };
  /** `repoOf(missionId)`; absent when the mission store does not know it. */
  repository?: string;
}

export interface AnalyticsDataset {
  tasks: TaskFacts[];
  byKey: Map<string, TaskFacts>;
  /** Every attempt, with its task's key. */
  attempts: { attempt: AttemptRecord; task: TaskFacts }[];
  turnsByAttempt: Map<string, TurnRecord[]>;
  localCalls: LocalCallRecord[];
  plans: PlanRecord[];
  planReviews: PlanReviewRecord[];
  /** Mission-scoped overrides, by mission. */
  missionOverrides: Map<string, OverrideRecord[]>;
  /** Every record by id, for evidence. */
  byId: Map<string, AnalyticsRecord>;
  tiers: readonly TierName[];
  records: readonly AnalyticsRecord[];
}

export interface DatasetInput {
  records: readonly AnalyticsRecord[];
  /** Tier names, weakest first (the catalog's order). */
  tiers: readonly TierName[];
  /** The mission store's repository for a mission. */
  repoOf?: (missionId: string) => string | undefined;
}

export const UNKNOWN = 'unknown';

function taskOf(map: Map<string, TaskFacts>, missionId: string, taskId: string, repoOf: DatasetInput['repoOf']): TaskFacts {
  const key = `${missionId}|${taskId}`;
  let t = map.get(key);
  if (!t) {
    const repository = repoOf?.(missionId);
    t = {
      key,
      missionId,
      taskId,
      attempts: [],
      routings: [],
      escalations: [],
      integrations: [],
      overrides: [],
      at: 0,
      dims: {},
      route: {},
      ...(repository ? { repository } : {}),
    };
    map.set(key, t);
  }
  return t;
}

export function buildDataset(input: DatasetInput): AnalyticsDataset {
  const byKey = new Map<string, TaskFacts>();
  const turnsByAttempt = new Map<string, TurnRecord[]>();
  const localCalls: LocalCallRecord[] = [];
  const plans: PlanRecord[] = [];
  const planReviews: PlanReviewRecord[] = [];
  const missionOverrides = new Map<string, OverrideRecord[]>();
  const byId = new Map<string, AnalyticsRecord>();
  for (const r of input.records) {
    byId.set(r.id, r);
    switch (r.type) {
      case 'attempt':
      case 'routing':
      case 'escalation':
      case 'task-final':
      case 'integration': {
        const t = taskOf(byKey, r.missionId, r.taskId, input.repoOf);
        t.at = Math.max(t.at, r.at);
        if (r.type === 'attempt') t.attempts.push(r);
        else if (r.type === 'routing') t.routings.push(r);
        else if (r.type === 'escalation') t.escalations.push(r);
        else if (r.type === 'task-final') t.final = r;
        else t.integrations.push(r);
        break;
      }
      case 'override':
        if (r.scope === 'task' && r.taskId) taskOf(byKey, r.missionId, r.taskId, input.repoOf).overrides.push(r);
        else missionOverrides.set(r.missionId, [...(missionOverrides.get(r.missionId) ?? []), r]);
        break;
      case 'turn':
        if (r.attemptId) turnsByAttempt.set(r.attemptId, [...(turnsByAttempt.get(r.attemptId) ?? []), r]);
        break;
      case 'local-call':
        localCalls.push(r);
        break;
      case 'plan':
        plans.push(r);
        break;
      case 'plan-review':
        planReviews.push(r);
        break;
    }
  }
  const attempts: AnalyticsDataset['attempts'] = [];
  for (const t of byKey.values()) {
    t.attempts.sort((a, b) => a.n - b.n);
    t.routings.sort((a, b) => a.attemptN - b.attemptN || a.at - b.at);
    t.escalations.sort((a, b) => a.afterAttemptN - b.afterAttemptN || a.at - b.at);
    t.first = t.attempts[0];
    if (t.final) t.at = t.final.at;
    const assessed = [...t.attempts].reverse().find((a) => a.assessment);
    if (assessed?.assessment) {
      for (const [name, d] of Object.entries(assessed.assessment.dimensions)) t.dims[name] = d.value;
      t.assessorVersion = assessed.assessment.assessorVersion;
    }
    const f = t.first;
    const r0 = t.routings[0];
    if (f) {
      t.route = { tier: f.target.tier, effort: f.target.effortRequested, model: f.target.model, harness: f.target.harness, location: f.target.location };
    } else if (r0) {
      t.route = { tier: r0.ran.tier, effort: r0.ranEffort, model: r0.ran.model, harness: r0.ran.harness, location: r0.ran.location };
    }
    for (const a of t.attempts) attempts.push({ attempt: a, task: t });
  }
  const tasks = [...byKey.values()].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  attempts.sort((a, b) => a.attempt.at - b.attempt.at || a.attempt.id.localeCompare(b.attempt.id));
  return { tasks, byKey, attempts, turnsByAttempt, localCalls, plans, planReviews, missionOverrides, byId, tiers: input.tiers, records: input.records };
}

// ---------------------------------------------------------------------------
// Filters and group-by
// ---------------------------------------------------------------------------

/** Every field narrows; absent means any. Values are exact matches. */
export interface AnalyticsFilter {
  kind?: string;
  tier?: string;
  effort?: string;
  model?: string;
  /** A `repoOf` value, or `unknown`. */
  repository?: string;
  harness?: string;
  location?: 'hosted' | 'local';
  /** Other assessment dimensions, e.g. `{ complexity: 'routine' }`. */
  dimensions?: Record<string, string>;
  assessorVersion?: string;
  /** Inclusive start, exclusive end, epoch ms. */
  from?: number;
  to?: number;
  /** A mission cohort. */
  missionId?: string;
  /** A single task (`missionId|taskId`). */
  taskKey?: string;
}

function inTime(at: number, f: AnalyticsFilter): boolean {
  return (f.from === undefined || at >= f.from) && (f.to === undefined || at < f.to);
}

/** The filters that belong to the task whichever attempt is being counted. */
function taskScopeMatches(t: TaskFacts, f: AnalyticsFilter): boolean {
  if (f.missionId !== undefined && t.missionId !== f.missionId) return false;
  if (f.taskKey !== undefined && t.key !== f.taskKey) return false;
  if (f.kind !== undefined && (t.dims.kind ?? UNKNOWN) !== f.kind) return false;
  if (f.repository !== undefined && (t.repository ?? UNKNOWN) !== f.repository) return false;
  if (f.assessorVersion !== undefined && (t.assessorVersion ?? UNKNOWN) !== f.assessorVersion) return false;
  for (const [name, value] of Object.entries(f.dimensions ?? {})) {
    if ((t.dims[name] ?? UNKNOWN) !== value) return false;
  }
  return true;
}

function routeMatches(route: TaskFacts['route'], f: AnalyticsFilter): boolean {
  if (f.tier !== undefined && (route.tier ?? UNKNOWN) !== f.tier) return false;
  if (f.effort !== undefined && (route.effort ?? UNKNOWN) !== f.effort) return false;
  if (f.model !== undefined && (route.model ?? UNKNOWN) !== f.model) return false;
  if (f.harness !== undefined && (route.harness ?? UNKNOWN) !== f.harness) return false;
  if (f.location !== undefined && (route.location ?? UNKNOWN) !== f.location) return false;
  return true;
}

function attemptRoute(a: AttemptRecord): TaskFacts['route'] {
  return { tier: a.target.tier, effort: a.target.effortRequested, model: a.target.model, harness: a.target.harness, location: a.target.location };
}

/** Tasks in the cohort: route filters read the first attempt's route, time the task's end. */
export function filterTasks(ds: AnalyticsDataset, f: AnalyticsFilter): TaskFacts[] {
  return ds.tasks.filter((t) => taskScopeMatches(t, f) && routeMatches(t.route, f) && inTime(t.at, f));
}

/** Attempts in the cohort: route filters read the attempt's own route, time its record. */
export function filterAttempts(ds: AnalyticsDataset, f: AnalyticsFilter): { attempt: AttemptRecord; task: TaskFacts }[] {
  return ds.attempts.filter(({ attempt, task }) => taskScopeMatches(task, f) && routeMatches(attemptRoute(attempt), f) && inTime(attempt.at, f));
}

export type GroupDimension =
  | 'kind'
  | 'tier'
  | 'effort'
  | 'model'
  | 'repository'
  | 'harness'
  | 'location'
  | 'mission'
  | 'assessorVersion'
  | 'month'
  | `dim:${string}`;

function monthOf(at: number): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** A task's value on a dimension (route dimensions: its first attempt's). */
export function taskGroupKey(t: TaskFacts, dim: GroupDimension): string {
  switch (dim) {
    case 'kind':
      return t.dims.kind ?? UNKNOWN;
    case 'tier':
    case 'effort':
    case 'model':
    case 'harness':
    case 'location':
      return t.route[dim] ?? UNKNOWN;
    case 'repository':
      return t.repository ?? UNKNOWN;
    case 'mission':
      return t.missionId;
    case 'assessorVersion':
      return t.assessorVersion ?? UNKNOWN;
    case 'month':
      return monthOf(t.at);
    default:
      return t.dims[dim.slice('dim:'.length)] ?? UNKNOWN;
  }
}

/** An attempt's value on a dimension (route dimensions: its own). */
export function attemptGroupKey(a: AttemptRecord, t: TaskFacts, dim: GroupDimension): string {
  if (dim === 'tier' || dim === 'effort' || dim === 'model' || dim === 'harness' || dim === 'location') return attemptRoute(a)[dim] ?? UNKNOWN;
  if (dim === 'month') return monthOf(a.at);
  if (dim === 'assessorVersion') return a.assessment?.assessorVersion ?? UNKNOWN;
  return taskGroupKey(t, dim);
}

/** Group anything by a key, largest group first, ties by key. */
export function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): { key: string; items: T[] }[] {
  const m = new Map<string, T[]>();
  for (const item of items) {
    const k = keyOf(item);
    const list = m.get(k);
    if (list) list.push(item);
    else m.set(k, [item]);
  }
  return [...m.entries()].map(([key, list]) => ({ key, items: list })).sort((a, b) => b.items.length - a.items.length || a.key.localeCompare(b.key));
}

/** The values each filterable dimension takes in the data, sorted. */
export function dimensionValues(ds: AnalyticsDataset, dim: GroupDimension): string[] {
  const seen = new Set<string>();
  if (dim === 'tier' || dim === 'effort' || dim === 'model' || dim === 'harness' || dim === 'location') {
    for (const { attempt, task } of ds.attempts) seen.add(attemptGroupKey(attempt, task, dim));
  }
  for (const t of ds.tasks) seen.add(taskGroupKey(t, dim));
  const list = [...seen];
  if (dim === 'tier') return list.sort((a, b) => rankOrEnd(ds.tiers, a) - rankOrEnd(ds.tiers, b) || a.localeCompare(b));
  if (dim === 'effort') return list.sort((a, b) => rankOrEnd(EFFORT_LEVELS, a) - rankOrEnd(EFFORT_LEVELS, b) || a.localeCompare(b));
  return list.sort();
}

function rankOrEnd(list: readonly string[], v: string): number {
  const i = list.indexOf(v);
  return i < 0 ? list.length : i;
}

// ---------------------------------------------------------------------------
// Metrics (§17)
// ---------------------------------------------------------------------------

export type MetricId =
  | 'first-attempt-success'
  | 'eventual-success'
  | 'escalation-rate'
  | 'cost-per-success'
  | 'model-distribution'
  | 'verification-rejection'
  | 'tokens-per-success'
  | 'escalation-cost'
  | 'effort-distribution'
  | 'active-time'
  | 'queue-time'
  | 'waiting-on-human'
  | 'retry-rate'
  | 'crashes'
  | 'merge-conflicts'
  | 'overrides'
  | 'permission-interruptions'
  | 'human-rescue';

/** The five the view puts first (#49's acceptance criteria). */
export const HEADLINE_METRICS: readonly MetricId[] = ['first-attempt-success', 'eventual-success', 'escalation-rate', 'cost-per-success', 'model-distribution'];

export const METRIC_IDS: readonly MetricId[] = [
  ...HEADLINE_METRICS,
  'verification-rejection',
  'tokens-per-success',
  'escalation-cost',
  'effort-distribution',
  'active-time',
  'queue-time',
  'waiting-on-human',
  'retry-rate',
  'crashes',
  'merge-conflicts',
  'overrides',
  'permission-interruptions',
  'human-rescue',
];

/**
 * `ratio`: numerator / denominator. `usd-per` and `tokens-per`: numerator
 * summed over denominator items, per item. `usd`, `ms` and `count`: the
 * numerator itself, of the denominator named by `of`.
 */
export type MetricUnit = 'ratio' | 'usd-per' | 'tokens-per' | 'usd' | 'ms' | 'count' | 'distribution';

export interface MetricBucket {
  key: string;
  count: number;
  ids: string[];
}

export interface MetricResult {
  id: MetricId;
  label: string;
  unit: MetricUnit;
  /** What the denominator counts, e.g. "finished tasks". */
  of: string;
  numerator: number;
  denominator: number;
  /** Absent: nothing to measure. `NotReported`: every record lacked the field. */
  value?: number | NotReported;
  /** Records in the denominator's population. */
  ids: string[];
  /** Records that made the numerator. */
  numeratorIds: string[];
  /** Records left out because they lacked the field, and the harnesses that wrote them (provider fields only). */
  missing?: { ids: string[]; harnesses: string[] };
  /** For distributions (and cost, by basis). */
  buckets?: MetricBucket[];
}

export const METRIC_LABELS: Record<MetricId, string> = {
  'first-attempt-success': 'First-attempt success',
  'eventual-success': 'Eventual success',
  'escalation-rate': 'Escalation rate',
  'cost-per-success': 'Cost per successful task',
  'model-distribution': 'Model distribution',
  'verification-rejection': 'Verification rejection',
  'tokens-per-success': 'Tokens per successful task',
  'escalation-cost': 'Escalation cost',
  'effort-distribution': 'Effort distribution',
  'active-time': 'Active agent time',
  'queue-time': 'Queue time',
  'waiting-on-human': 'Waiting on you',
  'retry-rate': 'Retry rate',
  crashes: 'Crashes and lost attempts',
  'merge-conflicts': 'Merge conflicts',
  overrides: 'Manual overrides',
  'permission-interruptions': 'Permission interruptions',
  'human-rescue': 'Human rescue',
};

function isFinished(t: TaskFacts): t is TaskFacts & { final: TaskFinalRecord } {
  return !!t.final && (t.final.outcome === 'done' || t.final.outcome === 'failed');
}

function isDone(t: TaskFacts): t is TaskFacts & { final: TaskFinalRecord } {
  return t.final?.outcome === 'done';
}

const STEP_ACTIONS: ReadonlySet<string> = new Set(['raise-tier', 'raise-effort']);

/** The tier or effort steps the ladder took for a task (§17's escalation rate): launched steps only. */
export function tierOrEffortSteps(t: TaskFacts): EscalationRecord[] {
  return t.escalations.filter((e) => STEP_ACTIONS.has(e.action) && !e.blockedBy);
}

/** The records that say a person rescued the task, if any. */
export function rescueEvidence(t: TaskFacts): { ids: string[]; signals: string[] } {
  const ids: string[] = [];
  const signals = new Set<string>();
  if (t.final?.acceptedBy === 'user') {
    ids.push(t.final.id);
    signals.add('accepted by you');
  }
  for (const a of t.attempts) {
    if (a.flags.tookOver) signals.add('taken over');
    if (a.flags.userIntervened) signals.add('you stepped in');
    if (a.flags.tookOver || a.flags.userIntervened) ids.push(a.id);
  }
  for (const e of t.escalations) {
    if (e.action === 'needs-human' && !e.blockedBy) {
      ids.push(e.id);
      signals.add('needed you');
    }
  }
  return { ids, signals: [...signals] };
}

function ratioResult(id: MetricId, of: string, population: string[], hits: string[]): MetricResult {
  return {
    id,
    label: METRIC_LABELS[id],
    unit: 'ratio',
    of,
    numerator: hits.length,
    denominator: population.length,
    ...(population.length > 0 ? { value: hits.length / population.length } : {}),
    ids: population,
    numeratorIds: hits,
  };
}

/** The harness a task's records came from: its first attempt's. */
function taskHarness(t: TaskFacts): string {
  return t.route.harness ?? UNKNOWN;
}

function taskCost(t: TaskFacts): { usd?: number; basis: string } {
  if (t.final?.cost.usd !== undefined) return { usd: t.final.cost.usd, basis: t.final.cost.basis };
  if (t.attempts.length > 0 && t.attempts.every((a) => a.cost.usd !== undefined)) {
    return { usd: t.attempts.reduce((s, a) => s + (a.cost.usd ?? 0), 0), basis: t.attempts[0].cost.basis };
  }
  return { basis: t.final?.cost.basis ?? 'none' };
}

function usageTokens(a: AttemptRecord): number | undefined {
  const models = Object.values(a.usage);
  if (models.length === 0) return undefined;
  let sum = 0;
  let any = false;
  for (const m of models) {
    for (const v of [m.in, m.out, m.cacheRead, m.cacheWrite]) {
      if (v !== undefined) {
        sum += v;
        any = true;
      }
    }
  }
  return any ? sum : undefined;
}

function taskTokens(t: TaskFacts): number | undefined {
  if (t.final?.tokens !== undefined) return t.final.tokens;
  if (t.attempts.length === 0) return undefined;
  let sum = 0;
  for (const a of t.attempts) {
    const n = usageTokens(a);
    if (n === undefined) return undefined;
    sum += n;
  }
  return sum;
}

/** A per-item mean over the items that reported, or not-reported when none did. */
function meanResult(
  id: MetricId,
  unit: 'usd-per' | 'tokens-per',
  of: string,
  items: { id: string; value?: number; harness: string }[],
): MetricResult {
  const known = items.filter((i) => i.value !== undefined);
  const missing = items.filter((i) => i.value === undefined);
  const sum = known.reduce((s, i) => s + (i.value ?? 0), 0);
  let value: MetricResult['value'];
  if (known.length > 0) value = sum / known.length;
  else if (missing.length > 0) value = notReported(missing.map((m) => m.harness));
  return {
    id,
    label: METRIC_LABELS[id],
    unit,
    of,
    numerator: sum,
    denominator: known.length,
    ...(value !== undefined ? { value } : {}),
    ids: items.map((i) => i.id),
    numeratorIds: known.map((i) => i.id),
    ...(missing.length > 0 ? { missing: { ids: missing.map((m) => m.id), harnesses: notReported(missing.map((m) => m.harness)).harnesses } } : {}),
  };
}

/** A sum over the items that have the field. `provider`: the field is the harness's, so a gap is "not reported". */
function sumResult(
  id: MetricId,
  unit: 'usd' | 'ms' | 'count',
  of: string,
  items: { id: string; value?: number; harness: string }[],
  provider: boolean,
): MetricResult {
  const known = items.filter((i) => i.value !== undefined);
  const missing = items.filter((i) => i.value === undefined);
  const sum = known.reduce((s, i) => s + (i.value ?? 0), 0);
  let value: MetricResult['value'];
  if (known.length > 0) value = sum;
  else if (missing.length > 0 && provider) value = notReported(missing.map((m) => m.harness));
  return {
    id,
    label: METRIC_LABELS[id],
    unit,
    of,
    numerator: sum,
    denominator: known.length,
    ...(value !== undefined ? { value } : {}),
    ids: items.map((i) => i.id),
    numeratorIds: known.filter((i) => (i.value ?? 0) > 0).map((i) => i.id),
    ...(missing.length > 0 ? { missing: { ids: missing.map((m) => m.id), harnesses: provider ? notReported(missing.map((m) => m.harness)).harnesses : [] } } : {}),
  };
}

function distribution(id: MetricId, of: string, items: { id: string; key: string }[]): MetricResult {
  const buckets = groupBy(items, (i) => i.key).map((g) => ({ key: g.key, count: g.items.length, ids: g.items.map((i) => i.id) }));
  return {
    id,
    label: METRIC_LABELS[id],
    unit: 'distribution',
    of,
    numerator: items.length,
    denominator: items.length,
    ...(items.length > 0 ? { value: buckets.length } : {}),
    ids: items.map((i) => i.id),
    numeratorIds: items.map((i) => i.id),
    buckets,
  };
}

/** One §17 metric over the cohort the filter selects. */
export function computeMetric(ds: AnalyticsDataset, f: AnalyticsFilter, id: MetricId): MetricResult {
  const tasks = filterTasks(ds, f);
  const finished = tasks.filter(isFinished);
  const done = tasks.filter(isDone);
  const withAttempts = tasks.filter((t) => t.attempts.length > 0);
  const attempts = () => filterAttempts(ds, f);
  switch (id) {
    case 'first-attempt-success':
      return ratioResult(
        id,
        'finished tasks',
        finished.map((t) => t.final.id),
        finished.filter((t) => t.final.outcome === 'done' && t.final.firstAttemptPass && t.final.acceptedBy !== 'user').map((t) => t.final.id),
      );
    case 'eventual-success':
      return ratioResult(id, 'finished tasks', finished.map((t) => t.final.id), done.filter(isFinished).map((t) => t.final.id));
    case 'escalation-rate': {
      const stepped = withAttempts.filter((t) => tierOrEffortSteps(t).length > 0);
      const r = ratioResult(id, 'tasks', withAttempts.map((t) => t.key), stepped.map((t) => t.key));
      return { ...r, numeratorIds: stepped.flatMap((t) => tierOrEffortSteps(t).map((e) => e.id)) };
    }
    case 'cost-per-success': {
      const items = done.map((t) => ({ id: t.final!.id, value: taskCost(t).usd, harness: taskHarness(t) }));
      const r = meanResult(id, 'usd-per', 'successful tasks', items);
      const buckets = groupBy(done, (t) => taskCost(t).basis).map((g) => ({ key: g.key, count: g.items.length, ids: g.items.map((t) => t.final!.id) }));
      return { ...r, buckets };
    }
    case 'tokens-per-success':
      return meanResult(id, 'tokens-per', 'successful tasks', done.map((t) => ({ id: t.final!.id, value: taskTokens(t), harness: taskHarness(t) })));
    case 'model-distribution':
      return distribution(id, 'attempts', attempts().map(({ attempt }) => ({ id: attempt.id, key: attempt.target.model })));
    case 'effort-distribution':
      return distribution(id, 'attempts', attempts().map(({ attempt }) => ({ id: attempt.id, key: attempt.target.effortRequested ?? attempt.target.effortApplied ?? UNKNOWN })));
    case 'verification-rejection': {
      const verified = attempts().filter(({ attempt }) => attempt.verification.some((v) => !v.skipped && v.outcome !== 'unavailable'));
      return ratioResult(
        id,
        'verified attempts',
        verified.map(({ attempt }) => attempt.id),
        verified.filter(({ attempt }) => attempt.verification.some((v) => v.outcome === 'failed' && !v.preExisting && !v.skipped)).map(({ attempt }) => attempt.id),
      );
    }
    case 'escalation-cost': {
      const all = attempts().map(({ attempt }) => ({ id: attempt.id, value: attempt.cost.usd, harness: attempt.target.harness, later: attempt.n > 1 }));
      const total = sumResult(id, 'usd', 'attempts', all, true);
      const later = all.filter((a) => a.later && a.value !== undefined);
      if (isNotReported(total.value) || total.value === undefined) return total;
      return {
        ...total,
        of: 'total cost',
        numerator: later.reduce((s, a) => s + (a.value ?? 0), 0),
        denominator: total.numerator,
        value: later.reduce((s, a) => s + (a.value ?? 0), 0),
        numeratorIds: later.map((a) => a.id),
      };
    }
    case 'active-time':
      return sumResult(id, 'ms', 'attempts', attempts().map(({ attempt }) => ({ id: attempt.id, value: attempt.activeMs, harness: attempt.target.harness })), false);
    case 'queue-time':
      return sumResult(id, 'ms', 'attempts', attempts().map(({ attempt }) => ({ id: attempt.id, value: attempt.queueMs, harness: attempt.target.harness })), false);
    case 'waiting-on-human':
      // Written only when there was a wait: absent on an attempt with an active time is none.
      return sumResult(
        id,
        'ms',
        'attempts',
        attempts().map(({ attempt }) => ({ id: attempt.id, value: attempt.waitedOnHumanMs ?? (attempt.activeMs !== undefined ? 0 : undefined), harness: attempt.target.harness })),
        false,
      );
    case 'retry-rate':
      return ratioResult(id, 'tasks', withAttempts.map((t) => t.key), withAttempts.filter((t) => t.attempts.length > 1).map((t) => t.key));
    case 'crashes': {
      const list = attempts();
      return ratioResult(
        id,
        'attempts',
        list.map(({ attempt }) => attempt.id),
        list.filter(({ attempt }) => attempt.outcome === 'interrupted' || attempt.category === 'infra' || attempt.category === 'lost').map(({ attempt }) => attempt.id),
      );
    }
    case 'merge-conflicts': {
      const merges = tasks.flatMap((t) => t.integrations).filter((i) => i.event === 'merged' || i.event === 'conflict' || i.event === 'error');
      return ratioResult(id, 'merges', merges.map((i) => i.id), merges.filter((i) => i.event === 'conflict').map((i) => i.id));
    }
    case 'overrides': {
      const missions = new Set(tasks.map((t) => t.missionId));
      const records = [...tasks.flatMap((t) => t.overrides), ...[...missions].flatMap((m) => ds.missionOverrides.get(m) ?? [])];
      return {
        id,
        label: METRIC_LABELS[id],
        unit: 'count',
        of: 'tasks',
        numerator: records.length,
        denominator: tasks.length,
        ...(tasks.length > 0 ? { value: records.length } : {}),
        ids: tasks.map((t) => t.key),
        numeratorIds: records.map((r) => r.id),
      };
    }
    case 'permission-interruptions':
      return sumResult(
        id,
        'count',
        'attempts',
        attempts().map(({ attempt }) => {
          const turns = ds.turnsByAttempt.get(attempt.attemptId);
          const fromTurns = turns?.some((t) => t.permissionAsks !== undefined) ? turns.reduce((s, t) => s + (t.permissionAsks ?? 0), 0) : undefined;
          return { id: attempt.id, value: attempt.permissionAsks ?? fromTurns, harness: attempt.target.harness };
        }),
        true,
      );
    case 'human-rescue': {
      const rescued = finished.filter((t) => rescueEvidence(t).ids.length > 0);
      const r = ratioResult(id, 'finished tasks', finished.map((t) => t.final.id), rescued.map((t) => t.final.id));
      return { ...r, numeratorIds: rescued.flatMap((t) => rescueEvidence(t).ids) };
    }
  }
}

export function computeMetrics(ds: AnalyticsDataset, f: AnalyticsFilter, ids: readonly MetricId[] = METRIC_IDS): MetricResult[] {
  return ids.map((id) => computeMetric(ds, f, id));
}

/** One metric per value of a dimension: the breakdown behind a number. */
export function metricByGroup(ds: AnalyticsDataset, f: AnalyticsFilter, id: MetricId, dim: GroupDimension): { key: string; result: MetricResult }[] {
  return dimensionValues(ds, dim)
    .map((key) => ({ key, result: computeMetric(ds, withGroup(f, dim, key), id) }))
    .filter((g) => g.result.ids.length > 0);
}

/** The filter narrowed to one group of a dimension. */
export function withGroup(f: AnalyticsFilter, dim: GroupDimension, key: string): AnalyticsFilter {
  switch (dim) {
    case 'kind':
    case 'tier':
    case 'effort':
    case 'model':
    case 'repository':
    case 'harness':
      return { ...f, [dim]: key };
    case 'location':
      return { ...f, location: key as 'hosted' | 'local' };
    case 'mission':
      return { ...f, missionId: key };
    case 'month': {
      const [y, m] = key.split('-').map(Number);
      return { ...f, from: Math.max(f.from ?? -Infinity, Date.UTC(y, m - 1, 1)), to: Math.min(f.to ?? Infinity, Date.UTC(y, m, 1)) };
    }
    case 'assessorVersion':
      return { ...f, assessorVersion: key };
    default:
      return { ...f, dimensions: { ...f.dimensions, [dim.slice('dim:'.length)]: key } };
  }
}

// ---------------------------------------------------------------------------
// Hosted vs local
// ---------------------------------------------------------------------------

export interface LocationSide {
  location: 'hosted' | 'local';
  attempts: number;
  succeeded: number;
  successRate?: number;
  /** Σ reported cost; local attempts are `$0 API cost` by rule. */
  costUsd?: number | NotReported;
  /** Local only: what the hosted route would have cost, an estimate. */
  apiEquivalentUsd?: number;
  ids: string[];
}

export interface HostedLocalSplit {
  hosted: LocationSide;
  local: LocationSide;
  /** Direct calls to a local endpoint (planner, completion, qualification). */
  localCalls: { total: number; ok: number; fellBackToHosted: number; ids: string[] };
  /** Nothing ran locally in the cohort. */
  noLocal: boolean;
}

/** Hosted against local attempts (§19.4). The filter's own location is ignored, or one side would always be empty. */
export function hostedLocalSplit(ds: AnalyticsDataset, f: AnalyticsFilter): HostedLocalSplit {
  const { location: _ignored, ...rest } = f;
  const list = filterAttempts(ds, rest);
  const side = (location: 'hosted' | 'local'): LocationSide => {
    const of = list.filter(({ attempt }) => (attempt.local ? 'local' : attempt.target.location) === location).map(({ attempt }) => attempt);
    const succeeded = of.filter((a) => a.outcome === 'succeeded').length;
    const known = of.filter((a) => a.cost.usd !== undefined);
    const apiEq = of.filter((a) => a.local?.apiEquivalentUsd !== undefined);
    let costUsd: LocationSide['costUsd'];
    if (known.length > 0) costUsd = known.reduce((s, a) => s + (a.cost.usd ?? 0), 0);
    else if (of.length > 0) costUsd = notReported(of.map((a) => a.target.harness));
    return {
      location,
      attempts: of.length,
      succeeded,
      ...(of.length > 0 ? { successRate: succeeded / of.length } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(apiEq.length > 0 ? { apiEquivalentUsd: apiEq.reduce((s, a) => s + (a.local?.apiEquivalentUsd ?? 0), 0) } : {}),
      ids: of.map((a) => a.id),
    };
  };
  const calls = ds.localCalls.filter((c) => inTime(c.at, f) && (f.model === undefined || c.model === f.model));
  const hosted = side('hosted');
  const local = side('local');
  return {
    hosted,
    local,
    localCalls: { total: calls.length, ok: calls.filter((c) => c.ok).length, fellBackToHosted: calls.filter((c) => c.fellBackToHosted).length, ids: calls.map((c) => c.id) },
    noLocal: local.attempts === 0 && calls.length === 0,
  };
}

// ---------------------------------------------------------------------------
// The calibration report (§17 routing quality)
// ---------------------------------------------------------------------------

export type CalibrationReason = 'escalation' | 'rescue' | 'expert-small-diff' | 'shadow-wanted-cheaper';

export interface CalibrationEntry {
  direction: 'under' | 'over';
  reason: CalibrationReason;
  /** Over-routing is a heuristic: the cheaper counterfactual is never observed (§17). */
  heuristic: boolean;
  missionId: string;
  taskId: string;
  taskKey: string;
  kind?: string;
  /** The values that triggered it, e.g. `{ tier: 'expert', complexity: 'routine', filesChanged: 1 }`. */
  triggers: Record<string, string | number | boolean>;
  /** Record ids behind it. */
  evidence: string[];
}

export interface AgreementRow {
  key: string;
  /** Decisions (or attempts) in the row. */
  decisions: number;
  /** Of them, how many agreed: no change on this dimension, or the proposal taken as offered. */
  agreed: number;
  rate?: number;
  meanScopeAccuracy?: number;
  evidence: string[];
}

export interface CalibrationReport {
  under: CalibrationEntry[];
  over: CalibrationEntry[];
  agreement: {
    /** Per route dimension a person changed: agreed = decisions that kept it. */
    byDimension: AgreementRow[];
    /** Per assessor version: agreed = decisions whose route was not changed. */
    byAssessorVersion: AgreementRow[];
    /** Mean fraction of changed files inside the predicted scope. */
    scopeAccuracy: { mean?: number; n: number; evidence: string[] };
  };
}

export interface CalibrationOptions {
  /** The tier from which a trivial task is suspect. Default `expert`. */
  expertTier?: TierName;
  /** A diff at most this big is "small". Defaults: 3 files, 100 changed lines. */
  smallDiff?: { files: number; lines: number };
}

export const DEFAULT_SMALL_DIFF = { files: 3, lines: 100 };
const LOW_COMPLEXITY: ReadonlySet<string> = new Set(['trivial', 'routine']);
const ROUTE_DIMENSIONS: readonly RouteDimension[] = ['tier', 'effort', 'model', 'harness'];

export function calibrationReport(ds: AnalyticsDataset, f: AnalyticsFilter, opts: CalibrationOptions = {}): CalibrationReport {
  const tasks = filterTasks(ds, f);
  const expertRank = rankIn(ds.tiers, opts.expertTier ?? 'expert') >= 0 ? rankIn(ds.tiers, opts.expertTier ?? 'expert') : ds.tiers.length - 1;
  const small = opts.smallDiff ?? DEFAULT_SMALL_DIFF;

  const under: CalibrationEntry[] = [];
  const over: CalibrationEntry[] = [];
  for (const t of tasks) {
    const base = { missionId: t.missionId, taskId: t.taskId, taskKey: t.key, ...(t.dims.kind ? { kind: t.dims.kind } : {}) };
    const firstRoute = { ...(t.route.tier ? { tier: t.route.tier } : {}), ...(t.route.effort ? { effort: t.route.effort } : {}), ...(t.dims.complexity ? { complexity: t.dims.complexity } : {}) };
    const steps = tierOrEffortSteps(t);
    const rescue = rescueEvidence(t);
    if (steps.length > 0 || rescue.ids.length > 0) {
      under.push({
        ...base,
        direction: 'under',
        reason: steps.length > 0 ? 'escalation' : 'rescue',
        heuristic: false,
        triggers: {
          ...firstRoute,
          ...(steps.length > 0 ? { steps: steps.map((e) => `${e.action}${e.delta?.tier ? `→${e.delta.tier}` : e.delta?.effort ? `→${e.delta.effort}` : ''}`).join(', ') } : {}),
          ...(steps.length > 0 ? { after: [...new Set(steps.map((e) => e.category))].join(', ') } : {}),
          ...(rescue.signals.length > 0 ? { rescue: rescue.signals.join(', ') } : {}),
          ...(t.final ? { outcome: t.final.outcome } : {}),
        },
        evidence: [...(t.first ? [t.first.id] : []), ...steps.map((e) => e.id), ...rescue.ids, ...(t.final ? [t.final.id] : [])].filter(uniq),
      });
    }
    const first = t.first;
    const git = first?.git;
    if (
      first &&
      rankIn(ds.tiers, first.target.tier) >= expertRank &&
      LOW_COMPLEXITY.has(t.dims.complexity ?? '') &&
      t.final?.outcome === 'done' &&
      t.final.firstAttemptPass &&
      git &&
      git.filesChanged <= small.files &&
      git.insertions + git.deletions <= small.lines
    ) {
      over.push({
        ...base,
        direction: 'over',
        reason: 'expert-small-diff',
        heuristic: true,
        triggers: { tier: first.target.tier, complexity: t.dims.complexity!, filesChanged: git.filesChanged, lines: git.insertions + git.deletions, firstAttemptPass: true },
        evidence: [first.id, t.final.id],
      });
    }
  }

  // Shadow disagreements where the router wanted cheaper and the dearer route passed first time.
  const keys = new Set(tasks.map((t) => t.key));
  const scoped = ds.records.filter((r) => (r.type === 'routing' || r.type === 'attempt') && keys.has(`${r.missionId}|${r.taskId}`));
  const rows = compareDecisions(scoped, ds.tiers);
  for (const row of rows) {
    if (row.direction !== 'router-cheaper' || row.outcome !== 'passed-first') continue;
    const r = row.routing;
    over.push({
      direction: 'over',
      reason: 'shadow-wanted-cheaper',
      heuristic: true,
      missionId: r.missionId,
      taskId: r.taskId,
      taskKey: `${r.missionId}|${r.taskId}`,
      ...(row.kind ? { kind: row.kind } : {}),
      triggers: {
        router: `${row.predicted.tier} · ${row.predicted.effort}`,
        ran: `${row.ran.tier}${row.ran.effort ? ` · ${row.ran.effort}` : ''}`,
        changed: r.changed.join(', ') || 'none',
        mode: r.mode,
      },
      evidence: [r.id, ...(row.attempt ? [row.attempt.id] : [])],
    });
  }

  const byDimension: AgreementRow[] = ROUTE_DIMENSIONS.map((dim) => {
    const changed = rows.filter((row) => row.routing.changed.includes(dim));
    return {
      key: dim,
      decisions: rows.length,
      agreed: rows.length - changed.length,
      ...(rows.length > 0 ? { rate: (rows.length - changed.length) / rows.length } : {}),
      evidence: changed.map((row) => row.routing.id),
    };
  });

  const scopeAttempts = filterAttempts(ds, f).filter(({ attempt }) => attempt.scopeAccuracy !== undefined).map(({ attempt }) => attempt);
  const mean = (list: AttemptRecord[]) => (list.length > 0 ? list.reduce((s, a) => s + (a.scopeAccuracy ?? 0), 0) / list.length : undefined);

  const byAssessorVersion: AgreementRow[] = groupBy(rows, (row) => row.attempt?.assessment?.assessorVersion ?? UNKNOWN).map((g) => {
    const agreed = g.items.filter((row) => row.routing.agreement === 'accepted' || row.routing.agreement === 'matched').length;
    const scope = mean(scopeAttempts.filter((a) => (a.assessment?.assessorVersion ?? UNKNOWN) === g.key));
    return {
      key: g.key,
      decisions: g.items.length,
      agreed,
      rate: agreed / g.items.length,
      ...(scope !== undefined ? { meanScopeAccuracy: scope } : {}),
      evidence: g.items.flatMap((row) => [row.routing.id, ...(row.attempt ? [row.attempt.id] : [])]),
    };
  });

  const scopeMean = mean(scopeAttempts);
  return {
    under,
    over,
    agreement: {
      byDimension,
      byAssessorVersion,
      scopeAccuracy: { ...(scopeMean !== undefined ? { mean: scopeMean } : {}), n: scopeAttempts.length, evidence: scopeAttempts.map((a) => a.id) },
    },
  };
}

function uniq<T>(v: T, i: number, all: readonly T[]): boolean {
  return all.indexOf(v) === i;
}
