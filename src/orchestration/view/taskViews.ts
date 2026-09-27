/**
 * Turning a `Mission` into what the panes draw (#34).
 *
 * The rule this file exists to keep: **a webview never sees a `Mission`.**
 * The table and the conversation get a `TaskBadge` and a `TaskView`
 * (`shared/orchestration/taskView.ts`) — flat records with no attempt list to
 * search, no state machine to interpret and no harness to special-case. Every
 * "which attempt is current", "which worktree is this attempt's" and "is this
 * model local" question is answered here, once, on the host side.
 *
 * Pure: a `Mission` in, view records out. No Node, no store, no runner — the
 * caller passes the actions and the clock, so a test can build every view a
 * pane can be sent without starting anything.
 */
import { modelLabel } from '../../shared/modelName';
import { DEFAULT_TIERS } from '../../shared/orchestration/catalog';
import {
  describePolicy,
  diffText,
  missionLayers,
  pinnedDimensions,
  policyDiff,
  resolveEffectivePolicy,
  scopeTag,
  type PolicyContext,
} from '../../shared/orchestration/executionPolicy';
import { REVIEW, stageLine, summariseVerification, verificationBadge } from '../../shared/orchestration/verification';
import { PROVENANCE_LABEL } from '../policy/assessment';
import { explainDecision } from './routeExplain';
import type {
  AssessmentRowView,
  RouteExplanationView,
  TaskAssessmentView,
  TaskAttemptView,
  TaskBadge,
  TaskDiffView,
  TaskPolicyView,
  TaskReviewView,
  TaskRouteView,
  TaskVerificationView,
  TaskView,
  TaskViewAction,
} from '../../shared/orchestration/taskView';
import type {
  Assessed,
  ExecutionAttempt,
  HarnessId,
  Mission,
  RoutingDecision,
  Task,
  VerificationResult,
} from '../../shared/orchestration/types';

/** How a harness's sessions are keyed in the table (`${provider}:${sessionId}`). */
const PROVIDER: Record<string, string> = { 'claude-code': 'claude', codex: 'codex' };

/** The table's key for a session of this harness, or undefined when either is unknown. */
export function sessionKeyFor(harness: HarnessId, sessionId: string | undefined): string | undefined {
  const provider = PROVIDER[harness];
  return provider && sessionId ? `${provider}:${sessionId}` : undefined;
}

/** The task a view is about: the one named, or a single-task mission's only task. */
function taskOf(m: Mission, taskId?: string): Task | undefined {
  return taskId ? m.tasks.find((t) => t.id === taskId) : m.tasks[0];
}

function decisionOf(m: Mission, a: ExecutionAttempt | undefined): RoutingDecision | undefined {
  return a?.routingDecisionId ? m.decisions.find((d) => d.id === a.routingDecisionId) : undefined;
}

/**
 * What an attempt ran on.
 *
 * Read from the routing decision, which is the immutable record of it (§7.2);
 * an attempt with no decision (nothing has been routed yet) has no route to
 * show, and the chip is simply absent rather than guessed at.
 *
 * The effort shown is AW's own level from the requirement, not the model's
 * native one: `high` is a thing a person set, `effortNative` is what the wire
 * happened to carry. The native level rides along in the tooltip via the
 * requirement only when the two differ, which the formatter decides.
 */
export function routeViewOf(m: Mission, a: ExecutionAttempt | undefined): TaskRouteView | undefined {
  const d = decisionOf(m, a);
  if (!d) return undefined;
  const t = d.resolution.target;
  return {
    harness: t.harness,
    model: modelLabel(t.resolvedModel ?? t.model) ?? (t.model || undefined),
    effort: d.requirement.effort ?? (t.effortNative === 'none' ? undefined : t.effortNative),
    tier: t.tier,
    mode: d.mode,
    location: t.location,
    why: explainDecision(m, d).summary,
  };
}

/** Why the attempt runs where it does (#38), from its stored decision. */
export function routingViewOf(m: Mission, a: ExecutionAttempt | undefined): RouteExplanationView | undefined {
  const d = decisionOf(m, a);
  return d ? explainDecision(m, d) : undefined;
}

/**
 * What the checks said about an attempt (#35).
 *
 * Only once they have finished: an attempt that is still `verifying` has an
 * incomplete list, and summing that would show `unverified` — which is a
 * verdict, not a progress report — while the checks are still running.
 */
export function verificationViewOf(
  task: Task,
  a: ExecutionAttempt | undefined,
): TaskVerificationView | undefined {
  const results = a?.verification ?? [];
  if (results.length === 0) return undefined;
  if (results.some((r) => r.state === 'running')) return undefined;
  const summary = summariseVerification(task.verification, results);
  const badge = verificationBadge(summary);
  return {
    glyph: badge.glyph,
    text: badge.text,
    title: badge.title,
    verdict: summary.verdict,
    baseIsRed: summary.baseIsRed || undefined,
    stages: results.map(stageLine),
    // The log of whatever went wrong, or of the last stage that wrote one:
    // the thing a user clicking "open log" is looking for is the failure.
    logPath:
      results.find((r) => r.outcome === 'failed' || r.outcome === 'inconclusive' || r.outcome === 'error')?.evidence?.logPath ??
      [...results].reverse().find((r) => r.evidence?.logPath)?.evidence?.logPath,
    review: reviewViewOf(task, results),
  };
}

