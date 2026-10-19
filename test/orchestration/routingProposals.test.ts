/**
 * Routing-policy proposals from history (#52, plan §20): the statistics, the
 * sample thresholds, pooling, rejection and expiry, and the learned rule the
 * router reads once a person accepts one. Synthetic telemetry only.
 */
import { describe, expect, it } from 'vitest';
import { buildDataset } from '../../src/shared/orchestration/analytics';
import {
  betaCdf,
  betaQuantile,
  dataSummary,
  generateProposals,
  observationOf,
  pendingProposals,
  posterior,
  proposalText,
  REJECTION_SNOOZE_MS,
  ruleFromProposal,
  ruleHealth,
  type LearnedRule,
  type RoutingProposal,
} from '../../src/shared/orchestration/routingProposals';
import { applyLearnedRule } from '../../src/orchestration/policy/learnedRules';
import { proposalVeto } from '../../src/orchestration/policy/learnedVeto';
import { routeTask } from '../../src/orchestration/policy/router';
import { DEFAULT_TIERS } from '../../src/shared/orchestration/catalog';
import { DAY, repoOf, T0, taskRecords, TIERS, type AttemptSpec, type TaskSpec } from './analyticsFixtures';
import { assessed } from './routingFixtures';
import { loadCorpus, assessCard, labelsAsAnswer } from './routingCorpus';
import { egregiousMisroutes } from '../../src/orchestration/policy/egregious';
import { ASSESSOR_VERSION } from '../../src/orchestration/policy/assessment';

const NOW = T0 + 200 * DAY;
const ROUTABLE = ['basic', 'standard', 'expert'];

/** `n` finished tasks of one cohort on `tier`, `passes` of them first time. The router asked for `policy`. */
function batch(prefix: string, n: number, passes: number, tier: string, over: Partial<TaskSpec> = {}, policy = 'standard') {
  const specs: TaskSpec[] = [];
  for (let i = 0; i < n; i++) {
    const pass = i < passes;
    const attempts: AttemptSpec[] = pass
      ? [{ tier }]
      : [{ tier, outcome: 'failed', category: 'quality-new' }, { tier: 'expert', escalation: 'raise-tier' }];
    specs.push({
      task: `${prefix}${i}`,
      kind: 'test',
      complexity: 'routine',
      verifiability: 'strong',
      risk: 'low',
      attempts,
      router: { tier: policy, effort: 'medium', changed: tier === policy ? [] : ['tier'] },
      day: i % 20,
      ...over,
    });
  }
  return specs;
}

function proposals(specs: TaskSpec[], now = NOW) {
  const ds = buildDataset({ records: specs.flatMap(taskRecords), tiers: TIERS, repoOf });
  return { ds, list: generateProposals(ds, { now, tiers: ROUTABLE }) };
}

describe('Beta statistics', () => {
  it('has the right cdf and quantile', () => {
    expect(betaCdf(0.3, 1, 1)).toBeCloseTo(0.3, 9);
    expect(betaCdf(0.5, 2, 2)).toBeCloseTo(0.5, 9);
    expect(betaCdf(0.2, 2, 5)).toBeCloseTo(0.34464, 4);
    expect(betaQuantile(0.5, 2, 2)).toBeCloseTo(0.5, 6);
    expect(betaCdf(betaQuantile(0.1, 27, 2), 27, 2)).toBeCloseTo(0.1, 6);
  });

  it('a weak prior cannot swing a tiny sample', () => {
    const p = posterior(3, 3, 0.5);
    expect(p.lower).toBeLessThan(0.6);
    expect(posterior(0, 0, 0.8).mean).toBeCloseTo(0.8, 9);
    expect(posterior(25, 25, 0.5).lower).toBeGreaterThan(0.8);
  });
});

