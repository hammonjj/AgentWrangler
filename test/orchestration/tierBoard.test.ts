import { describe, expect, it } from 'vitest';
import { buildCatalog, DEFAULT_TIERS, known, UNKNOWN, type CatalogEntry, type ModelDescriptor, type ReportedModels, type TierDef } from '../../src/shared/orchestration/catalog';
import { localModelStatus } from '../../src/shared/orchestration/localReadiness';
import {
  buildBoard,
  matchesQuery,
  meterBars,
  needsTierBadge,
  needsTierCount,
  rowStatus,
  tierOptions,
  type BoardQuery,
} from '../../src/shared/orchestration/tierBoard';
import { laneSubline, tierRoleLine, tierRoles } from '../../src/shared/orchestration/tierRoles';
import { routeTask } from '../../src/orchestration/policy/router';
import { assessed, type Levels } from './routingFixtures';

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Invented models: two with shipped defaults, two that no default names. */
const REPORTED: ReportedModels[] = [
  {
    source: 'anthropic',
    models: [
      { value: 'sonnet', label: 'Sonnet', resolved: 'claude-sonnet-5', effortLevels: LEVELS },
      { value: 'haiku', label: 'Haiku', resolved: 'claude-haiku-4-5-20251001' },
      { value: 'claude-newfamily-1', label: 'Newfamily 1', resolved: 'claude-newfamily-1', effortLevels: LEVELS },
    ],
  },
  {
    source: 'openai',
    models: [{ value: 'gpt-9-test', label: 'GPT-9 Test', resolved: 'gpt-9-test', effortLevels: LEVELS }],
  },
];

describe('Models badge', () => {
  it('counts enabled models nothing ever gave a tier', () => {
    const catalog = buildCatalog({ reported: REPORTED });
    expect(needsTierCount(catalog.entries)).toBe(2);
  });

  it('leaves out a model unassigned on purpose, a disabled one, and one on an undefined tier', () => {
    const catalog = buildCatalog({
      reported: REPORTED,
      policy: {
        'anthropic:claude-haiku-4-5-20251001': { tier: null },
        'anthropic:claude-newfamily-1': { enabled: false },
        'openai:gpt-9-test': { tier: 'legendary' },
      },
    });
    expect(needsTierCount(catalog.entries)).toBe(0);
  });

  it('counts a model whose default tier the list no longer has', () => {
    const catalog = buildCatalog({ reported: REPORTED, tiers: [{ name: 'basic', reachableBy: 'route' }] });
    // Sonnet defaults to standard, which this list does not have; the two new ones have nothing.
    expect(needsTierCount(catalog.entries)).toBe(3);
  });

  it('is hidden at 0 and says what it counts to a screen reader', () => {
    expect(needsTierBadge(0)).toBeUndefined();
    expect(needsTierBadge(4)).toEqual({ text: '4', srText: '4 need a tier' });
    expect(needsTierBadge(1)).toEqual({ text: '1', srText: '1 needs a tier' });
  });
});

// ---------------------------------------------------------------------------
// Routability: the row's dot and reason come from the catalog, worded
// ---------------------------------------------------------------------------

function localDescriptor(id: string, source = 'local:box', qualified = false): ModelDescriptor {
  return {
    source,
    modelId: id,
    label: id,
    location: 'local',
    contextWindow: known(65_536, 'declared'),
    maxOutputTokens: UNKNOWN,
    toolCalling: qualified ? known('reliable', 'measured') : UNKNOWN,
    structuredOutput: UNKNOWN,
    vision: UNKNOWN,
    streaming: UNKNOWN,
    nativeEffort: UNKNOWN,
    maxConcurrency: UNKNOWN,
    throughput: UNKNOWN,
    costBasis: 'none',
    ...(qualified ? { qualifiedHarnesses: ['codex' as const] } : {}),
  };
}

function withLocal(policy: Parameters<typeof buildCatalog>[0]['policy'], endpointEnabled = true, harnesses: ('codex' | 'claude-code')[] = ['codex']) {
  return buildCatalog({
    reported: REPORTED,
    policy,
    local: [{ descriptor: localDescriptor('coder'), harnesses, endpointEnabled, external: false, ...(harnesses.length === 0 ? { completionOnlyBecause: 'No harness can drive it' } : {}) }],
  });
}

const entryOf = (c: { entries: CatalogEntry[] }, key: string) => c.entries.find((e) => e.key === key)!;

