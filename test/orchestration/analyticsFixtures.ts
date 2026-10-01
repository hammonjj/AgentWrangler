/**
 * Synthetic telemetry for the analytics tests (#49): the records the runner
 * writes for one task — routing, attempts, escalations between them, and the
 * task's end — from a short description. Nothing here is real session data;
 * repositories are `/Users/test/...` paths.
 */
import type { AnalyticsRecord } from '../../src/shared/orchestration/analytics';
import type {
  AttemptRecord,
  EscalationRecord,
  IntegrationRecord,
  LocalCallRecord,
  OverrideRecord,
  RoutingRecord,
  TaskFinalRecord,
} from '../../src/shared/orchestration/telemetry';
import type { EffortLevel, EscalationAction, ExecutionTarget, OutcomeCategory, RouteDimension, RoutingMode } from '../../src/shared/orchestration/types';

export const TIERS = ['basic', 'standard', 'expert', 'frontier'];
export const MODEL: Record<string, string> = { basic: 'haiku', standard: 'sonnet', expert: 'opus', frontier: 'opus-max' };
export const DAY = 86_400_000;
export const T0 = Date.UTC(2026, 8, 1);

export interface AttemptSpec {
  tier: string;
  effort?: EffortLevel;
  model?: string;
  outcome?: AttemptRecord['outcome'];
  category?: OutcomeCategory;
  /** Absent: not reported (Codex). */
  costUsd?: number;
  tokens?: number;
  git?: { files: number; lines: number };
  verification?: 'passed' | 'failed';
  flags?: AttemptRecord['flags'];
  /** The escalation step that launched this attempt (not for the first). */
  escalation?: EscalationAction;
  activeMs?: number;
  queueMs?: number;
  waitedOnHumanMs?: number;
  permissionAsks?: number;
  scopeAccuracy?: number;
  local?: { apiEquivalentUsd?: number };
}

export interface TaskSpec {
  mission?: string;
  task: string;
  kind?: string;
  complexity?: string;
  verifiability?: string;
  risk?: string;
  assessorVersion?: string;
  harness?: 'claude-code' | 'codex';
  mode?: RoutingMode;
  attempts: AttemptSpec[];
  /** Default: done when the last attempt succeeded, else failed. `false`: still running. */
  final?: { outcome: TaskFinalRecord['outcome']; acceptedBy?: TaskFinalRecord['acceptedBy'] } | false;
  /** What the router recommended for the first attempt, when it differs from what ran. */
  router?: { tier: string; effort: EffortLevel; changed: RouteDimension[] };
  /** A blocked escalation step after the last attempt. */
  blockedStep?: EscalationAction;
  /** A needs-human step after the last attempt. */
  needsHuman?: boolean;
  /** Days after T0. */
  day?: number;
}

function target(tier: string, harness: string, model?: string, location: 'hosted' | 'local' = 'hosted'): ExecutionTarget {
  return { harness, source: location === 'local' ? 'local:box' : harness === 'codex' ? 'openai' : 'anthropic', model: model ?? MODEL[tier] ?? tier, tier, effortNative: 'medium', location };
}

