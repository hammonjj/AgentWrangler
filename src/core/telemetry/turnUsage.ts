/**
 * Per-turn usage from the totals the agents report
 * (`docs/plans/intelligent-orchestration.md` §16.3). Pure.
 *
 * **Claude** reports usage on each `result` as running totals for the `Query`
 * that produced it: `modelUsage` per model and `total_cost_usd`, cumulative
 * across turns. A turn's own usage is therefore the difference from the
 * previous `result` of the same execution. The totals start again on a new
 * execution (a resume, a host version migration), reset on `/clear`, and a
 * crashed session's last `result` may carry zeroes.
 *
 * **Codex** reports `thread/tokenUsage/updated` with `last` (one turn) and
 * `total` (cumulative per thread). `total` is differenced when there is a
 * baseline, because it also covers turns nobody was connected for.
 *
 * Rules, from the plan: a field the agent did not report is absent, never 0; a
 * total that went down without a known reset is "no data" for that turn,
 * never subtracted; a turn seen for the second time (a reattach replays the
 * last `result`) records nothing.
 */
import type { ModelTurnUsage } from '../../shared/orchestration/telemetry';
import type { PriceTable } from '../../shared/orchestration/catalog';

/** Running totals: per model, plus the overall cost where the agent reports one. */
export interface UsageTotals {
  models: Record<string, ModelTurnUsage>;
  costUsd?: number;
}

/** What is remembered about one execution (Claude) or thread (Codex) between turns. */
export interface SegmentState {
  /** The totals after the last turn recorded. */
  totals?: UsageTotals;
  /** The provider's id of the last turn recorded: the replay guard. */
  lastId?: string;
  /** A `/clear` happened since: a drop in the totals is expected, not an error. */
  resetPending?: boolean;
  /** Loaded from a previous run of the app: the next turn may cover turns nobody saw. */
  fromDisk?: boolean;
  updatedAt: number;
}

export type TurnUsage =
  | { kind: 'duplicate' }
  | { kind: 'usage'; modelsUsed: Record<string, ModelTurnUsage>; costUsd?: number; coversGap: boolean; next: SegmentState }
  | { kind: 'no-data'; why: string; next: SegmentState };

const FIELDS = ['in', 'out', 'cacheRead', 'cacheWrite', 'thinking', 'costUsd'] as const;

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** The totals on a Claude `result`, or undefined when it carries none. */
export function claudeTotals(result: unknown): UsageTotals | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as { modelUsage?: unknown; total_cost_usd?: unknown };
  if (!r.modelUsage || typeof r.modelUsage !== 'object') return undefined;
  const models: Record<string, ModelTurnUsage> = {};
  for (const [model, raw] of Object.entries(r.modelUsage as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const u = raw as Record<string, unknown>;
    models[model] = prune({
      in: num(u.inputTokens),
      out: num(u.outputTokens),
      cacheRead: num(u.cacheReadInputTokens),
      cacheWrite: num(u.cacheCreationInputTokens),
      thinking: num(u.thinkingTokens),
      costUsd: num(u.costUSD),
    });
  }
  return { models, costUsd: num(r.total_cost_usd) };
}

/** A Codex `TokenUsageBreakdown` as one model's usage. `in` includes the cached part, as Codex counts it. */
export function codexBreakdown(b: unknown): ModelTurnUsage | undefined {
  if (!b || typeof b !== 'object') return undefined;
  const u = b as Record<string, unknown>;
  return prune({
    in: num(u.inputTokens),
    out: num(u.outputTokens),
    cacheRead: num(u.cachedInputTokens),
    cacheWrite: num(u.cacheWriteInputTokens),
    thinking: num(u.reasoningOutputTokens),
  });
}

function prune(u: ModelTurnUsage): ModelTurnUsage {
  const out: ModelTurnUsage = {};
  for (const f of FIELDS) if (u[f] !== undefined) out[f] = u[f];
  return out;
}

function isZero(t: UsageTotals): boolean {
  if ((t.costUsd ?? 0) !== 0) return false;
  return Object.values(t.models).every((m) => FIELDS.every((f) => (m[f] ?? 0) === 0));
}

/** True if any counter in `now` is below its value in `prev`. */
function wentDown(prev: UsageTotals, now: UsageTotals): boolean {
  if (prev.costUsd !== undefined && now.costUsd !== undefined && now.costUsd < prev.costUsd) return true;
  for (const [model, p] of Object.entries(prev.models)) {
    const n = now.models[model];
    // A model that was used and has vanished from the totals means they restarted.
    if (!n) {
      if (FIELDS.some((f) => (p[f] ?? 0) > 0)) return true;
      continue;
    }
    for (const f of FIELDS) if (p[f] !== undefined && n[f] !== undefined && n[f]! < p[f]!) return true;
  }
  return false;
}

/** `now − prev`, per model and field; models unused this turn are left out. */
function difference(prev: UsageTotals | undefined, now: UsageTotals): { models: Record<string, ModelTurnUsage>; costUsd?: number } {
  const models: Record<string, ModelTurnUsage> = {};
  for (const [model, n] of Object.entries(now.models)) {
    const p = prev?.models[model];
    const d: ModelTurnUsage = {};
    for (const f of FIELDS) {
      if (n[f] === undefined) continue;
      d[f] = round(n[f]! - (p?.[f] ?? 0));
    }
    if (FIELDS.some((f) => (d[f] ?? 0) !== 0)) models[model] = d;
  }
  const costUsd = now.costUsd === undefined ? undefined : round(now.costUsd - (prev?.costUsd ?? 0));
  return { models, costUsd };
}

/** Floating-point subtraction of dollar amounts leaves noise in the 1e-17s. */
function round(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}

