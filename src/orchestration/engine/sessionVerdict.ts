/**
 * What an attempt's session says about the attempt
 * (`docs/plans/intelligent-orchestration.md` §7.5, §23.3).
 *
 * Pure. One table, read two ways: live, each time the session changes, and at
 * core start, once #4 has adopted hosts and rejoined Codex threads. Both look
 * at the same two things, the session's registry record and its live handle,
 * because after a restart there is no event history to go on: a turn that
 * ended while the core was away sent nothing (§16.3).
 *
 * The rules that shape it, from the #25 gate:
 * - `connecting` is live, and an `unreachable` or foreign host still holds
 *   the session: neither is ever `interrupted`.
 * - `stopped` is read by its reason.
 * - Nothing here resumes anything. Interrupted attempts wait for a person,
 *   except that a mission's `autoRecover` may resume once, never after a
 *   host crash (`host lost`).
 */
import type { SessionLifecycle } from '../../core/session/sessionHandle';
import type { SessionRecordState } from '../../core/session/sessionRegistry';
import type { AttemptState, OutcomeCategory } from '../../shared/orchestration/types';

/** The part of a registry record the table reads. */
export interface RecordView {
  state: SessionRecordState;
  endedReason?: string;
}

/** The part of a live handle the table reads. */
export interface HandleView {
  lifecycle: SessionLifecycle;
  /** A question, plan or permission is waiting for an answer. */
  pendingAsk: boolean;
  /** Undefined: the harness does not report background work. */
  backgroundTasks?: number;
}

export type SessionVerdict =
  /** Still working (or its host is catching up): follow it. */
  | { kind: 'running'; unreachable?: boolean }
  /** It asked something and waits for a person. */
  | { kind: 'waiting-human' }
  /** Its work is over: turn ended, idle, nothing pending, nothing in the background. */
  | { kind: 'finished' }
  /** Something this build cannot follow holds it. A person decides; nothing is ended. */
  | { kind: 'held'; reason: string }
  | { kind: 'interrupted'; reason: string; resumable: boolean; autoResumable: boolean; unexpected?: boolean }
  /** Stopped by a person, outside the task. */
  | { kind: 'cancelled'; reason: string }
  | { kind: 'failed'; reason: string; category: OutcomeCategory }
  /** Stopped by the orchestrator itself: already accounted for. */
  | { kind: 'ignore' };

/** Reasons a Resume may follow automatically under `autoRecover`: the conversation was cut off, not crashed. */
const CLEAN_CUTS = ['app-restart', 'machine restarted', 'host stopped', 'idle'];
/** Why a record is `interrupted` after a host died with no exit record (#4's `HOST_LOST`). */
export const HOST_LOST = 'host lost';
const OPEN_ELSEWHERE = 'open-elsewhere';

export interface VerdictInput {
  /** The newest record for the attempt's session, if the registry has one. */
  record?: RecordView;
  /** Its live handle, if an executor runs it. */
  handle?: HandleView;
  /** The attempt's state before this reading. */
  attempt: AttemptState;
  /** The attempt has held a session id (so there is a conversation to resume). */
  hasSession: boolean;
  /**
   * An idle handle counts as finished only once a turn of this attempt has
   * been seen to end, or the reading is a recovery (the turn may have ended
   * while the core was away). Stops a session that is idle before its first
   * turn has started from reading as done.
   */
  turnEnded: boolean;
  /** The orchestrator ended this session itself. */
  stoppedByUs: boolean;
}