export function taskRecords(spec: TaskSpec): AnalyticsRecord[] {
  const missionId = spec.mission ?? `m-${spec.task}`;
  const taskId = `t-${spec.task}`;
  const harness = spec.harness ?? 'claude-code';
  const mode = spec.mode ?? 'manual';
  let at = T0 + (spec.day ?? 0) * DAY;
  const out: AnalyticsRecord[] = [];
  const attempts: AttemptRecord[] = [];
  spec.attempts.forEach((a, i) => {
    const n = i + 1;
    const effort = a.effort ?? 'medium';
    const t = target(a.tier, harness, a.model, a.local ? 'local' : 'hosted');
    if (i > 0 && a.escalation) {
      const prev = attempts[i - 1];
      const esc: EscalationRecord = {
        v: 1,
        type: 'escalation',
        at: at++,
        id: `escalation:${spec.task}-${n}`,
        missionId,
        taskId,
        decisionId: `esc-${spec.task}-${n}`,
        afterAttemptId: prev.attemptId,
        afterAttemptN: prev.n,
        mode,
        category: prev.category ?? 'quality-new',
        repeats: 1,
        action: a.escalation,
        ...(a.escalation === 'raise-tier' ? { delta: { tier: a.tier } } : a.escalation === 'raise-effort' ? { delta: { effort } } : {}),
        step: i,
      };
      out.push(esc);
    }
    const routerRec = i === 0 && spec.router ? spec.router : undefined;
    const changed = routerRec?.changed ?? [];
    const routing: RoutingRecord = {
      v: 1,
      type: 'routing',
      at: at++,
      id: `routing:${spec.task}-${n}`,
      missionId,
      taskId,
      decisionId: `d-${spec.task}-${n}`,
      attemptN: n,
      mode,
      decidedBy: changed.length > 0 || mode === 'manual' ? 'user' : 'router',
      routerVersion: 'rtr-1',
      catalogVersion: 'c1',
      requirement: { minTier: routerRec?.tier ?? a.tier, maxTier: 'frontier', effort: routerRec?.effort ?? effort, gates: [] },
      ruleIds: ['tier.band'],
      verdict: 'route',
      recommended: target(routerRec?.tier ?? a.tier, harness),
      ran: t,
      ranEffort: effort,
      ...(i > 0 && a.escalation ? { escalationStep: i } : {}),
      agreement: changed.includes('tier') ? 'changed-tier' : changed.includes('effort') ? 'changed-effort' : changed.includes('model') ? 'changed-model' : mode === 'assisted' ? 'accepted' : 'matched',
      changed,
      candidates: { chosen: 1, fallback: 0, rejected: 0 },
    };
    out.push(routing);
    const outcome = a.outcome ?? 'succeeded';
    const attempt: AttemptRecord = {
      v: 1,
      type: 'attempt',
      at: at++,
      id: `attempt:${spec.task}-${n}`,
      missionId,
      taskId,
      attemptId: `a-${spec.task}-${n}`,
      n,
      mode,
      assessment: {
        dimensions: {
          kind: { value: spec.kind ?? 'feature', confidence: 'high' },
          complexity: { value: spec.complexity ?? 'involved', confidence: 'medium' },
          ...(spec.verifiability ? { verifiability: { value: spec.verifiability, confidence: 'high' } } : {}),
          ...(spec.risk ? { risk: { value: spec.risk, confidence: 'high' } } : {}),
        },
        assessorVersion: spec.assessorVersion ?? 'asm-2',
      },
      target: { ...t, effortRequested: effort },
      agreement: routing.agreement,
      ...(changed.length > 0 ? { changed } : {}),
      usage: a.tokens !== undefined ? { [t.model]: { in: a.tokens, out: 0 } } : {},
      cost: a.costUsd !== undefined ? { usd: a.costUsd, basis: 'harness-estimate' } : { basis: 'none' },
      turns: 1,
      outcome,
      ...(outcome === 'failed' ? { category: a.category ?? 'quality-new' } : a.category ? { category: a.category } : {}),
      ...(i > 0 && a.escalation ? { escalationStep: i, escalationAction: a.escalation } : {}),
      ...(a.git ? { git: { filesChanged: a.git.files, insertions: a.git.lines, deletions: 0, commits: 1 } } : {}),
      ...(a.scopeAccuracy !== undefined ? { scopeAccuracy: a.scopeAccuracy } : {}),
      ...(a.activeMs !== undefined ? { activeMs: a.activeMs } : {}),
      ...(a.queueMs !== undefined ? { queueMs: a.queueMs } : {}),
      ...(a.waitedOnHumanMs !== undefined ? { waitedOnHumanMs: a.waitedOnHumanMs } : {}),
      ...(a.permissionAsks !== undefined ? { permissionAsks: a.permissionAsks } : {}),
      verification: a.verification ? [{ strategy: 'commands', outcome: a.verification }] : [],
      flags: a.flags ?? {},
      ...(a.local ? { local: { source: 'local:box', ...a.local } } : {}),
    };
    attempts.push(attempt);
    out.push(attempt);
  });
  const last = attempts[attempts.length - 1];
  if (spec.blockedStep || spec.needsHuman) {
    out.push({
      v: 1,
      type: 'escalation',
      at: at++,
      id: `escalation:${spec.task}-end`,
      missionId,
      taskId,
      decisionId: `esc-${spec.task}-end`,
      afterAttemptId: last.attemptId,
      afterAttemptN: last.n,
      mode,
      category: last.category ?? 'quality-new',
      repeats: 1,
      action: spec.needsHuman ? 'needs-human' : spec.blockedStep!,
      ...(spec.blockedStep && !spec.needsHuman ? { blockedBy: 'cap' as const } : {}),
    });
  }
  if (spec.final !== false) {
    const outcome = spec.final?.outcome ?? (last.outcome === 'succeeded' ? 'done' : 'failed');
    const costs = attempts.map((a) => a.cost.usd);
    const final: TaskFinalRecord = {
      v: 1,
      type: 'task-final',
      at: at++,
      id: `task-final:${spec.task}`,
      missionId,
      taskId,
      missionTasks: 1,
      outcome,
      ...(spec.final?.acceptedBy ? { acceptedBy: spec.final.acceptedBy } : outcome === 'done' ? { acceptedBy: 'verification' as const } : {}),
      attempts: attempts.length,
      firstAttemptPass: attempts[0].outcome === 'succeeded' && outcome === 'done',
      cost: costs.every((c) => c !== undefined) ? { usd: costs.reduce((s, c) => s + (c ?? 0), 0), basis: 'harness-estimate' } : { basis: 'none' },
      ...(spec.attempts.every((a) => a.tokens !== undefined) ? { tokens: spec.attempts.reduce((s, a) => s + (a.tokens ?? 0), 0) } : {}),
    };
    out.push(final);
  }
  return out;
}

export function tasks(...specs: TaskSpec[]): AnalyticsRecord[] {
  return specs.flatMap(taskRecords);
}

export function conflict(task: string, event: IntegrationRecord['event'], mission = `m-${task}`): IntegrationRecord {
  return { v: 1, type: 'integration', at: T0 + 1, id: `integration:${task}-${event}`, missionId: mission, taskId: `t-${task}`, attemptId: `a-${task}-1`, event, durationMs: 10 };
}

export function override(task: string, scope: 'mission' | 'task' = 'task'): OverrideRecord {
  return {
    v: 1,
    type: 'override',
    at: T0 + 2,
    id: `override:${task}-${scope}`,
    missionId: `m-${task}`,
    ...(scope === 'task' ? { taskId: `t-${task}` } : {}),
    scope,
    by: 'user',
    via: 'editor',
    changes: [{ field: 'tier', from: 'standard', to: 'expert' }],
    missionState: 'draft',
  };
}

export function localCall(id: string, ok = true): LocalCallRecord {
  return { v: 1, type: 'local-call', at: T0 + 3, id: `local-call:${id}`, source: 'local:box', model: 'qwen', purpose: 'completion', ok, durationMs: 100, attempts: 1, local: { source: 'local:box' } };
}

/** Missions `m-<task>` in `/Users/test/<repo>`: repo `proj` unless the task name starts with `other`. */
export function repoOf(missionId: string): string | undefined {
  if (missionId.startsWith('m-gone')) return undefined;
  return missionId.startsWith('m-other') ? '/Users/test/other' : '/Users/test/proj';
}
