/**
 * The proposal card (#81): an `aw task` proposal drawn in the conversation
 * that asked for it, and the card's answer turned back into what the runner
 * takes.
 *
 * Pure. The options are the ones the launcher's "Change model…" offers
 * (routable, tiered, within the task's cap), so the card can never propose a
 * route the palette would refuse.
 */
import { harnessLabel } from '../../shared/harness';
import { nativeEffortFor, tierRank, type CapabilityCatalogView, type CatalogEntry } from '../../shared/orchestration/catalog';
import type { ProposalDecision, ProposalModelOption, TaskProposalView } from '../../shared/orchestration/taskView';
import { EFFORT_LEVELS, type Mission, type RouteRecommendation } from '../../shared/orchestration/types';
import type { ProposalChoice } from '../engine/taskRunner';
import { explainRecommendation } from './routeExplain';

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
  return { route: { harness: route.harness, model: route.model, ...(route.effort && route.effort !== 'none' ? { effort: route.effort } : {}) } };
}
