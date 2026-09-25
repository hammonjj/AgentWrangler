/**
 * Per-turn telemetry for every session Agent Wrangler runs, orchestrated or
 * not (#27; `docs/plans/intelligent-orchestration.md` §16).
 *
 * It follows each `SessionHandle` through its public event stream (never the
 * runner internals), and writes one `turn` record per completed turn: models
 * used, tokens, estimated cost with its basis, requested and applied effort,
 * durations, tool calls, permission asks and time spent waiting on a human.
 *
 * Metadata only. Tool names are counted; tool inputs, prompts, replies and
 * file contents never reach a record.
 */
import type { Disposable } from '../events';
import type { ConvBlock } from '../../shared/conversation';
import type { TurnRecord } from '../../shared/orchestration/telemetry';
import { TELEMETRY_SCHEMA_VERSION } from '../../shared/orchestration/telemetry';
import { isOrchestrationOrigin } from '../../shared/orchestration/types';
import type { SessionHandle, SessionViewEvent } from '../session/sessionHandle';
import type { SessionExecutors } from '../session/sessionExecutors';
import type { SessionRegistry } from '../session/sessionRegistry';
import type { TelemetryLog } from './telemetryLog';
import { claudeTurnUsage, codexTurnUsage, priceCost, type PriceTable, type SegmentState } from './turnUsage';

export const TELEMETRY_ENABLED_KEY = 'telemetry.enabled';
/** Optional per-model prices for Codex, which reports no cost: `{model: {inPerMTok, outPerMTok, cacheReadPerMTok?}}`. */
export const TELEMETRY_PRICES_KEY = 'telemetry.prices';

export interface TurnTelemetryDeps {
  sessions: Pick<SessionExecutors, 'list' | 'onDidChange'>;
  log: TelemetryLog;
  /** Read at every turn: off means nothing is written. */
  enabled: () => boolean;
  prices?: () => PriceTable | undefined;
  /** The effort a Claude session last reported running at (its hooks). */
  appliedEffort?: (sessionId: string) => string | undefined;
  registry?: Pick<SessionRegistry, 'get' | 'noteApplied'>;
  now?: () => number;
  logLine?: (msg: string) => void;
  /** Told each record once it is written (the per-session usage index, #28). */
  onRecord?: (record: TurnRecord) => void;
}

const ASK_KINDS = new Set(['permission', 'question', 'plan']);

interface Tracker {
  sub: Disposable;
  toolCalls: Record<string, number>;
  permissionAsks: number;
  /** Ask block id → when it opened. */
  pending: Map<string, number>;
  waitedMs: number;
  /** A `/clear` since the last turn: its totals are expected to drop. */
  reset: boolean;
}

export class TurnTelemetry implements Disposable {
  private trackers = new Map<SessionHandle, Tracker>();
  private readonly now: () => number;
  /** Handles started before this: an execution with no baseline may already have spent tokens. */
  private readonly startedAt: number;
  private sub: Disposable;
  /** Baselines kept while recording is off, so switching it back on does not count the gap as one turn. */
  private unpersisted = new Map<string, SegmentState>();

  constructor(private deps: TurnTelemetryDeps) {
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
    this.sub = deps.sessions.onDidChange(() => this.sync());
    this.sync();
  }

  /** Follow every handle not yet followed; forget ended ones. */
  sync(): void {
    const live = new Set(this.deps.sessions.list());
    for (const handle of live) if (!this.trackers.has(handle)) this.follow(handle);
    for (const [handle, t] of this.trackers) {
      if (!live.has(handle)) {
        t.sub.dispose();
        this.trackers.delete(handle);
      }
    }
  }

  dispose(): void {
    this.sub.dispose();
    for (const t of this.trackers.values()) t.sub.dispose();
    this.trackers.clear();
  }

  private follow(handle: SessionHandle): void {
    const tracker: Tracker = { sub: { dispose: () => undefined }, toolCalls: {}, permissionAsks: 0, pending: new Map(), waitedMs: 0, reset: false };
    this.trackers.set(handle, tracker);
    const listener = (e: SessionViewEvent) => this.onEvent(handle, tracker, e);
    // From the start of the handle's view log, so a turn that ended before we
    // looked is not missed; a turn seen twice is recorded once.
    try {
      tracker.sub = handle.subscribe(0, listener);
    } catch {
      tracker.sub = handle.subscribe(handle.snapshot().seq, listener);
    }
  }

  private onEvent(handle: SessionHandle, t: Tracker, e: SessionViewEvent): void {
    const now = this.now();
    switch (e.type) {
      case 'append':
        for (const b of e.blocks) this.countBlock(t, b, now);
        return;
      case 'patch': {
        const since = t.pending.get(e.patch.id);
        const state = (e.patch.block as { state?: unknown }).state;
        if (since !== undefined && state !== undefined && state !== 'pending') {
          t.waitedMs += now - since;
          t.pending.delete(e.patch.id);
        }
        return;
      }
      case 'reset':
        t.reset = true;
        return;
      case 'turnEnd':
        try {
          this.onTurnEnd(handle, t, e.raw, e.segment, now);
        } catch (err) {
          this.deps.logLine?.(`telemetry: could not record a turn: ${String(err)}`);
        }
        return;
      default:
        return;
    }
  }

