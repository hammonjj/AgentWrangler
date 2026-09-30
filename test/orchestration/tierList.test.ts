/**
 * The tier list: one validator for the loader, the host's save and the Tiers
 * editor; old names (aliases) that keep a renamed tier's references working
 * everywhere a tier name is compared; and the save plan behind setTierList.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KeyValueStorage } from '../../src/core/archive';
import { CapabilityCatalog, type CatalogSettings } from '../../src/core/capabilityCatalog';
import { JsonSettings } from '../../src/electron/jsonStore';
import {
  buildCatalog,
  canonicalTier,
  DEFAULT_TIERS,
  MODEL_POLICY_KEY,
  modelsInTierRange,
  parseTiers,
  tierRank,
  TIERS_KEY,
  validateTierList,
  type ReportedModels,
  type TierDef,
} from '../../src/shared/orchestration/catalog';
import { ROUTING_KEY, parseRoutingSettings, resolveEffectivePolicy, validateExecutionPolicy } from '../../src/shared/orchestration/executionPolicy';
import { draftRenames, isShippedList, planTierListSave, tierListImpact, tierListMessage } from '../../src/shared/orchestration/tierListSave';
import { routeTask } from '../../src/orchestration/policy/router';
import { resolveRoute } from '../../src/orchestration/policy/resolver';
import { decideEscalation, limitsFor } from '../../src/orchestration/policy/escalation';
import { assessed } from './routingFixtures';

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const REPORTED: ReportedModels[] = [
  {
    source: 'anthropic',
    models: [
      { value: 'haiku', label: 'Haiku', resolved: 'claude-haiku-4-5-20251001' },
      { value: 'sonnet', label: 'Sonnet', resolved: 'claude-sonnet-5', effortLevels: LEVELS },
      { value: 'opus', label: 'Opus', resolved: 'claude-opus-5-5', effortLevels: LEVELS },
    ],
  },
];

/** The shipped list with `expert` renamed to `pro`, the old name kept. */
const RENAMED: TierDef[] = [
  { name: 'basic', reachableBy: 'route' },
  { name: 'standard', reachableBy: 'route' },
  { name: 'pro', reachableBy: 'route', aliases: ['expert'] },
  { name: 'frontier', reachableBy: 'escalation' },
];

describe('validateTierList (the loader’s rules, shared)', () => {
  it('rejects a blank name and marks both rows of a duplicate, after trimming', () => {
    const r = validateTierList([
      { name: 'basic', reachableBy: 'route' },
      { name: '  ', reachableBy: 'route' },
      { name: 'expert ', reachableBy: 'route' },
      { name: 'expert', reachableBy: 'escalation' },
    ]);
    expect(r).toEqual({
      ok: false,
      errors: [
        { index: 1, message: 'Name is required' },
        { index: 2, message: 'Duplicate name' },
        { index: 3, message: 'Duplicate name' },
      ],
    });
  });

  it('rejects an empty list', () => {
    expect(validateTierList([])).toMatchObject({ ok: false, errors: [{ index: -1 }] });
  });

  it('rejects an old name that collides with a name or with another tier’s old name', () => {
    expect(validateTierList([...RENAMED, { name: 'expert', reachableBy: 'route' }])).toEqual({
      ok: false,
      errors: [{ index: 4, message: 'Already an old name of "pro"' }],
    });
    const twice = validateTierList([
      { name: 'a', reachableBy: 'route', aliases: ['old'] },
      { name: 'b', reachableBy: 'route', aliases: ['old'] },
    ]);
    expect(twice.ok).toBe(false);
  });

  it('is what the loader uses: a bad list falls back to the shipped one whole, a good one keeps its old names', () => {
    expect(parseTiers([{ name: 'a' }, { name: 'a ' }])).toEqual(DEFAULT_TIERS);
    expect(parseTiers([...RENAMED, { name: 'expert', reachableBy: 'route' }])).toEqual(DEFAULT_TIERS);
    expect(parseTiers(RENAMED)).toEqual(RENAMED);
    expect(parseTiers([{ name: ' basic ', reachableBy: 'route', aliases: ['basic', ' cheap ', 7] }])).toEqual([{ name: 'basic', reachableBy: 'route', aliases: ['cheap'] }]);
  });

  it('is the one the Tiers editor imports', () => {
    const editor = fs.readFileSync(path.join(__dirname, '../../src/webview/preferences/orchTiers.ts'), 'utf8');
    expect(editor).toMatch(/import \{[^}]*validateTierList[^}]*\} from '..\/..\/shared\/orchestration\/catalog'/);
    expect(editor).not.toMatch(/Duplicate name|Name is required/);
  });
});

