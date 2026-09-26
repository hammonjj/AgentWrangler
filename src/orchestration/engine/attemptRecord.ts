/**
 * An attempt's usage and its `attempt` telemetry record
 * (`docs/plans/intelligent-orchestration.md` §16.2–16.3).
 *
 * Pure. Metadata only: ids, enums, counts, durations and token numbers,
 * never the objective, the prompt or anything the agent wrote. A field
 * nobody reported is absent, never zero.
 */
import { TELEMETRY_SCHEMA_VERSION, type AttemptRecord, type TurnRecord } from '../../shared/orchestration/telemetry';
import type { ExecutionAttempt, Millis, Mission, ReviewVerdict, UsageSummary } from '../../shared/orchestration/types';
import { reviewCounts } from '../../shared/orchestration/verification';

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
      .map((v) =>
        prune({
          strategy: v.strategy,
          outcome: v.outcome!,
          flaky: v.flaky,
          preExisting: v.preExisting,
          skipped: v.skipped,
          durationMs: v.durationMs,
          review: v.review ? reviewTelemetry(v.review) : undefined,
        }),
      ),
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

/** A review verdict as numbers: counts, the model and its cost, never its reasons. */
function reviewTelemetry(v: ReviewVerdict): NonNullable<AttemptRecord['verification'][number]['review']> {
  const n = reviewCounts(v);
  return prune({
    ...n,
    concerns: v.concerns.length,
    repaired: v.repaired,
    model: v.model,
    inputTokens: v.usage?.inputTokens,
    outputTokens: v.usage?.outputTokens,
    costUsd: v.usage?.costUsd,
  });
}

function prune<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}