describe('proposals: thresholds', () => {
  it('makes no proposal below 20 observations, however clean', () => {
    expect(proposals(batch('a', 19, 19, 'basic')).list).toEqual([]);
  });

  it('proposes lowering the floor at 20 clean passes, with its cohort, counts, interval and window', () => {
    const { list } = proposals(batch('a', 20, 20, 'basic'));
    expect(list).toHaveLength(1);
    const p = list[0];
    expect(p.direction).toBe('downgrade');
    expect([p.fromTier, p.toTier]).toEqual(['standard', 'basic']);
    expect(p.cohort).toEqual({ kind: 'test', complexity: 'trivial-routine', verifiability: 'partial-strong' });
    expect(p.evidence).toMatchObject({ successes: 20, observations: 20, route: { tier: 'basic' }, pooledFrom: 'all-repositories' });
    expect(p.evidence.interval.lower).toBeGreaterThanOrEqual(0.8);
    expect(p.evidence.window.from).toBeLessThanOrEqual(p.evidence.window.to);
    expect(p.evidence.taskKeys).toHaveLength(20);
    expect(proposalText(p)).toBe('basic passed first time 20 of 20; lower the floor from standard to basic?');
  });

  it('makes none when the lower bound is under the target: 23 of 25 is not enough at 90%', () => {
    expect(proposals(batch('a', 25, 23, 'basic')).list).toEqual([]);
  });

  it('never proposes a downgrade for weak verification or risk above moderate', () => {
    expect(proposals(batch('a', 30, 30, 'basic', { verifiability: 'weak' })).list).toEqual([]);
    expect(proposals(batch('a', 30, 30, 'basic', { risk: 'high' })).list).toEqual([]);
  });

  it('proposes raising the floor at 10 observations whose upper bound is under 60%', () => {
    const { list } = proposals(batch('a', 10, 1, 'standard'));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ direction: 'upgrade', fromTier: 'standard', toTier: 'expert' });
    expect(proposals(batch('a', 9, 0, 'standard')).list).toEqual([]);
    expect(proposals(batch('a', 10, 5, 'standard')).list).toEqual([]);
  });

  it('does not propose raising past the top tier', () => {
    expect(proposals(batch('a', 12, 1, 'expert', {}, 'expert')).list).toEqual([]);
  });
});

describe('what counts as a success', () => {
  const one = (over: Partial<TaskSpec> = {}, now = NOW) => {
    const ds = buildDataset({ records: taskRecords({ ...batch('x', 1, 1, 'basic')[0], ...over }), tiers: TIERS, repoOf });
    return observationOf(ds.tasks[0], now);
  };

  it('is first-time verified, with no rescue, and stood for 14 days', () => {
    expect(one()?.success).toBe(true);
    expect(one({}, T0 + 3 * DAY)).toBeUndefined();
  });

  it('a rescue makes it a failure, and a failure counts at once', () => {
    const rescued = one({ attempts: [{ tier: 'basic', flags: { userIntervened: true } }] });
    expect(rescued?.success).toBe(false);
    expect(one({ attempts: [{ tier: 'basic', outcome: 'failed', category: 'quality-new' }, { tier: 'standard', escalation: 'raise-tier' }] }, T0 + 3 * DAY)?.success).toBe(false);
  });

  it('a failure that is not the route’s fault says nothing about it', () => {
    expect(one({ attempts: [{ tier: 'basic', outcome: 'failed', category: 'capacity' }, { tier: 'basic' }] })).toBeUndefined();
  });

  it('is counted in dataSummary, with the young ones pending', () => {
    const ds = buildDataset({ records: batch('a', 4, 4, 'basic').flatMap(taskRecords), tiers: TIERS, repoOf });
    expect(dataSummary(ds, T0 + 3 * DAY)).toEqual({ observations: 0, finishedTasks: 4, pending: 4 });
    expect(dataSummary(ds, NOW)).toEqual({ observations: 4, finishedTasks: 4, pending: 0 });
  });
});

