/**
 * Routing-policy proposals from historical outcomes (`docs/plans/intelligent-orchestration.md`
 * §20; #52). Learned proposes, deterministic disposes: this reads what happened
 * and says "basic has passed 23 of 25 first time for tests in this repository;
 * lower the floor?". Nothing here changes a route. A person accepts a proposal,
 * and only then does it become a rule (`learnedRules.ts`) the pure router reads.
 *
 * Pure: a dataset and a clock in, proposals out. The statistics are a
 * Beta-binomial posterior per cohort × route with a weak prior, pooled upward
 * (repository → all repositories) until a cohort has enough data. Below the
 * sample thresholds there is no proposal, and the deterministic rule applies:
 * that is the fallback, not an exception.
 */
import { isRouteFailure, rescueEvidence, type AnalyticsDataset, type TaskFacts } from './analytics';
import type { TierName } from './types';

// ---------------------------------------------------------------------------
// Thresholds (§20.3)
// ---------------------------------------------------------------------------

export const DOWNGRADE_MIN_OBSERVATIONS = 20;
export const UPGRADE_MIN_OBSERVATIONS = 10;
/** The cheaper route's lower bound must reach this for a downgrade. */
export const TARGET_SUCCESS = 0.8;
/** The current route's upper bound must be under this for an upgrade. */
export const UPGRADE_BELOW = 0.6;
/** Two-sided credible interval: the bounds are the 5th and 95th percentiles, i.e. 90% one-sided each way. */
export const BOUND_QUANTILE = 0.1;
/** The prior is worth about this many observations. */
export const PRIOR_WEIGHT = 4;
/** A success is not one until it has gone this long without being rejected or reverted. */
export const REVERT_WINDOW_MS = 14 * 86_400_000;
/** A proposal not decided in this time lapses; it comes back only if the data still says so. */
export const PROPOSAL_TTL_MS = 30 * 86_400_000;
/** A rejected proposal is not made again for this long. */
export const REJECTION_SNOOZE_MS = 30 * 86_400_000;
/** An accepted rule is re-checked against this much recent history. */
export const RULE_RECHECK_WINDOW_MS = 90 * 86_400_000;
/** A rule whose route now succeeds less often than this is flagged for review. */
export const RULE_REVIEW_BELOW = 0.6;

// ---------------------------------------------------------------------------
// Beta distribution
// ---------------------------------------------------------------------------

function logGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.001208650973866179, -0.000005395239384953];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const k of c) ser += k / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-30;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return h;
}

