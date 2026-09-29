/**
 * Which session runs an attempt (`docs/plans/intelligent-orchestration.md`
 * §22.1, #54): a new one, an earlier task's warm one (`reuse`), or a fork of
 * an upstream task's conversation into this attempt's worktree (`fork`).
 *
 * Separate from routing on purpose. The route (the `RoutingDecision`) says
 * what the work needs; this only picks, among sessions that already exist,
 * one that satisfies it. It never changes the route:
 *
 * - **The requirement wins.** A warm session on another harness, source or
 *   model, or on a tier outside `[minTier, maxTier]`, is never taken. Nor is
 *   one a pin rules out.
 * - **Reuse stays on its tree.** A session's working directory is fixed, so
 *   `reuse` is only for the next task in the same worktree (sequential tasks
 *   on one branch), never for a task in a parallel tree.
 * - **Fork crosses trees**, only from an upstream task, and only on a harness
 *   whose adapter can fork into a new working directory (the #54 spike).
 * - **A full session is left alone.** Above the context ceiling it is cold.
 *
 * Pure and deterministic: the same input gives the same answer.
 */
import { tierRank, type TierDef } from '../../shared/orchestration/catalog';
import type { HarnessId, Millis, ModelSourceId, TierName } from '../../shared/orchestration/types';

/** What the route asks for, from its routing requirement and target. */
export interface AssignmentRequirement {
  harness: HarnessId;
  source: ModelSourceId;
  /** Empty: the harness's own default model. */
  model: string;
  minTier: TierName;
  maxTier: TierName;
}

/** The effective pins (§10.2): a warm session must match every one set. */
export interface AssignmentPins {
  harness?: HarnessId;
  source?: ModelSourceId;
  model?: string;
}

/** The route harness's adapter capabilities that matter here. */
export interface AssignmentCapabilities {
  /** A session on record can be resumed by id (in its own working directory). */
  resume: boolean;
  /** A session can be forked into a new working directory with its context. */
  fork: boolean;
}

/** An idle session an earlier attempt left, which the next one could carry on. */
export interface WarmCandidate {
  /** The attempt that ran in it last. */
  attemptId: string;
  taskId: string;
  /** For reasons. */
  taskKey?: string;
  sessionId: string;
  harness: HarnessId;
  source: ModelSourceId;
  model: string;
  tier: TierName;
  /** The worktree its working directory is. */
  treeId: string;
  /** Live here, idle and asking nothing: it can take the next message now. Otherwise it is resumed from its record. */
  idle: boolean;
  /** Its last known context, input-side tokens. Absent: not reported. */
  contextTokens?: number;
  /** Its model's context window, when known. */
  contextWindow?: number;
  endedAt: Millis;
}

export interface AssignmentInput {
  requirement: AssignmentRequirement;
  /** The catalog's tier order, weakest first. */
  tiers: readonly TierDef[];
  pins?: AssignmentPins;
  capabilities: AssignmentCapabilities;
  /** The worktree the attempt will run in, when it is one that exists already (a planned mission's tree). Absent: a new one. */
  treeId?: string;
  /** The task's upstream task ids: a fork comes only from one of these. */
  upstream: readonly string[];
  candidates: readonly WarmCandidate[];
  /** Context above this (input-side tokens) is not carried on. Default `DEFAULT_CONTEXT_CEILING`. */
  contextCeiling?: number;
}

export type AssignmentChoice =
  | { mode: 'cold'; reason: string }
  | { mode: 'reuse' | 'fork'; sessionId: string; fromAttemptId: string; reason: string };

/** Above this much context a session is not carried on to another task (input-side tokens). */
export const DEFAULT_CONTEXT_CEILING = 120_000;
/** Nor above this share of its model's window, when the window is known. */
export const CONTEXT_WINDOW_SHARE = 0.5;

/** The ceiling that applies to one candidate. */
export function contextCeilingFor(c: Pick<WarmCandidate, 'contextWindow'>, ceiling = DEFAULT_CONTEXT_CEILING): number {
  return c.contextWindow !== undefined && c.contextWindow > 0 ? Math.min(ceiling, Math.floor(c.contextWindow * CONTEXT_WINDOW_SHARE)) : ceiling;
}

/** Whether `tier` is inside `[min, max]`. A tier the catalog does not order only matches a requirement of exactly it. */
export function tierWithin(tiers: readonly TierDef[], tier: TierName, min: TierName, max: TierName): boolean {
  const r = tierRank(tiers, tier);
  const lo = tierRank(tiers, min);
  const hi = tierRank(tiers, max);
  if (r < 0 || lo < 0 || hi < 0) return min === max && tier === min;
  return r >= lo && r <= hi;
}

type Verdict = { ok: true; mode: 'reuse' | 'fork' } | { ok: false; why: string };

