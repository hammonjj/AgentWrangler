/**
 * The resolver (#38, plan §9.4): candidates, tier fit, availability, context
 * limits, caps, unassigned models, ranking, fallbacks — and replaying a stored
 * decision against the snapshot it was made with.
 */
import { describe, expect, it } from 'vitest';
import { resolveRoute, ASSUMED_HOSTED_WINDOW } from '../../src/orchestration/policy/resolver';
import { recommendRoute, compareRoutes } from '../../src/orchestration/policy/recommend';
import type { RouteRequirement } from '../../src/shared/orchestration/types';
import { assessed, catalog, snapshot, status } from './routingFixtures';
import { T0 } from './fixtures';

function req(over: Partial<RouteRequirement> = {}): RouteRequirement {
  return { minTier: 'standard', maxTier: 'expert', effort: 'medium', needs: ['edit', 'shell', 'context:45000'], gates: [], ...over };
}

function rejectedReasons(r: ReturnType<typeof resolveRoute>): string[] {
  return r.candidates.filter((c) => c.verdict === 'rejected').map((c) => c.reason);
}

describe('resolver', () => {
  it('prefers exactly minTier; same-tier fallbacks; every other model rejected with why', () => {
    const r = resolveRoute(req(), snapshot(), { preferences: { harness: 'claude-code' } });
    expect(r.outcome).toBe('resolved');
    expect(r.target).toMatchObject({ harness: 'claude-code', source: 'anthropic', model: 'sonnet', resolvedModel: 'claude-sonnet-5', tier: 'standard', effortNative: 'medium' });
    expect(r.candidates.filter((c) => c.verdict === 'fallback').map((c) => c.target.model)).toEqual(['gpt-6-sol']);
    const why = rejectedReasons(r);
    expect(why).toEqual(
      expect.arrayContaining([
        'Haiku 4.5: basic is below the required standard',
        'Opus 5.5: expert is above the standard this needs',
        'Fable 5.1: frontier is reached only by escalation',
        'gpt-5.6-sol: Unassigned',
      ]),
    );
  });

  it('ranks by preference: the launcher’s harness first within the tier', () => {
    const r = resolveRoute(req(), snapshot(), { preferences: { harness: 'codex' } });
    expect(r.target).toMatchObject({ harness: 'codex', model: 'gpt-6-sol', effortNative: 'medium' });
  });

  it('never routes to an unassigned model, whatever it might be', () => {
    const cat = catalog({ policy: { 'anthropic:claude-sonnet-5': { tier: null }, 'openai:gpt-6-sol': { tier: null } } });
    const r = resolveRoute(req({ maxTier: 'standard' }), snapshot({ catalog: cat }));
    expect(r.outcome).toBe('needs-human');
    expect(rejectedReasons(r)).toEqual(expect.arrayContaining(['Sonnet 5: Unassigned', 'gpt-6-sol: Unassigned']));
  });

  it('assigning a tier changes resolution and nothing else', () => {
    const cat = catalog({ policy: { 'openai:gpt-5.6-sol': { tier: 'standard' } } });
    const r = resolveRoute(req({ maxTier: 'standard' }), snapshot({ catalog: cat }), { preferences: { harness: 'codex' } });
    expect(r.candidates.filter((c) => c.verdict !== 'rejected').map((c) => c.target.model)).toContain('gpt-5.6-sol');
  });

  it('upgrades for availability, within maxTier, and says why', () => {
    const snap = snapshot({ sources: { anthropic: status('anthropic', 'reachable', 20), openai: status('openai', 'degraded', 97) }, catalog: catalog({ policy: { 'anthropic:claude-sonnet-5': { enabled: false } } }) });
    const r = resolveRoute(req(), snap);
    expect(r.target).toMatchObject({ model: 'opus', tier: 'expert' });
    expect(r.note).toMatch(/^Upgraded to expert: no standard model is available/);
    expect(r.note).toMatch(/gpt-6-sol: usage window 97% \(admits below 95%\)/);
  });

  it('never upgrades past maxTier or into an escalation-only tier: blocked while a window is full', () => {
    const snap = snapshot({
      sources: { anthropic: status('anthropic', 'down', 100, T0 + 3_600_000), openai: status('openai', 'down', 100, T0 + 3_600_000) },
    });
    const r = resolveRoute(req({ maxTier: 'standard' }), snap);
    expect(r.outcome).toBe('blocked');
    expect(r.target).toBeUndefined();
    expect(r.note).toMatch(/out of capacity until a usage window resets/);
  });

  it('a source that is down for another reason is needs-human, not blocked', () => {
    const down = { ...status('anthropic', 'down'), health: { state: 'down' as const, reason: 'Not signed in' } };
    const r = resolveRoute(req({ maxTier: 'standard' }), snapshot({ sources: { anthropic: down, openai: down }, catalog: catalog({ openai: false }) }));
    expect(r.outcome).toBe('needs-human');
    expect(rejectedReasons(r)).toContain('Sonnet 5: Not signed in');
  });

  it('respects the mission’s admission threshold', () => {
    const snap = snapshot({ sources: { anthropic: status('anthropic', 'reachable', 60), openai: status('openai', 'reachable', 20) } });
    const r = resolveRoute(req(), snap, { caps: { maxUsageWindowPercent: 50 }, preferences: { harness: 'claude-code' } });
    expect(r.target?.model).toBe('gpt-6-sol');
    expect(rejectedReasons(r)).toContain('Sonnet 5: usage window 60% (admits below 50%)');
  });

  it('context: a reported window must hold the need; an unreported hosted one is assumed only up to 200k', () => {
    const observed = { 'anthropic:claude-sonnet-5': { contextWindow: 100_000, at: T0 } };
    const small = resolveRoute(req(), snapshot({ catalog: catalog({ observed }) }), { preferences: { harness: 'claude-code' } });
    expect(small.target?.model).toBe('sonnet');
    const big = resolveRoute(req({ needs: ['context:150000'] }), snapshot({ catalog: catalog({ observed }) }), { preferences: { harness: 'claude-code' } });
    expect(big.target?.model).toBe('gpt-6-sol');
    expect(rejectedReasons(big)).toContain('Sonnet 5: context 100k < needed 150k');
    expect(big.candidates.find((c) => c.verdict === 'chosen')?.reason).toMatch(/context window not reported yet/);
    const huge = resolveRoute(req({ needs: [`context:${ASSUMED_HOSTED_WINDOW + 1}`] }), snapshot());
    expect(huge.outcome).toBe('needs-human');
    expect(rejectedReasons(huge)).toContain('gpt-6-sol: context window not reported, and 200k is needed');
  });

  it('vision: only models that report taking images', () => {
    const r = resolveRoute(req({ needs: ['edit', 'vision'] }), snapshot(), { preferences: { harness: 'claude-code' } });
    expect(r.target?.model).toBe('gpt-6-sol');
    expect(rejectedReasons(r)).toContain('Sonnet 5: nothing has reported whether it takes images');
  });

  it('policy exclusions and location caps', () => {
    const r = resolveRoute(req(), snapshot(), { exclusions: { harnesses: ['codex'] } });
    expect(r.target?.harness).toBe('claude-code');
    expect(rejectedReasons(r)).toContain('gpt-6-sol: Codex is excluded');
    const local = resolveRoute(req(), snapshot(), { caps: { location: 'local-only' } });
    expect(local.outcome).toBe('needs-human');
  });

  it('a model with no effort control sends none', () => {
    const r = resolveRoute(req({ minTier: 'basic', maxTier: 'basic', effort: 'low' }), snapshot(), { preferences: { harness: 'claude-code' } });
    expect(r.target).toMatchObject({ model: 'haiku', effortNative: 'none' });
  });

  it('maps AW max to the strongest non-pin level', () => {
    const r = resolveRoute(req({ effort: 'max' }), snapshot(), { preferences: { harness: 'claude-code' } });
    expect(r.target?.effortNative).toBe('xhigh');
  });

  it('no routable model at all says where to fix it', () => {
    const cat = catalog({ policy: Object.fromEntries(catalog().entries.map((e) => [e.key, { enabled: false }])) });
    expect(resolveRoute(req(), snapshot({ catalog: cat })).note).toMatch(/Preferences → Orchestration/);
  });
});

