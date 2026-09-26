/**
 * The routing evaluation corpus, deterministically (plan §27.2; #39): every
 * card is well formed, its labels are an assessment the assessor could
 * actually produce, and — once the router exists — labelled assessment →
 * router → requirement lands inside the card's expectations with **zero
 * egregious misroutes**. This is the guard every routing rule change runs
 * against.
 *
 * Recorded live-assessor answers (`routingCorpus.live.test.ts`) replay here
 * too: the real assessor's answers, combined with the rules, must never lead
 * to an egregious misroute either.
 */
import { describe, expect, it } from 'vitest';
import { ASSESSOR_VERSION } from '../../src/orchestration/policy/assessment';
import type { RouteRequirement } from '../../src/shared/orchestration/types';
import { corpusRouter } from './corpusRouter';
import {
  EGREGIOUS,
  addAgreement,
  assessCard,
  cardHash,
  cardProblems,
  egregiousMisroutes,
  emptyAgreement,
  evaluateCard,
  expectationMisses,
  labelConflicts,
  labelsAsAnswer,
  loadCorpus,
  loadRecording,
  type CardExpectations,
  type CorpusCard,
} from './routingCorpus';

const corpus = loadCorpus();

function req(over: Partial<RouteRequirement> = {}): RouteRequirement {
  return { minTier: 'standard', maxTier: 'expert', effort: 'medium', needs: ['edit', 'shell'], gates: [], ...over };
}

describe('routing corpus: the cards', () => {
  it('has about thirty cards, covering every case the plan names', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(28);
    const cases = corpus.map((c) => c.case).join(' | ');
    for (const needle of [
      'small typo',
      'single-file bug',
      'test generation',
      'multi-file feature',
      'large refactor',
      'architecture change',
      'database migration',
      'Unity UI',
      'Unity shader',
      'documentation',
      'git conflict resolution',
      'dependency bump on a protocol path',
      'flaky test fix',
      'performance investigation',
      'security fix',
      'CI configuration',
      'vague request',
      'trivial but critical',
      'large but mechanical',
    ]) {
      expect(cases, needle).toContain(needle);
    }
  });

  it('has unique ids', () => {
    expect(new Set(corpus.map((c) => c.id)).size).toBe(corpus.length);
  });

  it('uses only invented paths', () => {
    // The repo is public: no home directories, no real project names, ever.
    for (const c of corpus) {
      const text = JSON.stringify(c);
      expect(text, c.id).not.toMatch(/\/Users\/|\/home\/|C:\\\\/);
    }
  });

  it.each(corpus.map((c) => [c.id, c] as const))('%s: labels agree with what the rules establish', (_id, c) => {
    expect(labelConflicts(c)).toEqual([]);
  });

  it('rejects a malformed card, naming the field', () => {
    const good = corpus[0];
    const bad = {
      ...good,
      labels: { ...good.labels, risk: 'spicy' },
      expect: { ...good.expect, tierIn: ['basic'], never: [{ tier: 'basic' }] },
    } as unknown as CorpusCard;
    const problems = cardProblems(bad, `${good.id}.json`).join('\n');
    expect(problems).toContain('labels.risk');
    expect(problems).toContain('never forbids');
  });
});

