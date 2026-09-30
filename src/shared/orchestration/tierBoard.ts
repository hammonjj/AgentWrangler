/**
 * Preferences → Orchestration → Models: what the tier board shows, derived
 * from the catalog and nothing else.
 *
 * Nothing here decides whether a model is routable. `buildCatalog` does
 * (`routable`, `notRoutableBecause`), and `localModelStatus` says what a local
 * model still needs; this file only arranges and words their answers.
 *
 * Pure and shared: no Node or DOM here.
 */

import type { CatalogEntry } from './catalog';

// ---------------------------------------------------------------------------
// The Models tab's badge
// ---------------------------------------------------------------------------

/**
 * Enabled models that have no tier because nothing ever gave them one: no
 * shipped default names them and the user has not chosen. A model set to
 * `tier: null` on purpose was given an answer, so it does not count; nor does
 * one whose chosen tier the list no longer has (that one says why elsewhere).
 */
export function needsTierCount(entries: readonly Pick<CatalogEntry, 'enabled' | 'tier' | 'tierDeclared'>[]): number {
  return entries.filter((e) => e.enabled && e.tier === undefined && !e.tierDeclared).length;
}

/** The badge beside "Models": hidden at 0, with its screen-reader wording. */
export function needsTierBadge(count: number): { text: string; srText: string } | undefined {
  if (count <= 0) return undefined;
  return { text: String(count), srText: `${count} need${count === 1 ? 's' : ''} a tier` };
}