describe('routability as the board shows it', () => {
  it('disabled: a hollow dot and "Not routed: disabled"', () => {
    const e = entryOf(buildCatalog({ reported: REPORTED, policy: { 'anthropic:claude-sonnet-5': { enabled: false } } }), 'anthropic:claude-sonnet-5');
    expect(rowStatus(e)).toEqual({ routable: false, tone: 'off', reason: 'Not routed: disabled' });
  });

  it('unassigned: nothing ever gave it a tier', () => {
    const e = entryOf(buildCatalog({ reported: REPORTED }), 'openai:gpt-9-test');
    expect(rowStatus(e)).toEqual({ routable: false, tone: 'warn', reason: 'Not routed: unassigned' });
  });

  it('unassigned on purpose: a default tier overridden with null', () => {
    const e = entryOf(buildCatalog({ reported: REPORTED, policy: { 'anthropic:claude-sonnet-5': { tier: null } } }), 'anthropic:claude-sonnet-5');
    expect(rowStatus(e)).toEqual({ routable: false, tone: 'warn', reason: 'Not routed: unassigned on purpose' });
  });

  it('a tier the list does not define', () => {
    const e = entryOf(buildCatalog({ reported: REPORTED, policy: { 'openai:gpt-9-test': { tier: 'legendary' } } }), 'openai:gpt-9-test');
    expect(rowStatus(e)).toEqual({ routable: false, tone: 'warn', reason: 'Not routed: tier "legendary" is not defined' });
  });

  it('its endpoint is off', () => {
    const e = entryOf(withLocal({ 'local:box:coder': { tier: 'basic' } }, false), 'local:box:coder');
    expect(rowStatus(e)).toEqual({ routable: false, tone: 'warn', reason: 'Not routed: its endpoint is off' });
  });

  it('no harness can drive it', () => {
    const e = entryOf(withLocal({ 'local:box:coder': { tier: 'basic' } }, true, []), 'local:box:coder');
    expect(rowStatus(e)).toEqual({ routable: false, tone: 'warn', reason: 'Not routed: no harness can drive it' });
  });

  it('routable, with a note: a local model that cannot plan at its tier', () => {
    const catalog = buildCatalog({
      reported: [],
      policy: { 'local:box:coder': { tier: 'basic' } },
      local: [{ descriptor: localDescriptor('coder', 'local:box', true), harnesses: ['codex'], endpointEnabled: true, external: false }],
    });
    const e = entryOf(catalog, 'local:box:coder');
    const local = localModelStatus({ entry: e, tiers: DEFAULT_TIERS, facts: { endpointOn: true, health: 'reachable', responses: true, plannerWindowFits: true } });
    expect(rowStatus(e, local)).toEqual({ routable: true, tone: 'note', reason: 'Planning needs tier standard or above (it has basic)' });
  });

  it('routable, with a caution: a local model not yet qualified for agentic work', () => {
    const e = entryOf(withLocal({ 'local:box:coder': { tier: 'standard' } }), 'local:box:coder');
    const local = localModelStatus({ entry: e, tiers: DEFAULT_TIERS, facts: { endpointOn: true, health: 'reachable', responses: true, plannerWindowFits: true } });
    expect(rowStatus(e, local)).toMatchObject({ routable: true, tone: 'caution' });
    expect(rowStatus(e, local).reason).toMatch(/^Agentic work needs qualification for Codex or Claude Code/);
  });

  it('routable with nothing to say: a green dot and no reason', () => {
    expect(rowStatus(entryOf(buildCatalog({ reported: REPORTED }), 'anthropic:claude-sonnet-5'))).toEqual({ routable: true, tone: 'ok' });
  });
});

// ---------------------------------------------------------------------------
// The tier select
// ---------------------------------------------------------------------------

describe('tier options', () => {
  it('mark the default and the escalation-only tier', () => {
    const { options, value } = tierOptions(entryOf(buildCatalog({ reported: REPORTED }), 'anthropic:claude-sonnet-5'), DEFAULT_TIERS);
    expect(options.map((o) => o.label)).toEqual(['Unassigned', 'basic', 'standard — default', 'expert', 'frontier (escalation only)']);
    expect(value).toBe('standard');
  });

  it('make Unassigned the default for a model no default names', () => {
    const { options, value } = tierOptions(entryOf(buildCatalog({ reported: REPORTED }), 'openai:gpt-9-test'), DEFAULT_TIERS);
    expect(options[0]).toEqual({ value: '', label: 'Unassigned — default' });
    expect(value).toBe('');
  });

  it('show a stored tier the list does not have, disabled, as the value', () => {
    const e = entryOf(buildCatalog({ reported: REPORTED, policy: { 'openai:gpt-9-test': { tier: 'legendary' } } }), 'openai:gpt-9-test');
    const { options, value } = tierOptions(e, DEFAULT_TIERS);
    expect(options.at(-1)).toEqual({ value: 'legendary', label: 'legendary (not defined)', disabled: true });
    expect(value).toBe('legendary');
  });
});

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

