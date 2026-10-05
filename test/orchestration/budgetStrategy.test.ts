/**
 * Budget strategies (#53, plan §21): resolver ranking tables per strategy,
 * scheduler admission and pacing per strategy against usage-window fixtures,
 * and the invariant that no strategy ever selects below a requirement's
 * minimum tier.
 */
import { describe, expect, it } from 'vitest';
import { resolveRoute } from '../../src/orchestration/policy/resolver';
import { DEFAULT_SCHEDULER_LIMITS, schedule, type CapacitySnapshot, type SchedMission, type SchedTask, type SchedulerAction } from '../../src/orchestration/engine/scheduler';
import { BUDGET_STRATEGIES, STRATEGY_PROFILES, admissionPercentFor, dollarsLeft, strategyOf, windowShareUsed } from '../../src/shared/orchestration/budgetStrategy';
import { buildCatalog, known, tierRank, type CapabilityCatalogView } from '../../src/shared/orchestration/catalog';
import { validateExecutionPolicy } from '../../src/shared/orchestration/executionPolicy';
import type { BudgetStrategy } from '../../src/shared/orchestration/budgetStrategy';
import type { RouteRequirement, TierName } from '../../src/shared/orchestration/types';
import { ANTHROPIC_MODELS, OPENAI_MODELS, snapshot, status } from './routingFixtures';
import { T0 } from './fixtures';

function req(over: Partial<RouteRequirement> = {}): RouteRequirement {
  return { minTier: 'standard', maxTier: 'expert', effort: 'medium', needs: ['edit', 'shell'], gates: [], ...over };
}

/** The default fixtures with prices, so cost ranking has something to rank. Sol is cheaper than Sonnet. */
function priced(throughput?: Record<string, number>): CapabilityCatalogView {
  const cat = buildCatalog({
    reported: [
      { source: 'anthropic', models: ANTHROPIC_MODELS, at: T0 },
      { source: 'openai', models: OPENAI_MODELS, at: T0 },
    ],
    prices: {
      'claude-sonnet-5': { inPerMTok: 3, outPerMTok: 15 },
      'gpt-6-sol': { inPerMTok: 1, outPerMTok: 8 },
      'claude-opus-5-5': { inPerMTok: 15, outPerMTok: 75 },
      'gpt-6-astra': { inPerMTok: 8, outPerMTok: 40 },
    },
  });
  if (!throughput) return cat;
  return {
    ...cat,
    entries: cat.entries.map((e) => {
      const tps = throughput[e.descriptor.modelId];
      return tps === undefined ? e : { ...e, descriptor: { ...e.descriptor, throughput: known({ outTokPerSec: tps, ttftMs: 400 }, 'measured') } };
    }),
  };
}

const standardPick = (strategy: BudgetStrategy, cat = priced(), r = req()) => resolveRoute(r, snapshot({ catalog: cat }), { preferences: { strategy } });