/**
 * One Claude `result` against what was recorded for its execution. `state` is
 * undefined for an execution never seen before (its totals start at zero).
 */
export function claudeTurnUsage(state: SegmentState | undefined, result: unknown, now: number): TurnUsage {
  const id = (result as { uuid?: unknown } | undefined)?.uuid;
  const resultId = typeof id === 'string' ? id : undefined;
  if (resultId && state?.lastId === resultId) return { kind: 'duplicate' };
  const totals = claudeTotals(result);
  const base = { lastId: resultId ?? state?.lastId, updatedAt: now };
  if (!totals) return { kind: 'no-data', why: 'the result carried no usage', next: { ...state, ...base, fromDisk: false } };
  // A crashed session's final result: zeroes that mean nothing (a real turn
  // always spends tokens). Keep the baseline.
  if (isZero(totals)) {
    return { kind: 'no-data', why: 'zeroed totals', next: { ...state, ...base, fromDisk: false } };
  }
  const prev = state?.totals;
  const next: SegmentState = { totals, ...base, resetPending: false, fromDisk: false };
  if (prev && wentDown(prev, totals)) {
    if (!state?.resetPending) return { kind: 'no-data', why: 'totals went down without a reset', next };
    const d = difference(undefined, totals);
    return { kind: 'usage', modelsUsed: d.models, costUsd: d.costUsd, coversGap: false, next };
  }
  const d = difference(prev, totals);
  return { kind: 'usage', modelsUsed: d.models, costUsd: d.costUsd, coversGap: state?.fromDisk === true, next };
}

/**
 * One Codex `turn/completed` (with the `usageUpdate` the runner attaches)
 * against what was recorded for its thread.
 */
export function codexTurnUsage(state: SegmentState | undefined, turnEnd: unknown, now: number): TurnUsage {
  const p = (turnEnd ?? {}) as {
    turn?: { id?: unknown };
    model?: unknown;
    usageUpdate?: { turnId?: unknown; tokenUsage?: { total?: unknown; last?: unknown } };
  };
  const turnId = typeof p.turn?.id === 'string' ? p.turn.id : undefined;
  if (turnId && state?.lastId === turnId) return { kind: 'duplicate' };
  const model = typeof p.model === 'string' && p.model ? p.model : 'unknown';
  const base = { lastId: turnId ?? state?.lastId, updatedAt: now };
  const total = codexBreakdown(p.usageUpdate?.tokenUsage?.total);
  const last = codexBreakdown(p.usageUpdate?.tokenUsage?.last);
  const lastIsThisTurn = !!turnId && p.usageUpdate?.turnId === turnId && !!last;
  if (!total) return { kind: 'no-data', why: 'no token usage reported', next: { ...state, ...base, fromDisk: false } };

  // Totals are kept under one key: a thread's `total` is not split by model.
  const totals: UsageTotals = { models: { thread: total } };
  const next: SegmentState = { totals, ...base, resetPending: false, fromDisk: false };
  const prev = state?.totals;
  if (prev && !wentDown(prev, totals)) {
    const d = difference(prev, totals).models.thread ?? {};
    const gap = lastIsThisTurn && (d.in ?? 0) + (d.out ?? 0) > (last!.in ?? 0) + (last!.out ?? 0);
    return { kind: 'usage', modelsUsed: nonEmpty(model, d), coversGap: gap || state?.fromDisk === true, next };
  }
  if (lastIsThisTurn) return { kind: 'usage', modelsUsed: nonEmpty(model, last!), coversGap: false, next };
  return { kind: 'no-data', why: prev ? 'thread totals went down' : 'no baseline and no per-turn usage for this turn', next };
}

function nonEmpty(model: string, u: ModelTurnUsage): Record<string, ModelTurnUsage> {
  return FIELDS.some((f) => (u[f] ?? 0) !== 0) ? { [model]: u } : {};
}

/** Per-million-token prices for models whose harness reports no cost (§16.4). User-supplied. Declared with the catalog. */
export type { PriceTable };

/**
 * The limits a Claude `result` reports per model (`modelUsage[*].contextWindow`
 * and `maxOutputTokens`), for the capability catalog. Empty when it reports none.
 */
export function claudeModelLimits(result: unknown): Record<string, { contextWindow?: number; maxOutputTokens?: number }> {
  const out: Record<string, { contextWindow?: number; maxOutputTokens?: number }> = {};
  const usage = (result as { modelUsage?: unknown } | null)?.modelUsage;
  if (!usage || typeof usage !== 'object') return out;
  for (const [model, raw] of Object.entries(usage as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const u = raw as Record<string, unknown>;
    const contextWindow = num(u.contextWindow);
    const maxOutputTokens = num(u.maxOutputTokens);
    // A zero is "not reported", not a model that holds nothing.
    const limits = {
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    };
    if (Object.keys(limits).length > 0) out[model] = limits;
  }
  return out;
}

/**
 * An estimated cost from a price table, or undefined when a model used has no
 * price. `in` is taken to include cached input (Codex's convention), so the
 * cached part is charged at the cache rate when one is given.
 */
export function priceCost(prices: PriceTable | undefined, usage: Record<string, ModelTurnUsage>): number | undefined {
  if (!prices) return undefined;
  let usd = 0;
  for (const [model, u] of Object.entries(usage)) {
    const p = prices[model];
    if (!p) return undefined;
    const cached = u.cacheRead ?? 0;
    const fresh = Math.max(0, (u.in ?? 0) - (p.cacheReadPerMTok !== undefined ? cached : 0));
    usd += (fresh * p.inPerMTok + (u.out ?? 0) * p.outPerMTok + (p.cacheReadPerMTok !== undefined ? cached * p.cacheReadPerMTok : 0)) / 1e6;
  }
  return round(usd);
}
