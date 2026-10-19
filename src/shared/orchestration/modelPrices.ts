/**
 * Per-model prices in `telemetry.prices`: `{ "<model id>": { inPerMTok,
 * outPerMTok, cacheReadPerMTok? } }`, US$ per million tokens.
 *
 * Telemetry prices a turn only when both `inPerMTok` and `outPerMTok` are
 * there (`priceCost`, which also reads `cacheReadPerMTok` when present), and
 * the catalog reads the same table. Preferences edits one field at a time, so
 * a half-filled entry can exist; it is kept and shown, and counts once the
 * other half is set.
 *
 * Pure and shared: no Node or DOM here.
 */

import type { CatalogEntry } from './catalog';

export type PriceField = 'input' | 'output' | 'cachedInput';

export const PRICE_FIELDS: readonly PriceField[] = ['input', 'output', 'cachedInput'];

/** Each field's key in the stored entry. */
export const PRICE_KEY: Record<PriceField, 'inPerMTok' | 'outPerMTok' | 'cacheReadPerMTok'> = {
  input: 'inPerMTok',
  output: 'outPerMTok',
  cachedInput: 'cacheReadPerMTok',
};

/** One model's stored price, possibly half-filled. */
export type StoredPrice = Partial<Record<'inPerMTok' | 'outPerMTok' | 'cacheReadPerMTok', number>>;

/** `telemetry.prices` as stored, every numeric field kept (the catalog keeps only complete ones). */
export function parseStoredPrices(raw: unknown): Record<string, StoredPrice> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, StoredPrice> = {};
  for (const [model, p] of Object.entries(raw as Record<string, unknown>)) {
    if (!p || typeof p !== 'object') continue;
    const v = p as Record<string, unknown>;
    const entry: StoredPrice = {};
    for (const k of Object.values(PRICE_KEY)) if (typeof v[k] === 'number' && Number.isFinite(v[k])) entry[k] = v[k] as number;
    if (Object.keys(entry).length > 0) out[model] = entry;
  }
  return out;
}

/**
 * The table key a model's price lives under: the one already holding it (the
 * catalog accepts the resolved id or the id it is called by), else the
 * resolved id.
 */
export function priceKeyFor(entry: Pick<CatalogEntry, 'descriptor'>, table: Readonly<Record<string, unknown>>): string {
  const d = entry.descriptor;
  const candidates = [d.resolvedId, d.modelId].filter((k): k is string => typeof k === 'string' && k !== '');
  return candidates.find((k) => k in table) ?? candidates[0];
}

/** What a price field's text means: a number, nothing (delete), or why not. */
export function parsePriceText(text: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const t = text.trim();
  if (t === '') return { ok: true, value: null };
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(t)) return { ok: false, error: 'Enter a price of 0 or more, like 3 or 0.25' };
  return { ok: true, value: Number(t) };
}

/** Why a price change cannot be stored, or undefined. `null` is always fine: it deletes. */
export function priceValueError(value: unknown): string | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'A price must be a number';
  if (value < 0) return 'A price cannot be negative';
  return undefined;
}

/**
 * The table after one field changes. `null` deletes the field; an entry left
 * empty is removed, and so is the table (undefined: delete the setting).
 * Never mutates `table`.
 */
export function applyPriceChange(
  table: Readonly<Record<string, unknown>>,
  model: string,
  field: PriceField,
  value: number | null,
): Record<string, unknown> | undefined {
  const next: Record<string, unknown> = { ...table };
  const current = next[model];
  const entry: Record<string, unknown> = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  if (value === null) delete entry[PRICE_KEY[field]];
  else entry[PRICE_KEY[field]] = value;
  if (Object.keys(entry).length > 0) next[model] = entry;
  else delete next[model];
  return Object.keys(next).length > 0 ? next : undefined;
}
