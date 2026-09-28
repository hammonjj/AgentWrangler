/**
 * The proposal card (#81): an `aw task` proposal drawn in the conversation
 * that asked for it, and the card's answer turned back into what the runner
 * takes. And the delegation card (#82): `aw delegate` work the planner is
 * deciding on, or planned as several tasks, in the conversation that
 * delegated it.
 *
 * Pure. The options are the ones the launcher's "Change model…" offers
 * (routable, tiered, within the task's cap), so the card can never propose a
 * route the palette would refuse.
 */
import { harnessLabel } from '../../shared/harness';
import { isEndpointSource } from '../../shared/orchestration/localEndpoints';
import { nativeEffortFor, tierRank, type CapabilityCatalogView, type CatalogEntry } from '../../shared/orchestration/catalog';
import type { DelegationView, ProposalDecision, ProposalModelOption, TaskProposalView } from '../../shared/orchestration/taskView';
import { EFFORT_LEVELS, type Mission, type RouteRecommendation } from '../../shared/orchestration/types';
import { canApprove, planIssues } from '../domain/plan';
import type { ProposalChoice } from '../engine/taskRunner';
import { explainRecommendation, targetLabel } from './routeExplain';

const optionId = (harness: string, model: string) => `${harness}|${model}`;

/** The catalog entry a target names, by any of its aliases. */
function entryFor(catalog: CapabilityCatalogView, source: string, model: string): CatalogEntry | undefined {
  return catalog.entries.find((e) => e.descriptor.source === source && (e.aliases.includes(model) || e.descriptor.modelId === model));
}

/** Whether a mission's task is a proposal nobody has started or dropped yet. */
export function isOpenProposal(m: Mission): boolean {
  const task = m.tasks[0];
  return !!task?.recommendation && task.attemptIds.length === 0 && ['routed', 'needs-human'].includes(task.state);
}

export function proposalViewOf(m: Mission, rec: RouteRecommendation, catalog: CapabilityCatalogView): TaskProposalView {
  const task = m.tasks[0];
  const cap = tierRank(catalog.tiers, rec.requirement.maxTier);
  const options: ProposalModelOption[] = catalog.entries
    .filter((e) => e.routable && e.tier !== undefined && (cap < 0 || tierRank(catalog.tiers, e.tier) <= cap))
    .flatMap((e) =>
      e.harnesses.map((h) => ({
        id: optionId(h, e.descriptor.modelId),
        harness: h,
        model: e.descriptor.modelId,
        label: `${e.descriptor.label} (${e.tier}) · ${harnessLabel(h)}`,
        tier: e.tier!,
        efforts: EFFORT_LEVELS.map((level) => ({ level, native: nativeEffortFor(e, level) })).filter((x) => x.native !== 'none'),
      })),
    );
  const target = rec.verdict !== 'blocked' ? rec.resolution.target : undefined;
  const entry = target && entryFor(catalog, target.source, target.model);
  const recommendedId = entry && target ? optionId(target.harness, entry.descriptor.modelId) : undefined;
  return {
    missionId: m.id,
    title: task?.title ?? m.title,
    objective: task?.objective ?? m.objective,
    acceptanceCriteria: task?.acceptanceCriteria ?? [],
    verdict: rec.verdict,
    why: explainRecommendation(rec),
    ...(recommendedId && options.some((o) => o.id === recommendedId)
      ? { recommended: { optionId: recommendedId, effort: rec.requirement.effort } }
      : {}),
    options,
    ...(m.delegation ? { delegated: true } : {}),
  };
}

/**
 * Whether a mission is a delegation (#82) whose card is a plan's: the planner
 * has not answered, could not plan it, or planned several tasks that wait
 * for review. One kept as one task is an open proposal instead.
 */
export function isOpenDelegation(m: Mission): boolean {
  return !!m.delegation && m.planned === true && ['planning', 'planning-failed', 'plan-review'].includes(m.state);
}

/**
 * What a delegation has come to (#82), for `aw delegate`'s answer.
 * `planning` until there is something for the user to approve: the planner
 * has not answered, or a task it kept whole is still being routed.
 */
export type DelegationOutcome =
  | { decision: 'planning' }
  | { decision: 'single'; verdict: string; route?: string; summary: string; note?: string }
  | { decision: 'multiple'; tasks: { key: string; title: string }[] }
  | { decision: 'failed' | 'cancelled' | 'started'; note?: string };