export function sessionVerdict(input: VerdictInput): SessionVerdict {
  const { record, handle } = input;
  if (!record) {
    if (handle) return fromHandle(input, handle);
    // Claude's id was chosen before launch, so no record means no host ever
    // started (a host that did is adopted and recorded at startup). A Codex
    // thread with no record has no turns: #4 dropped it as unresumable.
    if (input.attempt === 'launching') return { kind: 'interrupted', reason: 'nothing ran', resumable: false, autoResumable: false };
    return { kind: 'interrupted', reason: 'its session has no record', resumable: input.hasSession, autoResumable: false, unexpected: true };
  }
  switch (record.state) {
    case 'live':
      // Live, and nothing here runs it: a host this version cannot follow.
      if (!handle) return { kind: 'held', reason: 'held by a session host this version cannot follow' };
      return fromHandle(input, handle);
    case 'interrupted': {
      const reason = record.endedReason ?? 'interrupted';
      return { kind: 'interrupted', reason, resumable: true, autoResumable: isCleanCut(reason) };
    }
    case 'stopped': {
      if (input.stoppedByUs) return { kind: 'ignore' };
      const reason = record.endedReason;
      // Parked by the idle-orphan rule after a long absence: not a loss (#4 §7.5).
      if (reason === 'idle') return { kind: 'interrupted', reason: 'parked while idle', resumable: true, autoResumable: true };
      // Another app holds the Codex thread and #4 does not retry the writer lock:
      // a Resume would hit the same lock, so a person decides (Retry fresh, or close the other app).
      if (reason === OPEN_ELSEWHERE) return { kind: 'held', reason: 'open in another app' };
      return { kind: 'cancelled', reason: 'stopped outside the task (closed, released or quit with its agents)' };
    }
    case 'ended':
      // The agent exited on its own: rare for Claude, which stays idle.
      return { kind: 'finished' };
    case 'failed':
      return { kind: 'failed', reason: record.endedReason ?? 'agent error', category: 'infra' };
  }
}

function fromHandle(input: VerdictInput, h: HandleView): SessionVerdict {
  switch (h.lifecycle) {
    case 'unreachable':
      // The host still holds the session and #4 refuses any resume of it; the agent may yet finish.
      return { kind: 'running', unreachable: true };
    case 'connecting':
    case 'starting':
    case 'running':
    case 'ending':
      return h.pendingAsk ? { kind: 'waiting-human' } : { kind: 'running' };
    case 'idle':
      if (h.pendingAsk) return { kind: 'waiting-human' };
      if ((h.backgroundTasks ?? 0) > 0) return { kind: 'running' };
      return input.turnEnded ? { kind: 'finished' } : { kind: 'running' };
    case 'ended':
      return { kind: 'finished' };
    case 'error':
      return { kind: 'failed', reason: 'agent error', category: 'infra' };
  }
}

function isCleanCut(reason: string): boolean {
  if (reason === HOST_LOST) return false;
  return CLEAN_CUTS.some((r) => reason === r || reason.startsWith(`${r} `)) || reason.startsWith('host signalled');
}

/**
 * Why a turn's result means the attempt failed, or undefined when it did not
 * (§15.1's categories, only as far as #33 needs them). Claude: an error
 * `result`. Codex: a `turn/completed` whose turn failed.
 */
export function turnFailure(raw: unknown): { category: OutcomeCategory; signature: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.type === 'result') {
    const subtype = typeof r.subtype === 'string' ? r.subtype : '';
    if (r.is_error !== true && subtype === 'success') return undefined;
    const status = typeof r.api_error_status === 'number' ? r.api_error_status : undefined;
    const reason = typeof r.terminal_reason === 'string' ? r.terminal_reason : '';
    const text = typeof r.result === 'string' ? r.result.slice(0, 500) : '';
    if (status === 429 || /rate.?limit/i.test(reason)) return { category: 'capacity', signature: `api-${status ?? 'rate-limit'}` };
    if (subtype.startsWith('error_max_turns') || subtype.startsWith('error_max_budget')) return { category: 'budget', signature: subtype };
    if (/prompt.?too.?long|context/i.test(`${reason} ${subtype} ${text}`)) return { category: 'context', signature: 'context-overflow' };
    return { category: 'infra', signature: subtype || (status !== undefined ? `api-${status}` : 'error') };
  }
  const turn = (r as { turn?: { status?: unknown; error?: unknown } }).turn;
  if (turn && (turn.status === 'failed' || turn.error)) return { category: 'infra', signature: 'codex-turn-failed' };
  return undefined;
}

/**
 * The message ids a Claude turn answered (`result.user_message_uuid(s)`), or
 * undefined when the result names none (Codex, or an older CLI).
 */
export function turnMessageIds(raw: unknown): string[] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { user_message_uuid?: unknown; user_message_uuids?: unknown };
  const ids = new Set<string>();
  if (Array.isArray(r.user_message_uuids)) for (const u of r.user_message_uuids) if (typeof u === 'string') ids.add(u.toLowerCase());
  if (typeof r.user_message_uuid === 'string') ids.add(r.user_message_uuid.toLowerCase());
  return ids.size > 0 ? [...ids] : undefined;
}
