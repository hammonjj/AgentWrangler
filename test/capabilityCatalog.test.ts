import { describe, expect, it } from 'vitest';
import type { KeyValueStorage } from '../src/core/archive';
import { CapabilityCatalog, type CatalogSettings } from '../src/core/capabilityCatalog';
import { MODEL_POLICY_KEY, modelsInTierRange } from '../src/shared/orchestration/catalog';

function storage(initial: Record<string, unknown> = {}): KeyValueStorage & { data: Record<string, unknown>; writes: number } {
  const value = {
    data: { ...initial },
    writes: 0,
    get<T>(key: string, fallback: T): T {
      return key in value.data ? (value.data[key] as T) : fallback;
    },
    update(key: string, next: unknown) {
      value.writes++;
      value.data[key] = next;
    },
  };
  return value;
}

function settings(initial: Record<string, unknown> = {}): CatalogSettings & { data: Record<string, unknown> } {
  const listeners: ((affects: (key: string) => boolean) => void)[] = [];
  const value = {
    data: { ...initial },
    get<T>(key: string, fallback: T): T {
      return key in value.data ? (value.data[key] as T) : fallback;
    },
    async update(key: string, next: unknown) {
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

const CLAUDE = [
  { value: 'default', label: 'Default (Opus 5.5)', resolved: 'claude-opus-5-5', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus', label: 'Opus', resolved: 'claude-opus-5-5', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', label: 'Sonnet', resolved: 'claude-sonnet-5', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', label: 'Haiku', resolved: 'claude-haiku-4-5-20251001' },
];

describe('CapabilityCatalog', () => {
  it('keeps each source catalog when the other source reports models', () => {
    const saved = storage();
    const catalog = new CapabilityCatalog(saved);
    catalog.remember('openai', [{ value: 'gpt-6-sol', label: 'GPT-6 Sol', effortLevels: ['medium', 'high'] }]);
    catalog.remember('anthropic', [{ value: 'opus', label: 'Opus', effortLevels: ['high'] }]);

    // The launcher's list: Anthropic first, whoever reported first.
    expect(catalog.value.map((m) => [m.provider, m.value])).toEqual([
      ['anthropic', 'opus'],
      ['openai', 'gpt-6-sol'],
    ]);
    expect(catalog.catalog.entries.map((e) => e.key).sort()).toEqual(['anthropic:opus', 'openai:gpt-6-sol']);
  });

  it('ignores an empty report rather than erasing a good list', () => {
    const catalog = new CapabilityCatalog(storage());
    catalog.remember('anthropic', CLAUDE);
    catalog.remember('anthropic', []);
    catalog.remember('anthropic', undefined);
    expect(catalog.value).toHaveLength(4);
  });

  it('upgrades the old model-catalog storage once, without loss', () => {
    const legacy = [
      { value: 'sonnet', label: 'Sonnet', resolved: 'claude-sonnet-5', effortLevels: ['low', 'high'] }, // pre-provider entry
      { value: 'gpt-6-luna', label: 'GPT-6 Luna', provider: 'openai', resolved: 'gpt-6-luna', effortLevels: ['low'] },
      { value: 'haiku', label: 'Haiku', provider: 'anthropic', resolved: 'claude-haiku-4-5' },
      { value: '', label: 'broken' },
    ];
    const saved = storage({ 'agentWrangler.modelCatalog': legacy });
    const catalog = new CapabilityCatalog(saved);

    expect(catalog.value).toEqual([
      { value: 'sonnet', label: 'Sonnet', resolved: 'claude-sonnet-5', effortLevels: ['low', 'high'], provider: 'anthropic' },
      { value: 'haiku', label: 'Haiku', resolved: 'claude-haiku-4-5', effortLevels: undefined, provider: 'anthropic' },
      { value: 'gpt-6-luna', label: 'GPT-6 Luna', resolved: 'gpt-6-luna', effortLevels: ['low'], provider: 'openai' },
    ]);
    // Written under the new key; the old one is left for an older build.
    expect(saved.data['agentWrangler.capabilityCatalog']).toMatchObject({ v: 1 });
    expect(saved.data['agentWrangler.modelCatalog']).toBe(legacy);
    // Upgraded facts carry no report time: nothing says when they were reported.
    expect(catalog.catalog.entries.every((e) => e.reportedAt === undefined)).toBe(true);

    // Once the new key exists the old one is never read again.
    saved.data['agentWrangler.modelCatalog'] = [{ value: 'stale', label: 'Stale' }];
    const writes = saved.writes;
    const reopened = new CapabilityCatalog(saved);
    expect(reopened.value.map((m) => m.value)).toEqual(['sonnet', 'haiku', 'gpt-6-luna']);
    expect(saved.writes).toBe(writes);
  });

  it('records the limits a harness reports, with provenance, and fires once per change', () => {
    const catalog = new CapabilityCatalog(storage(), undefined, () => 1000);
    catalog.remember('anthropic', CLAUDE);
    let fired = 0;
    catalog.onDidChange(() => fired++);

    catalog.observe('anthropic', 'claude-opus-5-5', { contextWindow: 200_000, maxOutputTokens: 64_000 });
    catalog.observe('anthropic', 'claude-opus-5-5', { contextWindow: 200_000, maxOutputTokens: 64_000 });
    expect(fired).toBe(1);

    const opus = catalog.catalog.entries.find((e) => e.key === 'anthropic:claude-opus-5-5')!;
    expect(opus.descriptor.contextWindow).toEqual({ value: 200_000, from: 'reported' });
    expect(opus.descriptor.maxOutputTokens).toEqual({ value: 64_000, from: 'reported' });
    const sonnet = catalog.catalog.entries.find((e) => e.key === 'anthropic:claude-sonnet-5')!;
    expect(sonnet.descriptor.contextWindow).toEqual({ unknown: true });
  });

  it('changing a tier in settings changes resolution and nothing else', async () => {
    const saved = storage();
    const prefs = settings();
    const catalog = new CapabilityCatalog(saved, prefs);
    catalog.remember('anthropic', CLAUDE);
    const storedBefore = JSON.stringify(saved.data);
    const before = catalog.catalog;
    expect(modelsInTierRange(before, 'basic', 'basic').map((e) => e.key)).toEqual(['anthropic:claude-haiku-4-5-20251001']);

    let fired = 0;
    catalog.onDidChange(() => fired++);
    expect(await catalog.setPolicy({ key: 'anthropic:claude-sonnet-5', tier: 'basic' })).toBe(true);

    expect(fired).toBe(1);
    expect(prefs.data[MODEL_POLICY_KEY]).toEqual({ 'anthropic:claude-sonnet-5': { tier: 'basic' } });
    const after = catalog.catalog;
    expect(after.version).not.toBe(before.version);
    expect(modelsInTierRange(after, 'basic', 'basic').map((e) => e.key).sort()).toEqual([
      'anthropic:claude-haiku-4-5-20251001',
      'anthropic:claude-sonnet-5',
    ]);
    // The stored facts are untouched: tier is policy, not a model property.
    expect(JSON.stringify(saved.data)).toBe(storedBefore);

    // Picking the default again stores nothing.
    await catalog.setPolicy({ key: 'anthropic:claude-sonnet-5', tier: 'standard' });
    expect(prefs.data[MODEL_POLICY_KEY]).toBeUndefined();
    expect(catalog.catalog.version).toBe(before.version);
  });

  it('refuses a tier the list does not have and a model it has never seen', async () => {
    const catalog = new CapabilityCatalog(storage(), settings());
    catalog.remember('anthropic', CLAUDE);
    expect(await catalog.setPolicy({ key: 'anthropic:claude-sonnet-5', tier: 'legendary' })).toBe(false);
    expect(await catalog.setPolicy({ key: 'anthropic:claude-unknown', tier: 'basic' })).toBe(false);
  });

  it('can unassign a model, which takes it out of the pool', async () => {
    const prefs = settings();
    const catalog = new CapabilityCatalog(storage(), prefs);
    catalog.remember('anthropic', CLAUDE);
    await catalog.setPolicy({ key: 'anthropic:claude-haiku-4-5-20251001', tier: null });
    const haiku = catalog.catalog.entries.find((e) => e.key === 'anthropic:claude-haiku-4-5-20251001')!;
    expect(haiku).toMatchObject({ tier: undefined, tierDeclared: true, routable: false, notRoutableBecause: 'Unassigned' });
    expect(catalog.catalog.entries[0].key).toBe(haiku.key); // unassigned first
  });
});
