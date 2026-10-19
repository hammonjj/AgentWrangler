/**
 * Writing `orchestration.models` and `telemetry.prices` from Preferences →
 * Models: defaults stored by absence, `tier: null` only where it means
 * something, effort one level at a time, prices one field at a time, and the
 * host's refusals.
 */
import { describe, expect, it } from 'vitest';
import type { KeyValueStorage } from '../../src/core/archive';
import { CapabilityCatalog, PRICES_KEY, type CatalogSettings } from '../../src/core/capabilityCatalog';
import {
  applyPolicyChange,
  buildCatalog,
  defaultEffortMap,
  EFFORT_DEFAULT,
  MODEL_POLICY_KEY,
  type ReportedModels,
} from '../../src/shared/orchestration/catalog';
import { applyPriceChange, parsePriceText, parseStoredPrices, priceKeyFor } from '../../src/shared/orchestration/modelPrices';
import { effortEditor, policyDiffText, priceNote } from '../../src/shared/orchestration/tierBoard';
import { modelPolicyChange, modelPriceChange } from '../../src/shared/preferences';

const CLAUDE_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

const CLAUDE = [
  { value: 'sonnet', label: 'Sonnet', resolved: 'claude-sonnet-5', effortLevels: CLAUDE_LEVELS },
  { value: 'haiku', label: 'Haiku', resolved: 'claude-haiku-4-5-20251001' },
];
const CODEX = [
  { value: 'gpt-6-sol', label: 'GPT-6 Sol', resolved: 'gpt-6-sol', effortLevels: CODEX_LEVELS },
  { value: 'gpt-9-test', label: 'GPT-9 Test', resolved: 'gpt-9-test', effortLevels: CODEX_LEVELS },
];
const REPORTED: ReportedModels[] = [
  { source: 'anthropic', models: CLAUDE },
  { source: 'openai', models: CODEX },
];

function storage(): KeyValueStorage {
  const data: Record<string, unknown> = {};
  return { get: <T>(k: string, d: T) => (k in data ? (data[k] as T) : d), update: (k: string, v: unknown) => void (data[k] = v) };
}

function settings(initial: Record<string, unknown> = {}): CatalogSettings & { data: Record<string, unknown>; writes: string[] } {
  const listeners: ((affects: (key: string) => boolean) => void)[] = [];
  const value = {
    data: { ...initial },
    writes: [] as string[],
    get<T>(key: string, fallback: T): T {
      return key in value.data ? (value.data[key] as T) : fallback;
    },
    async update(key: string, next: unknown) {
      value.writes.push(key);
      if (next === undefined) delete value.data[key];
      else value.data[key] = next;
      for (const l of listeners) l((k) => k === key);
    },
    onDidChange(listener: (affects: (key: string) => boolean) => void) {
      listeners.push(listener);
      return { dispose: () => undefined };
    },
  };
  return value;
}

function catalogWith(initial: Record<string, unknown> = {}) {
  const prefs = settings(initial);
  const catalog = new CapabilityCatalog(storage(), prefs);
  catalog.remember('anthropic', CLAUDE);
  catalog.remember('openai', CODEX);
  return { catalog, prefs };
}

const SONNET = 'anthropic:claude-sonnet-5';
const GPT9 = 'openai:gpt-9-test';

