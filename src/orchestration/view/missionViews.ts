/**
 * Turning a `Mission` into what the Missions view draws (§18.2, §18.4; #43).
 *
 * Pure, like `taskViews.ts`: a mission in, flat records out, with the
 * actions and the clock passed in. The header's figures are **aggregates of
 * the mission's attempts** (§16.2): nothing here is stored twice, so a
 * mission's cost is always the sum of what its attempts reported, with the
 * basis the weakest of them had, and absent when none reported one.
 */
import { isOpenProposal, missionPhase, missionTaskCounts, originKeyOf, taskPhase } from '../../shared/orchestration/delegatedState';
import { summariseVerification } from '../../shared/orchestration/verification';
import { planDiffText, type MissionMetricsView, type MissionPlannerView, type MissionTaskView, type MissionView, type TaskPreviewView } from '../../shared/orchestration/missionView';
import { localModelName } from '../../shared/modelName';
import { formatUsd } from '../../shared/sessionUsage';
import type { TaskViewAction } from '../../shared/orchestration/taskView';
import type { CostBasis, ExecutionAttempt, Mission, MissionFinish, Task } from '../../shared/orchestration/types';
import { canApprove, executionOrder, planIssues, taskCap } from '../domain/plan';
import { explainRecommendation, targetLabel } from './routeExplain';
import { routeViewOf, sessionKeyFor, verificationViewOf } from './taskViews';

/** Attempt states in which a session is working for the mission. */
const WORKING = new Set(['launching', 'running', 'waiting-human', 'finishing']);
/** Attempt states that are not over yet. */
const OPEN = new Set(['created', 'launching', 'running', 'waiting-human', 'finishing', 'verifying']);

function attemptsOf(m: Mission, t: Task): ExecutionAttempt[] {
  return t.attemptIds.map((id) => m.attempts.find((a) => a.id === id)).filter((a): a is ExecutionAttempt => a !== undefined);
}

function tokensOf(a: ExecutionAttempt): number | undefined {
  const u = a.usage;
  if (!u) return undefined;
  const parts = [u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens].filter((x): x is number => x !== undefined);
  return parts.length > 0 ? parts.reduce((s, x) => s + x, 0) : undefined;
}

function sum(values: (number | undefined)[]): number | undefined {
  const known = values.filter((v): v is number => v !== undefined);
  return known.length > 0 ? Math.round(known.reduce((s, v) => s + v, 0) * 1e6) / 1e6 : undefined;
}

/** One basis for many figures: the same one if they agree, else the weaker claim. */
function combineBasis(bases: CostBasis[]): CostBasis {
  const real = bases.filter((b) => b !== 'none');
  if (real.length === 0) return 'none';
  return real.every((b) => b === real[0]) ? real[0] : 'price-table';
}