const ALL: BoardQuery = { query: '', filter: 'all', showDisabled: {} };

function board(policy: Parameters<typeof buildCatalog>[0]['policy'], q: Partial<BoardQuery> = {}, tiers: readonly TierDef[] = DEFAULT_TIERS) {
  const c = buildCatalog({ reported: REPORTED, policy, tiers });
  return buildBoard(c.entries, c.tiers, (e) => rowStatus(e), { ...ALL, ...q });
}

describe('buildBoard', () => {
  it('puts "Needs a tier" first, then every tier weakest first, with counts over all models', () => {
    const b = board({});
    expect(b.lanes.map((l) => l.title)).toEqual(['Needs a tier', 'basic', 'standard', 'expert', 'frontier']);
    expect(b.counts).toEqual({ all: 4, routable: 2, notRouted: 2 });
    expect(b.lanes[0]).toMatchObject({ kind: 'inbox', countText: '2 waiting' });
    expect(b.lanes[1]).toMatchObject({ countText: '1 of 1 routable', sub: 'Weakest routable tier · reachable by route' });
    expect(b.lanes[4]).toMatchObject({ escalation: true, countText: '0 of 0 routable' });
  });

  it('warns on a lane with nothing routable, in the words the resolver and escalation bear out', () => {
    const b = board({});
    expect(b.lanes.find((l) => l.title === 'expert')?.warn).toBe(
      'Nothing routable. Tasks that need expert move up to the next tier with a routable model, within their cap, never into escalation-only.',
    );
    expect(b.lanes.find((l) => l.title === 'frontier')?.warn).toBe('Nothing routable here, so escalation stops at the tier below.');
    expect(b.lanes.find((l) => l.title === 'basic')?.warn).toBeUndefined();
  });

  it('leaves "Needs a tier" out when it is empty', () => {
    const b = board({ 'anthropic:claude-newfamily-1': { tier: 'basic' }, 'openai:gpt-9-test': { tier: 'expert' } });
    expect(b.lanes[0].title).toBe('basic');
  });

  it('sorts enabled rows first and folds a tier lane’s disabled rows until asked', () => {
    const policy = { 'anthropic:claude-haiku-4-5-20251001': { enabled: false }, 'anthropic:claude-newfamily-1': { tier: 'basic' } };
    const folded = board(policy).lanes.find((l) => l.title === 'basic')!;
    const keys = (rows: { entry: CatalogEntry }[]) => rows.map((r) => r.entry.key);
    expect(keys(folded.rows)).toEqual(['anthropic:claude-newfamily-1']);
    expect(keys(folded.hidden)).toEqual(['anthropic:claude-haiku-4-5-20251001']);
    expect(folded.toggleText).toBe(`Show 1 disabled: ${folded.hidden[0].entry.descriptor.label}`);
    const open = board(policy, { showDisabled: { basic: true } }).lanes.find((l) => l.title === 'basic')!;
    expect(keys(open.rows)).toEqual(['anthropic:claude-newfamily-1', 'anthropic:claude-haiku-4-5-20251001']);
    expect(open.toggleText).toBe('Hide 1 disabled');
  });

  it('never folds the expanded row, and never folds while searching or filtering', () => {
    const policy = { 'anthropic:claude-haiku-4-5-20251001': { enabled: false } };
    expect(board(policy, { expanded: 'anthropic:claude-haiku-4-5-20251001' }).lanes.find((l) => l.title === 'basic')!.hidden).toEqual([]);
    expect(board(policy, { query: 'hai' }).lanes.find((l) => l.title === 'basic')!.rows).toHaveLength(1);
  });

  it('filters and searches; a lane with nothing to show is left out, counts ignore the search', () => {
    const routable = board({}, { filter: 'routable' });
    expect(routable.lanes.map((l) => l.title)).toEqual(['basic', 'standard']);
    const notRouted = board({}, { filter: 'notRouted' });
    expect(notRouted.lanes.map((l) => l.title)).toEqual(['Needs a tier']);
    const search = board({}, { query: 'GPT-9' });
    expect(search.lanes.map((l) => l.title)).toEqual(['Needs a tier']);
    expect(search.counts.all).toBe(4);
    expect(board({}, { query: 'nothing like this' }).lanes).toEqual([]);
  });

  it('marks a model with a stored entry as changed', () => {
    const b = board({ 'anthropic:claude-sonnet-5': { tier: 'expert' } });
    const row = b.lanes.find((l) => l.title === 'expert')!.rows[0];
    expect(row).toMatchObject({ changed: true });
    expect(b.lanes.find((l) => l.title === 'basic')!.rows[0].changed).toBe(false);
  });

  it('searches label, resolved id and aliases', () => {
    const e = entryOf(buildCatalog({ reported: REPORTED }), 'anthropic:claude-sonnet-5');
    expect(matchesQuery(e, 'SONNET')).toBe(true);
    expect(matchesQuery(e, 'claude-sonnet-5')).toBe(true);
    expect(matchesQuery(e, 'opus')).toBe(false);
  });

  it('scales the strength meter onto four bars', () => {
    expect(meterBars(0, 4)).toEqual([true, false, false, false]);
    expect(meterBars(3, 4)).toEqual([true, true, true, true]);
    expect(meterBars(1, 4)).toEqual([true, true, false, false]);
    expect(meterBars(1, 3)).toEqual([true, true, true, false]);
    expect(meterBars(0, 1)).toEqual([true, false, false, false]);
  });
});