describe('an old name resolves to its tier everywhere', () => {
  it('tierRank and canonicalTier', () => {
    expect(tierRank(RENAMED, 'expert')).toBe(2);
    expect(canonicalTier(RENAMED, 'expert')).toBe('pro');
    expect(canonicalTier(RENAMED, 'pro')).toBe('pro');
    expect(canonicalTier(RENAMED, 'legendary')).toBeUndefined();
  });

  it('buildCatalog: a shipped default and an override written with the old name land on the renamed tier', () => {
    const c = buildCatalog({ reported: REPORTED, tiers: RENAMED, policy: { 'anthropic:claude-sonnet-5': { tier: 'expert' } } });
    const opus = c.entries.find((e) => e.key === 'anthropic:claude-opus-5-5')!;
    const sonnet = c.entries.find((e) => e.key === 'anthropic:claude-sonnet-5')!;
    expect(opus).toMatchObject({ tier: 'pro', defaultTier: 'pro', routable: true });
    expect(sonnet).toMatchObject({ tier: 'pro', routable: true });
    expect(modelsInTierRange(c, 'expert', 'expert').map((e) => e.key).sort()).toEqual(['anthropic:claude-opus-5-5', 'anthropic:claude-sonnet-5']);
  });

  it('caps validation and the effective policy accept a cap written with the old name', () => {
    expect(validateExecutionPolicy({ caps: { maxTier: 'expert' } }, { tiers: RENAMED }).ok).toBe(true);
    const eff = resolveEffectivePolicy([{ scope: 'repo', policy: { caps: { maxTier: 'expert' } } }], { tiers: RENAMED });
    expect(eff.conflicts).toEqual([]);
    expect(eff.policy.caps?.maxTier).toBe('expert');
  });

  it('the router reads a cap written with the old name as that tier', () => {
    const hard = assessed({ complexity: 'hard', breadth: 'subsystem', risk: 'high', verifiability: 'partial', kind: 'architecture' });
    const r = routeTask(hard, { tiers: RENAMED, caps: { maxTier: 'expert' } });
    expect(r.verdict).toBe('route');
    expect(r.requirement).toMatchObject({ minTier: 'pro', maxTier: 'pro' });
    expect(r.reasons.some((x) => x.ruleId === 'cap.unknown')).toBe(false);
  });

  it('the resolver honours a requirement written with the old name', () => {
    const catalog = buildCatalog({ reported: REPORTED, tiers: RENAMED });
    const res = resolveRoute({ minTier: 'expert', maxTier: 'expert', effort: 'high', needs: [], gates: [] }, { catalog, sources: {}, now: 0 });
    expect(res.outcome).toBe('resolved');
    expect(res.target).toMatchObject({ model: 'opus', tier: 'pro' });
  });

  it('escalation treats a cap and a route written with the old name as that tier', () => {
    const out = decideEscalation({
      taskId: 't1',
      afterAttemptId: 'a2',
      classification: { category: 'quality-repeat', signature: 's', detail: 'synthetic' },
      history: [
        { id: 'a1', n: 1, status: 'failed', category: 'quality-new', signature: 's' },
        { id: 'a2', n: 2, status: 'failed', category: 'quality-repeat', signature: 's' },
      ],
      decisions: [],
      route: { harness: 'claude-code', model: 'sonnet', tier: 'standard', effort: 'max' },
      mode: 'auto',
      pinned: ['harness'],
      caps: { maxTier: 'expert' },
      frontierAllowed: false,
      autoRecover: false,
      tiers: RENAMED,
      sessionContinuable: true,
      effortMidSession: true,
      limits: limitsFor('auto'),
      probe: (req) => ({ ok: true, target: { harness: 'claude-code', source: 'anthropic', model: 'opus', tier: req.tier, effortNative: 'high', location: 'hosted' } }),
      now: 0,
      newId: () => 'd1',
    });
    // Raising standard → pro is within a cap of "expert", which is pro.
    expect(out.final).toMatchObject({ action: 'raise-tier', delta: { tier: 'pro' } });
  });
});

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

const SHIPPED_DRAFT = DEFAULT_TIERS.map(({ name, reachableBy }) => ({ name, reachableBy }));
const PRO_DRAFT = SHIPPED_DRAFT.map((t) => (t.name === 'expert' ? { ...t, name: 'pro' } : t));