describe('resolver ranking per strategy', () => {
  it('balanced: the required tier, the cheapest route in it', () => {
    const r = standardPick('balanced');
    expect(r.target).toMatchObject({ model: 'gpt-6-sol', tier: 'standard' });
  });

  it('maximum quality: the highest routable tier within the cap, and says so', () => {
    const r = standardPick('max-quality');
    expect(r.target?.tier).toBe('expert');
    expect(r.note).toMatch(/^Maximum quality: expert, the highest tier within the caps; the work needs standard\./);
  });

  it('maximum quality stops at the cap, and never reaches an escalation-only tier', () => {
    expect(standardPick('max-quality', priced(), req({ maxTier: 'standard' })).target?.tier).toBe('standard');
    const uncapped = standardPick('max-quality', priced(), req({ maxTier: 'frontier' }));
    expect(uncapped.target?.tier).toBe('expert');
  });

  it('maximum quality is a no-op when the work already needs the top tier', () => {
    const r = standardPick('max-quality', priced(), req({ minTier: 'expert' }));
    expect(r.target?.tier).toBe('expert');
    expect(r.note).toBeUndefined();
  });

  it('lowest cost: the cheapest route at the needed tier, however the catalog is ordered', () => {
    const r = standardPick('lowest-cost');
    expect(r.target).toMatchObject({ model: 'gpt-6-sol', tier: 'standard' });
    expect(r.candidates.find((c) => c.verdict === 'fallback')?.target.model).toBe('sonnet');
  });

  it('lowest cost prices expert work too, and stays at expert', () => {
    const r = standardPick('lowest-cost', priced(), req({ minTier: 'expert', maxTier: 'expert' }));
    expect(r.target).toMatchObject({ tier: 'expert', model: 'gpt-6-astra' });
  });

  it('fastest: the model measured quickest in the tier; an unmeasured one ranks after a measured one', () => {
    const fastSonnet = priced({ sonnet: 120, 'gpt-6-sol': 60 });
    expect(standardPick('fastest', fastSonnet).target?.model).toBe('sonnet');
    const fastSol = priced({ sonnet: 60, 'gpt-6-sol': 120 });
    expect(standardPick('fastest', fastSol).target?.model).toBe('gpt-6-sol');
    // Only Sonnet measured: it goes first although Sol is cheaper.
    expect(standardPick('fastest', priced({ sonnet: 10 })).target?.model).toBe('sonnet');
  });

  it('prefer local: a local candidate first when it satisfies the requirement', () => {
    // No local model in the fixtures: the strategy changes nothing rather than breaking the route.
    expect(standardPick('prefer-local').target).toEqual(standardPick('balanced').target);
  });

  it('the strategy name is read from `preferLocal` too, and defaults to balanced', () => {
    expect(strategyOf(undefined)).toBe('balanced');
    expect(strategyOf({ preferLocal: true })).toBe('prefer-local');
    expect(strategyOf({ strategy: 'fastest', preferLocal: true })).toBe('fastest');
  });

  it('a user’s preferred harness still outranks a strategy', () => {
    const r = resolveRoute(req(), snapshot({ catalog: priced() }), { preferences: { strategy: 'lowest-cost', harness: 'claude-code' } });
    expect(r.target).toMatchObject({ harness: 'claude-code', model: 'sonnet' });
  });

  it('a pinned model is not re-ranked by a strategy', () => {
    const r = resolveRoute(req(), snapshot({ catalog: priced() }), { preferences: { strategy: 'max-quality' }, pins: { model: 'sonnet' } });
    expect(r.target).toMatchObject({ model: 'sonnet', tier: 'standard' });
  });
});