// ---------------------------------------------------------------------------
// The role line and lane subline match the router
// ---------------------------------------------------------------------------

/** An assessment the router sends to each of its three named tiers. */
const WORK: Record<'basic' | 'standard' | 'expert', Levels> = {
  basic: { complexity: 'trivial', breadth: 'few-files', risk: 'low', verifiability: 'partial', kind: 'docs' },
  standard: { complexity: 'routine', breadth: 'cross-cutting', risk: 'moderate', verifiability: 'strong', kind: 'refactor' },
  expert: { complexity: 'hard', breadth: 'subsystem', risk: 'high', verifiability: 'partial', kind: 'architecture' },
};

function list(spec: string): TierDef[] {
  // "r r e r": route, route, escalation, route.
  return spec.split(' ').map((k, i) => ({ name: `t${i}`, reachableBy: k === 'e' ? 'escalation' : 'route' }));
}

describe('tier roles match the router', () => {
  const cases = ['r', 'r r', 'r r r', 'r r r r r', 'r e r', 'e r r e', 'r r e r r e'];
  for (const spec of cases) {
    it(`for "${spec}"`, () => {
      const tiers = list(spec);
      const roles = tierRoles(tiers);
      for (const role of ['basic', 'standard', 'expert'] as const) {
        const landed = routeTask(assessed(WORK[role]), { tiers }).requirement.minTier;
        const said = roles.filter((r) => r.roles.includes(role)).map((r) => r.tier.name);
        expect(said, `${role} on ${spec}`).toEqual([landed]);
      }
      for (const r of roles) {
        if (r.tier.reachableBy === 'escalation') expect(tierRoleLine(r)).toBe('Never chosen by the router · escalation or pin only');
        else if (r.roles.length === 0) expect(tierRoleLine(r)).toBe('No router rule targets this tier · reached by moving up');
        else expect(tierRoleLine(r)).toMatch(new RegExp(`^Router: ${r.roles.join(' \\+ ')} rules? lands? here$`));
      }
    });
  }

  it('words each case the way the brief lays them out', () => {
    expect(tierRoles(list('r')).map(tierRoleLine)).toEqual(['Router: basic + standard + expert rules land here']);
    expect(tierRoles(list('r r')).map(tierRoleLine)).toEqual(['Router: basic rule lands here', 'Router: standard + expert rules land here']);
    expect(tierRoles(list('r r r r r')).map(tierRoleLine)).toEqual([
      'Router: basic rule lands here',
      'Router: standard rule lands here',
      'No router rule targets this tier · reached by moving up',
      'No router rule targets this tier · reached by moving up',
      'Router: expert rule lands here',
    ]);
    expect(tierRoles(DEFAULT_TIERS).map(laneSubline)).toEqual([
      'Weakest routable tier · reachable by route',
      'Second routable tier · reachable by route',
      'Strongest routable tier · reachable by route',
      'Never chosen by the router. Reached when a failing task escalates and its mission allows it, or by a pin.',
    ]);
  });
});
