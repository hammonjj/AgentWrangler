/**
 * "Why this route" (#38, plan §9.5): built from the stored decision, naming
 * the rules, the requirement and the candidates passed over.
 */
import { describe, expect, it } from 'vitest';
import { recommendRoute } from '../../src/orchestration/policy/recommend';
import { explainDecision, explainRecommendation, requirementText, targetLabel } from '../../src/orchestration/view/routeExplain';
import { routeChipTitle } from '../../src/shared/orchestration/taskView';
import { routeViewOf } from '../../src/orchestration/view/taskViews';
import type { RoutingDecision } from '../../src/shared/orchestration/types';
import { assessed, catalog, snapshot } from './routingFixtures';
import { attempt, mission, T0 } from './fixtures';

const critical = assessed({ complexity: 'routine', breadth: 'few-files', risk: 'critical', verifiability: 'strong', kind: 'chore' });

describe('route explanation', () => {
  it('says why an expensive route is expensive, and which cheaper ones were passed over', () => {
    const rec = recommendRoute(critical, { preferences: { harness: 'claude-code' } }, snapshot({ catalog: catalog({ openai: false }) }));
    const v = explainRecommendation(rec, 'high');
    expect(v.headline).toBe('Opus 5.5 · medium (expert)');
    expect(v.summary).toMatch(/^Opus 5\.5 · medium \(expert\)\. Expert because Score 2 .*; Risk is critical, so at least expert\./);
    expect(v.summary).toMatch(/Cheaper candidates: Haiku 4\.5: basic is below the required expert; Sonnet 5: standard is below the required expert/);
    expect(v.summary).toMatch(/Assessment confidence: high\.$/);
    expect(v.gates).toEqual(['human-review']);
    expect(v.requirement).toBe('expert · medium effort · needs edit, shell · 45k context');
    expect(v.versions).toMatch(/^rtr-1 · cat-[0-9a-f]{8}$/);
  });

  it('a manual decision with no shadow yet says so rather than inventing one', () => {
    const target = { harness: 'claude-code', source: 'anthropic', model: 'opus', tier: 'expert', effortNative: 'high', location: 'hosted' as const };
    const d: RoutingDecision = {
      id: 'd1', taskId: 't1', attemptN: 1, mode: 'manual', policyVersion: 'manual',
      requirement: { minTier: 'expert', maxTier: 'expert', effort: 'high', needs: [], gates: [] },
      reasons: [{ ruleId: 'manual', text: 'Route picked by the user.' }], overrides: [],
      resolution: { target, candidates: [], catalogVersion: 'manual' }, decidedBy: 'user', decidedAt: T0,
    };
    const m = mission({ decisions: [d], attempts: [attempt('a1', 't1', { routingDecisionId: 'd1' })] });
    const v = explainDecision(m, d);
    expect(v.decided).toBe('Picked by you');
    expect(v.summary).toMatch(/no recommendation to compare with yet/);
    // The chip's tooltip carries it.
    expect(routeChipTitle(routeViewOf(m, m.attempts[0])!)).toMatch(/manual routing\n\nOpus · high \(expert\)\. Picked by you/);
  });

  it('labels a target with no model as the harness default, and an unassigned one as such', () => {
    expect(targetLabel({ harness: 'codex', source: 'openai', model: '', tier: 'unassigned', effortNative: 'none', location: 'hosted' })).toBe('Codex default (unassigned)');
    expect(requirementText({ minTier: 'standard', maxTier: 'expert', effort: 'low', needs: [], gates: [] })).toBe('standard (up to expert) · low effort');
  });
});
