/**
 * Saving the tier list from Preferences → Tiers: one message, one plan, every
 * write it needs worked out before any is made.
 *
 * A rename keeps the old name on the renamed tier as an alias, so everything
 * written with it — shipped defaults (`TIER_DEFAULTS` names `expert`, not a
 * position), a repository's policy file, a recorded mission — still resolves.
 * The two things Preferences itself wrote with the old name are rewritten to
 * the new one as well: `tier` in `orchestration.models`, and the global
 * `caps.maxTier` in `orchestration.routing`. `'default'` deletes
 * `orchestration.tiers` rather than writing a copy of the shipped list.
 *
 * Pure and shared: the host runs it on save, the tests run it on values.
 */

import { canonicalTier, DEFAULT_TIERS, validateTierList, type CatalogEntry, type TierDef, type TierListError } from './catalog';

/** One row of the Tiers editor's draft: where it came from in the saved list, if anywhere. */
export interface TierDraftRow extends TierListDraftEntry {
  /** The saved tier this row is (by stable id in the editor); absent for a row added in the draft. */
  origin?: string;
}

/** Whether a draft is the shipped list exactly: saving it deletes `orchestration.tiers`. */
export function isShippedList(rows: readonly TierListDraftEntry[]): boolean {
  return rows.length === DEFAULT_TIERS.length && rows.every((r, i) => r.name.trim() === DEFAULT_TIERS[i].name && r.reachableBy === DEFAULT_TIERS[i].reachableBy);
}

/** The renames a draft makes: rows from a saved tier whose name changed. */
export function draftRenames(rows: readonly TierDraftRow[]): TierRename[] {
  return rows.filter((r) => r.origin !== undefined && r.origin !== r.name.trim() && r.name.trim() !== '').map((r) => ({ from: r.origin!, to: r.name.trim() }));
}

const models = (n: number) => `${n} model${n === 1 ? '' : 's'}`;

/**
 * "What saving changes": warnings that do not block a save. A deleted tier
 * that models still use, a list with no tier the router can pick, a global cap
 * on a deleted or renamed tier, and what a rename does. Only the global cap is
 * known here; repository and mission caps are named in general terms.
 */
export function tierListImpact(input: {
  saved: readonly TierDef[];
  rows: readonly TierDraftRow[];
  entries: readonly Pick<CatalogEntry, 'tier' | 'tierDeclared'>[];
  globalCap?: string;
}): string[] {
  const out: string[] = [];
  const kept = new Set(input.rows.map((r) => r.origin).filter((o): o is string => o !== undefined));
  const cap = canonicalTier(input.saved, input.globalCap);
  for (const t of input.saved) {
    if (kept.has(t.name)) continue;
    const on = input.entries.filter((e) => e.tier === t.name);
    const chosen = on.filter((e) => e.tierDeclared).length;
    const byDefault = on.length - chosen;
    if (chosen > 0) out.push(`Deleting "${t.name}" leaves ${models(chosen)} on an undefined tier. They stop routing with: Tier "${t.name}" is not defined.`);
    if (byDefault > 0) out.push(`Deleting "${t.name}" leaves ${models(byDefault)} whose shipped default is "${t.name}" unassigned.`);
    if (cap === t.name) out.push(`The global defaults cap tiers at "${t.name}". Once it is gone that cap names no tier and is ignored, as are repo and mission caps that name it.`);
  }
  for (const r of draftRenames(input.rows)) {
    const n = input.entries.filter((e) => e.tier === r.from).length;
    out.push(`Renaming "${r.from}" to "${r.to}": its ${models(n)} move with it, and "${r.from}" stays as an old name, so defaults and caps written with it still mean this tier.`);
    if (cap === r.from) out.push(`The global defaults cap is rewritten from "${r.from}" to "${r.to}".`);
  }
  if (input.rows.length > 0 && !input.rows.some((r) => r.reachableBy === 'route')) out.push('No tier is reachable by route, so the router has nothing to pick.');
  if (isShippedList(input.rows) && input.saved.some((t, i) => t.name !== DEFAULT_TIERS[i]?.name || (t.aliases?.length ?? 0) > 0 || input.saved.length !== DEFAULT_TIERS.length)) {
    out.push('Saving removes orchestration.tiers, so the shipped tiers apply and old names kept by earlier renames are dropped.');
  }
  return out;
}

export interface TierListDraftEntry {
  name: string;
  reachableBy: 'route' | 'escalation';
}

export interface TierRename {
  from: string;
  to: string;
}

/** A `setTierList` message's content, or nothing when it is not well formed. */
export function tierListMessage(message: unknown): { tiers: TierListDraftEntry[] | 'default'; renames: TierRename[] } | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const m = message as { type?: unknown; tiers?: unknown; renames?: unknown };
  if (m.type !== 'setTierList') return undefined;
  let tiers: TierListDraftEntry[] | 'default';
  if (m.tiers === 'default') tiers = 'default';
  else if (Array.isArray(m.tiers)) {
    tiers = [];
    for (const t of m.tiers) {
      if (!t || typeof t !== 'object') return undefined;
      const x = t as { name?: unknown; reachableBy?: unknown };
      if (typeof x.name !== 'string' || (x.reachableBy !== 'route' && x.reachableBy !== 'escalation')) return undefined;
      tiers.push({ name: x.name, reachableBy: x.reachableBy });
    }
  } else return undefined;
  const renames: TierRename[] = [];
  if (m.renames !== undefined) {
    if (!Array.isArray(m.renames)) return undefined;
    for (const r of m.renames) {
      const x = r as { from?: unknown; to?: unknown } | null;
      if (!x || typeof x.from !== 'string' || typeof x.to !== 'string') return undefined;
      renames.push({ from: x.from, to: x.to });
    }
  }
  return { tiers, renames };
}

