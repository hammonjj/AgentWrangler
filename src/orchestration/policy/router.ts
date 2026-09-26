/**
 * The router: an assessment and a policy in, a route requirement and the
 * reasons for it out (`docs/plans/intelligent-orchestration.md` §9.1–§9.3; #38).
 *
 * Pure. No catalog, no clock, no model names: the router says what the work
 * *needs* (a tier range, an effort level, hard needs and gates), and the
 * resolver (`resolver.ts`) turns that into a model. So the same assessment and
 * policy always give the same requirement and the same explanation, and every
 * worked example in §9.3 is a row in a test.
 *
 * Three rules shape it:
 *
 * - **Rules are data** (§9.3). Each is an object with an id, a predicate and an
 *   effect, evaluated in a fixed order; every rule that changes the result adds
 *   a reason carrying its id and the inputs it read. The explanation a user
 *   sees is those reasons, stored, never regenerated.
 * - **Tier and effort come from different dimensions** (§9.2, §6.4). Tier from
 *   complexity, breadth and risk; effort from complexity, verifiability and
 *   ambiguity. Nothing here infers one from the other.
 * - **A cap is never exceeded.** When what the work needs is above the
 *   mission's cap, the answer is `needs-human` with both reasons, never a
 *   quiet under-powered route and never a quiet breach.
 */
import {
  AMBIGUITY_LEVELS,
  BREADTH_LEVELS,
  COMPLEXITY_LEVELS,
  RISK_LEVELS,
  VERIFIABILITY_LEVELS,
} from './assessment';
import type { TierDef } from '../../shared/orchestration/catalog';
import {
  EFFORT_LEVELS,
  type ContextLoad,
  type EffortLevel,
  type RouteCaps,
  type RouteGate,
  type RoutePreferences,
  type RouteRequirement,
  type RoutingReason,
  type TaskAssessment,
  type TierName,
} from '../../shared/orchestration/types';

/**
 * The rules below as one version. Recorded on every decision (`policyVersion`),
 * so a decision made by an older router is never mistaken for one this build
 * would make, and a replay test can say which rules it is replaying.
 */
export const ROUTER_VERSION = 'rtr-1';

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

export interface RouterPolicy {
  /** The tier list, weakest first (`CapabilityCatalogView.tiers`). */
  tiers: readonly TierDef[];
  /** The mission's caps. Only `maxTier` and `maxEffort` are read here (#40 does the rest). */
  caps?: RouteCaps;
  preferences?: RoutePreferences;
}