export function delegationOutcome(m: Mission): DelegationOutcome {
  if (m.state === 'cancelled') return { decision: 'cancelled', ...(m.stateReason ? { note: m.stateReason } : {}) };
  if (m.planned) {
    if (m.state === 'planning') return { decision: 'planning' };
    if (m.state === 'planning-failed') {
      const reason = m.planning?.at(-1)?.reason ?? m.stateReason;
      return { decision: 'failed', ...(reason ? { note: reason } : {}) };
    }
    if (m.state === 'plan-review') return { decision: 'multiple', tasks: m.tasks.map((t) => ({ key: t.key, title: t.title })) };
    return { decision: 'started' };
  }
  const task = m.tasks[0];
  if (isOpenProposal(m) && task.recommendation) {
    const rec = task.recommendation;
    const t = rec.verdict !== 'blocked' ? rec.resolution.target : undefined;
    return {
      decision: 'single',
      verdict: rec.verdict,
      ...(t ? { route: targetLabel(t) } : {}),
      summary: explainRecommendation(rec).summary,
      ...(rec.note ? { note: rec.note } : {}),
    };
  }
  if (m.state === 'draft' && task && task.attemptIds.length === 0) return { decision: 'planning' };
  return { decision: 'started' };
}

/** The delegation card (#82). `route` is what tasks without a pin run on if approved from the card. */
export function delegationViewOf(m: Mission, ctx: { canPlan: boolean; route?: string }): DelegationView {
  const state: DelegationView['state'] = m.state === 'planning' ? 'planning' : m.state === 'planning-failed' ? 'failed' : 'review';
  const run = m.planning?.at(-1);
  const reviewing = state === 'review';
  const keyOf = new Map(m.tasks.map((t) => [t.id, t.key]));
  const issues = reviewing ? planIssues(m) : [];
  const reason = state === 'failed' ? (run?.reason ?? m.stateReason) : m.stateReason;
  return {
    missionId: m.id,
    title: m.title,
    objective: m.objective,
    acceptanceCriteria: [...(m.delegation?.acceptanceCriteria ?? [])],
    state,
    ...(reason ? { reason } : {}),
    tasks: reviewing
      ? m.tasks.map((t) => ({
          key: t.key,
          title: t.title,
          objective: t.objective,
          acceptanceCriteria: [...t.acceptanceCriteria],
          after: t.dependsOn.map((d) => keyOf.get(d.taskId) ?? '?'),
        }))
      : [],
    risks: reviewing ? [...(run?.risks ?? [])] : [],
    warnings: [...(reviewing ? (run?.warnings ?? []) : []), ...issues.filter((i) => i.level === 'warning').map((i) => i.text)],
    blockers: issues.filter((i) => i.level !== 'warning').map((i) => i.text),
    canApprove: reviewing && m.planned === true && canApprove(m),
    canPlanAgain: ctx.canPlan && (state === 'failed' || state === 'review'),
    canRunAsTask: state === 'failed',
    ...(reviewing && ctx.route ? { route: ctx.route } : {}),
  };
}

/**
 * The card's answer as the runner's choice. A route equal to the
 * recommendation is an acceptance (no route), so picking what was offered
 * counts as agreeing with the router and not as a change (§27.3).
 */
export function proposalChoice(rec: RouteRecommendation, catalog: CapabilityCatalogView, decision: ProposalDecision & { kind: 'run' }): ProposalChoice {
  const route = decision.route;
  if (!route) return {};
  const t = rec.verdict !== 'blocked' ? rec.resolution.target : undefined;
  if (t && t.harness === route.harness) {
    const entry = entryFor(catalog, t.source, t.model);
    const sameModel = entry ? entry.aliases.includes(route.model) || entry.descriptor.modelId === route.model : t.model === route.model;
    const sameEffort = (route.effort ?? 'none') === (t.effortNative || 'none');
    if (sameModel && sameEffort) return {};
  }
  // The card names harness and model; a local endpoint's model also needs its source (#51).
  const picked = catalog.entries.find((e) => e.harnesses.includes(route.harness) && (e.descriptor.modelId === route.model || e.aliases.includes(route.model)));
  const source = picked && isEndpointSource(picked.descriptor.source) ? picked.descriptor.source : undefined;
  return {
    route: {
      harness: route.harness,
      ...(source ? { source } : {}),
      model: route.model,
      ...(route.effort && route.effort !== 'none' ? { effort: route.effort } : {}),
    },
  };
}