describe('override writing', () => {
  const sonnetDefaults = { tier: 'standard', enabled: true, effort: defaultEffortMap(CLAUDE_LEVELS) };
  const unnamedDefaults = { enabled: true };

  it('choosing the default tier deletes the tier key', () => {
    const next = applyPolicyChange({ [SONNET]: { tier: 'expert', enabled: false } }, { key: SONNET, tier: 'standard' }, sonnetDefaults);
    expect(next).toEqual({ [SONNET]: { enabled: false } });
  });

  it('on a model with a default tier, choosing Unassigned writes null', () => {
    expect(applyPolicyChange({}, { key: SONNET, tier: null }, sonnetDefaults)).toEqual({ [SONNET]: { tier: null } });
  });

  it('on a model without a default tier, choosing Unassigned deletes the key', () => {
    const next = applyPolicyChange({ [GPT9]: { tier: 'basic', enabled: false } }, { key: GPT9, tier: null }, unnamedDefaults);
    expect(next).toEqual({ [GPT9]: { enabled: false } });
  });

  it('emptying the entry removes it', () => {
    const next = applyPolicyChange({ [SONNET]: { enabled: false }, other: { tier: 'basic' } }, { key: SONNET, enabled: true }, sonnetDefaults);
    expect(next).toEqual({ other: { tier: 'basic' } });
  });

  it('reset removes the entry and leaves prices alone', async () => {
    const { catalog, prefs } = catalogWith({
      [MODEL_POLICY_KEY]: { [SONNET]: { tier: 'expert', effort: { max: 'high' } } },
      [PRICES_KEY]: { 'claude-sonnet-5': { inPerMTok: 3, outPerMTok: 15 } },
    });
    expect(await catalog.applyPolicy({ key: SONNET, reset: 'all' })).toEqual({ ok: true });
    expect(prefs.data[MODEL_POLICY_KEY]).toBeUndefined();
    expect(prefs.data[PRICES_KEY]).toEqual({ 'claude-sonnet-5': { inPerMTok: 3, outPerMTok: 15 } });
    expect(prefs.writes).toEqual([MODEL_POLICY_KEY]);
  });

  it('refuses an unknown key and a tier the list does not have, saying why', async () => {
    const { catalog, prefs } = catalogWith();
    expect(await catalog.applyPolicy({ key: 'openai:nothing-like-it', tier: 'basic' })).toMatchObject({ ok: false });
    expect(await catalog.applyPolicy({ key: SONNET, tier: 'legendary' })).toEqual({ ok: false, error: 'Tier "legendary" is not defined' });
    expect(prefs.writes).toEqual([]);
  });
});