  private countBlock(t: Tracker, b: ConvBlock, now: number): void {
    if (b.kind === 'tool') t.toolCalls[b.name] = (t.toolCalls[b.name] ?? 0) + 1;
    if (b.kind === 'permission') t.permissionAsks++;
    if (ASK_KINDS.has(b.kind) && (b as { state?: unknown }).state === 'pending') t.pending.set(b.id, now);
  }

  private onTurnEnd(handle: SessionHandle, t: Tracker, raw: unknown, segment: string | undefined, now: number): void {
    const sessionId = handle.sessionId ?? str((raw as { session_id?: unknown })?.session_id);
    if (!sessionId) return;
    const claude = handle.provider === 'claude';
    const key = claude ? `claude:${segment ?? sessionId}` : `codex:${sessionId.toLowerCase()}`;
    const enabled = this.deps.enabled();
    const prior = this.unpersisted.get(key) ?? this.deps.log.segment(key);
    const state: SegmentState | undefined = prior && t.reset ? { ...prior, resetPending: true } : prior;
    const usage = claude ? claudeTurnUsage(state, raw, now) : codexTurnUsage(state, raw, now);
    if (usage.kind === 'duplicate') return;
    t.reset = false;

    // Time still waiting on an ask counts up to now, then continues from now.
    let waited = t.waitedMs;
    for (const [id, since] of t.pending) {
      waited += now - since;
      t.pending.set(id, now);
    }
    const toolCalls = t.toolCalls;
    const permissionAsks = t.permissionAsks;
    t.toolCalls = {};
    t.permissionAsks = 0;
    t.waitedMs = 0;

    if (!enabled) {
      this.unpersisted.set(key, usage.next);
      return;
    }
    this.unpersisted.delete(key);

    const record = claude
      ? this.claudeRecord(handle, sessionId, raw, now)
      : this.codexRecord(handle, sessionId, raw, now);
    if (usage.kind === 'usage') {
      record.modelsUsed = usage.modelsUsed;
      const noPriorBaseline = !prior && handle.startedAt < this.startedAt;
      if (usage.coversGap || noPriorBaseline) record.coversGap = true;
      if (claude) {
        if (usage.costUsd !== undefined) {
          record.costUsd = usage.costUsd;
          record.costBasis = 'harness-estimate';
        }
      } else {
        const cost = priceCost(this.deps.prices?.(), usage.modelsUsed);
        if (cost !== undefined) {
          record.costUsd = cost;
          record.costBasis = 'price-table';
        }
      }
    } else {
      record.usageUnknown = usage.why;
    }
    if (Object.keys(toolCalls).length > 0) record.toolCalls = toolCalls;
    if (permissionAsks > 0) record.permissionAsks = permissionAsks;
    if (waited > 0) record.waitedOnHumanMs = waited;
    if (isOrchestrationOrigin(handle.origin)) record.attemptId = handle.origin.attemptId;

    const written = this.deps.log.append(record);
    this.deps.log.setSegment(key, usage.next);
    if (written) this.deps.onRecord?.(record);
    if (claude && record.effort.applied) this.noteApplied(sessionId, record.effort.applied);
  }

  private claudeRecord(handle: SessionHandle, sessionId: string, raw: unknown, now: number): TurnRecord {
    const r = (raw ?? {}) as Record<string, unknown>;
    const applied = this.deps.appliedEffort?.(sessionId);
    const requested = handle.composer.effort ?? this.deps.registry?.get(sessionId)?.launch.effort;
    return prune({
      v: TELEMETRY_SCHEMA_VERSION,
      type: 'turn',
      at: now,
      id: str(r.uuid) ?? `${sessionId}:${now}`,
      sessionId,
      harness: 'claude-code',
      source: 'anthropic',
      modelsUsed: {},
      effort: prune({ requested, applied }),
      permissionMode: handle.composer.permissionMode,
      durationMs: num(r.duration_ms),
      apiMs: num(r.duration_api_ms),
      ttftMs: num(r.ttft_ms),
      numTurns: num(r.num_turns),
      terminalReason: str(r.terminal_reason) ?? (str(r.subtype) !== 'success' ? str(r.subtype) : undefined),
      isError: r.is_error === true,
      apiErrorStatus: num(r.api_error_status),
      costBasis: 'none',
    });
  }

  private codexRecord(handle: SessionHandle, sessionId: string, raw: unknown, now: number): TurnRecord {
    const p = (raw ?? {}) as { turn?: { id?: unknown; status?: unknown; error?: unknown; durationMs?: unknown } };
    const status = str(p.turn?.status);
    return prune({
      v: TELEMETRY_SCHEMA_VERSION,
      type: 'turn',
      at: now,
      id: str(p.turn?.id) ?? `${sessionId}:${now}`,
      sessionId,
      harness: 'codex',
      source: 'openai',
      modelsUsed: {},
      effort: prune({ requested: handle.composer.effort ?? this.deps.registry?.get(sessionId)?.launch.effort }),
      durationMs: num(p.turn?.durationMs),
      terminalReason: status,
      isError: status === 'failed' || !!p.turn?.error,
      costBasis: 'none',
    });
  }

  private noteApplied(sessionId: string, effort: string): void {
    const registry = this.deps.registry;
    const record = registry?.get(sessionId);
    if (!registry || !record || record.launch.applied?.effort === effort) return;
    registry.noteApplied(sessionId, { effort });
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Drop undefined fields, so an unreported value is absent rather than `null` or `0`. */
function prune<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}