describe('pooling', () => {
  it('pools repositories upward when each has too little alone', () => {
    const { list } = proposals([...batch('a', 12, 12, 'basic'), ...batch('other', 12, 12, 'basic')]);
    expect(list).toHaveLength(1);
    expect(list[0].cohort.repository).toBeUndefined();
    expect(list[0].evidence.observations).toBe(24);
  });

  it('keeps a repository-specific proposal when only that repository has the data', () => {
    const { list } = proposals([...batch('a', 22, 22, 'basic'), ...batch('other', 12, 4, 'basic')]);
    const repoWide = list.filter((p) => p.cohort.repository === undefined);
    const specific = list.filter((p) => p.cohort.repository !== undefined);
    // Pooled data is 34 observations at 26 passes: under the bar, so only the repository's own clean run proposes.
    expect(repoWide).toEqual([]);
    expect(specific).toHaveLength(1);
    expect(specific[0].cohort.repository).toBe('/Users/test/proj');
    expect(specific[0].evidence.pooledFrom).toBe('repository');
  });
});

describe('decisions, expiry and review', () => {
  const base = proposals(batch('a', 20, 20, 'basic')).list[0];

  it('a rejected proposal is not made again until the snooze ends; an accepted one is not pending', () => {
    expect(pendingProposals([base], [], [], NOW)).toEqual([base]);
    expect(pendingProposals([base], [], [{ id: base.id, rejectedAt: NOW - DAY }], NOW)).toEqual([]);
    expect(pendingProposals([base], [], [{ id: base.id, rejectedAt: NOW - REJECTION_SNOOZE_MS - 1 }], NOW)).toEqual([base]);
    expect(pendingProposals([base], [ruleFromProposal(base, NOW)], [], NOW)).toEqual([]);
  });

  it('a proposal lapses after its time-to-live', () => {
    expect(pendingProposals([base], [], [], base.expiresAt + 1)).toEqual([]);
  });

  it('flags an accepted rule for review when its route now fails, and says so plainly when there is no recent data', () => {
    const rule = ruleFromProposal(base, NOW);
    expect(ruleHealth(rule, buildDataset({ records: [], tiers: TIERS }), NOW + DAY).state).toBe('no-recent-data');
    const later = batch('later', 12, 1, 'basic').map((s) => ({ ...s, day: 230 + (Number(s.task.replace('later', '')) % 20) }));
    const ds = buildDataset({ records: later.flatMap(taskRecords), tiers: TIERS, repoOf });
    expect(ruleHealth(rule, ds, NOW + 100 * DAY).state).toBe('review');
    const fine = batch('fine', 12, 12, 'basic').map((s) => ({ ...s, day: 230 }));
    expect(ruleHealth(rule, buildDataset({ records: fine.flatMap(taskRecords), tiers: TIERS, repoOf }), NOW + 100 * DAY).state).toBe('ok');
  });
});

