/**
 * An attempt's usage and its `attempt` telemetry record
 * (`docs/plans/intelligent-orchestration.md` §16.2–16.3).
 *
 * Pure. Metadata only: ids, enums, counts, durations and token numbers,
 * never the objective, the prompt or anything the agent wrote. A field
 * nobody reported is absent, never zero.
 */
import { TELEMETRY_SCHEMA_VERSION, type AttemptRecord, type RoutingRecord, type TurnRecord } from '../../shared/orchestration/telemetry';
import type { ExecutionAttempt, Millis, Mission, RoutingDecision, UsageSummary } from '../../shared/orchestration/types';

/** Fold one turn record into an attempt's usage. A record already counted is ignored. */
export function addTurnUsage(usage: UsageSummary | undefined, r: TurnRecord): UsageSummary {
  const u: UsageSummary = usage
    ? { ...usage, byModel: { ...usage.byModel }, turnIds: [...(usage.turnIds ?? [])] }
    : { costBasis: 'none', turns: 0, byModel: {}, turnIds: [] };
  if (u.turnIds!.includes(r.id)) return usage ?? u;
  u.turnIds!.push(r.id);
  u.turns++;
  for (const [model, m] of Object.entries(r.modelsUsed ?? {})) {
    const into = { ...u.byModel![model] };
    for (const k of ['in', 'out', 'cacheRead', 'cacheWrite', 'thinking', 'costUsd'] as const) {
      if (m[k] !== undefined) into[k] = round((into[k] ?? 0) + m[k]!);
    }
    u.byModel![model] = into;
    if (m.in !== undefined) u.inputTokens = (u.inputTokens ?? 0) + m.in;
    if (m.out !== undefined) u.outputTokens = (u.outputTokens ?? 0) + m.out;
    if (m.cacheRead !== undefined) u.cacheReadTokens = (u.cacheReadTokens ?? 0) + m.cacheRead;
    if (m.cacheWrite !== undefined) u.cacheWriteTokens = (u.cacheWriteTokens ?? 0) + m.cacheWrite;
  }
  if (r.costUsd !== undefined && r.costBasis !== 'none') {
    u.costUsd = round((u.costUsd ?? 0) + r.costUsd);
    // One basis per attempt; turns that disagree fall back to the weaker claim.
    u.costBasis = u.costBasis === 'none' || u.costBasis === r.costBasis ? r.costBasis : 'price-table';
  }
  return u;
}