export interface RouterResult {
  /** Always filled in, even for `needs-human`: the explanation needs it. */
  requirement: RouteRequirement;
  reasons: RoutingReason[];
  /**
   * `route`: resolve it. `needs-human`: the work needs more than the caps
   * allow (or a gate says a person must decide first); `needsHuman` says why.
   */
  verdict: 'route' | 'needs-human';
  needsHuman?: string;
  /** Tokens of context the route must hold, with headroom (§9.3 "Hard needs"). */
  contextTokens: number;
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

function rank<T extends string>(levels: readonly T[], value: T): number {
  const i = levels.indexOf(value);
  return i < 0 ? 0 : i;
}

/** The tiers the router may ask for: `reachableBy: 'route'`, weakest first (§6.3). */
function routeTiers(tiers: readonly TierDef[]): TierName[] {
  return tiers.filter((t) => t.reachableBy === 'route').map((t) => t.name);
}

/**
 * The three named tiers the policy is written against. The rules speak of
 * `basic`, `standard` and `expert` (§9.3); a tier list that renames or inserts
 * tiers maps onto them by position among the routable ones — weakest, second,
 * strongest — so a user's extra tier never makes a rule point at nothing.
 */
function namedTiers(tiers: readonly TierDef[]): { basic: number; standard: number; expert: number; top: number } {
  const n = routeTiers(tiers).length;
  const top = Math.max(0, n - 1);
  return { basic: 0, standard: Math.min(1, top), expert: top, top };
}

// ---------------------------------------------------------------------------
// Context (§9.3 "Hard needs")
// ---------------------------------------------------------------------------

/** The top of each `contextLoad` band (§8.2), and a figure for the open-ended last one. */
const CONTEXT_BAND_TOKENS: Record<ContextLoad, number> = {
  small: 30_000,
  medium: 100_000,
  large: 250_000,
  'very-large': 400_000,
};
/** "A context window of at least the estimate × 1.5 headroom." */
export const CONTEXT_HEADROOM = 1.5;

export function contextNeed(load: ContextLoad): number {
  return Math.round(CONTEXT_BAND_TOKENS[load] * CONTEXT_HEADROOM);
}

/** How the context need is written into `RouteRequirement.needs`. */
export const CONTEXT_NEED_PREFIX = 'context:';

/** The context need a requirement carries, or undefined when it names none. */
export function contextNeedOf(needs: readonly string[]): number | undefined {
  const n = needs.find((x) => x.startsWith(CONTEXT_NEED_PREFIX));
  const v = n ? Number(n.slice(CONTEXT_NEED_PREFIX.length)) : NaN;
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

// ---------------------------------------------------------------------------
// The rules (§9.3), as data
// ---------------------------------------------------------------------------

/** What a rule reads: the assessment's values, flattened, plus its confidences. */
export interface RuleFacts {
  complexity: number;
  breadth: number;
  risk: number;
  ambiguity: number;
  verifiability: number;
  kind: string;
  complexityConfidence: string;
  riskConfidence: string;
  values: Record<string, string>;
}

/** What a tier rule works on: an index into the routable tiers. */
interface TierState {
  score: number;
  tier: number;
  /** The rule ids that set the tier as it stands. */
  setBy: string[];
}

interface TierRule {
  id: string;
  /** Returns the new tier, or undefined when the rule does not fire. */
  apply(f: RuleFacts, s: TierState, t: ReturnType<typeof namedTiers>): number | undefined;
  text(f: RuleFacts, s: TierState, tierName: (i: number) => string, next: number): string;
  inputs(f: RuleFacts): Record<string, unknown>;
}

/**
 * Tier rules, in the order §9.3 lists them. Score and band are one rule each so
 * the explanation can say "score 2 → standard" in two steps a reader can check.
 */
export const TIER_RULES: readonly TierRule[] = [
  {
    id: 'tier.band',
    apply: (_f, s, t) => (s.score <= 0 ? t.basic : s.score <= 2 ? t.standard : t.expert),
    text: (f, s, name, next) => {
      const parts = [`complexity ${f.values.complexity} (${f.complexity})`];
      if (f.breadth >= rank(BREADTH_LEVELS, 'subsystem')) parts.push(`breadth ${f.values.breadth} (+1)`);
      if (f.risk >= rank(RISK_LEVELS, 'high')) parts.push(`risk ${f.values.risk} (+1)`);
      return `Score ${s.score} from ${parts.join(' + ')} → ${name(next)}.`;
    },
    inputs: (f) => ({ complexity: f.values.complexity, breadth: f.values.breadth, risk: f.values.risk }),
  },
  {
    id: 'floor.risk-critical',
    apply: (f, s, t) => (f.risk === rank(RISK_LEVELS, 'critical') && s.tier < t.expert ? t.expert : undefined),
    text: (_f, _s, name, next) => `Risk is critical, so at least ${name(next)}.`,
    inputs: (f) => ({ risk: f.values.risk }),
  },
  {
    id: 'floor.architecture',
    apply: (f, s, t) => ((f.kind === 'architecture' || f.kind === 'plan') && s.tier < t.expert ? t.expert : undefined),
    text: (f, _s, name, next) => `Kind is ${f.kind}: a bad plan multiplies every downstream cost, so at least ${name(next)}.`,
    inputs: (f) => ({ kind: f.kind }),
  },
  {
    id: 'floor.migration',
    apply: (f, s, t) => (f.kind === 'migration' && s.tier < t.standard ? t.standard : undefined),
    text: (_f, _s, name, next) => `Kind is migration, so at least ${name(next)}.`,
    inputs: (f) => ({ kind: f.kind }),
  },
  {
    id: 'ceiling.docs-chore',
    apply: (f, s, t) =>
      (f.kind === 'docs' || f.kind === 'chore') && f.risk < rank(RISK_LEVELS, 'high') && s.tier > t.standard ? t.standard : undefined,
    text: (f, _s, name, next) => `Kind is ${f.kind} and risk is below high, so at most ${name(next)}.`,
    inputs: (f) => ({ kind: f.kind, risk: f.values.risk }),
  },
  {
    id: 'guard.basic',
    apply: (f, s, t) =>
      s.tier === t.basic &&
      t.standard !== t.basic &&
      (f.verifiability < rank(VERIFIABILITY_LEVELS, 'partial') || f.risk > rank(RISK_LEVELS, 'moderate'))
        ? t.standard
        : undefined,
    text: (f, _s, name, next) =>
      f.verifiability < rank(VERIFIABILITY_LEVELS, 'partial')
        ? `The cheapest tier needs verifiability of at least partial, and it is ${f.values.verifiability}, so ${name(next)}.`
        : `The cheapest tier needs risk of at most moderate, and it is ${f.values.risk}, so ${name(next)}.`,
    inputs: (f) => ({ verifiability: f.values.verifiability, risk: f.values.risk }),
  },
  {
    id: 'confidence.low',
    apply: (f, s, t) => {
      if (f.complexityConfidence !== 'low' && f.riskConfidence !== 'low') return undefined;
      const next = Math.min(t.top, Math.max(s.tier + 1, t.standard));
      return next !== s.tier ? next : undefined;
    },
    text: (f, _s, name, next) => {
      const which = [f.complexityConfidence === 'low' ? 'complexity' : '', f.riskConfidence === 'low' ? 'risk' : ''].filter(Boolean).join(' and ');
      return `Low confidence in ${which}: one tier up, and never the cheapest, so ${name(next)}.`;
    },
    inputs: (f) => ({ complexityConfidence: f.complexityConfidence, riskConfidence: f.riskConfidence }),
  },
];

/** What an effort rule works on: an index into `EFFORT_LEVELS`. */
interface EffortRule {
  id: string;
  apply(f: RuleFacts, effort: number): number | undefined;
  text(f: RuleFacts, next: EffortLevel): string;
  inputs(f: RuleFacts): Record<string, unknown>;
}

const HIGH = EFFORT_LEVELS.indexOf('high');
const MAX = EFFORT_LEVELS.indexOf('max');

export const EFFORT_RULES: readonly EffortRule[] = [
  {
    id: 'effort.complexity',
    // trivial → low, routine → medium, involved → high, hard → high.
    apply: (f) => Math.min(f.complexity, HIGH),
    text: (f, next) => `Complexity ${f.values.complexity} → ${next} effort.`,
    inputs: (f) => ({ complexity: f.values.complexity }),
  },
  {
    id: 'effort.weak-verification',
    apply: (f, e) =>
      f.verifiability <= rank(VERIFIABILITY_LEVELS, 'weak') && f.complexity >= rank(COMPLEXITY_LEVELS, 'routine') && e < HIGH
        ? e + 1
        : undefined,
    text: (f, next) => `Verifiability is ${f.values.verifiability}, so the agent must check its own work: ${next} effort.`,
    inputs: (f) => ({ verifiability: f.values.verifiability, complexity: f.values.complexity }),
  },
  {
    id: 'effort.ambiguity',
    apply: (f, e) => (f.ambiguity >= rank(AMBIGUITY_LEVELS, 'underspecified') && e < HIGH ? e + 1 : undefined),
    text: (f, next) => `Ambiguity is ${f.values.ambiguity}: ${next} effort.`,
    inputs: (f) => ({ ambiguity: f.values.ambiguity }),
  },
  {
    id: 'effort.max',
    apply: (f, e) =>
      f.complexity === rank(COMPLEXITY_LEVELS, 'hard') &&
      (f.ambiguity >= rank(AMBIGUITY_LEVELS, 'underspecified') || f.verifiability <= rank(VERIFIABILITY_LEVELS, 'weak')) &&
      e < MAX
        ? MAX
        : undefined,
    text: (f) =>
      `Complexity is hard and ${f.ambiguity >= rank(AMBIGUITY_LEVELS, 'underspecified') ? `ambiguity is ${f.values.ambiguity}` : `verifiability is ${f.values.verifiability}`}: max effort.`,
    inputs: (f) => ({ complexity: f.values.complexity, ambiguity: f.values.ambiguity, verifiability: f.values.verifiability }),
  },
];

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export function ruleFacts(a: TaskAssessment): RuleFacts {
  const d = a.dimensions;
  return {
    complexity: rank(COMPLEXITY_LEVELS, d.complexity.value),
    breadth: rank(BREADTH_LEVELS, d.breadth.value),
    risk: rank(RISK_LEVELS, d.risk.value),
    ambiguity: rank(AMBIGUITY_LEVELS, d.ambiguity.value),
    verifiability: rank(VERIFIABILITY_LEVELS, d.verifiability.value),
    kind: a.kind.value,
    complexityConfidence: d.complexity.confidence,
    riskConfidence: d.risk.confidence,
    values: {
      complexity: d.complexity.value,
      breadth: d.breadth.value,
      risk: d.risk.value,
      ambiguity: d.ambiguity.value,
      verifiability: d.verifiability.value,
      contextLoad: d.contextLoad.value,
    },
  };
}

/** Assessment + policy → requirement + reasons. Pure. */
export function routeTask(assessment: TaskAssessment, policy: RouterPolicy): RouterResult {
  const f = ruleFacts(assessment);
  const tiers = routeTiers(policy.tiers);
  const named = namedTiers(policy.tiers);
  const name = (i: number) => tiers[i] ?? '(no tier)';
  const reasons: RoutingReason[] = [];

  // ---- Tier ----
  const score =
    f.complexity + (f.breadth >= rank(BREADTH_LEVELS, 'subsystem') ? 1 : 0) + (f.risk >= rank(RISK_LEVELS, 'high') ? 1 : 0);
  const s: TierState = { score, tier: 0, setBy: [] };
  for (const rule of TIER_RULES) {
    const next = rule.apply(f, s, named);
    if (next === undefined || (next === s.tier && rule.id !== 'tier.band')) continue;
    reasons.push({ ruleId: rule.id, text: rule.text(f, s, name, next), inputs: rule.inputs(f) });
    s.tier = next;
    s.setBy.push(rule.id);
  }
  // No rule produces an escalation-only tier: the list above is only the routable ones (§6.3 rule 7).
  const minTier = name(Math.min(s.tier, named.top));

  // ---- Effort (independent of tier) ----
  let effort = 0;
  for (const rule of EFFORT_RULES) {
    const next = rule.apply(f, effort);
    if (next === undefined) continue;
    effort = next;
    reasons.push({ ruleId: rule.id, text: rule.text(f, EFFORT_LEVELS[effort]), inputs: rule.inputs(f) });
  }

  // ---- Caps (§9.3 rule 6): never exceeded ----
  let verdict: RouterResult['verdict'] = 'route';
  let needsHuman: string | undefined;
  const capTier = policy.caps?.maxTier;
  const capRank = capTier !== undefined ? tiers.indexOf(capTier) : -1;
  // A cap naming a tier the list does not have caps nothing it can express; it is ignored, and said so.
  let maxTier = tiers[named.top] ?? minTier;
  if (capTier !== undefined && capRank < 0) {
    reasons.push({ ruleId: 'cap.unknown', text: `The mission caps the tier at "${capTier}", which is not a routable tier; ignored.`, inputs: { maxTier: capTier } });
  } else if (capTier !== undefined) {
    maxTier = capTier;
    if (tiers.indexOf(minTier) > capRank) {
      verdict = 'needs-human';
      const why = reasons.filter((r) => s.setBy.includes(r.ruleId)).at(-1)?.text ?? `The work needs ${minTier}.`;
      needsHuman = `The work needs ${minTier} but the mission is capped at ${capTier}. ${why}`;
      reasons.push({ ruleId: 'cap.tier', text: `The mission is capped at ${capTier}, below the ${minTier} this needs: a person decides.`, inputs: { maxTier: capTier, minTier } });
    }
  }
  const capEffort = policy.caps?.maxEffort;
  if (capEffort !== undefined && EFFORT_LEVELS.indexOf(capEffort) >= 0 && effort > EFFORT_LEVELS.indexOf(capEffort)) {
    // Effort buys deliberation from the same model; a cap on it is honoured by asking for less, and said so.
    reasons.push({
      ruleId: 'cap.effort',
      text: `The mission caps effort at ${capEffort}, below the ${EFFORT_LEVELS[effort]} this would get.`,
      inputs: { maxEffort: capEffort, wanted: EFFORT_LEVELS[effort] },
    });
    effort = EFFORT_LEVELS.indexOf(capEffort);
  }

  // ---- Gates ----
  const gates: RouteGate[] = [];
  if (assessment.dimensions.ambiguity.value === 'open-ended') {
    gates.push('plan-first');
    reasons.push({ ruleId: 'gate.plan-first', text: 'Ambiguity is open-ended: someone has to decide what to build before an agent edits anything.', inputs: { ambiguity: 'open-ended' } });
  }
  if (assessment.dimensions.risk.value === 'critical') {
    gates.push('human-review');
    reasons.push({ ruleId: 'gate.human-review', text: 'Risk is critical: passing verification is not enough; a person reviews it before it is integrated.', inputs: { risk: 'critical' } });
  }

  // ---- Hard needs ----
  const contextTokens = contextNeed(assessment.dimensions.contextLoad.value);
  // Stored on the requirement as `context:<tokens>`, so a replayed decision resolves against the same need.
  const needs = [...assessment.requires, `${CONTEXT_NEED_PREFIX}${contextTokens}`];

  return {
    requirement: {
      minTier,
      maxTier,
      effort: EFFORT_LEVELS[effort],
      needs,
      ...(policy.preferences ? { prefer: policy.preferences } : {}),
      gates,
    },
    reasons,
    verdict,
    needsHuman,
    contextTokens,
  };
}