describe('effort', () => {
  it('stores only the level that differs, and the rest keep their default mapping', async () => {
    const { catalog, prefs } = catalogWith();
    expect(await catalog.applyPolicy({ key: SONNET, effort: { level: 'max', native: 'high' } })).toEqual({ ok: true });
    expect(prefs.data[MODEL_POLICY_KEY]).toEqual({ [SONNET]: { effort: { max: 'high' } } });
    expect(catalog.catalog.entries.find((e) => e.key === SONNET)!.effortMap).toEqual({ low: 'low', medium: 'medium', high: 'high', max: 'high' });
  });

  it('choosing a default level deletes that level, by name or by "default"', async () => {
    const { catalog, prefs } = catalogWith({ [MODEL_POLICY_KEY]: { [SONNET]: { effort: { max: 'high', low: 'medium' }, enabled: false } } });
    await catalog.applyPolicy({ key: SONNET, effort: { level: 'max', native: 'xhigh' } });
    expect(prefs.data[MODEL_POLICY_KEY]).toEqual({ [SONNET]: { effort: { low: 'medium' }, enabled: false } });
    await catalog.applyPolicy({ key: SONNET, effort: { level: 'low', native: EFFORT_DEFAULT } });
    expect(prefs.data[MODEL_POLICY_KEY]).toEqual({ [SONNET]: { enabled: false } });
  });

  it('rejects a native level the model does not have, and one reached only by a pin', async () => {
    const { catalog, prefs } = catalogWith();
    expect(await catalog.applyPolicy({ key: SONNET, effort: { level: 'high', native: 'turbo' } })).toEqual({ ok: false, error: 'Sonnet 5 has no "turbo" effort level' });
    expect(await catalog.applyPolicy({ key: SONNET, effort: { level: 'max', native: 'max' } })).toEqual({ ok: false, error: '"max" can only be reached by pinning this model' });
    expect(await catalog.applyPolicy({ key: 'anthropic:claude-haiku-4-5-20251001', effort: { level: 'low', native: 'low' } })).toMatchObject({ ok: false });
    expect(prefs.writes).toEqual([]);
  });

  it('never offers a pin-only level, and marks the defaults', () => {
    const catalog = buildCatalog({ reported: REPORTED });
    const gpt = catalog.entries.find((e) => e.key === 'openai:gpt-6-sol')!;
    const editor = effortEditor(gpt);
    if (editor.kind !== 'map') throw new Error('expected an effort map');
    for (const row of editor.rows) expect(row.options.map((o) => o.native)).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(editor.rows.find((r) => r.level === 'max')!.options.find((o) => o.isDefault)?.native).toBe('xhigh');
    expect(editor.note).toBe('Dashed outline = shipped default. none, minimal can only be reached by pinning this model.');
    const claude = effortEditor(catalog.entries.find((e) => e.key === SONNET)!);
    if (claude.kind !== 'map') throw new Error('expected an effort map');
    expect(claude.rows[0].options.map((o) => o.native)).not.toContain('max');
  });

  it('shows a hand-edited pin-only mapping as selected but not offered', () => {
    const catalog = buildCatalog({ reported: REPORTED, policy: { [SONNET]: { effort: { max: 'max' } } } });
    const editor = effortEditor(catalog.entries.find((e) => e.key === SONNET)!);
    if (editor.kind !== 'map') throw new Error('expected an effort map');
    expect(editor.rows.find((r) => r.level === 'max')!.options.at(-1)).toEqual({ native: 'max', selected: true, isDefault: false, pinOnly: true });
  });

  it('says when a model has no effort control', () => {
    const catalog = buildCatalog({ reported: REPORTED });
    expect(effortEditor(catalog.entries.find((e) => e.key === 'anthropic:claude-haiku-4-5-20251001')!)).toMatchObject({ kind: 'none' });
  });

  it('the message parser takes one level per change and refuses an unknown level', () => {
    expect(modelPolicyChange({ type: 'modelPolicy', change: { key: SONNET, effort: { level: 'max', native: 'high' } } })).toEqual({
      key: SONNET,
      effort: { level: 'max', native: 'high' },
    });
    expect(modelPolicyChange({ type: 'modelPolicy', change: { key: SONNET, effort: { level: 'ultra', native: 'high' } } })).toBeUndefined();
    expect(modelPolicyChange({ type: 'modelPolicy', change: { key: SONNET, effort: { level: 'max' } } })).toBeUndefined();
  });
});