function judge(input: AssignmentInput, c: WarmCandidate, taken: ReadonlySet<string>): Verdict {
  const req = input.requirement;
  const pins = input.pins ?? {};
  const name = c.taskKey ?? c.taskId;
  if (taken.has(c.sessionId.toLowerCase())) return { ok: false, why: `${name}'s session is taken by another start` };
  if (c.harness !== req.harness) return { ok: false, why: `${name}'s session runs on ${c.harness}; the route is ${req.harness}` };
  if (pins.harness !== undefined && c.harness !== pins.harness) return { ok: false, why: `${name}'s session is not on the pinned harness` };
  if (c.source !== req.source || (pins.source !== undefined && c.source !== pins.source)) return { ok: false, why: `${name}'s session runs on ${c.source}; the route is ${req.source}` };
  if (c.model !== req.model || (pins.model !== undefined && c.model !== pins.model)) {
    return { ok: false, why: `${name}'s session runs ${c.model || 'the default model'}; the route is ${req.model || 'the default model'}` };
  }
  if (!tierWithin(input.tiers, c.tier, req.minTier, req.maxTier)) {
    const range = req.minTier === req.maxTier ? req.minTier : `${req.minTier}–${req.maxTier}`;
    return { ok: false, why: `${name}'s session is ${c.tier}; the route needs ${range}` };
  }
  const ceiling = contextCeilingFor(c, input.contextCeiling);
  if (c.contextTokens !== undefined && c.contextTokens > ceiling) return { ok: false, why: `${name}'s session holds ${c.contextTokens} tokens, above the ceiling of ${ceiling}` };
  if (input.treeId !== undefined && c.treeId === input.treeId) {
    if (c.idle || input.capabilities.resume) return { ok: true, mode: 'reuse' };
    return { ok: false, why: `${name}'s session is not live and ${req.harness} cannot resume it` };
  }
  // Another tree: a session's working directory is fixed, so only a fork can cross.
  if (!input.upstream.includes(c.taskId)) return { ok: false, why: `${name}'s session is in another worktree and is not upstream of this task` };
  if (!input.capabilities.fork) return { ok: false, why: `${name}'s session is in another worktree and ${req.harness} cannot fork into a new one` };
  return { ok: true, mode: 'fork' };
}

/** Reuse before fork, then a live session before one to resume, then the newest, then the smallest; ids break a tie. */
function rank(a: { c: WarmCandidate; mode: 'reuse' | 'fork' }, b: { c: WarmCandidate; mode: 'reuse' | 'fork' }): number {
  return (
    (a.mode === b.mode ? 0 : a.mode === 'reuse' ? -1 : 1) ||
    (a.c.idle === b.c.idle ? 0 : a.c.idle ? -1 : 1) ||
    b.c.endedAt - a.c.endedAt ||
    (a.c.contextTokens ?? Infinity) - (b.c.contextTokens ?? Infinity) ||
    (a.c.attemptId < b.c.attemptId ? -1 : a.c.attemptId > b.c.attemptId ? 1 : 0)
  );
}

/**
 * The session for the next attempt: the best warm session that satisfies the
 * requirement, else a new one (`cold`), saying why. `taken`: session ids
 * (lower case) already given to another start in the same step.
 */
export function chooseAssignment(input: AssignmentInput, taken: ReadonlySet<string> = new Set()): AssignmentChoice {
  if (input.candidates.length === 0) return { mode: 'cold', reason: 'no warm session to carry on' };
  const fit: { c: WarmCandidate; mode: 'reuse' | 'fork' }[] = [];
  const refused: string[] = [];
  // Dedupe by session: the newest attempt in it speaks for it.
  const bySession = new Map<string, WarmCandidate>();
  for (const c of input.candidates) {
    const key = c.sessionId.toLowerCase();
    const had = bySession.get(key);
    if (!had || c.endedAt > had.endedAt || (c.endedAt === had.endedAt && c.attemptId > had.attemptId)) bySession.set(key, c);
  }
  for (const c of [...bySession.values()].sort((a, b) => (a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0))) {
    const v = judge(input, c, taken);
    if (v.ok) fit.push({ c, mode: v.mode });
    else refused.push(v.why);
  }
  if (fit.length === 0) return { mode: 'cold', reason: refused[0] ?? 'no warm session to carry on' };
  fit.sort(rank);
  const best = fit[0];
  const name = best.c.taskKey ?? best.c.taskId;
  const ctx = best.c.contextTokens !== undefined ? `${best.c.contextTokens} tokens of context` : 'context not reported';
  const reason =
    best.mode === 'reuse'
      ? `carries on ${name}'s session in the same worktree (${best.c.tier}, ${ctx})`
      : `forks ${name}'s conversation into this task's worktree (${best.c.tier}, ${ctx})`;
  return { mode: best.mode, sessionId: best.c.sessionId, fromAttemptId: best.c.attemptId, reason };
}