describe('planTierListSave', () => {
  it('a rename keeps the old name and rewrites overrides and the global cap, in one set of writes', () => {
    const r = planTierListSave({
      current: DEFAULT_TIERS,
      tiers: PRO_DRAFT,
      renames: [{ from: 'expert', to: 'pro' }],
      models: { 'anthropic:claude-sonnet-5': { tier: 'expert', enabled: false }, 'openai:x': { tier: 'basic' } },
      routing: { mode: 'assisted', caps: { maxTier: 'expert', maxEffort: 'high' } },
    });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.plan.writes).toEqual({
      [TIERS_KEY]: RENAMED,
      [MODEL_POLICY_KEY]: { 'anthropic:claude-sonnet-5': { tier: 'pro', enabled: false }, 'openai:x': { tier: 'basic' } },
      [ROUTING_KEY]: { mode: 'assisted', caps: { maxTier: 'pro', maxEffort: 'high' } },
    });
    expect(r.plan.rewrittenModels).toEqual(['anthropic:claude-sonnet-5']);
  });

  it('a second rename carries the first one’s old name along, and rewrites an override written with it', () => {
    const r = planTierListSave({
      current: RENAMED,
      tiers: SHIPPED_DRAFT.map((t) => (t.name === 'expert' ? { ...t, name: 'elite' } : t)),
      renames: [{ from: 'pro', to: 'elite' }],
      models: { m: { tier: 'expert' } },
      routing: undefined,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.plan.tiers[2]).toEqual({ name: 'elite', reachableBy: 'route', aliases: ['pro', 'expert'] });
    expect(r.plan.writes[MODEL_POLICY_KEY]).toEqual({ m: { tier: 'elite' } });
  });

  it('restoring the shipped tiers deletes the key and writes nothing else', () => {
    const r = planTierListSave({ current: RENAMED, tiers: 'default', renames: [], models: { m: { tier: 'basic' } }, routing: { mode: 'manual' } });
    expect(r).toMatchObject({ ok: true, plan: { writes: { [TIERS_KEY]: undefined } } });
    if (r.ok) expect(Object.keys(r.plan.writes)).toEqual([TIERS_KEY]);
    expect(isShippedList(SHIPPED_DRAFT)).toBe(true);
    expect(isShippedList(PRO_DRAFT)).toBe(false);
  });

  it('rejects blank and duplicate names on the host, with the same validator', () => {
    const r = planTierListSave({ current: DEFAULT_TIERS, tiers: [{ name: 'a', reachableBy: 'route' }, { name: ' a', reachableBy: 'route' }, { name: '', reachableBy: 'route' }], renames: [], models: {}, routing: {} });
    expect(r).toEqual({
      ok: false,
      errors: [
        { index: 2, message: 'Name is required' },
        { index: 0, message: 'Duplicate name' },
        { index: 1, message: 'Duplicate name' },
      ],
    });
  });

  it('rejects a new tier that takes a renamed tier’s old name, and a rename of a tier that is not there', () => {
    expect(planTierListSave({ current: RENAMED, tiers: [...PRO_DRAFT, { name: 'expert', reachableBy: 'route' }], renames: [], models: {}, routing: {} }).ok).toBe(false);
    expect(planTierListSave({ current: DEFAULT_TIERS, tiers: PRO_DRAFT, renames: [{ from: 'legendary', to: 'pro' }], models: {}, routing: {} }).ok).toBe(false);
  });

  it('reads the message: a list or "default", with renames', () => {
    expect(tierListMessage({ type: 'setTierList', tiers: 'default', renames: [] })).toEqual({ tiers: 'default', renames: [] });
    expect(tierListMessage({ type: 'setTierList', tiers: [{ name: 'a', reachableBy: 'sideways' }], renames: [] })).toBeUndefined();
    expect(tierListMessage({ type: 'setTierList', tiers: [], renames: [{ from: 1 }] })).toBeUndefined();
  });
});

