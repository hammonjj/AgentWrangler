/**
 * Automatic routing's gate and the shadow comparison report
 * (`docs/plans/intelligent-orchestration.md` §27.3, §29 P7; #42).
 *
 * Both are **pure functions over telemetry records**: the `routing` record
 * written for every decision that carries a recommendation, and the `attempt`
 * record written when an attempt ends. Nothing here reads a mission, so the
 * numbers Preferences shows are the numbers the log holds, and a test feeds
 * fixtures straight in.
 *
 * The unit is a **task's own decision**: the route a task was started on, by
 * a person or the router, or started again on by a person. An attempt an
 * escalation step launched is the ladder's choice, not the router's first
 * word, so it is left out of both the count and the comparison.
 *
 * In `src/shared` because Preferences renders what these return.
 */
import type { AttemptRecord, RoutingRecord, TelemetryRecord } from './telemetry';
import { EFFORT_LEVELS, type EffortLevel, type OutcomeCategory, type RouteDimension, type RoutingMode, type TierName } from './types';

/** What the corpus run said about this build's router (`CORPUS_STATUS`, checked by `npm test`). */
export interface CorpusStatus {
  routerVersion: string;
  assessorVersion: string;
  cards: number;
  /** Cards whose requirement landed outside their expectations. */
  failing: number;
  /** Egregious misroutes, labelled and rules-only assessments together. */
  egregious: number;
}

/** The gate's thresholds (§27.3's starting criteria), revisable with evidence. */
export interface GateCriteria {
  /** Shadow or assisted decisions on record. */
  minDecisions: number;
  /** Share of assisted proposals run without a tier change. */
  minAssistedAcceptance: number;
  /** Assisted proposals needed before that share means anything. */
  minAssistedDecisions: number;
}

export const DEFAULT_GATE_CRITERIA: GateCriteria = { minDecisions: 30, minAssistedAcceptance: 0.7, minAssistedDecisions: 10 };

export type GateCheckId = 'corpus' | 'decisions' | 'acceptance' | 'under-routing';

export interface GateCheck {
  id: GateCheckId;
  met: boolean;
  /** What the criterion is, e.g. "At least 30 shadow or assisted decisions". */
  label: string;
  /** What the record says, e.g. "12 of 30". */
  value: string;
  /** Why it is not met, when it is not. */
  detail?: string;
}

export interface GateResult {
  met: boolean;
  checks: GateCheck[];
  /** The numbers the checks read, for an override to record. */
  numbers: {
    decisions: number;
    assisted: number;
    assistedKeptTier: number;
    underRoutedKinds: string[];
    corpus?: CorpusStatus;
  };
}

/** The records the gate and the report read. Anything else in the log is ignored. */
export type EvidenceRecord = RoutingRecord | AttemptRecord;

export function isEvidenceRecord(r: TelemetryRecord): r is EvidenceRecord {
  return r.type === 'routing' || r.type === 'attempt';
}

export interface EvidenceInput {
  records: readonly EvidenceRecord[];
  /** Tier names, weakest first (the catalog's order). */
  tiers: readonly TierName[];
}

export interface GateInput extends EvidenceInput {
  corpus: CorpusStatus | undefined;
  /** The router and assessor this build runs: a corpus result for another is not evidence. */
  routerVersion: string;
  assessorVersion: string;
  criteria?: Partial<GateCriteria>;
}

// ---------------------------------------------------------------------------
// The comparison report
// ---------------------------------------------------------------------------

/**
 * How the route that ran compares with the router's, in cost:
 * `router-cheaper` — the router wanted a lower tier (or the same tier with
 * less effort) than ran; `router-dearer` the reverse; `sideways` — same tier
 * and effort, another model or harness; `agreed` — the same route.
 */
export type RouteDirection = 'agreed' | 'router-cheaper' | 'router-dearer' | 'sideways' | 'unknown';

/** How the task went from that decision. */
export type ComparisonOutcome = 'passed-first' | 'needed-escalation' | 'failed-other' | 'cancelled' | 'interrupted' | 'running';

export interface ComparisonRow {
  missionId: string;
  taskId: string;
  attemptN: number;
  mode: RoutingMode;
  /** The task's kind as assessed. Absent until its attempt ended with an assessment on record. */
  kind?: string;
  predicted: { tier: TierName; effort: EffortLevel; model?: string };
  ran: { tier: TierName; effort?: EffortLevel; model: string };
  direction: RouteDirection;
  changed: RouteDimension[];
  outcome: ComparisonOutcome;
}

export interface ComparisonTally {
  decisions: number;
  disagreements: number;
  routerCheaper: number;
  routerDearer: number;
  sideways: number;
  /** Outcomes of the disagreements. */
  passedFirst: number;
  neededEscalation: number;
}