export interface TierListSaveInput {
  /** The list in force now (`parseTiers` of what is stored). */
  current: readonly TierDef[];
  tiers: TierListDraftEntry[] | 'default';
  renames: readonly TierRename[];
  /** `orchestration.models` and `orchestration.routing` as stored, untouched unless a rename rewrites them. */
  models: unknown;
  routing: unknown;
}

export interface TierListSavePlan {
  /** Every key to write and its new value (`undefined` deletes it). Keys not listed are left alone. */
  writes: Record<string, unknown>;
  /** The list that will be in force. */
  tiers: TierDef[];
  /** Model entries whose `tier` was rewritten, and whether the global cap was. */
  rewrittenModels: string[];
  rewroteCap: boolean;
}

export type TierListSaveResult = { ok: true; plan: TierListSavePlan } | { ok: false; errors: TierListError[] };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The writes a save needs, or why it cannot be saved: the rules the loader
 * applies (`validateTierList`), plus renames that name a tier the list does not
 * have now (`from`) or will not have (`to`).
 */
export function planTierListSave(input: TierListSaveInput): TierListSaveResult {
  const next: TierListDraftEntry[] = input.tiers === 'default' ? DEFAULT_TIERS.map((t) => ({ name: t.name, reachableBy: t.reachableBy })) : input.tiers;
  const names = next.map((t) => t.name.trim());
  const errors: TierListError[] = [];

  // Each rename: from a tier in force now (by any of its names), to one in the new list.
  const renames = new Map<string, string>();
  for (const r of input.renames) {
    const from = canonicalTier(input.current, r.from.trim());
    const to = r.to.trim();
    if (!from) errors.push({ index: -1, message: `Renamed tier "${r.from}" is not in the list in force` });
    else if (!names.includes(to)) errors.push({ index: -1, message: `Renamed tier "${r.from}" → "${r.to}": "${r.to}" is not in the new list` });
    else if (renames.has(from) && renames.get(from) !== to) errors.push({ index: -1, message: `"${r.from}" is renamed twice` });
    else if (from !== to) renames.set(from, to);
  }

  // Aliases: a tier that keeps its name keeps its old names; a renamed one gains its previous name and old names.
  const oldOf = (name: string) => input.current.find((t) => t.name === name);
  const draft = next.map((t, i) => {
    const name = names[i];
    const aliases = new Set<string>(oldOf(name)?.aliases ?? []);
    for (const [from, to] of renames) {
      if (to !== name) continue;
      aliases.add(from);
      for (const a of oldOf(from)?.aliases ?? []) aliases.add(a);
    }
    aliases.delete(name);
    return { name, reachableBy: t.reachableBy, ...(aliases.size > 0 ? { aliases: [...aliases] } : {}) };
  });
  // Restoring the shipped list stores nothing, so old names cannot ride along; renames still rewrite what Preferences wrote.
  const toValidate = input.tiers === 'default' ? draft.map(({ name, reachableBy }) => ({ name, reachableBy })) : draft;
  const valid = validateTierList(toValidate);
  if (!valid.ok) errors.push(...valid.errors);
  if (errors.length > 0 || !valid.ok) return { ok: false, errors };

  const writes: Record<string, unknown> = { 'orchestration.tiers': input.tiers === 'default' ? undefined : valid.tiers };

  // orchestration.models: `tier` written with a renamed tier's name (or an old name of it).
  const rewrittenModels: string[] = [];
  if (isObj(input.models) && renames.size > 0) {
    const models: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.models)) {
      if (isObj(value) && typeof value.tier === 'string') {
        const to = renames.get(canonicalTier(input.current, value.tier) ?? '');
        if (to !== undefined && value.tier !== to) {
          models[key] = { ...value, tier: to };
          rewrittenModels.push(key);
          continue;
        }
      }
      models[key] = value;
    }
    if (rewrittenModels.length > 0) writes['orchestration.models'] = models;
  }

  // orchestration.routing: the global cap, nested (`caps.maxTier`) or in the flat form #38 shipped (`maxTier`).
  let rewroteCap = false;
  if (isObj(input.routing) && renames.size > 0) {
    const routing: Record<string, unknown> = { ...input.routing };
    const rename = (v: unknown) => (typeof v === 'string' ? renames.get(canonicalTier(input.current, v) ?? '') : undefined);
    if (isObj(routing.caps)) {
      const to = rename(routing.caps.maxTier);
      if (to !== undefined && routing.caps.maxTier !== to) {
        routing.caps = { ...routing.caps, maxTier: to };
        rewroteCap = true;
      }
    }
    const flat = rename(routing.maxTier);
    if (flat !== undefined && routing.maxTier !== flat) {
      routing.maxTier = flat;
      rewroteCap = true;
    }
    if (rewroteCap) writes['orchestration.routing'] = routing;
  }

  return { ok: true, plan: { writes, tiers: valid.tiers, rewrittenModels, rewroteCap } };
}