describe('no strategy selects below the required tier', () => {
  const tiers: TierName[] = ['basic', 'standard', 'expert'];
  const caps: (TierName | undefined)[] = [undefined, 'standard', 'expert'];
  const cat = priced({ sonnet: 90, 'gpt-6-sol': 70, haiku: 200, 'gpt-6-luna': 150 });
  const sources = [
    { anthropic: status('anthropic', 'reachable', 20), openai: status('openai', 'reachable', 20) },
    // Anthropic full: whatever is picked is an upgrade, never a downgrade.
    { anthropic: status('anthropic', 'degraded', 99), openai: status('openai', 'reachable', 20) },
    { anthropic: status('anthropic', 'reachable', 99), openai: status('openai', 'degraded', 99) },
  ];
  it.each(BUDGET_STRATEGIES.flatMap((s) => tiers.map((t) => [s, t] as const)))('%s, needing %s', (strategy, minTier) => {
    const lo = tierRank(cat.tiers, minTier);
    for (const cap of caps) {
      for (const src of sources) {
        const r = resolveRoute(req({ minTier, maxTier: cap ?? 'expert' }), snapshot({ catalog: cat, sources: src }), { preferences: { strategy }, ...(cap ? { caps: { maxTier: cap } } : {}) });
        if (r.outcome !== 'resolved') continue;
        const rank = tierRank(cat.tiers, r.target!.tier);
        expect(rank).toBeGreaterThanOrEqual(lo);
        expect(rank).toBeLessThanOrEqual(tierRank(cat.tiers, cap ?? 'expert'));
        // Every fallback keeps the same tier, whatever the strategy.
        for (const c of r.candidates.filter((x) => x.verdict === 'fallback')) expect(c.target.tier).toBe(r.target!.tier);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const REPO = '/Users/test/proj';
const task = (id: string, over: Partial<SchedTask> = {}): SchedTask => ({ id, key: id, state: 'pending', dependsOn: [], integrated: false, harness: 'claude-code', source: 'anthropic', attempts: 0, ...over });
const mission = (id: string, tasks: SchedTask[], over: Partial<SchedMission> = {}): SchedMission => ({ id, repo: `${REPO}/${id}`, state: 'running', priority: 0, createdAt: T0, planned: true, sharedTree: false, tasks, ...over });
const cap = (over: Partial<CapacitySnapshot> = {}): CapacitySnapshot => ({ limits: { ...DEFAULT_SCHEDULER_LIMITS }, sources: {}, fleetPaused: false, ...over });
const starts = (a: SchedulerAction[]) => a.filter((x) => x.kind === 'start').map((x) => (x as { taskId: string }).taskId);
const waits = (a: SchedulerAction[]) => a.filter((x): x is Extract<SchedulerAction, { kind: 'wait' }> => x.kind === 'wait');

describe('admission per strategy against usage-window fixtures', () => {
  // The 5-hour window rising through the day; the default admission is 85%.
  const windows = [0, 40, 67, 68, 70, 84, 85, 95, 100];
  const admitted = (strategy: BudgetStrategy | undefined, pct: number) => starts(schedule({ missions: [mission('m1', [task('A')], { strategy })] }, cap({ sources: { anthropic: { windowPercent: pct } } }), T0)).length === 1;

  it.each<[BudgetStrategy | undefined, number]>([
    [undefined, 84],
    ['balanced', 84],
    ['max-quality', 84],
    ['fastest', 84],
    ['prefer-local', 84],
    ['lowest-cost', 67],
  ])('%s admits up to %i%% and holds from the next step', (strategy, last) => {
    for (const pct of windows) expect(admitted(strategy, pct)).toBe(pct <= last);
  });

  it('lowest cost holds work sooner, and says which strategy asked', () => {
    const w = waits(schedule({ missions: [mission('m1', [task('A')], { strategy: 'lowest-cost' })] }, cap({ sources: { anthropic: { windowPercent: 70 } } }), T0));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ reason: 'usage' });
    expect(w[0].detail).toMatch(/new work starts below 68% \(Lowest cost\)/);
  });

  it('a mission’s own usage cap still lowers the threshold, never raises it', () => {
    expect(admissionPercentFor('lowest-cost', 85, 50)).toBe(50);
    expect(admissionPercentFor('lowest-cost', 85, 90)).toBe(68);
    expect(admissionPercentFor('fastest', 85, 90)).toBe(85);
  });

  it('fastest runs one more agent at once, within the machine’s limits and the mission’s cap', () => {
    const tasks = ['A', 'B', 'C', 'D', 'E'].map((id) => task(id));
    const run = (strategy: BudgetStrategy | undefined, over: Partial<SchedMission> = {}) =>
      starts(schedule({ missions: [mission('m1', tasks, { strategy, ...over })] }, cap({ limits: { ...DEFAULT_SCHEDULER_LIMITS, global: 2, perRepo: 2 } }), T0)).length;
    expect(run(undefined)).toBe(2);
    expect(run('balanced')).toBe(2);
    expect(run('fastest')).toBe(3);
    expect(run('fastest', { maxConcurrentAgents: 2 })).toBe(2);
  });

  it('prefer local starts a local endpoint’s task ahead of a hosted one when only one fits', () => {
    const tasks = [task('hosted'), task('local', { harness: 'codex', source: 'local:box' })];
    const one = cap({ limits: { ...DEFAULT_SCHEDULER_LIMITS, global: 1 } });
    expect(starts(schedule({ missions: [mission('m1', tasks)] }, one, T0))).toEqual(['hosted']);
    expect(starts(schedule({ missions: [mission('m1', tasks, { strategy: 'prefer-local' })] }, one, T0))).toEqual(['local']);
  });
});

describe('budgets: usage-window share and dollars', () => {
  it('holds a mission that has used its share of the window, and pays no attention to a mission that has not', () => {
    const over = mission('m1', [task('A')], { maxWindowShare: 15, windowShareUsed: 15 });
    const under = mission('m2', [task('B')], { maxWindowShare: 15, windowShareUsed: 9.5, createdAt: T0 + 1 });
    const actions = schedule({ missions: [over, under] }, cap(), T0);
    expect(starts(actions)).toEqual(['B']);
    expect(waits(actions)[0]).toMatchObject({ taskId: 'A', reason: 'budget' });
    expect(waits(actions)[0].detail).toMatch(/used 15 points of the usage window; it stops starting work at 15/);
  });

  it('an unknown share does not block', () => {
    expect(starts(schedule({ missions: [mission('m1', [task('A')], { maxWindowShare: 15 })] }, cap(), T0))).toEqual(['A']);
  });

  it('holds a mission that has spent its dollars; unknown spend does not block', () => {
    expect(starts(schedule({ missions: [mission('m1', [task('A')], { maxCostUsd: 5, spentUsd: 5.01 })] }, cap(), T0))).toEqual([]);
    expect(starts(schedule({ missions: [mission('m1', [task('A')], { maxCostUsd: 5, spentUsd: 4.99 })] }, cap(), T0))).toEqual(['A']);
    expect(starts(schedule({ missions: [mission('m1', [task('A')], { maxCostUsd: 5 })] }, cap(), T0))).toEqual(['A']);
  });

  it('the helpers: share is the change in the window, floored at zero; dollars left never go negative', () => {
    expect(windowShareUsed(20, 31.5)).toBe(11.5);
    expect(windowShareUsed(80, 5)).toBe(0); // the window reset
    expect(windowShareUsed(undefined, 5)).toBeUndefined();
    expect(dollarsLeft(5, 1.25)).toBe(3.75);
    expect(dollarsLeft(5, 9)).toBe(0);
    expect(dollarsLeft(undefined, 9)).toBeUndefined();
  });
});

describe('simulation: missions paced across the 5-hour window', () => {
  /** Each started attempt adds `cost` points to the window; the window falls back to 0 once at `resetAt`. */
  function simulate(strategy: BudgetStrategy | undefined, opts: { cost: number; resetAfter?: number }) {
    let pct = 0;
    let startedAt = 0;
    const done: string[] = [];
    const ids = Array.from({ length: 20 }, (_, i) => `T${i}`);
    for (let step = 0; step < 40; step++) {
      const open = ids.filter((id) => !done.includes(id)).map((id) => task(id));
      if (open.length === 0) break;
      if (opts.resetAfter !== undefined && step === opts.resetAfter) pct = 0;
      const actions = schedule({ missions: [mission('m1', open, { strategy, sharedTree: true })] }, cap({ sources: { anthropic: { windowPercent: pct } } }), T0 + step);
      const s = starts(actions);
      for (const id of s) {
        done.push(id);
        pct += opts.cost;
        startedAt = step;
      }
      // Everything started in a step finishes before the next, so concurrency never hides a hold.
      if (s.length === 0 && opts.resetAfter === undefined) break;
    }
    return { started: done.length, pct, startedAt };
  }

  it('each strategy stops starting work at its own threshold of the window', () => {
    // 5 points per attempt: balanced stops at 85, lowest cost at 68, the rest like balanced.
    const stopped = Object.fromEntries(BUDGET_STRATEGIES.map((s) => [s, simulate(s, { cost: 5 }).started]));
    expect(stopped).toEqual({ balanced: 17, 'max-quality': 17, 'lowest-cost': 14, fastest: 17, 'prefer-local': 17 });
  });

  it('after the window resets the held work goes on', () => {
    expect(simulate('lowest-cost', { cost: 5, resetAfter: 20 }).started).toBe(20);
  });

  it('every strategy has a profile, and none of them carries a tier', () => {
    for (const s of BUDGET_STRATEGIES) expect(Object.keys(STRATEGY_PROFILES[s]).sort()).toEqual(['admissionScale', 'concurrencyBonus', 'help', 'label', 'localFirst']);
  });
});

describe('policy: the strategy and the share cap are editable', () => {
  it('accepts a strategy and a window share, and refuses bad ones with the field named', () => {
    const ok = validateExecutionPolicy({ preferences: { strategy: 'lowest-cost' }, caps: { maxWindowSharePercent: 15, maxEstimatedCostUsd: 20 } });
    expect(ok).toMatchObject({ ok: true, policy: { preferences: { strategy: 'lowest-cost' }, caps: { maxWindowSharePercent: 15, maxEstimatedCostUsd: 20 } } });
    const bad = validateExecutionPolicy({ preferences: { strategy: 'cheapest' }, caps: { maxWindowSharePercent: 120 } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.map((e) => e.path).sort()).toEqual(['caps.maxWindowSharePercent', 'preferences.strategy']);
  });
});