/** One of the two named patterns (§27.3), with what happened. */
export interface ComparisonPattern {
  direction: 'router-cheaper' | 'router-dearer';
  /** "Router wanted cheaper, you went more expensive". */
  label: string;
  count: number;
  passedFirst: number;
  neededEscalation: number;
  other: number;
  /** What the outcomes suggest, in one sentence. */
  reading: string;
}

export interface ComparisonReport {
  rows: ComparisonRow[];
  total: ComparisonTally;
  patterns: ComparisonPattern[];
  /** By task kind, most disagreements first. */
  byKind: ({ kind: string } & ComparisonTally)[];
  /** By route dimension a person changed, most first. */
  byDimension: { dimension: RouteDimension; count: number; passedFirst: number; neededEscalation: number }[];
}

/**
 * A failure that says the route was too weak for the work: the result was
 * wrong, empty, went round in circles, or did not fit the context window.
 * Infrastructure, capacity, budget and policy stops say nothing about the
 * route; ambiguity is the task's, not the model's.
 */
const ROUTE_FAILURES: readonly OutcomeCategory[] = ['quality-new', 'quality-repeat', 'empty', 'stuck', 'context'];

/**
 * Each task's own decision: the routing record of the first attempt it was
 * started on, with that attempt's record once it has ended. One per task, so
 * a resume, a retry or an escalation step does not count the same judgement
 * twice; a record from an escalation step is never a task's first.
 */
