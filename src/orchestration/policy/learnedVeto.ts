/**
 * The corpus veto for routing proposals (`docs/plans/intelligent-orchestration.md`
 * §20.3, §27; #52): a proposal that would make any task of its cohort routed
 * egregiously is refused, whatever the data says.
 *
 * The corpus itself runs in `npm test` and cannot be read by the app, so the
 * veto judges the same list (`EGREGIOUS`) over every assessment the cohort can
 * contain: each level of every dimension the cohort leaves open, at both
 * confidence extremes. That is a superset of what the corpus cards cover, and
 * `learnedRules.test.ts` also runs the cards through the rule.
 */
import { AMBIGUITY_LEVELS, BREADTH_LEVELS, COMPLEXITY_LEVELS, RISK_LEVELS, VERIFIABILITY_LEVELS } from './assessment';
import { egregiousMisroutes, EGREGIOUS } from './egregious';
import { routeTask } from './router';
import { DEFAULT_TIERS, type TierDef } from '../../shared/orchestration/catalog';
import { complexityBucket, verifiabilityBucket, type LearnedRule } from '../../shared/orchestration/routingProposals';
import type { Assessed, Confidence, TaskAssessment, TaskKind } from '../../shared/orchestration/types';

function assessed<T>(value: T, confidence: Confidence): Assessed<T> {
  return { value, confidence, from: 'rule' as Assessed<T>['from'] };
}

/** One line per egregious misroute the rule would commit, empty when it commits none. */
export function proposalVeto(rule: LearnedRule, tiers: readonly TierDef[] = DEFAULT_TIERS): string[] {
  const found = new Map<string, string>();
  const confidences: Confidence[] = ['low', 'high'];
  for (const complexity of COMPLEXITY_LEVELS.filter((c) => complexityBucket(c) === rule.cohort.complexity)) {
    for (const verifiability of VERIFIABILITY_LEVELS.filter((v) => verifiabilityBucket(v) === rule.cohort.verifiability)) {
      for (const risk of RISK_LEVELS) {
        for (const breadth of BREADTH_LEVELS) {
          for (const ambiguity of AMBIGUITY_LEVELS) {
            for (const confidence of confidences) {
              const a: TaskAssessment = {
                id: 'veto',
                taskId: 'veto',
                taskRevision: 1,
                inputsHash: 'veto',
                assessorVersion: 'veto',
                dimensions: {
                  complexity: assessed(complexity, confidence),
                  breadth: assessed(breadth, 'high'),
                  risk: assessed(risk, confidence),
                  ambiguity: assessed(ambiguity, 'high'),
                  verifiability: assessed(verifiability, 'high'),
                  contextLoad: assessed('small' as const, 'high'),
                },
                kind: assessed(rule.cohort.kind as TaskKind, 'high'),
                domains: [],
                requires: ['edit', 'shell'],
                confidence: 'high',
                evidence: [],
                createdAt: 0,
              };
              const { requirement } = routeTask(a, { tiers, learnedRules: [rule], ...(rule.cohort.repository ? { repository: rule.cohort.repository } : {}) });
              for (const id of egregiousMisroutes({ requirement, kind: a.kind.value, risk, verifiability })) {
                if (!found.has(id)) {
                  const text = EGREGIOUS.find((e) => e.id === id)?.text ?? id;
                  found.set(id, `${text} (${complexity}, risk ${risk}, ${verifiability} verification)`);
                }
              }
            }
          }
        }
      }
    }
  }
  return [...found.values()];
}