function round(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

/** Time waiting on a person, including a wait still open at `now`. */
export function waitedMs(a: ExecutionAttempt, now: Millis): number {
  const t = a.timing;
  return (t?.waitedOnHumanMs ?? 0) + (t?.waitingSince !== undefined ? Math.max(0, now - t.waitingSince) : 0);
}

/**
 * The assessment this attempt's task carried when it ran (§16.2, #37):
 * dimension values, how sure each was, and which assessor said so. Values and
 * levels only — the evidence lines quote the objective, and the telemetry log
 * holds no user text.
 */
function assessmentSnapshot(
  mission: Mission,
  a: ExecutionAttempt,
): { snapshot: NonNullable<AttemptRecord['assessment']>; confidence: string } | undefined {
  const forTask = mission.assessments.filter((x) => x.taskId === a.taskId);
  const latest = forTask[forTask.length - 1];
  if (!latest) return undefined;
  const dimensions: Record<string, { value: string; confidence: string }> = {};
  for (const [name, d] of Object.entries(latest.dimensions)) dimensions[name] = { value: d.value, confidence: d.confidence };
  dimensions.kind = { value: latest.kind.value, confidence: latest.kind.confidence };
  return { snapshot: { dimensions, assessorVersion: latest.assessorVersion }, confidence: latest.confidence };
}

/**
 * The `attempt` record for an attempt that has ended. `partial` for an
 * interrupted one: what happened after the core lost sight of it is unknown.
 * The id is the attempt's, so writing it twice records it once.
 */
export function attemptRecord(mission: Mission, a: ExecutionAttempt, now: Millis): AttemptRecord | undefined {
  const outcome = a.outcome?.status;
  if (!outcome) return undefined;
  const decision = mission.decisions.find((d) => d.id === a.routingDecisionId);
  if (!decision) return undefined;
  const target = decision.resolution.target;
  const assessment = assessmentSnapshot(mission, a);
  const ended = a.endedAt ?? now;
  const waited = waitedMs(a, ended);
  const record: AttemptRecord = {
    v: TELEMETRY_SCHEMA_VERSION,
    type: 'attempt',
    at: now,
    id: `attempt:${a.id}`,
    missionId: mission.id,
    taskId: a.taskId,
    attemptId: a.id,
    n: a.n,
    mode: decision.mode,
    repoPolicyVersion: a.repoPolicyVersion,
    ...(assessment ? { assessment: assessment.snapshot, routingConfidence: assessment.confidence } : {}),
    target: { ...target, ...(decision.requirement.effort ? { effortRequested: decision.requirement.effort } : {}) },
    ...(decision.shadow
      ? {
          requirement: { tier: decision.shadow.requirement.minTier, effort: decision.shadow.requirement.effort },
          shadow: {
            tier: decision.shadow.requirement.minTier,
            effort: decision.shadow.requirement.effort,
            ...(decision.shadow.resolution.target ? { target: decision.shadow.resolution.target } : {}),
            verdict: decision.shadow.verdict,
          },
          ...(decision.agreement ? { agreement: decision.agreement } : {}),
          ...(decision.overrides.length > 0 ? { changed: [...decision.overrides] } : {}),
        }
      : {}),
    queuedAt: a.timing?.queuedAt,
    startedAt: a.launchedAt,
    endedAt: a.endedAt,
    usage: a.usage?.byModel ?? {},
    cost: { ...(a.usage?.costUsd !== undefined ? { usd: a.usage.costUsd } : {}), basis: a.usage?.costBasis ?? 'none' },
    turns: a.usage?.turns ?? 0,
    outcome,
    category: a.outcome?.category,
    signature: a.outcome?.signature,
    verification: a.verification
      .filter((v) => v.outcome !== undefined)
      .map((v) => ({ strategy: v.strategy, outcome: v.outcome!, flaky: v.flaky, preExisting: v.preExisting, durationMs: v.durationMs })),
    flags: { ...a.flags },
  };
  if (a.launchedAt !== undefined) {
    record.activeMs = Math.max(0, ended - a.launchedAt - waited);
    if (a.timing?.queuedAt !== undefined) record.queueMs = Math.max(0, a.launchedAt - a.timing.queuedAt);
  }
  if (waited > 0) record.waitedOnHumanMs = waited;
  if (a.git) record.git = { filesChanged: a.git.filesChanged, insertions: a.git.insertions, deletions: a.git.deletions, commits: a.git.commits };
  if (outcome === 'interrupted') record.partial = true;
  return prune(record);
}

/**
 * The `routing` record for a decision that carries a recommendation (#38).
 * Undefined for one that does not (a manual decision whose task has not been
 * assessed yet): there is nothing to compare, and it is written once the
 * shadow is filled in. The id is the decision's, so writing it twice records once.
 */
export function routingRecord(mission: Mission, d: RoutingDecision, now: Millis): RoutingRecord | undefined {
  const rec = d.shadow;
  if (!rec) return undefined;
  // The resolver's view of the pool, whoever decided: that is what the router is being judged on.
  const count = (v: string) => rec.resolution.candidates.filter((c) => c.verdict === v).length;
  return prune<RoutingRecord>({
    v: TELEMETRY_SCHEMA_VERSION,
    type: 'routing',
    at: now,
    id: `routing:${d.id}`,
    missionId: mission.id,
    taskId: d.taskId,
    decisionId: d.id,
    attemptN: d.attemptN,
    mode: d.mode,
    decidedBy: d.decidedBy,
    routerVersion: rec.policyVersion,
    catalogVersion: rec.resolution.catalogVersion,
    assessmentId: rec.assessmentId,
    requirement: {
      minTier: rec.requirement.minTier,
      maxTier: rec.requirement.maxTier,
      effort: rec.requirement.effort,
      gates: [...rec.requirement.gates],
    },
    ruleIds: rec.reasons.map((r) => r.ruleId),
    verdict: rec.verdict,
    recommended: rec.resolution.target,
    ran: d.resolution.target,
    agreement: d.agreement ?? 'no-recommendation',
    changed: [...d.overrides],
    candidates: { chosen: count('chosen'), fallback: count('fallback'), rejected: count('rejected') },
  });
}

function prune<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}