/** The mission-level aggregates (§16.2, §18.2), from its tasks and attempts. */
export function missionMetrics(m: Mission): MissionMetricsView {
  const attempts = m.attempts;
  const costed = attempts.filter((a) => a.usage?.costUsd !== undefined && a.usage.costBasis !== 'none');
  const launched = attempts.map((a) => a.launchedAt).filter((x): x is number => x !== undefined);
  const open = attempts.some((a) => OPEN.has(a.state));
  const ended = attempts.map((a) => a.endedAt).filter((x): x is number => x !== undefined);

  // Verification health: judged over every attempt whose checks finished, newest last.
  const verdicts = attempts
    .filter((a) => a.verification.length > 0 && a.verification.every((r) => r.state === 'finished'))
    .sort((x, y) => (x.endedAt ?? x.createdAt) - (y.endedAt ?? y.createdAt))
    .map((a) => {
      const task = m.tasks.find((t) => t.id === a.taskId);
      return task ? summariseVerification(task.verification, a.verification).verdict : 'unverified';
    });
  const health: MissionMetricsView['health'] =
    verdicts.length === 0 ? 'none' : verdicts.at(-1) === 'failed' ? 'bad' : verdicts.every((v) => v === 'passed') ? 'good' : 'mixed';

  const byModel = new Map<string, { label: string; count: number; local?: boolean }>();
  for (const a of attempts) {
    const r = routeViewOf(m, a);
    if (!r) continue;
    const label = r.model ?? r.harness;
    const key = `${r.location === 'local' ? 'local:' : ''}${label}`;
    const cur = byModel.get(key) ?? { label, count: 0, ...(r.location === 'local' ? { local: true } : {}) };
    cur.count++;
    byModel.set(key, cur);
  }

  // The task counts come from the shared derivation (#101, L4), so the origin
  // row, the conversation's summary and this header show the same numbers.
  const counts = missionTaskCounts(m);
  return {
    total: counts.total,
    done: counts.done,
    running: counts.running,
    waiting: counts.needsYou,
    blocked: counts.blocked,
    failed: counts.failed,
    skipped: counts.skipped,
    pending: counts.pending,
    activeAgents: attempts.filter((a) => WORKING.has(a.state)).length,
    attempts: attempts.length,
    ...(launched.length > 0 ? { startedAt: Math.min(...launched) } : {}),
    ...(!open && ended.length > 0 ? { endedAt: Math.max(...ended) } : {}),
    ...(costed.length > 0 ? { costUsd: sum(costed.map((a) => a.usage!.costUsd)) } : {}),
    costBasis: combineBasis(costed.map((a) => a.usage!.costBasis)),
    ...(sum(attempts.map(tokensOf)) !== undefined ? { tokens: sum(attempts.map(tokensOf)) } : {}),
    escalations: m.tasks.reduce((s, t) => s + t.escalations.length, 0),
    health,
    models: [...byModel.values()].sort((x, y) => y.count - x.count || x.label.localeCompare(y.label)),
  };
}

/** What plan review shows of a task's preview assessment and route (§11.2). */
function previewOf(m: Mission, t: Task): TaskPreviewView | undefined {
  const id = t.assessmentIds.at(-1);
  const a = id ? m.assessments.find((x) => x.id === id) : undefined;
  if (!a) return undefined;
  const d = a.dimensions;
  const out: TaskPreviewView = { summary: [a.kind.value, d.complexity.value, `risk ${d.risk.value}`].join(' · '), confidence: a.confidence };
  const rec = t.recommendation?.assessmentId === a.id ? t.recommendation : undefined;
  if (rec) {
    const why = explainRecommendation(rec, a.confidence);
    out.requirement = why.requirement;
    out.verdict = rec.verdict;
    out.target = rec.resolution.target && rec.verdict !== 'blocked' ? `→ ${targetLabel(rec.resolution.target)}` : undefined;
    if (rec.note) out.note = rec.note;
  }
  // Out of date: edited since. The next preview replaces it.
  if (a.taskRevision !== t.revision) out.note = [out.note, 'from before the last edit; updating'].filter(Boolean).join(' · ');
  return out;
}

export interface MissionViewContext {
  /** What can be done with a task now: the task runner's `actions(missionId, taskId)`. */
  actions: (taskId: string) => TaskViewAction[];
  /** The repository's own finish default (§13.6), when it has a policy. */
  finishDefault?: MissionFinish;
  /** A planner is running here (#44), so Plan again and Replan can be offered. */
  canPlan?: boolean;
  /**
   * The finish under way: the task runner's `finishingOf(missionId)`, which
   * also knows one asked for in this run and not yet recorded. Absent: read
   * from the mission's own write-ahead record.
   */
  finishing?: { how: MissionFinish; uncertain?: string };
}

/** The finish a mission's record says is under way, when nothing fresher is known. */
function recordedFinishing(m: Mission): MissionView['finishing'] {
  const p = m.pendingFinish;
  return p ? { how: p.how, ...(p.uncertain ? { uncertain: p.uncertain.why } : {}) } : undefined;
}