describe('the learned rule in the router', () => {
  const rule = (over: Partial<RoutingProposal> = {}): LearnedRule => ruleFromProposal({ ...proposals(batch('a', 20, 20, 'basic')).list[0], ...over }, NOW);
  const routine = assessed({ complexity: 'routine', breadth: 'single-file', risk: 'low', verifiability: 'strong', kind: 'test' });

  it('without a rule the route is the deterministic one', () => {
    expect(routeTask(routine, { tiers: DEFAULT_TIERS }).requirement.minTier).toBe('standard');
  });

  it('an accepted downgrade lowers the floor one step and says why, with its evidence', () => {
    const r = routeTask(routine, { tiers: DEFAULT_TIERS, learnedRules: [rule()] });
    expect(r.requirement.minTier).toBe('basic');
    const reason = r.reasons.find((x) => x.ruleId === 'learned.downgrade');
    expect(reason?.text).toMatch(/You accepted a proposal for test .*: basic passed first time 20 of 20, \d+%–\d+% \(90% interval\), so the floor is lowered from standard to basic\./);
    expect(reason?.inputs).toMatchObject({ successes: 20, observations: 20 });
  });

  it('does not apply to another cohort, repository, risk, floor or confidence', () => {
    const opts = (l: Parameters<typeof assessed>[0]) => routeTask(assessed(l), { tiers: DEFAULT_TIERS, learnedRules: [rule()] }).requirement.minTier;
    expect(opts({ complexity: 'routine', breadth: 'single-file', risk: 'low', verifiability: 'strong', kind: 'bugfix' })).toBe('standard');
    expect(opts({ complexity: 'hard', breadth: 'single-file', risk: 'low', verifiability: 'strong', kind: 'test' })).toBe('expert');
    expect(opts({ complexity: 'routine', breadth: 'single-file', risk: 'high', verifiability: 'strong', kind: 'test' })).not.toBe('basic');
    expect(opts({ complexity: 'routine', breadth: 'single-file', risk: 'low', verifiability: 'strong', kind: 'test', complexityConfidence: 'low' })).toBe('expert');
    const scoped = rule({ cohort: { kind: 'test', complexity: 'trivial-routine', verifiability: 'partial-strong', repository: '/Users/test/proj' } });
    expect(routeTask(routine, { tiers: DEFAULT_TIERS, learnedRules: [scoped], repository: '/Users/test/other' }).requirement.minTier).toBe('standard');
    expect(routeTask(routine, { tiers: DEFAULT_TIERS, learnedRules: [scoped], repository: '/Users/test/proj' }).requirement.minTier).toBe('basic');
  });

  it('never moves more than one tier, or the wrong way', () => {
    const facts = { kind: 'test', complexity: 'routine', verifiability: 'strong', risk: 'low' };
    const state = { tier: 1, setBy: ['tier.band'] };
    expect(applyLearnedRule(rule({ toTier: 'expert' }), facts, state, ROUTABLE, undefined)).toBeUndefined();
    expect(applyLearnedRule({ ...rule(), toTier: 'basic' }, facts, { tier: 2, setBy: [] }, ROUTABLE, undefined)).toBeUndefined();
  });

  it('an accepted upgrade raises the floor', () => {
    const up = ruleFromProposal(proposals(batch('a', 10, 1, 'standard')).list[0], NOW);
    expect(routeTask(routine, { tiers: DEFAULT_TIERS, learnedRules: [up] }).requirement.minTier).toBe('expert');
  });
});

describe('the corpus veto', () => {
  const clean = ruleFromProposal(proposals(batch('a', 20, 20, 'basic')).list[0], NOW);

  it('lets a rule the generator makes through', () => {
    expect(proposalVeto(clean)).toEqual([]);
  });

  it('refuses a rule that would route unguarded work to the cheapest tier', () => {
    const bad: LearnedRule = { ...clean, cohort: { ...clean.cohort, verifiability: 'none-weak' } };
    const why = proposalVeto(bad);
    expect(why.length).toBeGreaterThan(0);
    expect(why.join('\n')).toMatch(/basic tier without at least partial verification/);
  });

  it('every corpus card, routed with the rule for its own kind and cohort, stays free of egregious misroutes', () => {
    for (const card of loadCorpus()) {
      const combined = assessCard(card, labelsAsAnswer(card.labels));
      const kind = combined.kind.value;
      const down: LearnedRule = { ...clean, cohort: { ...clean.cohort, kind } };
      const r = routeTask(
        { id: 'c', taskId: 'c', taskRevision: 1, inputsHash: 'c', assessorVersion: ASSESSOR_VERSION, createdAt: 0, ...combined },
        { tiers: DEFAULT_TIERS, learnedRules: [down] },
      );
      expect(egregiousMisroutes({ requirement: r.requirement, kind, risk: combined.dimensions.risk.value, verifiability: combined.dimensions.verifiability.value }), card.id).toEqual([]);
    }
  });
});
