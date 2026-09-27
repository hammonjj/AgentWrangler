import { describe, expect, it } from 'vitest';
import { isOpenProposal, proposalChoice, proposalViewOf } from '../src/orchestration/view/proposalView';
import { buildCatalog } from '../src/shared/orchestration/catalog';
import type { Mission, RouteRecommendation } from '../src/shared/orchestration/types';

const catalog = buildCatalog({
  reported: [
    {
      source: 'anthropic',
      models: [
        { value: 'opus', label: 'Opus', resolved: 'claude-opus-5-5', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'sonnet', label: 'Sonnet', resolved: 'claude-sonnet-5', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'haiku', label: 'Haiku', resolved: 'claude-haiku-4-5-20251001' },
      ],
    },
  ],
});

function rec(over: Partial<RouteRecommendation> = {}, maxTier = 'expert'): RouteRecommendation {
  return {
    assessmentId: 'a1',
    policyVersion: 'r1',
    requirement: { minTier: 'standard', maxTier, effort: 'medium', needs: [], gates: [] },
    reasons: [{ ruleId: 'R1', text: 'routine change' }],
    verdict: 'route',
    resolution: {
      target: { harness: 'claude-code', source: 'anthropic', model: 'sonnet', tier: 'standard', effortNative: 'medium', location: 'hosted' },
      candidates: [],
      catalogVersion: 'c1',
    },
    at: 0,
    ...over,
  };
}

function mission(over: { state?: string; attemptIds?: string[]; recommendation?: RouteRecommendation } = {}): Mission {
  return {
    id: 'm1',
    title: 'Fix the parser',
    objective: 'Fix the parser so it rejects empty input.',
    origin: { provider: 'claude', sessionId: 'abcd1234' },
    tasks: [
      {
        title: 'Fix the parser',
        objective: 'Fix the parser so it rejects empty input.',
        acceptanceCriteria: ['tests pass'],
        state: over.state ?? 'routed',
        attemptIds: over.attemptIds ?? [],
        recommendation: 'recommendation' in over ? over.recommendation : rec(),
      },
    ],
  } as unknown as Mission;
}

describe('proposal card (#81)', () => {
  it('offers the routable models within the cap, with the recommendation pre-selected', () => {
    const v = proposalViewOf(mission(), rec(), catalog);
    expect(v.options.map((o) => o.id)).toEqual(['claude-code|haiku', 'claude-code|sonnet', 'claude-code|opus']);
    expect(v.recommended).toEqual({ optionId: 'claude-code|sonnet', effort: 'medium' });
    expect(v.acceptanceCriteria).toEqual(['tests pass']);
    // Haiku has no effort control: nothing to pick.
    expect(v.options[0].efforts).toEqual([]);
    expect(v.options[1].efforts.find((e) => e.level === 'medium')?.native).toBe('medium');
    expect(v.why.summary).toContain('Sonnet');
  });

  it('leaves out models above the cap', () => {
    const v = proposalViewOf(mission(), rec({}, 'standard'), catalog);
    expect(v.options.map((o) => o.model)).toEqual(['haiku', 'sonnet']);
  });

  it('pre-selects nothing when the router recommends nothing', () => {
    const blocked = rec({ verdict: 'blocked' });
    expect(proposalViewOf(mission(), blocked, catalog).recommended).toBeUndefined();
  });

  it('counts picking what was offered as accepting, and anything else as a change', () => {
    const r = rec();
    expect(proposalChoice(r, catalog, { kind: 'run' })).toEqual({});
    expect(proposalChoice(r, catalog, { kind: 'run', route: { harness: 'claude-code', model: 'sonnet', effort: 'medium' } })).toEqual({});
    expect(proposalChoice(r, catalog, { kind: 'run', route: { harness: 'claude-code', model: 'sonnet', effort: 'high' } })).toEqual({
      route: { harness: 'claude-code', model: 'sonnet', effort: 'high' },
    });
    expect(proposalChoice(r, catalog, { kind: 'run', route: { harness: 'claude-code', model: 'haiku' } })).toEqual({
      route: { harness: 'claude-code', model: 'haiku' },
    });
  });

  it('is open only until an attempt starts or it is dropped', () => {
    expect(isOpenProposal(mission())).toBe(true);
    expect(isOpenProposal(mission({ state: 'needs-human' }))).toBe(true);
    expect(isOpenProposal(mission({ attemptIds: ['at1'], state: 'running' }))).toBe(false);
    expect(isOpenProposal(mission({ state: 'cancelled' }))).toBe(false);
    expect(isOpenProposal(mission({ recommendation: undefined }))).toBe(false);
  });
});