/** The last review verdict among the results, with each criterion's own text beside its verdict (#36). */
export function reviewViewOf(task: Task, results: readonly VerificationResult[]): TaskReviewView | undefined {
  const r = [...results].reverse().find((x) => x.strategy === REVIEW && x.review);
  if (!r?.review) return undefined;
  const v = r.review;
  return {
    required: task.verification.stages.some((s) => s.strategy === REVIEW && s.required),
    outcome: r.outcome ?? 'no result',
    criteria: v.criteria.map((c, i) => ({ id: c.id, text: task.acceptanceCriteria[i] ?? c.id, verdict: c.verdict, why: c.why })),
    concerns: v.concerns,
    model: v.model,
    ...(v.usage?.costUsd !== undefined ? { costUsd: v.usage.costUsd } : {}),
  };
}

function diffOf(a: ExecutionAttempt | undefined): TaskDiffView | undefined {
  if (!a?.git) return undefined;
  const g = a.git;
  return {
    filesChanged: g.filesChanged,
    insertions: g.insertions,
    deletions: g.deletions,
    commits: g.commits,
  };
}

/** The attempt the task is on now: the last one it recorded. */
export function currentAttemptOf(m: Mission, taskId?: string): ExecutionAttempt | undefined {
  const id = taskOf(m, taskId)?.attemptIds.at(-1);
  return id ? m.attempts.find((a) => a.id === id) : undefined;
}

function attemptViewOf(m: Mission, a: ExecutionAttempt, current: boolean): TaskAttemptView {
  return {
    id: a.id,
    n: a.n,
    state: a.state,
    outcome: a.outcome?.status,
    category: a.outcome?.category,
    route: routeViewOf(m, a),
    sessionKey: sessionKeyFor(a.assignment.harness, a.assignment.sessionIds.at(-1)),
    startedAt: a.launchedAt ?? a.createdAt,
    endedAt: a.endedAt,
    tokens: totalTokens(a),
    costUsd: a.usage?.costUsd,
    current: current || undefined,
  };
}

/**
 * Every token the attempt is known to have spent.
 *
 * Summed rather than taken from one field because the harnesses do not agree
 * on what "input" includes (`sessionUsage.ts`); an attempt whose turns reported
 * nothing has no figure at all, which is shown as nothing, never as zero.
 */
function totalTokens(a: ExecutionAttempt): number | undefined {
  const u = a.usage;
  if (!u) return undefined;
  const parts = [u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens];
  if (parts.every((p) => p === undefined)) return undefined;
  return parts.reduce<number>((sum, p) => sum + (p ?? 0), 0);
}

/** Values a reader should not miss, whatever else the strip is saying (§18.1). */
const LOUD_VALUES = new Set(['critical', 'open-ended', 'none']);

/**
 * The task's assessment, as the strip shows it: the newest one for the task,
 * every dimension with how sure it is and who said so (§8.2, #37).
 *
 * The evidence lines come through as they are. They are one sentence each, and
 * they are the only reason a person can tell "risk: critical because a path
 * rule says so" from "risk: critical because a model had a feeling".
 */
export function assessmentViewOf(m: Mission, taskId?: string): TaskAssessmentView | undefined {
  const task = taskOf(m, taskId);
  if (!task) return undefined;
  const id = task.assessmentIds.at(-1);
  const a = (id && m.assessments.find((x) => x.id === id)) || undefined;
  if (!a) return undefined;
  const row = (label: string, d: Assessed<string>): AssessmentRowView => ({
    label,
    value: d.value,
    confidence: d.confidence,
    from: d.from,
    fromLabel: PROVENANCE_LABEL[d.from],
    evidence: d.evidence,
    emphasis: LOUD_VALUES.has(d.value) || undefined,
  });
  const d = a.dimensions;
  return {
    summary: [a.kind.value, d.complexity.value, `risk ${d.risk.value}`].join(' · '),
    confidence: a.confidence,
    rows: [
      row('Kind', a.kind),
      row('Complexity', d.complexity),
      row('Breadth', d.breadth),
      row('Risk', d.risk),
      row('Ambiguity', d.ambiguity),
      row('Verifiability', d.verifiability),
      row('Context load', d.contextLoad),
    ],
    domains: a.domains,
    requires: a.requires,
    note: a.evidence.length > 0 ? a.evidence.join(' · ') : undefined,
    assessorVersion: a.assessorVersion,
  };
}

/**
 * The strip above the conversation.
 *
 * `attempts` is every attempt in the order they happened, each carrying the
 * session key that opens it — that is what lets the pane list them without
 * asking the host anything further.
 */
/**
 * The mission header's policy (§10.2, #40): the controls in force for the
 * task's next attempt, where each came from, and every change since the
 * mission started. `ctx` gives the tier order; without it, the default tiers.
 */