describe('what saving changes', () => {
  const entries = buildCatalog({ reported: REPORTED, policy: { 'anthropic:claude-sonnet-5': { tier: 'expert' } } }).entries;

  it('deleting a tier models and the global cap use is allowed, with warnings', () => {
    const rows = [
      { name: 'basic', reachableBy: 'route' as const, origin: 'basic' },
      { name: 'standard', reachableBy: 'route' as const, origin: 'standard' },
      { name: 'frontier', reachableBy: 'escalation' as const, origin: 'frontier' },
    ];
    expect(tierListImpact({ saved: DEFAULT_TIERS, rows, entries, globalCap: 'expert' })).toEqual([
      'Deleting "expert" leaves 1 model on an undefined tier. They stop routing with: Tier "expert" is not defined.',
      'Deleting "expert" leaves 1 model whose shipped default is "expert" unassigned.',
      'The global defaults cap tiers at "expert". Once it is gone that cap names no tier and is ignored, as are repo and mission caps that name it.',
    ]);
    // And the host saves it: warnings do not block.
    expect(planTierListSave({ current: DEFAULT_TIERS, tiers: rows, renames: [], models: {}, routing: { caps: { maxTier: 'expert' } } }).ok).toBe(true);
  });

  it('says what a rename does, and when no tier is left for the router', () => {
    const rows = DEFAULT_TIERS.map((t) => ({ name: t.name === 'expert' ? 'pro' : t.name, reachableBy: 'escalation' as const, origin: t.name }));
    expect(draftRenames(rows)).toEqual([{ from: 'expert', to: 'pro' }]);
    const impact = tierListImpact({ saved: DEFAULT_TIERS, rows, entries, globalCap: 'expert' });
    expect(impact).toContain('The global defaults cap is rewritten from "expert" to "pro".');
    expect(impact).toContain('No tier is reachable by route, so the router has nothing to pick.');
    expect(impact[0]).toMatch(/^Renaming "expert" to "pro": its 2 models move with it/);
  });
});

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

function storage(): KeyValueStorage {
  const data: Record<string, unknown> = {};
  return { get: <T>(k: string, d: T) => (k in data ? (data[k] as T) : d), update: (k: string, v: unknown) => void (data[k] = v) };
}

describe('CapabilityCatalog.setTierList', () => {
  it('writes the list, the overrides and the cap in one settings write and one change event', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-tiers-'));
    try {
      const file = path.join(dir, 'settings.json');
      fs.writeFileSync(file, JSON.stringify({ [MODEL_POLICY_KEY]: { 'anthropic:claude-sonnet-5': { tier: 'expert' } }, [ROUTING_KEY]: { mode: 'manual', caps: { maxTier: 'expert' } } }));
      const settings = new JsonSettings(file);
      const events: string[][] = [];
      settings.onDidChange((affects) => events.push([TIERS_KEY, MODEL_POLICY_KEY, ROUTING_KEY].filter(affects)));
      const catalog = new CapabilityCatalog(storage(), settings);
      catalog.remember('anthropic', REPORTED[0].models);
      let fired = 0;
      catalog.onDidChange(() => fired++);

      expect(await catalog.setTierList({ tiers: PRO_DRAFT, renames: [{ from: 'expert', to: 'pro' }] })).toEqual({ ok: true });
      expect(events).toEqual([[TIERS_KEY, MODEL_POLICY_KEY, ROUTING_KEY]]);
      expect(fired).toBe(1);
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(onDisk[TIERS_KEY]).toEqual(RENAMED);
      expect(onDisk[MODEL_POLICY_KEY]).toEqual({ 'anthropic:claude-sonnet-5': { tier: 'pro' } });
      expect(parseRoutingSettings(onDisk[ROUTING_KEY]).policy.caps?.maxTier).toBe('pro');
      expect(catalog.catalog.entries.find((e) => e.key === 'anthropic:claude-opus-5-5')?.tier).toBe('pro');

      // Restore deletes the key; nothing else is touched.
      expect(await catalog.setTierList({ tiers: 'default', renames: [{ from: 'pro', to: 'expert' }] })).toEqual({ ok: true });
      const restored = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(TIERS_KEY in restored).toBe(false);
      expect(restored[MODEL_POLICY_KEY]).toEqual({ 'anthropic:claude-sonnet-5': { tier: 'expert' } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an invalid list and writes nothing', async () => {
    const writes: string[] = [];
    const settings: CatalogSettings = {
      get: <T>(_k: string, d: T) => d,
      update: async (k: string) => void writes.push(k),
      onDidChange: () => ({ dispose: () => undefined }),
    };
    const catalog = new CapabilityCatalog(storage(), settings);
    const r = await catalog.setTierList({ tiers: [{ name: 'a', reachableBy: 'route' }, { name: 'a', reachableBy: 'route' }], renames: [] });
    expect(r).toEqual({ ok: false, errors: ['Tier 1: Duplicate name', 'Tier 2: Duplicate name'] });
    expect(writes).toEqual([]);
  });
});