/** The planner's latest run as review shows it (#44). */
export function plannerViewOf(m: Mission): MissionPlannerView | undefined {
  const run = m.planning?.at(-1);
  if (!run) return undefined;
  const cost = sum(run.rounds.map((r) => r.costUsd));
  const verb = run.kind === 'replan' ? 'Replanned' : 'Planned';
  // The tooltip below keeps the run's raw model id; the line shows its name.
  const modelName = localModelName(run.model) ?? run.model;
  const text =
    run.state === 'running'
      ? `${run.kind === 'replan' ? 'Replanning' : 'Planning'} with ${modelName}…`
      : run.state === 'proposed'
        ? [
            `${verb} by ${modelName}${run.source ? ' (local)' : ''}`,
            `${run.proposed ?? 0} ${run.kind === 'replan' ? 'new ' : ''}task${run.proposed === 1 ? '' : 's'}`,
            `${run.rounds.length} round${run.rounds.length === 1 ? '' : 's'}`,
            ...(cost !== undefined ? [formatUsd(cost)] : []),
          ].join(' · ')
        : run.state === 'failed'
          ? `${run.kind === 'replan' ? 'Replanning' : 'Planning'} failed`
          : `${run.kind === 'replan' ? 'Replanning' : 'Planning'} cancelled`;
  const title = [
    run.source
      ? `Local planner (${run.model}): no tools; it planned from an excerpt of the repository Agent Wrangler gathered.`
      : `Read-only planner (${run.model}${run.effort ? `, ${run.effort} effort` : ''}): it can read the repository, never change it.`,
    ...(run.fellBack ? [`The local planner${run.fellBack.from ? ` (${run.fellBack.from})` : ''} was not used: ${run.fellBack.because}.`] : []),
    ...run.rounds.map((r) => `Round ${r.n}: ${r.ok ? 'accepted' : `${r.problems.length} problem${r.problems.length === 1 ? '' : 's'}`}`),
    ...(run.state === 'proposed' ? [`${run.editsInReview} edit${run.editsInReview === 1 ? '' : 's'} in review so far`] : []),
  ].join('\n');
  return {
    kind: run.kind,
    state: run.state,
    text,
    title,
    risks: run.risks ?? [],
    warnings: run.warnings ?? [],
    ...(run.diff ? { diff: planDiffText(run.diff) } : {}),
    ...(run.reason ? { reason: run.reason } : {}),
  };
}

const LIVE_ATTEMPT = new Set(['launching', 'running', 'waiting-human', 'finishing', 'verifying']);

function taskRowOf(m: Mission, t: Task, ctx: MissionViewContext): MissionTaskView {
  const attempts = attemptsOf(m, t);
  const current = attempts.at(-1);
  const wt = current?.worktreeId ? m.worktrees.find((w) => w.id === current.worktreeId) : undefined;
  const open = current ? OPEN.has(current.state) : false;
  const first = attempts[0];
  const editable = m.state === 'plan-review' && t.attemptIds.length === 0 && t.state === 'pending';
  return {
    taskId: t.id,
    key: t.key,
    title: t.title,
    state: t.state,
    ...(t.stateReason ? { stateReason: t.stateReason } : {}),
    ...(current ? { route: routeViewOf(m, current), attempt: { n: current.n, of: attempts.length } } : {}),
    ...(current && verificationViewOf(t, current) ? { verification: verificationViewOf(t, current) } : {}),
    ...(first ? { startedAt: first.launchedAt ?? first.createdAt } : {}),
    ...(current?.endedAt !== undefined && !open ? { endedAt: current.endedAt } : {}),
    ...(sum(attempts.map(tokensOf)) !== undefined ? { tokens: sum(attempts.map(tokensOf)) } : {}),
    ...(sum(attempts.map((a) => a.usage?.costUsd)) !== undefined ? { costUsd: sum(attempts.map((a) => a.usage?.costUsd)) } : {}),
    ...(t.result?.branch || wt?.branch ? { branch: t.result?.branch ?? wt?.branch } : {}),
    deps: t.dependsOn.map((d) => ({ taskId: d.taskId, key: m.tasks.find((x) => x.id === d.taskId)?.key ?? '?', kind: d.kind })),
    ...(current ? { sessionKey: sessionKeyFor(current.assignment.harness, current.assignment.sessionIds.at(-1)) } : {}),
    actions: ctx.actions(t.id),
    objective: t.objective,
    acceptanceCriteria: t.acceptanceCriteria,
    scopePaths: t.scope.paths,
    ...(t.kindHint ? { kind: t.kindHint } : {}),
    ...(t.kindDefaulted ? { kindDefaulted: true } : {}),
    ...(t.overrides?.pins ? { pins: { harness: t.overrides.pins.harness, model: t.overrides.pins.model, effort: t.overrides.pins.effort } } : {}),
    ...(t.overrides?.caps ? { caps: { maxTier: t.overrides.caps.maxTier, maxEffort: t.overrides.caps.maxEffort } } : {}),
    ...(previewOf(m, t) ? { preview: previewOf(m, t) } : {}),
    editable,
    ...taskPhase(m, t),
  };
}

