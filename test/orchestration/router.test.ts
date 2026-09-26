/**
 * The router (#38, plan §9.3): rule tables, the worked examples, caps and gates.
 * Pure: an assessment and a policy in, a requirement and its reasons out.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TIERS } from '../../src/shared/orchestration/catalog';
import { contextNeed, contextNeedOf, ROUTER_VERSION, routeTask } from '../../src/orchestration/policy/router';
import { recommendRoute } from '../../src/orchestration/policy/recommend';
import { targetLabel } from '../../src/orchestration/view/routeExplain';
import { assessed, snapshot, type Levels } from './routingFixtures';

const policy = { tiers: DEFAULT_TIERS };

function route(l: Levels, caps?: Parameters<typeof routeTask>[1]['caps']) {
  return routeTask(assessed(l), { ...policy, caps });
}

describe('router: the worked examples of §9.3', () => {
  // Task | assessment | requirement | could resolve to — each row of the plan's table.
  const EXAMPLES: { task: string; l: Levels; tier: string; effort: string; gates?: string[]; resolves: RegExp }[] = [
    {
      task: 'Fix a typo in the README',
      l: { complexity: 'trivial', breadth: 'single-file', risk: 'low', verifiability: 'weak', kind: 'docs' },
      tier: 'standard',
      effort: 'low',
      resolves: /^Sonnet 5 · low \(standard\)$/,
    },
    {
      task: 'Rename a helper across the repo, typecheck + tests',
      l: { complexity: 'routine', breadth: 'cross-cutting', risk: 'moderate', verifiability: 'strong', kind: 'refactor' },
      tier: 'standard',
      effort: 'medium',
      resolves: /^Sonnet 5 · medium \(standard\)$/,
    },
    {
      task: 'Add a unit test for a pure function',
      l: { complexity: 'routine', breadth: 'single-file', risk: 'low', verifiability: 'strong', kind: 'test' },
      tier: 'standard',
      effort: 'medium',
      resolves: /^Sonnet 5 · medium \(standard\)$/,
    },
    {
      task: 'Tricky off-by-one in one parser file, weak tests',
      l: { complexity: 'involved', breadth: 'single-file', risk: 'moderate', verifiability: 'weak', kind: 'bugfix' },
      tier: 'standard',
      effort: 'high',
      resolves: /^Sonnet 5 · high \(standard\)$/,
    },
    {
      task: 'Bump a dependency pinned by the host protocol',
      l: { complexity: 'routine', breadth: 'few-files', risk: 'critical', verifiability: 'strong', kind: 'chore' },
      tier: 'expert',
      effort: 'medium',
      gates: ['human-review'],
      resolves: /^Opus 5\.5 · medium \(expert\)$/,
    },
    {
      task: 'Redesign the session registry format',
      l: { complexity: 'hard', breadth: 'subsystem', risk: 'high', verifiability: 'partial', kind: 'architecture' },
      tier: 'expert',
      effort: 'high',
      resolves: /^Opus 5\.5 · high \(expert\)$/,
    },
    {
      task: 'Update docs for a shipped feature (docs lint configured)',
      l: { complexity: 'trivial', breadth: 'few-files', risk: 'low', verifiability: 'partial', kind: 'docs' },
      tier: 'basic',
      effort: 'low',
      resolves: /^Haiku 4\.5 \(basic\)$/,
    },
  ];

  for (const ex of EXAMPLES) {
    it(`${ex.task} → ${ex.tier} / ${ex.effort}`, () => {
      const r = route(ex.l);
      expect(r.verdict).toBe('route');
      expect(r.requirement).toMatchObject({ minTier: ex.tier, effort: ex.effort, gates: ex.gates ?? [] });
      // Tier and effort are the router's; the model is the resolver's, from today's catalog.
      const rec = recommendRoute(assessed(ex.l), { preferences: { harness: 'claude-code' } }, snapshot());
      expect(rec.verdict).toBe('route');
      expect(targetLabel(rec.resolution.target!)).toMatch(ex.resolves);
    });
  }
});

describe('router: rules', () => {
  it('records a reason for every rule that fired, with its inputs, in order', () => {
    const r = route({ complexity: 'hard', breadth: 'subsystem', risk: 'high', verifiability: 'partial', kind: 'architecture' });
    expect(r.reasons.map((x) => x.ruleId)).toEqual(['tier.band', 'effort.complexity']);
    expect(r.reasons[0].text).toBe('Score 5 from complexity hard (3) + breadth subsystem (+1) + risk high (+1) → expert.');
    expect(r.reasons[0].inputs).toEqual({ complexity: 'hard', breadth: 'subsystem', risk: 'high' });
  });

  it('floors: critical risk and architecture/plan are expert, migration is at least standard', () => {
    expect(route({ complexity: 'trivial', breadth: 'single-file', risk: 'critical', verifiability: 'strong' }).requirement.minTier).toBe('expert');
    expect(route({ complexity: 'trivial', breadth: 'single-file', risk: 'low', verifiability: 'strong', kind: 'plan' }).requirement.minTier).toBe('expert');
    const m = route({ complexity: 'trivial', breadth: 'single-file', risk: 'low', verifiability: 'strong', kind: 'migration' });
    expect(m.requirement.minTier).toBe('standard');
    expect(m.reasons.map((x) => x.ruleId)).toContain('floor.migration');
  });

  it('ceiling: docs and chores stay at most standard unless risk is high', () => {
    const docs = route({ complexity: 'hard', breadth: 'cross-cutting', risk: 'moderate', verifiability: 'strong', kind: 'docs' });
    expect(docs.requirement.minTier).toBe('standard');
    expect(docs.reasons.map((x) => x.ruleId)).toContain('ceiling.docs-chore');
    const risky = route({ complexity: 'hard', breadth: 'cross-cutting', risk: 'high', verifiability: 'strong', kind: 'docs' });
    expect(risky.requirement.minTier).toBe('expert');
  });

  it('guard: basic needs verifiability ≥ partial and risk ≤ moderate', () => {
    expect(route({ complexity: 'trivial', breadth: 'single-file', risk: 'low', verifiability: 'partial' }).requirement.minTier).toBe('basic');
    expect(route({ complexity: 'trivial', breadth: 'single-file', risk: 'low', verifiability: 'none' }).requirement.minTier).toBe('standard');
    // The score for high risk is already 1 → standard; the guard never has to fire, but basic is still out.
    expect(route({ complexity: 'trivial', breadth: 'single-file', risk: 'high', verifiability: 'strong' }).requirement.minTier).toBe('standard');
  });

  it('low confidence in complexity or risk: one tier up and never the cheapest', () => {
    const l: Levels = { complexity: 'trivial', breadth: 'single-file', risk: 'low', verifiability: 'strong' };
    expect(route(l).requirement.minTier).toBe('basic');
    expect(route({ ...l, complexityConfidence: 'low' }).requirement.minTier).toBe('standard');
    expect(route({ ...l, complexity: 'routine', riskConfidence: 'low' }).requirement.minTier).toBe('expert');
    // Low confidence elsewhere does not move the tier.
    expect(routeTask(assessed({ ...l }), policy).reasons.map((x) => x.ruleId)).not.toContain('confidence.low');
  });

  it('never produces the escalation-only tier', () => {
    const r = route({ complexity: 'hard', breadth: 'cross-cutting', risk: 'critical', verifiability: 'none', kind: 'architecture', confidence: 'low' });
    expect(r.requirement.minTier).toBe('expert');
    expect(r.requirement.maxTier).toBe('expert');
  });

  it('effort comes from complexity, verifiability and ambiguity — never from tier', () => {
    const base: Levels = { complexity: 'routine', breadth: 'single-file', risk: 'critical', verifiability: 'strong' };
    // Expert tier, medium effort: the two axes are independent.
    expect(route(base).requirement).toMatchObject({ minTier: 'expert', effort: 'medium' });
    expect(route({ ...base, verifiability: 'weak' }).requirement.effort).toBe('high');
    expect(route({ ...base, ambiguity: 'underspecified' }).requirement.effort).toBe('high');
    // Weak verification of trivial work buys nothing: there is nothing to check.
    expect(route({ ...base, complexity: 'trivial', verifiability: 'weak' }).requirement.effort).toBe('low');
    // max only for hard work that is also underspecified or weakly verified.
    expect(route({ ...base, complexity: 'hard' }).requirement.effort).toBe('high');
    expect(route({ ...base, complexity: 'hard', ambiguity: 'underspecified' }).requirement.effort).toBe('max');
    expect(route({ ...base, complexity: 'hard', verifiability: 'none' }).requirement.effort).toBe('max');
  });

  it('gates: open-ended is plan-first, critical is human-review', () => {
    const r = route({ complexity: 'routine', breadth: 'single-file', risk: 'critical', verifiability: 'strong', ambiguity: 'open-ended' });
    expect(r.requirement.gates).toEqual(['plan-first', 'human-review']);
  });

  it('hard needs: the assessment’s requires, and context with 1.5× headroom', () => {
    const r = route({ complexity: 'routine', breadth: 'single-file', risk: 'low', verifiability: 'strong', contextLoad: 'large', requires: ['edit', 'shell', 'vision'] });
    expect(contextNeed('large')).toBe(375_000);
    expect(r.contextTokens).toBe(375_000);
    expect(r.requirement.needs).toEqual(['edit', 'shell', 'vision', 'context:375000']);
    expect(contextNeedOf(r.requirement.needs)).toBe(375_000);
  });
});

describe('router: caps are never exceeded', () => {
  const expertWork: Levels = { complexity: 'hard', breadth: 'subsystem', risk: 'high', verifiability: 'partial', kind: 'architecture' };

  it('a floor above the mission’s tier cap is needs-human, with both reasons', () => {
    const r = route(expertWork, { maxTier: 'standard' });
    expect(r.verdict).toBe('needs-human');
    expect(r.requirement).toMatchObject({ minTier: 'expert', maxTier: 'standard' });
    expect(r.needsHuman).toMatch(/needs expert but the mission is capped at standard/);
    expect(r.needsHuman).toMatch(/Score 5/);
    expect(r.reasons.at(-1)?.ruleId).toBe('cap.tier');
    // When a floor is what put it there, the floor is the reason given.
    const floored = route({ complexity: 'trivial', breadth: 'single-file', risk: 'low', verifiability: 'strong', kind: 'architecture' }, { maxTier: 'standard' });
    expect(floored.verdict).toBe('needs-human');
    expect(floored.needsHuman).toMatch(/Kind is architecture/);
  });

  it('within the cap, the cap is the requirement’s maxTier', () => {
    const r = route({ complexity: 'routine', breadth: 'single-file', risk: 'low', verifiability: 'strong' }, { maxTier: 'standard' });
    expect(r.verdict).toBe('route');
    expect(r.requirement).toMatchObject({ minTier: 'standard', maxTier: 'standard' });
  });

  it('an effort cap lowers the effort asked for, and says so', () => {
    const r = route(expertWork, { maxEffort: 'medium' });
    expect(r.requirement.effort).toBe('medium');
    expect(r.reasons.find((x) => x.ruleId === 'cap.effort')?.text).toMatch(/caps effort at medium, below the high/);
  });

  it('a cap naming a tier nobody defined is ignored, and said so', () => {
    const r = route(expertWork, { maxTier: 'gold' });
    expect(r.verdict).toBe('route');
    expect(r.reasons.map((x) => x.ruleId)).toContain('cap.unknown');
  });
});

describe('recommendRoute', () => {
  it('stamps the router version and the catalog version it resolved against', () => {
    const snap = snapshot();
    const rec = recommendRoute(assessed({ complexity: 'routine', breadth: 'single-file', risk: 'low', verifiability: 'strong' }), {}, snap);
    expect(rec.policyVersion).toBe(ROUTER_VERSION);
    expect(rec.resolution.catalogVersion).toBe(snap.catalog.version);
    expect(rec.assessmentId).toBe('asm1');
  });

  it('a cap conflict resolves nothing', () => {
    const rec = recommendRoute(assessed({ complexity: 'hard', breadth: 'subsystem', risk: 'critical', verifiability: 'strong' }), { caps: { maxTier: 'basic' } }, snapshot());
    expect(rec.verdict).toBe('needs-human');
    expect(rec.resolution.target).toBeUndefined();
    expect(rec.resolution.candidates).toEqual([]);
  });

  it('an open-ended task resolves, but waits for a person', () => {
    const rec = recommendRoute(assessed({ complexity: 'routine', breadth: 'single-file', risk: 'low', verifiability: 'strong', ambiguity: 'open-ended' }), {}, snapshot());
    expect(rec.verdict).toBe('needs-human');
    expect(rec.resolution.target).toBeDefined();
    expect(rec.note).toMatch(/open-ended/);
  });
});
