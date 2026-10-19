/**
 * What an accepted routing proposal does inside the router (`docs/plans/intelligent-orchestration.md`
 * §20.1; #52). A learned rule is data: a cohort, the tier the deterministic
 * policy lands on, and the tier to move to, one step. The router stays a pure
 * function; this is one more input it reads, and every firing is a reason that
 * carries the evidence the rule was accepted on.
 *
 * Deliberately narrow, so a rule cannot do more than the evidence it carries:
 * - it applies only when the deterministic policy lands on exactly `fromTier`;
 * - it moves one tier, never more;
 * - a downgrade never overrides a hard floor (`floor.*`) or low confidence, and
 *   needs risk ≤ moderate on the task itself.
 */
import {
  complexityBucket,
  cohortText,
  intervalText,
  verifiabilityBucket,
  type LearnedRule,
} from '../../shared/orchestration/routingProposals';
import type { TierName } from '../../shared/orchestration/types';

/** The facts a learned rule matches on: strings, as the router flattens an assessment into. */
export interface LearnedFacts {
  kind: string;
  complexity: string;
  verifiability: string;
  risk: string;
}

export interface LearnedFiring {
  /** The index into `tiers` the rule moves the task to. */
  tier: number;
  text: string;
  inputs: Record<string, unknown>;
}

export const LEARNED_RULE_PREFIX = 'learned.';

const RISK_OK_FOR_DOWNGRADE: ReadonlySet<string> = new Set(['low', 'moderate']);

/** Whether `rule` fires for this task at this point in the tier rules, and where it moves it. */
export function applyLearnedRule(
  rule: LearnedRule,
  facts: LearnedFacts,
  current: { tier: number; setBy: readonly string[] },
  tiers: readonly TierName[],
  repository: string | undefined,
): LearnedFiring | undefined {
  if (rule.cohort.kind !== facts.kind) return undefined;
  if (rule.cohort.complexity !== complexityBucket(facts.complexity)) return undefined;
  if (rule.cohort.verifiability !== verifiabilityBucket(facts.verifiability)) return undefined;
  if (rule.cohort.repository !== undefined && rule.cohort.repository !== repository) return undefined;
  if (tiers[current.tier] !== rule.fromTier) return undefined;
  const to = tiers.indexOf(rule.toTier);
  if (to < 0 || Math.abs(to - current.tier) !== 1) return undefined;
  if (rule.direction === 'downgrade') {
    if (to > current.tier) return undefined;
    if (!RISK_OK_FOR_DOWNGRADE.has(facts.risk)) return undefined;
    if (current.setBy.some((id) => id.startsWith('floor.') || id === 'confidence.low')) return undefined;
  } else if (to < current.tier) return undefined;
  const e = rule.evidence;
  const verb = rule.direction === 'downgrade' ? 'lowered' : 'raised';
  return {
    tier: to,
    text:
      `You accepted a proposal for ${cohortText(rule.cohort)}: ${e.route.tier} passed first time ${e.successes} of ${e.observations}, ` +
      `${intervalText(e)}, so the floor is ${verb} from ${rule.fromTier} to ${rule.toTier}.`,
    inputs: { rule: rule.id, direction: rule.direction, successes: e.successes, observations: e.observations, lower: e.interval.lower, upper: e.interval.upper },
  };
}