/** The whole mission as the Missions view draws it. */
export function missionViewOf(m: Mission, ctx: MissionViewContext): MissionView {
  const order = executionOrder(m.tasks);
  // A plan with a cycle cannot be ordered; show it as written rather than lose tasks.
  const tasks = order.length === m.tasks.length ? order : m.tasks;
  const reviewing = m.state === 'plan-review' || m.state === 'draft';
  const inReview = m.state === 'review' || m.state === 'completed';
  const results = m.tasks
    .filter((t) => t.state === 'done')
    .map((t) => m.attempts.find((a) => a.id === t.attemptIds.at(-1))?.git)
    .filter((g): g is NonNullable<ExecutionAttempt['git']> => g !== undefined);
  const branch = m.planned ? (m.integration !== 'none' ? m.integration.branch : undefined) : m.tasks[0]?.result?.branch;
  return {
    id: m.id,
    title: m.title,
    objective: m.objective,
    state: m.state,
    ...(m.stateReason ? { stateReason: m.stateReason } : {}),
    repo: m.repoRoot.split(/[\\/]/).filter(Boolean).pop() ?? m.repoRoot,
    baseRef: m.base.ref,
    ...(branch ? { branch } : {}),
    planned: m.planned === true,
    metrics: missionMetrics(m),
    tasks: tasks.map((t) => taskRowOf(m, t, ctx)),
    issues: reviewing ? planIssues(m).map((i) => ({ level: i.level, text: i.text, ...(i.taskId ? { taskId: i.taskId } : {}) })) : [],
    cap: taskCap(m.policy),
    canApprove: m.state === 'plan-review' && m.planned === true && canApprove(m),
    ...(isOpenProposal(m) ? { canRunProposal: true } : {}),
    ...(inReview
      ? {
          review: {
            commits: results.reduce((s, g) => s + g.commits, 0),
            insertions: results.reduce((s, g) => s + g.insertions, 0),
            deletions: results.reduce((s, g) => s + g.deletions, 0),
            finishes: m.state === 'review' ? (['merge-local', 'pull-request', 'keep', 'discard'] as MissionFinish[]) : [],
            ...(ctx.finishDefault ? { recommended: ctx.finishDefault } : {}),
          },
        }
      : {}),
    ...(m.finish ? { finish: m.finish } : {}),
    ...(m.finishResult ? { finishResult: m.finishResult } : {}),
    ...(m.state === 'review' && (ctx.finishing ?? recordedFinishing(m)) ? { finishing: ctx.finishing ?? recordedFinishing(m) } : {}),
    ...(m.state === 'review' && m.finishFailure ? { finishFailure: { how: m.finishFailure.how, why: m.finishFailure.why } } : {}),
    canCancel: !['completed', 'cancelled', 'failed', 'review'].includes(m.state),
    canPause: m.planned === true && m.state === 'running',
    canResume: m.state === 'paused',
    ...(plannerViewOf(m) ? { planner: plannerViewOf(m) } : {}),
    canPlanAgain: ctx.canPlan === true && m.planned === true && (m.state === 'planning-failed' || (m.state === 'plan-review' && (m.planning?.length ?? 0) > 0)),
    canWritePlan: m.state === 'planning-failed',
    canReplan:
      ctx.canPlan === true &&
      m.planned === true &&
      m.state === 'running' &&
      !m.attempts.some((a) => LIVE_ATTEMPT.has(a.state)) &&
      m.tasks.some((t) => t.state !== 'done'),
    phase: missionPhase(m),
    ...(m.origin ? { originKey: originKeyOf(m.origin) } : {}),
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}
