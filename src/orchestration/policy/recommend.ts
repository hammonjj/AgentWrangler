/**
 * Router, then resolver, as one recommendation; and how a route that ran
 * compares with it (`docs/plans/intelligent-orchestration.md` §9.1, §10.1,
 * §27.3; #38).
 *
 * Pure: an assessment, a policy and a snapshot in; a `RouteRecommendation`
 * out. The task runner stores it — as the proposal in `assisted`, as the
 * shadow in `manual` — and everything the user is later told about "why this
 * route" is read back from what was stored here.
 */
import type {
  ExecutionPolicy,
  ExecutionTarget,
  Millis,
  RouteAgreement,
  RouteDimension,
  RouteRecommendation,
  TaskAssessment,
} from '../../shared/orchestration/types';
import { resolveRoute, type ResolverSnapshot } from './resolver';
import { ROUTER_VERSION, routeTask } from './router';

/** Assessment + the mission's policy + a catalog/health snapshot → a recommendation. */
export function recommendRoute(
  assessment: TaskAssessment,
  policy: ExecutionPolicy,
  snapshot: ResolverSnapshot,
  at: Millis = snapshot.now,
): RouteRecommendation {
  const routed = routeTask(assessment, {
    tiers: snapshot.catalog.tiers,
    caps: policy.caps,
    preferences: policy.preferences,
  });
  const base = {
    assessmentId: assessment.id,
    policyVersion: ROUTER_VERSION,
    requirement: routed.requirement,
    reasons: routed.reasons,
    at,
  };
  // A cap below what the work needs is a person's call: nothing is resolved
  // against a requirement that cannot be met without breaking the cap.
  if (routed.verdict === 'needs-human') {
    return { ...base, verdict: 'needs-human', note: routed.needsHuman, resolution: { candidates: [], catalogVersion: snapshot.catalog.version } };
  }
  const r = resolveRoute(routed.requirement, snapshot, { caps: policy.caps, preferences: policy.preferences, exclusions: policy.exclusions });
  const resolution = { target: r.target, candidates: r.candidates, catalogVersion: r.catalogVersion, ...(r.note ? { note: r.note } : {}) };
  if (r.outcome !== 'resolved') return { ...base, verdict: r.outcome, note: r.note, resolution };
  // A resolved route with a plan-first gate still needs a person before an agent edits anything (§7.5).
  if (routed.requirement.gates.includes('plan-first')) {
    return { ...base, verdict: 'needs-human', note: 'The task is open-ended: decide what to build (or plan it) before an agent edits anything.', resolution };
  }
  return { ...base, verdict: 'route', resolution };
}

function modelOf(t: ExecutionTarget): string {
  return (t.resolvedModel ?? t.model).toLowerCase();
}

/**
 * Which dimensions of what ran differ from what was recommended, and the
 * single label telemetry and the comparison report group by. `offered` is
 * true when the user was shown the recommendation (the first attempt of an
 * `assisted` task) — only then is agreeing with it an *acceptance*.
 */
export function compareRoutes(
  recommended: ExecutionTarget | undefined,
  ran: ExecutionTarget,
  offered: boolean,
): { agreement: RouteAgreement; changed: RouteDimension[] } {
  if (!recommended) return { agreement: 'no-recommendation', changed: [] };
  const changed: RouteDimension[] = [];
  if (recommended.harness !== ran.harness) changed.push('harness');
  if (modelOf(recommended) !== modelOf(ran)) changed.push('model');
  if (recommended.tier !== ran.tier) changed.push('tier');
  if (recommended.effortNative !== ran.effortNative) changed.push('effort');
  if (changed.length === 0) return { agreement: offered ? 'accepted' : 'matched', changed };
  const order: [RouteDimension, RouteAgreement][] = [
    ['tier', 'changed-tier'],
    ['harness', 'changed-harness'],
    ['model', 'changed-model'],
    ['effort', 'changed-effort'],
  ];
  const agreement = order.find(([d]) => changed.includes(d))![1];
  return { agreement, changed };
}
