import { describe, expect, it } from 'vitest';
import {
  applyPolicyChange,
  buildCatalog,
  DEFAULT_TIERS,
  defaultEffortMap,
  defaultFor,
  effortMapText,
  modelsInTierRange,
  nativeEffortFor,
  parseModelPolicy,
  parseTiers,
  type ReportedModels,
} from '../../src/shared/orchestration/catalog';
import { harnessOf, sourceOf } from '../../src/shared/harness';

const CLAUDE_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const REPORTED: ReportedModels[] = [
  {
    source: 'anthropic',
    at: 1000,
    models: [
      { value: 'default', label: 'Default (Opus 5.5)', resolved: 'claude-opus-5-5', effortLevels: CLAUDE_LEVELS, description: 'Most capable' },
      { value: 'opus', label: 'Opus', resolved: 'claude-opus-5-5', effortLevels: CLAUDE_LEVELS },
      { value: 'opus[1m]', label: 'Opus (1M context)', resolved: 'claude-opus-5-5[1m]', effortLevels: CLAUDE_LEVELS },
      { value: 'sonnet', label: 'Sonnet', resolved: 'claude-sonnet-5', effortLevels: CLAUDE_LEVELS },
      { value: 'haiku', label: 'Haiku', resolved: 'claude-haiku-4-5-20251001' },
      { value: 'claude-fable-5-1', label: 'Fable 5.1', resolved: 'claude-fable-5-1', effortLevels: CLAUDE_LEVELS },
      { value: 'claude-mythos-1', label: 'Mythos 1', resolved: 'claude-mythos-1', effortLevels: CLAUDE_LEVELS },
    ],
  },
  {
    source: 'openai',
    at: 2000,
    models: [
      { value: 'gpt-6-astra', label: 'GPT-6 Astra', resolved: 'gpt-6-astra', effortLevels: CODEX_LEVELS, inputModalities: ['text', 'image'] },
      { value: 'gpt-6-sol', label: 'GPT-6 Sol', resolved: 'gpt-6-sol', effortLevels: CODEX_LEVELS, inputModalities: ['text'] },
      { value: 'gpt-6-luna', label: 'GPT-6 Luna', resolved: 'gpt-6-luna', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', resolved: 'gpt-5.6-sol', effortLevels: CODEX_LEVELS },
      { value: 'codex-auto-review', label: 'Auto review', resolved: 'codex-auto-review', effortLevels: ['low'] },
    ],
  },
];

const byKey = (key: string) => buildCatalog({ reported: REPORTED }).entries.find((e) => e.key === key)!;

describe('vocabulary', () => {
  it('keeps harness and source apart', () => {
    expect(harnessOf('claude')).toBe('claude-code');
    expect(harnessOf('codex')).toBe('codex');
    expect(sourceOf('claude')).toBe('anthropic');
    expect(sourceOf('codex')).toBe('openai');
  });
});

describe('family tier defaults', () => {
  it('tiers Claude models by the family of the id they resolve to', () => {
    expect(defaultFor('anthropic', 'claude-haiku-4-5-20251001')?.tier).toBe('basic');
    expect(defaultFor('anthropic', 'claude-sonnet-5')?.tier).toBe('standard');
    expect(defaultFor('anthropic', 'claude-opus-5-5[1m]')?.tier).toBe('expert');
    expect(defaultFor('anthropic', 'us.anthropic.claude-opus-4-8-v1:0')?.tier).toBe('expert');
    expect(defaultFor('anthropic', 'claude-fable-5-1')?.tier).toBe('frontier');
    expect(defaultFor('anthropic', 'claude-mythos-1')).toBeUndefined();
  });

  it('assigns only the newest Codex generation, and excludes the reviewer', () => {
    expect(defaultFor('openai', 'gpt-6-luna')?.tier).toBe('basic');
    expect(defaultFor('openai', 'gpt-reserve')?.tier).toBe('basic');
    expect(defaultFor('openai', 'gpt-6-sol')?.tier).toBe('standard');
    expect(defaultFor('openai', 'gpt-6-astra')?.tier).toBe('expert');
    expect(defaultFor('openai', 'gpt-5.6-sol')).toBeUndefined();
    expect(defaultFor('openai', 'gpt-5.5')).toBeUndefined();
    expect(defaultFor('openai', 'codex-auto-review')?.excluded).toBeTruthy();
  });

  it('never matches across sources', () => {
    expect(defaultFor('openai', 'claude-opus-5-5')).toBeUndefined();
    expect(defaultFor('local:lab', 'gpt-6-sol')).toBeUndefined();
  });
});

describe('buildCatalog', () => {
  it('lists every reported model once per resolved id, aliases together', () => {
    const catalog = buildCatalog({ reported: REPORTED });
    expect(catalog.entries).toHaveLength(11);
    const opus = byKey('anthropic:claude-opus-5-5');
    // The stable alias is the one to call, not `default`, which may move.
    expect(opus.descriptor.modelId).toBe('opus');
    expect(opus.aliases).toEqual(['opus', 'default']);
    expect(opus.descriptor.label).toBe('Opus 5.5');
    expect(byKey('anthropic:claude-opus-5-5[1m]').descriptor.label).toBe('Opus 5.5 (1M context)');
    expect(opus.harnesses).toEqual(['claude-code']);
    expect(byKey('openai:gpt-6-sol').harnesses).toEqual(['codex']);
  });

  it('carries provenance, and leaves what nobody reported unknown', () => {
    const astra = byKey('openai:gpt-6-astra').descriptor;
    expect(astra.vision).toEqual({ value: true, from: 'reported' });
    expect(byKey('openai:gpt-6-sol').descriptor.vision).toEqual({ value: false, from: 'reported' });
    expect(astra.nativeEffort).toEqual({ value: CODEX_LEVELS, from: 'reported' });
    const sonnet = byKey('anthropic:claude-sonnet-5').descriptor;
    expect(sonnet.vision).toEqual({ unknown: true });
    expect(sonnet.contextWindow).toEqual({ unknown: true });
    expect(sonnet.toolCalling).toEqual({ unknown: true });
    expect(sonnet.throughput).toEqual({ unknown: true });
    expect(sonnet.maxConcurrency).toEqual({ unknown: true });
    expect(byKey('anthropic:claude-haiku-4-5-20251001').descriptor.nativeEffort).toEqual({ value: [], from: 'reported' });
  });

  it('merges observed limits by the resolved id', () => {
    const catalog = buildCatalog({
      reported: REPORTED,
      observed: { 'anthropic:claude-opus-5-5[1m]': { contextWindow: 1_000_000, at: 5 } },
    });
    const e = catalog.entries.find((x) => x.key === 'anthropic:claude-opus-5-5[1m]')!;
    expect(e.descriptor.contextWindow).toEqual({ value: 1_000_000, from: 'reported' });
    expect(e.descriptor.maxOutputTokens).toEqual({ unknown: true });
  });

  it('puts unassigned models first and never routes to them', () => {
    const catalog = buildCatalog({ reported: REPORTED });
    const unassigned = catalog.entries.filter((e) => e.tier === undefined).map((e) => e.key);
    expect(unassigned.sort()).toEqual(['anthropic:claude-mythos-1', 'openai:codex-auto-review', 'openai:gpt-5.6-sol']);
    expect(catalog.entries.slice(0, 3).every((e) => e.tier === undefined)).toBe(true);
    for (const key of unassigned) expect(byKey(key).routable).toBe(false);
    expect(byKey('openai:gpt-5.6-sol').notRoutableBecause).toBe('Unassigned');
    expect(byKey('openai:codex-auto-review')).toMatchObject({ enabled: false, notRoutableBecause: 'Not a coding model' });
    const everything = modelsInTierRange(catalog, 'basic', 'frontier', { allowEscalation: true });
    for (const key of unassigned) expect(everything.map((e) => e.key)).not.toContain(key);
  });

  it('keeps the escalation-only tier out of routing unless asked', () => {
    const catalog = buildCatalog({ reported: REPORTED });
    expect(modelsInTierRange(catalog, 'basic', 'frontier').map((e) => e.key)).not.toContain('anthropic:claude-fable-5-1');
    expect(modelsInTierRange(catalog, 'expert', 'frontier', { allowEscalation: true }).map((e) => e.key)).toContain(
      'anthropic:claude-fable-5-1',
    );
    expect(modelsInTierRange(catalog, 'expert', 'basic')).toEqual([]);
  });

  it('lets declared policy win over the defaults', () => {
    const catalog = buildCatalog({
      reported: REPORTED,
      policy: {
        'anthropic:claude-mythos-1': { tier: 'expert' },
        'anthropic:claude-opus-5-5': { enabled: false },
        'openai:gpt-6-sol': { tier: null },
        'openai:codex-auto-review': { enabled: true },
      },
    });
    const get = (key: string) => catalog.entries.find((e) => e.key === key)!;
    expect(get('anthropic:claude-mythos-1')).toMatchObject({ tier: 'expert', tierDeclared: true, routable: true });
    expect(get('anthropic:claude-opus-5-5')).toMatchObject({ tier: 'expert', enabled: false, routable: false, notRoutableBecause: 'Disabled' });
    expect(get('openai:gpt-6-sol')).toMatchObject({ tier: undefined, defaultTier: 'standard', routable: false });
    // Enabled on purpose, but still has no tier.
    expect(get('openai:codex-auto-review')).toMatchObject({ enabled: true, routable: false, notRoutableBecause: 'Unassigned' });
  });

  it('treats a tier the list does not define as unassigned, and says so', () => {
    const catalog = buildCatalog({ reported: REPORTED, policy: { 'anthropic:claude-sonnet-5': { tier: 'legendary' } } });
    const sonnet = catalog.entries.find((e) => e.key === 'anthropic:claude-sonnet-5')!;
    expect(sonnet).toMatchObject({ tier: undefined, routable: false, notRoutableBecause: 'Tier "legendary" is not defined' });
  });

  it('follows a custom tier list, and drops defaults naming a tier it lacks', () => {
    const tiers = parseTiers([{ name: 'cheap' }, { name: 'standard' }, { name: 'expert' }]);
    const catalog = buildCatalog({ reported: REPORTED, tiers });
    const haiku = catalog.entries.find((e) => e.key === 'anthropic:claude-haiku-4-5-20251001')!;
    expect(haiku.tier).toBeUndefined();
    expect(catalog.entries.find((e) => e.key === 'anthropic:claude-sonnet-5')!.tier).toBe('standard');
  });

  it('versions the catalog by what affects resolution', () => {
    const a = buildCatalog({ reported: REPORTED });
    const b = buildCatalog({ reported: REPORTED.map((r) => ({ ...r, at: 99 })) });
    expect(a.version).toMatch(/^cat-[0-9a-f]{8}$/);
    expect(b.version).toBe(a.version); // a newer report of the same list changes nothing
    const c = buildCatalog({ reported: REPORTED, policy: { 'openai:gpt-6-sol': { tier: 'expert' } } });
    expect(c.version).not.toBe(a.version);
  });

  it('says how each model gets a cost', () => {
    const catalog = buildCatalog({ reported: REPORTED, prices: { 'gpt-6-sol': { inPerMTok: 1, outPerMTok: 8 } } });
    const get = (key: string) => catalog.entries.find((e) => e.key === key)!;
    expect(get('anthropic:claude-sonnet-5').costReporting).toBe('harness-estimate');
    expect(get('openai:gpt-6-sol').costReporting).toBe('price-table');
    expect(get('openai:gpt-6-sol').descriptor.price).toEqual({ inPerMTok: 1, outPerMTok: 8 });
    expect(get('openai:gpt-6-astra').costReporting).toBe('none');
  });
});

describe('effort maps', () => {
  it('maps max to the strongest level below the pin-only ones', () => {
    expect(defaultEffortMap(CLAUDE_LEVELS)).toEqual({ low: 'low', medium: 'medium', high: 'high', max: 'xhigh' });
    expect(defaultEffortMap(CODEX_LEVELS)).toEqual({ low: 'low', medium: 'medium', high: 'high', max: 'xhigh' });
    // No xhigh: max falls to high rather than reaching the session-scoped max.
    expect(defaultEffortMap(['low', 'medium', 'high', 'max'])).toEqual({ low: 'low', medium: 'medium', high: 'high', max: 'high' });
  });

  it('leaves minimal to a pin and fills gaps with the nearest stronger level', () => {
    expect(defaultEffortMap(['minimal', 'medium', 'high'])).toEqual({ low: 'medium', medium: 'medium', high: 'high', max: 'high' });
  });

  it('says a model has no effort control', () => {
    expect(defaultEffortMap([])).toBeUndefined();
    const haiku = byKey('anthropic:claude-haiku-4-5-20251001');
    expect(haiku.effortMap).toBeUndefined();
    expect(nativeEffortFor(haiku, 'high')).toBe('none');
    expect(effortMapText(haiku)).toBe('No effort control');
  });

  it('gives native levels per model', () => {
    const sonnet = byKey('anthropic:claude-sonnet-5');
    expect(nativeEffortFor(sonnet, 'max')).toBe('xhigh');
    expect(effortMapText(sonnet)).toBe('low→low · medium→medium · high→high · max→xhigh');
    expect(sonnet.effortMapFrom).toBe('default');
  });

  it('an empty map when only pin-only levels exist', () => {
    expect(defaultEffortMap(['max'])).toEqual({});
  });

  it('accepts a declared map only where it names a real native level', () => {
    const catalog = buildCatalog({
      reported: REPORTED,
      policy: { 'anthropic:claude-sonnet-5': { effort: { max: 'max', high: 'turbo' } } },
    });
    const sonnet = catalog.entries.find((e) => e.key === 'anthropic:claude-sonnet-5')!;
    expect(sonnet.effortMap).toEqual({ max: 'max' });
    expect(sonnet.effortMapFrom).toBe('declared');
  });
});

describe('policy', () => {
  it('parses only well-formed entries', () => {
    expect(parseModelPolicy(undefined)).toEqual({});
    expect(parseModelPolicy([1, 2])).toEqual({});
    expect(
      parseModelPolicy({
        a: { tier: 'basic', enabled: 'yes', effort: { low: 'minimal', bogus: 'x' } },
        b: { tier: null },
        c: { tier: '' },
        d: 7,
      }),
    ).toEqual({ a: { tier: 'basic', effort: { low: 'minimal' } }, b: { tier: null } });
  });

  it('stores a value equal to the default by absence', () => {
    const defaults = { tier: 'standard', enabled: true };
    let p = applyPolicyChange({}, { key: 'k', tier: 'expert' }, defaults);
    expect(p).toEqual({ k: { tier: 'expert' } });
    p = applyPolicyChange(p, { key: 'k', enabled: false }, defaults);
    expect(p).toEqual({ k: { tier: 'expert', enabled: false } });
    p = applyPolicyChange(p, { key: 'k', tier: 'standard' }, defaults);
    expect(p).toEqual({ k: { enabled: false } });
    p = applyPolicyChange(p, { key: 'k', reset: 'enabled' }, defaults);
    expect(p).toEqual({});
  });

  it('stores an explicit unassigned over a default tier, and nothing over no default', () => {
    expect(applyPolicyChange({}, { key: 'k', tier: null }, { tier: 'basic', enabled: true })).toEqual({ k: { tier: null } });
    expect(applyPolicyChange({}, { key: 'k', tier: null }, { enabled: true })).toEqual({});
  });

  it('falls back to the default tier list when the stored one is malformed', () => {
    expect(parseTiers(undefined)).toEqual(DEFAULT_TIERS);
    expect(parseTiers([{ name: 'a' }, { name: 'a' }])).toEqual(DEFAULT_TIERS);
    expect(parseTiers([{ name: 'a', reachableBy: 'escalation' }, { name: 'b', reachableBy: 'nonsense' }])).toEqual([
      { name: 'a', reachableBy: 'escalation' },
      { name: 'b', reachableBy: 'route' },
    ]);
  });
});