describe('routing corpus: the checks themselves', () => {
  it('flags each egregious misroute, and nothing reasonable', () => {
    const ok = { requirement: req(), kind: 'feature' as const, risk: 'moderate' as const, verifiability: 'strong' as const };
    expect(egregiousMisroutes(ok)).toEqual([]);
    expect(egregiousMisroutes({ ...ok, kind: 'docs', requirement: req({ minTier: 'expert', effort: 'high' }) })).toEqual(['docs-expert-high']);
    expect(egregiousMisroutes({ ...ok, kind: 'architecture', requirement: req({ effort: 'low' }) })).toEqual(['architecture-basic-or-low']);
    expect(egregiousMisroutes({ ...ok, kind: 'plan', requirement: req({ minTier: 'basic', effort: 'high' }) })).toEqual(['architecture-basic-or-low']);
    expect(egregiousMisroutes({ ...ok, risk: 'critical', requirement: req({ minTier: 'standard' }) })).toEqual(['critical-below-expert']);
    expect(egregiousMisroutes({ ...ok, verifiability: 'weak', requirement: req({ minTier: 'basic' }) })).toEqual(['basic-unguarded']);
    expect(egregiousMisroutes({ ...ok, risk: 'high', requirement: req({ minTier: 'basic' }) })).toEqual(['basic-unguarded']);
    expect(EGREGIOUS.map((e) => e.id)).toHaveLength(4);
  });

  it('reports every expectation a requirement misses', () => {
    const e: CardExpectations = { tierIn: ['expert'], effortIn: ['medium'], requires: ['exclusive:x'], gates: ['human-review'], never: [{ effort: 'low' }] };
    expect(expectationMisses(e, req({ minTier: 'expert', needs: ['exclusive:x'], gates: ['human-review'] }))).toEqual([]);
    expect(expectationMisses(e, req({ effort: 'low' }))).toEqual([
      'tier standard not in [expert]',
      'effort low not in [medium]',
      'needs is missing exclusive:x',
      'gate human-review missing',
      'never low',
    ]);
  });
});

/**
 * Labelled assessment → router → requirement. Skipped only until the router
 * (#38) is wired into `corpusRouter.ts`; after that, it is the gate.
 */
describe.skipIf(!corpusRouter)('routing corpus: labelled assessments through the router', () => {
  const route = corpusRouter!;

  it.each(corpus.map((c) => [c.id, c] as const))('%s: lands inside its expectations', (_id, c) => {
    const v = evaluateCard(c, assessCard(c, labelsAsAnswer(c.labels)), route);
    expect(v.misses, JSON.stringify(v.requirement)).toEqual([]);
  });

  it('commits zero egregious misroutes across the corpus', () => {
    const bad = corpus
      .map((c) => evaluateCard(c, assessCard(c, labelsAsAnswer(c.labels)), route))
      .filter((v) => v.egregious.length > 0)
      .map((v) => `${v.id}: ${v.egregious.join(', ')}`);
    expect(bad).toEqual([]);
  });

  it('routes a rules-only assessment (the completion failed) without an egregious misroute', () => {
    const bad = corpus
      .map((c) => evaluateCard(c, assessCard(c, undefined), route))
      .filter((v) => v.egregious.length > 0)
      .map((v) => `${v.id}: ${v.egregious.join(', ')}`);
    expect(bad).toEqual([]);
  });
});

/**
 * The recorded answers of the last live run of this assessor version,
 * replayed. The assessor may disagree with a label — that is what the
 * agreement numbers measure — but its answers must never route egregiously.
 */
describe('routing corpus: recorded assessor answers', () => {
  const recording = loadRecording(ASSESSOR_VERSION);
  const replayable = corpus.filter((c) => recording?.answers[c.id]?.cardHash === cardHash(c));

  it.skipIf(!recording)('replays to the agreement that was recorded', () => {
    const acc = emptyAgreement();
    for (const c of replayable) addAgreement(acc, c.labels, assessCard(c, recording!.answers[c.id].answer));
    // Cards edited since the recording are not replayed, so only compare a complete replay.
    if (replayable.length === recording!.agreement.cards) expect(acc).toEqual(recording!.agreement);
    expect(replayable.length).toBeGreaterThan(0);
  });

  it.skipIf(!recording || !corpusRouter)('never routes egregiously', () => {
    const bad = replayable
      .map((c) => evaluateCard(c, assessCard(c, recording!.answers[c.id].answer), corpusRouter!))
      .filter((v) => v.egregious.length > 0)
      .map((v) => `${v.id}: ${v.egregious.join(', ')}`);
    expect(bad).toEqual([]);
  });
});
