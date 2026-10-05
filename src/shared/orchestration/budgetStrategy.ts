/**
 * Budget strategies (`docs/plans/intelligent-orchestration.md` §21; #53).
 *
 * A strategy changes two things and nothing else: how the resolver ranks
 * candidates that already satisfy the requirement, and how scheduler admission
 * paces work. The router never sees one, so no strategy can route below the
 * tier the work needs: every candidate the resolver ranks is at or above
 * `minTier` by construction, and the profile here holds no tier at all.
 *
 * Pure data and arithmetic, shared by the resolver, the scheduler and the
 * editors that name strategies.
 */
import type { RoutePreferences } from './types';

export type BudgetStrategy = NonNullable<RoutePreferences['strategy']>;

export const BUDGET_STRATEGIES: readonly BudgetStrategy[] = ['balanced', 'max-quality', 'lowest-cost', 'fastest', 'prefer-local'];

/** What a strategy changes about admission (§21 table, right column). */
export interface StrategyProfile {
  label: string;
  /** One line for the editors. */
  help: string;
  /**
   * Multiplies the admission threshold: below 1 stops starting work sooner on a
   * fuller usage window (lowest cost accepts being slower to save the window).
   * The mission's own `maxUsageWindowPercent` still lowers it further, never raises it.
   */
  admissionScale: number;
  /** Agents the machine-wide and per-repository limits grow by. A mission's own concurrency cap still binds. */
  concurrencyBonus: number;
  /** A start on a local endpoint goes ahead of a hosted start in the queue (local capacity first). */
  localFirst: boolean;
}

export const STRATEGY_PROFILES: Record<BudgetStrategy, StrategyProfile> = {
  balanced: { label: 'Balanced', help: 'The tier the work needs, on the cheapest route; standard pacing.', admissionScale: 1, concurrencyBonus: 0, localFirst: false },
  'max-quality': { label: 'Maximum quality', help: 'The highest tier within the caps; standard pacing.', admissionScale: 1, concurrencyBonus: 0, localFirst: false },
  'lowest-cost': { label: 'Lowest cost', help: 'The cheapest route at the tier needed, local first; stops starting work sooner on a full usage window.', admissionScale: 0.8, concurrencyBonus: 0, localFirst: false },
  fastest: { label: 'Fastest', help: 'The highest-throughput route at the tier needed; one more agent at once within the caps.', admissionScale: 1, concurrencyBonus: 1, localFirst: false },
  'prefer-local': { label: 'Prefer local', help: 'Local models first when they satisfy the requirement; local capacity is used before hosted.', admissionScale: 1, concurrencyBonus: 0, localFirst: true },
};

/** The strategy a preference set names. `preferLocal` alone is `prefer-local`; nothing is `balanced`. */
export function strategyOf(prefs: Pick<RoutePreferences, 'strategy' | 'preferLocal'> | undefined): BudgetStrategy {
  if (prefs?.strategy) return prefs.strategy;
  return prefs?.preferLocal ? 'prefer-local' : 'balanced';
}

/** The admission threshold under a strategy: the base, scaled, then lowered (never raised) by the mission's own cap. */
export function admissionPercentFor(strategy: BudgetStrategy, basePercent: number, missionCapPercent?: number): number {
  const scaled = Math.round(basePercent * STRATEGY_PROFILES[strategy].admissionScale * 100) / 100;
  return Math.min(scaled, missionCapPercent ?? Infinity);
}

/**
 * Share of a usage window one mission has used, in percentage points: the
 * source's window now less the window when the mission began, floored at 0
 * (a window that reset in between has used nothing of this mission's).
 * Other work on the same source counts too, which is why this is a share of the
 * window the mission ran in, not a bill.
 */
export function windowShareUsed(percentAtStart: number | undefined, percentNow: number | undefined): number | undefined {
  if (percentAtStart === undefined || percentNow === undefined) return undefined;
  return Math.max(0, Math.round((percentNow - percentAtStart) * 100) / 100);
}

/** Estimated dollars a mission may still spend under a cap, or undefined with no cap or no known spend. */
export function dollarsLeft(capUsd: number | undefined, spentUsd: number | undefined): number | undefined {
  if (capUsd === undefined) return undefined;
  return Math.max(0, Math.round((capUsd - (spentUsd ?? 0)) * 1e6) / 1e6);
}
