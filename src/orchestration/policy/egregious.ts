/**
 * The misroutes no rule change may ever produce (`docs/plans/intelligent-orchestration.md`
 * §27.2). Every one is a routing that is wrong whatever the calibration: the
 * first three are the plan's list, the fourth is §9.2's principle — the
 * cheapest tier only where a machine will catch its mistakes and a mistake is
 * cheap.
 *
 * Lives in `src` because two things judge against it: the routing corpus
 * (`npm test`) and the proposal veto (#52), which refuses a learned rule that
 * would commit one.
 */
import { VERIFIABILITY_LEVELS, RISK_LEVELS } from './assessment';
import { DEFAULT_TIERS, tierRank } from '../../shared/orchestration/catalog';
import { EFFORT_LEVELS, type EffortLevel, type Risk, type RouteRequirement, type TaskKind, type TierName, type Verifiability } from '../../shared/orchestration/types';

const rankTier = (t: TierName): number => tierRank(DEFAULT_TIERS, t);
const rankEffort = (e: EffortLevel): number => EFFORT_LEVELS.indexOf(e);

/** What a route was judged on: the requirement, and the assessment it was made from. */
export interface RouteCase {
  requirement: RouteRequirement;
  kind: TaskKind;
  risk: Risk;
  /** The verifiability the router saw, i.e. after the configured ceiling (§8.3). */
  verifiability: Verifiability;
}

export const EGREGIOUS: readonly { id: string; text: string; test: (r: RouteCase) => boolean }[] = [
  {
    id: 'docs-expert-high',
    text: 'documentation routed to expert tier at high effort or more',
    test: (r) => r.kind === 'docs' && rankTier(r.requirement.minTier) >= rankTier('expert') && rankEffort(r.requirement.effort) >= rankEffort('high'),
  },
  {
    id: 'architecture-basic-or-low',
    text: 'architecture or planning routed to basic tier or low effort',
    test: (r) =>
      (r.kind === 'architecture' || r.kind === 'plan') &&
      (rankTier(r.requirement.minTier) <= rankTier('basic') || r.requirement.effort === 'low'),
  },
  {
    id: 'critical-below-expert',
    text: 'critical risk routed below expert tier',
    test: (r) => r.risk === 'critical' && rankTier(r.requirement.minTier) < rankTier('expert'),
  },
  {
    id: 'basic-unguarded',
    text: 'basic tier without at least partial verification, or above moderate risk',
    test: (r) =>
      rankTier(r.requirement.minTier) <= rankTier('basic') &&
      (VERIFIABILITY_LEVELS.indexOf(r.verifiability) < VERIFIABILITY_LEVELS.indexOf('partial') ||
        RISK_LEVELS.indexOf(r.risk) > RISK_LEVELS.indexOf('moderate')),
  },
];

/** The egregious misroutes a route commits, by id. */
export function egregiousMisroutes(r: RouteCase): string[] {
  return EGREGIOUS.filter((e) => e.test(r)).map((e) => e.id);
}