describe('replay', () => {
  it('a stored recommendation replays to the same result from the same assessment and snapshot', () => {
    const a = assessed({ complexity: 'involved', breadth: 'single-file', risk: 'moderate', verifiability: 'weak', kind: 'bugfix' });
    const snap = snapshot();
    const stored = JSON.parse(JSON.stringify(recommendRoute(a, { preferences: { harness: 'claude-code' } }, snap)));
    const again = recommendRoute(a, { preferences: { harness: 'claude-code' } }, JSON.parse(JSON.stringify(snap)));
    expect(again).toEqual(stored);
  });

  it('the same assessment against a changed catalog changes resolution, and the version says so', () => {
    const a = assessed({ complexity: 'routine', breadth: 'single-file', risk: 'low', verifiability: 'strong' });
    const before = recommendRoute(a, {}, snapshot());
    const after = recommendRoute(a, {}, snapshot({ catalog: catalog({ policy: { 'anthropic:claude-sonnet-5': { tier: 'expert' } } }) }));
    expect(after.requirement).toEqual(before.requirement);
    expect(after.resolution.catalogVersion).not.toBe(before.resolution.catalogVersion);
    expect(after.resolution.target?.model).not.toBe('sonnet');
  });
});

describe('compareRoutes', () => {
  const rec = { harness: 'claude-code', source: 'anthropic', model: 'sonnet', resolvedModel: 'claude-sonnet-5', tier: 'standard', effortNative: 'medium', location: 'hosted' as const };

  it('accepted when offered and unchanged; matched when not offered', () => {
    expect(compareRoutes(rec, { ...rec }, true)).toEqual({ agreement: 'accepted', changed: [] });
    expect(compareRoutes(rec, { ...rec }, false)).toEqual({ agreement: 'matched', changed: [] });
  });

  it('names every dimension that changed, and labels by the most significant', () => {
    expect(compareRoutes(rec, { ...rec, effortNative: 'high' }, true)).toEqual({ agreement: 'changed-effort', changed: ['effort'] });
    const opus = { ...rec, model: 'opus', resolvedModel: 'claude-opus-5-5', tier: 'expert', effortNative: 'high' };
    expect(compareRoutes(rec, opus, true)).toEqual({ agreement: 'changed-tier', changed: ['model', 'tier', 'effort'] });
    const codex = { ...rec, harness: 'codex', source: 'openai', model: 'gpt-6-sol', resolvedModel: undefined };
    expect(compareRoutes(rec, codex, true)).toEqual({ agreement: 'changed-harness', changed: ['harness', 'model'] });
  });

  it('an alias and its resolved id are one model', () => {
    expect(compareRoutes(rec, { ...rec, model: 'claude-sonnet-5', resolvedModel: undefined }, false).changed).toEqual([]);
  });

  it('no recommendation, nothing to compare', () => {
    expect(compareRoutes(undefined, rec, false)).toEqual({ agreement: 'no-recommendation', changed: [] });
  });
});
