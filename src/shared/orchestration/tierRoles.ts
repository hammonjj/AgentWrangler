/**
 * Which tier each of the router's rules lands on.
 *
 * The router's rules speak of `basic`, `standard` and `expert` (plan §9.3). A
 * tier list that renames or inserts tiers maps onto them by position among the
 * tiers reachable by route — weakest, second, strongest — so a user's extra
 * tier never makes a rule point at nothing. This is that mapping, once: the
 * router (`orchestration/policy/router.ts`) runs on it, and Preferences words
 * it, so the two cannot disagree.
 *
 * Pure and shared: no Node or DOM here.
 */

import type { TierDef } from './catalog';
import type { TierName } from './types';

/** The tiers the router may ask for: `reachableBy: 'route'`, weakest first (§6.3). */
export function routeTierNames(tiers: readonly TierDef[]): TierName[] {
  return tiers.filter((t) => t.reachableBy === 'route').map((t) => t.name);
}

/** The three rule targets as indexes into `routeTierNames(tiers)`, and the strongest route tier. */
export interface NamedTiers {
  basic: number;
  standard: number;
  expert: number;
  top: number;
}

/**
 * One route tier: all three. Two: the first is basic, the second standard and
 * expert. Three or more: first basic, second standard, last expert, and the
 * ones between are reached only by moving up.
 */
export function namedTiers(tiers: readonly TierDef[]): NamedTiers {
  const n = routeTierNames(tiers).length;
  const top = Math.max(0, n - 1);
  return { basic: 0, standard: Math.min(1, top), expert: top, top };
}

export type RouterRole = 'basic' | 'standard' | 'expert';

export const ROUTER_ROLES: readonly RouterRole[] = ['basic', 'standard', 'expert'];

/** One tier of the list and the rules that land on it. */
export interface TierRole {
  tier: TierDef;
  /** Position in the whole list, weakest 0. */
  index: number;
  /** Position among the route tiers; absent for an escalation-only tier. */
  routeIndex?: number;
  /** The rules that land here, in rule order. Empty for escalation-only and in-between tiers. */
  roles: RouterRole[];
}

export function tierRoles(tiers: readonly TierDef[]): TierRole[] {
  const named = namedTiers(tiers);
  const routeCount = routeTierNames(tiers).length;
  let r = 0;
  return tiers.map((tier, index) => {
    if (tier.reachableBy !== 'route') return { tier, index, roles: [] };
    const routeIndex = r++;
    const roles = routeCount === 0 ? [] : ROUTER_ROLES.filter((role) => named[role] === routeIndex);
    return { tier, index, routeIndex, roles };
  });
}

/** The Tiers editor's role line for one tier. */
export function tierRoleLine(role: TierRole): string {
  if (role.tier.reachableBy === 'escalation') return 'Never chosen by the router · escalation or pin only';
  if (role.roles.length === 0) return 'No router rule targets this tier · reached by moving up';
  return `Router: ${role.roles.join(' + ')} rule${role.roles.length === 1 ? '' : 's'} land${role.roles.length === 1 ? 's' : ''} here`;
}

/** The Models board's lane subline for one tier. */
export function laneSubline(role: TierRole): string {
  if (role.tier.reachableBy === 'escalation') {
    return 'Never chosen by the router. Reached when a failing task escalates and its mission allows it, or by a pin.';
  }
  const has = (r: RouterRole) => role.roles.includes(r);
  if (has('basic') && has('expert')) return 'The only routable tier · reachable by route';
  if (has('basic')) return 'Weakest routable tier · reachable by route';
  if (has('expert')) return 'Strongest routable tier · reachable by route';
  if (has('standard')) return 'Second routable tier · reachable by route';
  return 'Reachable by route';
}