describe('prices', () => {
  it('writes one field at a time under the resolved id, and null deletes it', async () => {
    const { catalog, prefs } = catalogWith();
    expect(await catalog.setPrice({ key: GPT9, field: 'input', usdPerMTok: 1.5 })).toEqual({ ok: true });
    expect(prefs.data[PRICES_KEY]).toEqual({ 'gpt-9-test': { inPerMTok: 1.5 } });
    // Half a price does not count yet.
    expect(catalog.catalog.entries.find((e) => e.key === GPT9)!.costReporting).toBe('none');
    await catalog.setPrice({ key: GPT9, field: 'output', usdPerMTok: 6 });
    await catalog.setPrice({ key: GPT9, field: 'cachedInput', usdPerMTok: 0.15 });
    expect(catalog.catalog.entries.find((e) => e.key === GPT9)!.descriptor.price).toEqual({ inPerMTok: 1.5, outPerMTok: 6, cacheReadPerMTok: 0.15 });
    await catalog.setPrice({ key: GPT9, field: 'input', usdPerMTok: null });
    await catalog.setPrice({ key: GPT9, field: 'output', usdPerMTok: null });
    await catalog.setPrice({ key: GPT9, field: 'cachedInput', usdPerMTok: null });
    expect(prefs.data[PRICES_KEY]).toBeUndefined();
    expect(prefs.data[MODEL_POLICY_KEY]).toBeUndefined();
  });

  it('rejects a negative price and an unknown model', async () => {
    const { catalog, prefs } = catalogWith();
    expect(await catalog.setPrice({ key: GPT9, field: 'input', usdPerMTok: -1 })).toEqual({ ok: false, error: 'A price cannot be negative' });
    expect(await catalog.setPrice({ key: 'openai:nothing', field: 'input', usdPerMTok: 1 })).toMatchObject({ ok: false });
    expect(prefs.writes).toEqual([]);
  });

  it('keeps writing to the key a price already lives under', () => {
    const entry = buildCatalog({ reported: REPORTED }).entries.find((e) => e.key === SONNET)!;
    expect(priceKeyFor(entry, {})).toBe('claude-sonnet-5');
    expect(priceKeyFor(entry, { sonnet: {} })).toBe('sonnet');
    expect(applyPriceChange({ other: { inPerMTok: 1 } }, 'x', 'output', 2)).toEqual({ other: { inPerMTok: 1 }, x: { outPerMTok: 2 } });
  });

  it('parses the field as a non-negative decimal, empty meaning delete', () => {
    expect(parsePriceText(' 0.25 ')).toEqual({ ok: true, value: 0.25 });
    expect(parsePriceText('')).toEqual({ ok: true, value: null });
    expect(parsePriceText('-1')).toMatchObject({ ok: false });
    expect(parsePriceText('3e2')).toMatchObject({ ok: false });
    expect(parsePriceText('abc')).toMatchObject({ ok: false });
  });

  it('reads stored prices whole, half-filled ones included', () => {
    expect(parseStoredPrices({ a: { inPerMTok: 1 }, b: { inPerMTok: 'x' }, c: null })).toEqual({ a: { inPerMTok: 1 } });
  });

  it('the message parser leaves the negative check to the host, which can say why', () => {
    expect(modelPriceChange({ type: 'modelPrice', change: { key: GPT9, field: 'cachedInput', usdPerMTok: -2 } })).toEqual({ key: GPT9, field: 'cachedInput', usdPerMTok: -2 });
    expect(modelPriceChange({ type: 'modelPrice', change: { key: GPT9, field: 'input', usdPerMTok: null } })).toEqual({ key: GPT9, field: 'input', usdPerMTok: null });
    expect(modelPriceChange({ type: 'modelPrice', change: { key: GPT9, field: 'total', usdPerMTok: 1 } })).toBeUndefined();
    expect(modelPriceChange({ type: 'modelPrice', change: { key: GPT9, field: 'input', usdPerMTok: '1' } })).toBeUndefined();
  });

  it('says what a price does for the model', () => {
    const c = buildCatalog({ reported: REPORTED });
    const gpt = c.entries.find((e) => e.key === GPT9)!;
    const sonnet = c.entries.find((e) => e.key === SONNET)!;
    expect(priceNote(gpt, undefined)).toBe('No price set: cost shows as plan window only.');
    expect(priceNote(sonnet, undefined)).toBe('No price set: cost is estimated by the agent.');
    expect(priceNote(gpt, { inPerMTok: 1 })).toBe('Input and output are both needed before a price counts.');
  });
});

describe('the diff footer', () => {
  it('names what is stored against the defaults', () => {
    const c = buildCatalog({ reported: REPORTED, policy: { [SONNET]: { tier: 'expert', enabled: false, effort: { max: 'high' } } } });
    expect(policyDiffText(c.entries.find((e) => e.key === SONNET)!)).toBe('Differs from defaults: tier expert (default standard) · disabled (default on) · effort max→high');
    expect(policyDiffText(c.entries.find((e) => e.key === GPT9)!)).toBe('Following shipped defaults. Nothing is stored for this model.');
  });
});