/** The regularised incomplete beta function: P(X ≤ x) for X ~ Beta(a, b). */
export function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betaContinuedFraction(x, a, b)) / a : 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/** The p-quantile of Beta(a, b), by bisection. */
export function betaQuantile(p: number, a: number, b: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface Posterior {
  successes: number;
  n: number;
  mean: number;
  /** 90% lower bound of the success rate. */
  lower: number;
  /** 90% upper bound of the success rate. */
  upper: number;
}

/** The posterior after `successes` of `n`, from a prior centred on `priorMean` and worth `PRIOR_WEIGHT` observations. */
export function posterior(successes: number, n: number, priorMean: number): Posterior {
  const a = priorMean * PRIOR_WEIGHT + successes;
  const b = (1 - priorMean) * PRIOR_WEIGHT + (n - successes);
  return { successes, n, mean: a / (a + b), lower: betaQuantile(BOUND_QUANTILE, a, b), upper: betaQuantile(1 - BOUND_QUANTILE, a, b) };
}

// ---------------------------------------------------------------------------
// Cohorts (§20.2)
// ---------------------------------------------------------------------------

export type ComplexityBucket = 'trivial-routine' | 'involved-hard';
export type VerifiabilityBucket = 'none-weak' | 'partial-strong';

/** What a proposal is about. `repository` absent: every repository (the pooled cohort). */
export interface CohortKey {
  kind: string;
  complexity: ComplexityBucket;
  verifiability: VerifiabilityBucket;
  repository?: string;
}

export function complexityBucket(v: string | undefined): ComplexityBucket | undefined {
  if (v === 'trivial' || v === 'routine') return 'trivial-routine';
  if (v === 'involved' || v === 'hard') return 'involved-hard';
  return undefined;
}

export function verifiabilityBucket(v: string | undefined): VerifiabilityBucket | undefined {
  if (v === 'none' || v === 'weak') return 'none-weak';
  if (v === 'partial' || v === 'strong') return 'partial-strong';
  return undefined;
}

export function cohortKeyText(c: CohortKey): string {
  return `${c.kind}|${c.complexity}|${c.verifiability}|${c.repository ?? '*'}`;
}

/** One finished task as evidence about a route in a cohort. */
export interface Observation {
  taskKey: string;
  /** Ids of the records this rests on: the task's end, its first attempt. */
  recordIds: string[];
  kind: string;
  complexity: ComplexityBucket;
  verifiability: VerifiabilityBucket;
  /** The risk the assessor gave it: a downgrade only reads risk ≤ moderate. */
  risk: string;
  repository?: string;
  /** The tier the first attempt ran on. */
  tier: TierName;
  /** The tier the router asked for. */
  policyTier: TierName;
  success: boolean;
  at: number;
}

/**
 * What a finished task says about its first route, or nothing. A success is:
 * verified on the first attempt, no human rescue, and not reverted. A success
 * counts only once it has stood for `REVERT_WINDOW_MS`; a failure counts at
 * once. A failure that is not the route's fault (capacity, infrastructure,
 * cancellation) says nothing about the route and is left out.
 */
export function observationOf(t: TaskFacts, now: number): Observation | undefined {
  const final = t.final;
  const first = t.first;
  if (!final || !first || (final.outcome !== 'done' && final.outcome !== 'failed')) return undefined;
  const tier = t.route.tier;
  const kind = t.dims.kind;
  const complexity = complexityBucket(t.dims.complexity);
  const verifiability = verifiabilityBucket(t.dims.verifiability);
  const policyTier = t.routings[0]?.requirement.minTier;
  if (!tier || !kind || !complexity || !verifiability || !policyTier) return undefined;
  // Only the router's own recommendation says what policy expected; a task its escalation ladder reran is judged by its first route.
  const routeFailed = first.outcome !== 'succeeded' && isRouteFailure(first.category);
  if (first.outcome !== 'succeeded' && !routeFailed) return undefined;
  const reverted = t.integrations.some((i) => i.event === 'reverted');
  const rescued = rescueEvidence(t).ids.length > 0;
  const success = final.outcome === 'done' && final.firstAttemptPass && first.outcome === 'succeeded' && !rescued && !reverted;
  if (success && now - final.at < REVERT_WINDOW_MS) return undefined;
  return {
    taskKey: t.key,
    recordIds: [final.id, first.id],
    kind,
    complexity,
    verifiability,
    risk: t.dims.risk ?? 'unknown',
    ...(t.repository ? { repository: t.repository } : {}),
    tier,
    policyTier,
    success,
    at: final.at,
  };
}

export function observations(ds: AnalyticsDataset, now: number): Observation[] {
  return ds.tasks.map((t) => observationOf(t, now)).filter((o): o is Observation => o !== undefined);
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export type ProposalDirection = 'downgrade' | 'upgrade';

export interface ProposalEvidence {
  cohort: CohortKey;
  /** The route the counts are about. */
  route: { tier: TierName };
  /** What the deterministic policy asked for in this cohort. */
  policyTier: TierName;
  successes: number;
  observations: number;
  /** 90% bounds of the success rate. */
  interval: { lower: number; upper: number; level: 0.9 };
  mean: number;
  /** The first and last finished task the counts rest on. */
  window: { from: number; to: number };
  /** Task keys, so a click can open the evidence. */
  taskKeys: string[];
  recordIds: string[];
  /** Observations pooled in from outside the repository (0 for a pooled cohort). */
  pooledFrom: 'repository' | 'all-repositories';
}

export interface RoutingProposal {
  /** Stable for the same cohort, direction and tiers, so a rejection can be remembered. */
  id: string;
  direction: ProposalDirection;
  cohort: CohortKey;
  fromTier: TierName;
  toTier: TierName;
  evidence: ProposalEvidence;
  createdAt: number;
  expiresAt: number;
}

export function proposalId(direction: ProposalDirection, cohort: CohortKey, from: TierName, to: TierName): string {
  return `${direction}:${cohortKeyText(cohort)}:${from}>${to}`;
}

export interface ProposalOptions {
  now: number;
  /** The tiers the router may ask for, weakest first. */
  tiers?: readonly TierName[];
}

const RISK_OK_FOR_DOWNGRADE: ReadonlySet<string> = new Set(['low', 'moderate']);

function evidenceOf(cohort: CohortKey, tier: TierName, policyTier: TierName, obs: Observation[], post: Posterior, scope: ProposalEvidence['pooledFrom']): ProposalEvidence {
  const sorted = [...obs].sort((a, b) => a.at - b.at);
  return {
    cohort,
    route: { tier },
    policyTier,
    successes: post.successes,
    observations: post.n,
    interval: { lower: post.lower, upper: post.upper, level: 0.9 },
    mean: post.mean,
    window: { from: sorted[0].at, to: sorted[sorted.length - 1].at },
    taskKeys: sorted.map((o) => o.taskKey),
    recordIds: [...new Set(sorted.flatMap((o) => o.recordIds))],
    pooledFrom: scope,
  };
}

/** The most common value, ties to the first seen. */
function modal(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** The proposals one cohort's observations support, at most one per direction. */
export function proposalsForCohort(cohort: CohortKey, obs: readonly Observation[], tiers: readonly TierName[], now: number): RoutingProposal[] {
  if (obs.length === 0) return [];
  const policyTier = modal(obs.map((o) => o.policyTier));
  const at = tiers.indexOf(policyTier);
  if (at < 0) return [];
  const scope: ProposalEvidence['pooledFrom'] = cohort.repository ? 'repository' : 'all-repositories';
  const out: RoutingProposal[] = [];
  const make = (direction: ProposalDirection, to: TierName, ev: ProposalEvidence): RoutingProposal => ({
    id: proposalId(direction, cohort, policyTier, to),
    direction,
    cohort,
    fromTier: policyTier,
    toTier: to,
    evidence: ev,
    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_MS,
  });

  // Downgrade: the next cheaper tier, only where a machine will catch its mistakes and a mistake is cheap.
  if (at > 0 && cohort.verifiability === 'partial-strong') {
    const cheaper = tiers[at - 1];
    const here = obs.filter((o) => o.tier === cheaper && RISK_OK_FOR_DOWNGRADE.has(o.risk));
    if (here.length >= DOWNGRADE_MIN_OBSERVATIONS) {
      const post = posterior(here.filter((o) => o.success).length, here.length, 0.5);
      if (post.lower >= TARGET_SUCCESS) out.push(make('downgrade', cheaper, evidenceOf(cohort, cheaper, policyTier, here, post, scope)));
    }
  }
  // Upgrade: the current route fails too often; one tier up.
  if (at < tiers.length - 1) {
    const here = obs.filter((o) => o.tier === policyTier);
    if (here.length >= UPGRADE_MIN_OBSERVATIONS) {
      const post = posterior(here.filter((o) => o.success).length, here.length, TARGET_SUCCESS);
      if (post.upper < UPGRADE_BELOW) out.push(make('upgrade', tiers[at + 1], evidenceOf(cohort, policyTier, policyTier, here, post, scope)));
    }
  }
  return out;
}

/**
 * Every proposal the history supports. Each base cohort (kind × complexity ×
 * verifiability) is judged per repository first, then pooled across
 * repositories; a repository's proposal that the pooled cohort already makes
 * is dropped, because the pooled one covers it.
 */
export function generateProposals(ds: AnalyticsDataset, opts: ProposalOptions): RoutingProposal[] {
  const tiers = opts.tiers ?? ds.tiers;
  const obs = observations(ds, opts.now);
  const bases = new Map<string, { base: CohortKey; items: Observation[] }>();
  for (const o of obs) {
    const base: CohortKey = { kind: o.kind, complexity: o.complexity, verifiability: o.verifiability };
    const key = cohortKeyText(base);
    const had = bases.get(key);
    if (had) had.items.push(o);
    else bases.set(key, { base, items: [o] });
  }
  const out: RoutingProposal[] = [];
  for (const { base, items } of bases.values()) {
    const pooled = proposalsForCohort(base, items, tiers, opts.now);
    out.push(...pooled);
    const repos = [...new Set(items.map((o) => o.repository).filter((r): r is string => r !== undefined))];
    for (const repository of repos) {
      const mine = proposalsForCohort({ ...base, repository }, items.filter((o) => o.repository === repository), tiers, opts.now);
      for (const p of mine) if (!pooled.some((q) => q.direction === p.direction && q.toTier === p.toTier && q.fromTier === p.fromTier)) out.push(p);
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** How much history a cohort has, for "not enough data yet". */
export function dataSummary(ds: AnalyticsDataset, now: number): { observations: number; finishedTasks: number; pending: number } {
  const finished = ds.tasks.filter((t) => t.final && (t.final.outcome === 'done' || t.final.outcome === 'failed')).length;
  const counted = observations(ds, now).length;
  return { observations: counted, finishedTasks: finished, pending: finished - counted };
}

// ---------------------------------------------------------------------------
// Decisions, and what an accepted proposal becomes
// ---------------------------------------------------------------------------

/** A proposal a person accepted: the rule, with the evidence it was accepted on. */
export interface LearnedRule {
  id: string;
  direction: ProposalDirection;
  cohort: CohortKey;
  fromTier: TierName;
  toTier: TierName;
  evidence: ProposalEvidence;
  acceptedAt: number;
}

export interface RejectedProposal {
  id: string;
  rejectedAt: number;
}

export function ruleFromProposal(p: RoutingProposal, acceptedAt: number): LearnedRule {
  return { id: p.id, direction: p.direction, cohort: p.cohort, fromTier: p.fromTier, toTier: p.toTier, evidence: p.evidence, acceptedAt };
}

/** Proposals not already a rule, not snoozed by a rejection, and not lapsed. */
export function pendingProposals(
  proposals: readonly RoutingProposal[],
  rules: readonly LearnedRule[],
  rejected: readonly RejectedProposal[],
  now: number,
): RoutingProposal[] {
  return proposals.filter(
    (p) =>
      p.expiresAt > now &&
      !rules.some((r) => r.id === p.id) &&
      !rejected.some((r) => r.id === p.id && now - r.rejectedAt < REJECTION_SNOOZE_MS),
  );
}

export type RuleHealth = { state: 'ok' | 'review' | 'no-recent-data'; recent?: Posterior };

/**
 * An accepted rule is re-checked against recent history: when the route it
 * sends work to now succeeds in less than `RULE_REVIEW_BELOW` of the cases
 * (with enough observations to say so), it is flagged for review rather than
 * silently kept.
 */
export function ruleHealth(rule: LearnedRule, ds: AnalyticsDataset, now: number): RuleHealth {
  const from = now - RULE_RECHECK_WINDOW_MS;
  const recent = observations(ds, now).filter(
    (o) =>
      o.at >= from &&
      o.at >= rule.acceptedAt &&
      o.kind === rule.cohort.kind &&
      o.complexity === rule.cohort.complexity &&
      o.verifiability === rule.cohort.verifiability &&
      (rule.cohort.repository === undefined || o.repository === rule.cohort.repository) &&
      o.tier === rule.toTier,
  );
  if (recent.length < UPGRADE_MIN_OBSERVATIONS) return { state: 'no-recent-data' };
  const post = posterior(recent.filter((o) => o.success).length, recent.length, TARGET_SUCCESS);
  return { state: post.upper < RULE_REVIEW_BELOW ? 'review' : 'ok', recent: post };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const pctText = (v: number): string => `${Math.round(v * 100)}%`;
const dateText = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function cohortText(c: CohortKey): string {
  const repo = c.repository ? c.repository.split(/[\\/]/).filter(Boolean).pop() ?? c.repository : 'all repositories';
  return `${c.kind} · ${c.complexity} · ${c.verifiability} verification · ${repo}`;
}

/** The proposal as a question, with its numbers. */
export function proposalText(p: Pick<RoutingProposal, 'direction' | 'fromTier' | 'toTier' | 'evidence'>): string {
  const e = p.evidence;
  const counts = `${e.route.tier} passed first time ${e.successes} of ${e.observations}`;
  return p.direction === 'downgrade'
    ? `${counts}; lower the floor from ${p.fromTier} to ${p.toTier}?`
    : `${counts}; raise the floor from ${p.fromTier} to ${p.toTier}?`;
}

export function intervalText(e: ProposalEvidence): string {
  return `${pctText(e.interval.lower)}–${pctText(e.interval.upper)} (90% interval)`;
}

export function windowText(e: ProposalEvidence): string {
  return `${dateText(e.window.from)} to ${dateText(e.window.to)}`;
}