function ownDecisions(input: EvidenceInput): { routing: RoutingRecord; attempt?: AttemptRecord }[] {
  const attempts = new Map<string, AttemptRecord>();
  const first = new Map<string, RoutingRecord>();
  for (const r of input.records) {
    if (r.type === 'attempt') attempts.set(`${r.missionId}|${r.taskId}|${r.n}`, r);
  }
  for (const r of input.records) {
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

function rank(list: readonly string[], v: string | undefined): number {
  return v === undefined ? -1 : list.indexOf(v);
}

function directionOf(
  tiers: readonly TierName[],
  predicted: { tier: TierName; effort: EffortLevel },
  ran: { tier: TierName; effort?: EffortLevel },
  changed: readonly RouteDimension[],
): RouteDirection {
  const pt = rank(tiers, predicted.tier);
  const rt = rank(tiers, ran.tier);
  if (pt < 0 || rt < 0) return predicted.tier === ran.tier ? (changed.length > 0 ? 'sideways' : 'agreed') : 'unknown';
  if (pt < rt) return 'router-cheaper';
  if (pt > rt) return 'router-dearer';
  const pe = rank(EFFORT_LEVELS, predicted.effort);
  const re = rank(EFFORT_LEVELS, ran.effort);
  if (pe >= 0 && re >= 0 && pe !== re) return pe < re ? 'router-cheaper' : 'router-dearer';
  return changed.length > 0 ? 'sideways' : 'agreed';
}

function outcomeOf(a: AttemptRecord | undefined): ComparisonOutcome {
  if (!a) return 'running';
  if (a.outcome === 'succeeded') return 'passed-first';
  if (a.outcome === 'cancelled') return 'cancelled';
  if (a.outcome === 'interrupted') return 'interrupted';
  return a.category && ROUTE_FAILURES.includes(a.category) ? 'needed-escalation' : 'failed-other';
}

function tally(): ComparisonTally {
  return { decisions: 0, disagreements: 0, routerCheaper: 0, routerDearer: 0, sideways: 0, passedFirst: 0, neededEscalation: 0 };
}

function add(t: ComparisonTally, row: ComparisonRow): void {
  t.decisions++;
  if (row.direction === 'agreed') return;
  t.disagreements++;
  if (row.direction === 'router-cheaper') t.routerCheaper++;
  else if (row.direction === 'router-dearer') t.routerDearer++;
  else if (row.direction === 'sideways') t.sideways++;
  if (row.outcome === 'passed-first') t.passedFirst++;
  if (row.outcome === 'needed-escalation') t.neededEscalation++;
}

/**
 * For each task's own decision: what the router predicted, what ran, and how
 * it went (§27.3). Decisions the router made itself (`auto`, or an accepted
 * proposal) are counted as agreeing; a recommendation that was not a route
 * (`needs-human`, `blocked`) has nothing to compare and is left out.
 */
export function comparisonReport(input: EvidenceInput): ComparisonReport {
  const rows: ComparisonRow[] = [];
  for (const { routing: r, attempt: a } of ownDecisions(input)) {
    if (r.verdict !== 'route' || r.agreement === 'no-recommendation') continue;
    const predicted = { tier: r.requirement.minTier, effort: r.requirement.effort, ...(r.recommended ? { model: r.recommended.model } : {}) };
    const ranEffort = a?.target.effortRequested ?? r.ranEffort;
    const ran = { tier: r.ran.tier, ...(ranEffort ? { effort: ranEffort } : {}), model: r.ran.model };
    // The requirement's tier is the floor the router asked for; the tier it resolved to is what it picked.
    const picked = { tier: r.recommended?.tier ?? predicted.tier, effort: predicted.effort };
    rows.push({
      missionId: r.missionId,
      taskId: r.taskId,
      attemptN: r.attemptN,
      mode: r.mode,
      ...(a?.assessment?.dimensions.kind ? { kind: a.assessment.dimensions.kind.value } : {}),
      predicted: { ...predicted, tier: picked.tier },
      ran,
      direction: directionOf(input.tiers, picked, ran, r.changed),
      changed: [...r.changed],
      outcome: outcomeOf(a),
    });
  }

  const total = tally();
  const kinds = new Map<string, ComparisonTally>();
  const dims = new Map<RouteDimension, { count: number; passedFirst: number; neededEscalation: number }>();
  for (const row of rows) {
    add(total, row);
    const k = row.kind ?? 'not yet assessed';
    if (!kinds.has(k)) kinds.set(k, tally());
    add(kinds.get(k)!, row);
    for (const d of row.changed) {
      const e = dims.get(d) ?? { count: 0, passedFirst: 0, neededEscalation: 0 };
      e.count++;
      if (row.outcome === 'passed-first') e.passedFirst++;
      if (row.outcome === 'needed-escalation') e.neededEscalation++;
      dims.set(d, e);
    }
  }

  const pattern = (direction: 'router-cheaper' | 'router-dearer'): ComparisonPattern => {
    const of = rows.filter((r) => r.direction === direction);
    const passedFirst = of.filter((r) => r.outcome === 'passed-first').length;
    const neededEscalation = of.filter((r) => r.outcome === 'needed-escalation').length;
    const cheaper = direction === 'router-cheaper';
    let reading: string;
    if (of.length === 0) reading = 'None yet.';
    else if (cheaper) {
      reading =
        neededEscalation > 0
          ? `${neededEscalation} still needed escalation on the dearer route: evidence the router under-routes ${neededEscalation === 1 ? 'that kind' : 'those kinds'}.`
          : passedFirst === of.length
            ? 'All passed first time: possibly over-routed by hand.'
            : 'Mixed outcomes.';
    } else {
      reading =
        neededEscalation > 0
          ? `${neededEscalation} needed escalation on the cheaper route: the router was right.`
          : passedFirst === of.length
            ? 'All passed first time on the cheaper route: the router may over-route these.'
            : 'Mixed outcomes.';
    }
    return {
      direction,
      label: cheaper ? 'Router wanted cheaper, the route that ran was dearer' : 'Router wanted more, the route that ran was cheaper',
      count: of.length,
      passedFirst,
      neededEscalation,
      other: of.length - passedFirst - neededEscalation,
      reading,
    };
  };

  return {
    rows,
    total,
    patterns: [pattern('router-cheaper'), pattern('router-dearer')],
    byKind: [...kinds.entries()].map(([kind, t]) => ({ kind, ...t })).sort((a, b) => b.disagreements - a.disagreements || b.decisions - a.decisions || a.kind.localeCompare(b.kind)),
    byDimension: [...dims.entries()].map(([dimension, e]) => ({ dimension, ...e })).sort((a, b) => b.count - a.count || a.dimension.localeCompare(b.dimension)),
  };
}

// ---------------------------------------------------------------------------
// The gate (§27.3)
// ---------------------------------------------------------------------------

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/**
 * Whether the record supports turning automatic routing on (§27.3):
 *
 * 1. the corpus is green with zero egregious misroutes, for the router and
 *    assessor this build runs;
 * 2. at least `minDecisions` shadow or assisted decisions;
 * 3. at least `minAssistedAcceptance` of assisted proposals run without a
 *    tier change, over at least `minAssistedDecisions` of them;
 * 4. no task kind where the router recommended a cheaper route than the one
 *    that ran, and the route that ran still needed escalation.
 */
export function evaluateGate(input: GateInput): GateResult {
  const c = { ...DEFAULT_GATE_CRITERIA, ...input.criteria };
  const decisions = ownDecisions(input).filter((d) => d.routing.mode !== 'auto' && d.routing.verdict === 'route' && d.routing.agreement !== 'no-recommendation');
  const assisted = decisions.filter((d) => d.routing.mode === 'assisted');
  const keptTier = assisted.filter((d) => d.routing.agreement !== 'changed-tier').length;
  const report = comparisonReport(input);
  const underRouted = [
    ...new Set(report.rows.filter((r) => r.direction === 'router-cheaper' && r.outcome === 'needed-escalation').map((r) => r.kind ?? 'not yet assessed')),
  ].sort();

  const checks: GateCheck[] = [];
  const corpus = input.corpus;
  const corpusStale = corpus && (corpus.routerVersion !== input.routerVersion || corpus.assessorVersion !== input.assessorVersion);
  checks.push({
    id: 'corpus',
    met: !!corpus && !corpusStale && corpus.failing === 0 && corpus.egregious === 0,
    label: 'Routing corpus green, zero egregious misroutes',
    value: corpus ? `${corpus.cards - corpus.failing}/${corpus.cards} cards · ${corpus.egregious} egregious` : 'not run',
    ...(!corpus
      ? { detail: 'No corpus result for this build.' }
      : corpusStale
        ? { detail: `The corpus result is for ${corpus.routerVersion}/${corpus.assessorVersion}; this build routes with ${input.routerVersion}/${input.assessorVersion}.` }
        : corpus.failing > 0 || corpus.egregious > 0
          ? { detail: `${corpus.failing} card(s) outside expectations, ${corpus.egregious} egregious.` }
          : {}),
  });
  checks.push({
    id: 'decisions',
    met: decisions.length >= c.minDecisions,
    label: `At least ${c.minDecisions} shadow or assisted decisions`,
    value: `${decisions.length} of ${c.minDecisions}`,
    ...(decisions.length < c.minDecisions ? { detail: `${c.minDecisions - decisions.length} more needed.` } : {}),
  });
  const rate = assisted.length > 0 ? keptTier / assisted.length : 0;
  const enoughAssisted = assisted.length >= c.minAssistedDecisions;
  checks.push({
    id: 'acceptance',
    met: enoughAssisted && rate >= c.minAssistedAcceptance,
    label: `At least ${pct(c.minAssistedAcceptance)} of assisted proposals run without a tier change`,
    value: assisted.length > 0 ? `${pct(rate)} (${keptTier} of ${assisted.length})` : 'no assisted proposals yet',
    ...(!enoughAssisted
      ? { detail: `Needs at least ${c.minAssistedDecisions} assisted proposals to judge; ${assisted.length} so far.` }
      : rate < c.minAssistedAcceptance
        ? { detail: `${assisted.length - keptTier} of ${assisted.length} had their tier changed.` }
        : {}),
  });
  checks.push({
    id: 'under-routing',
    met: underRouted.length === 0,
    label: 'No task kind the router under-routes',
    value: underRouted.length === 0 ? 'none' : underRouted.join(', '),
    ...(underRouted.length > 0
      ? { detail: `The router wanted a cheaper route than ran, and the route that ran still needed escalation: ${underRouted.join(', ')}.` }
      : {}),
  });
  return {
    met: checks.every((x) => x.met),
    checks,
    numbers: { decisions: decisions.length, assisted: assisted.length, assistedKeptTier: keptTier, underRoutedKinds: underRouted, ...(corpus ? { corpus } : {}) },
  };
}

/** The gate's checks as lines, e.g. for an override's confirmation and its record. */
export function gateLines(g: GateResult): string[] {
  return g.checks.map((x) => `${x.met ? '✓' : '✗'} ${x.label}: ${x.value}`);
}

// ---------------------------------------------------------------------------
// The mode in force
// ---------------------------------------------------------------------------

/** An explicit decision to run `auto` with the gate unmet, and the numbers shown when it was made. */
export interface AutoOverride {
  at: number;
  /** `gateLines` at the time: what the user saw and accepted. */
  shown: string[];
}

/**
 * The mode a new launcher task runs in (§10.1): `auto` only while the gate is
 * met or an override stands. Settings saying `auto` without either — written
 * by hand, or the evidence changed since — run `assisted`, and say why.
 */
export function effectiveMode(
  configured: RoutingMode,
  gate: GateResult | undefined,
  override: AutoOverride | undefined,
): { mode: RoutingMode; note?: string } {
  if (configured !== 'auto') return { mode: configured };
  if (override) return { mode: 'auto' };
  if (gate?.met) return { mode: 'auto' };
  const unmet = gate ? gate.checks.filter((x) => !x.met).map((x) => `${x.label} (${x.value})`) : ['the gate could not be read'];
  return { mode: 'assisted', note: `Automatic routing is set but its gate is not met, so this task is assisted: ${unmet.join('; ')}.` };
}