export function policyViewOf(m: Mission, ctx: PolicyContext = { tiers: DEFAULT_TIERS }, taskId?: string): TaskPolicyView | undefined {
  const task = taskOf(m, taskId);
  if (!task) return undefined;
  const eff = resolveEffectivePolicy(missionLayers(m, task), ctx);
  const p = eff.policy;
  // The chip is for limits the route chip does not already say: a task's own
  // pins are the route it runs on, so only pins from a wider scope show here.
  // The panel lists everything, task pins included.
  const wider = (field: string) => eff.from[field] !== undefined && eff.from[field] !== 'task';
  const chip: string[] = [];
  if (p.caps?.maxTier) chip.push(`≤ ${p.caps.maxTier}`);
  if (p.pins?.model && wider('pins.model')) chip.push(`${modelLabel(p.pins.model) ?? p.pins.model} (pinned)`);
  if (p.pins?.effort && wider('pins.effort')) chip.push(`${p.pins.effort} effort (pinned)`);
  else if (p.caps?.maxEffort) chip.push(`effort ≤ ${p.caps.maxEffort}`);
  if (p.caps?.maxAttempts !== undefined) chip.push(`${p.caps.maxAttempts} attempt${p.caps.maxAttempts === 1 ? '' : 's'} max`);
  if (p.caps?.location) chip.push(p.caps.location);
  const lines = describePolicy(eff).map((l) => ({ label: l.label, value: l.value, from: scopeTag(l.from) }));
  const started = task.attemptIds.length;
  const changes = m.policyChanges.map((c) => ({
    at: c.at,
    scope: c.scope,
    text: diffText(policyDiff(c.before, c.changed)) || c.fields.join(', '),
    appliesFromAttempt: c.appliesFromAttempt,
    pending: c.appliesFromAttempt > started,
  }));
  const conflicts = eff.conflicts.map((c) => c.message);
  if (lines.length === 0 && changes.length === 0 && conflicts.length === 0) return undefined;
  return { chip: chip.slice(0, 3).join(' · ') + (chip.length > 3 ? ` +${chip.length - 3}` : ''), lines, frozen: pinnedDimensions(p), changes, conflicts };
}

export function taskViewOf(m: Mission, actions: TaskViewAction[], taskId?: string, ctx?: PolicyContext): TaskView | undefined {
  const task = taskOf(m, taskId);
  if (!task) return undefined;
  const attempts = task.attemptIds
    .map((id) => m.attempts.find((a) => a.id === id))
    .filter((a): a is ExecutionAttempt => a !== undefined);
  const current = attempts.at(-1);
  const wt = current?.worktreeId ? m.worktrees.find((w) => w.id === current.worktreeId) : undefined;
  return {
    missionId: m.id,
    taskId: task.id,
    taskKey: task.key,
    ...(m.tasks.length > 1 ? { mission: { title: m.title, tasks: m.tasks.length } } : {}),
    title: task.title,
    objective: task.objective,
    acceptanceCriteria: task.acceptanceCriteria,
    state: task.state,
    stateReason: task.stateReason,
    route: routeViewOf(m, current),
    assessment: assessmentViewOf(m, task.id),
    routing: routingViewOf(m, current),
    attempt: current ? { n: current.n, of: attempts.length } : undefined,
    branch: wt?.branch,
    worktreePath: wt?.path,
    worktreeState: wt?.state,
    diff: diffOf(current),
    verification: verificationViewOf(task, current),
    attempts: attempts.map((a) => attemptViewOf(m, a, a.id === current?.id)),
    policy: policyViewOf(m, ctx, task.id),
    actions,
  };
}

/** The chips on the row of a session that is running one of this mission's attempts. */
export function taskBadgeOf(m: Mission, attempt: ExecutionAttempt): TaskBadge | undefined {
  const task = taskOf(m, attempt.taskId);
  if (!task) return undefined;
  return {
    missionId: m.id,
    taskId: task.id,
    taskKey: task.key,
    title: task.title,
    state: task.state,
    attempt: { n: attempt.n, of: task.attemptIds.length },
    route: routeViewOf(m, attempt),
    multiTask: m.tasks.length > 1 || undefined,
    verification: verificationViewOf(task, attempt),
  };
}

/**
 * Every session key an active mission has an attempt in, with the badge its
 * row should carry.
 *
 * Built over *every* attempt, not only the current one: an earlier attempt's
 * session is still in the table and is still that task's, so its row says so
 * too. When two attempts share a session id (a resume continues the same one),
 * the later attempt wins, because that is the one the task is on.
 */
export function taskBadges(missions: readonly Mission[]): Map<string, TaskBadge> {
  const out = new Map<string, TaskBadge>();
  for (const m of missions) {
    for (const task of m.tasks) {
      for (const id of task.attemptIds) {
        const a = m.attempts.find((x) => x.id === id);
        if (!a) continue;
        const badge = taskBadgeOf(m, a);
        if (!badge) continue;
        for (const sessionId of a.assignment.sessionIds) {
          const key = sessionKeyFor(a.assignment.harness, sessionId);
          if (key) out.set(key, badge);
        }
      }
    }
  }
  return out;
}
