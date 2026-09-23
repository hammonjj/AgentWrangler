import { finishedTurnStatus } from '../core/needsReply';
import type { SessionStatus } from '../shared/model';
import type { LastMeaningful } from './transcriptTail';

export interface StatusInput {
  pidAlive: boolean;
  lastMeaningful?: LastMeaningful;
  /** Transcript mtime; undefined = no transcript file (brand-new session). */
  transcriptMtimeMs?: number;
  /** Text of the last assistant message seen in the tail; decides waiting vs done. */
  lastAssistantText?: string;
  nowMs: number;
  stuckThresholdMs: number;
}

/**
 * Decision table (see plan):
 *  1. pid dead → ended (whatever the transcript tail looks like)
 *  2. pid alive, no transcript → waiting (brand-new session idle at its first prompt;
 *     the provider hides these until something happens in them)
 *  3. pid alive, assistant with a final stop_reason (end_turn/stop_sequence/max_tokens/…)
 *     → done when its text is a report, waiting when it asks for something (or is unknown)
 *  4. pid alive, assistant mid-work (stop_reason tool_use or null) → busy, or stuck when stale
 *  5. pid alive, user/queue-operation last → busy, or stuck when stale
 *  6. pid alive, transcript unparseable in window → busy, or stuck when stale
 */
export function deriveStatus(i: StatusInput): SessionStatus {
  if (!i.pidAlive) return 'ended';

  const lm = i.lastMeaningful;
  if (lm?.kind === 'assistant') {
    const sr = lm.stopReason;
    if (sr !== null && sr !== undefined && sr !== 'tool_use') return turnOver(i.lastAssistantText);
    return busyOrStuck(i);
  }
  if (lm) return busyOrStuck(i); // user | queue-operation

  if (i.transcriptMtimeMs === undefined) return 'waiting';
  return busyOrStuck(i);
}

/** What `blockClearedByClaude` needs off the session's pid file. */
export interface LiveStatusInput {
  liveStatus?: string;
  statusUpdatedAtMs?: number;
}

/**
 * True when Claude Code's pid file says a permission prompt we still think is
 * open has already been answered.
 *
 * Hooks cannot tell us this. The event order for a tool that needs permission
 * is `PreToolUse` → `PermissionRequest` → *the human answers* → `PostToolUse`,
 * and there is no hook in between — Claude Code 2.1.270 has no
 * `PermissionGranted` event (only `PermissionDenied`, for the other answer).
 * `PostToolUse` fires when the tool has *finished*, so allowing a ten-minute
 * test run in the Claude Code window leaves the row blocked on a prompt for the
 * whole ten minutes, which is exactly backwards: the moment it is allowed is
 * the moment it stops needing the human.
 *
 * The pid file closes the gap. Claude Code rewrites `status` there on every
 * state change, so it flips to `busy` as the tool starts running, and the
 * registry watcher already sees that write.
 *
 * The timestamp guard is what makes this safe against the opposite mistake —
 * cancelling a block that has only just opened. `blockedSinceMs` is *our*
 * receipt time for the `PermissionRequest` line, which is already later than
 * the moment Claude Code decided to prompt (the hook has to run and we debounce
 * the read), so a `busy` written before the prompt existed always compares
 * older and is ignored. Only a status change stamped after the block began can
 * end it.
 */
export function blockClearedByClaude(blockedSinceMs: number | undefined, live: LiveStatusInput): boolean {
  if (blockedSinceMs === undefined) return false;
  if (live.liveStatus === undefined || live.statusUpdatedAtMs === undefined) return false;
  // `waiting` is Claude Code agreeing with us; anything else is it disagreeing.
  if (live.liveStatus === 'waiting') return false;
  return live.statusUpdatedAtMs > blockedSinceMs;
}

/** A finished turn is `waiting` if its reply asks for something, else `done`. */
export function turnOver(replyText: string | undefined): SessionStatus {
  return finishedTurnStatus(replyText);
}

function busyOrStuck(i: StatusInput): SessionStatus {
  if (i.transcriptMtimeMs === undefined) return 'busy';
  return i.nowMs - i.transcriptMtimeMs > i.stuckThresholdMs ? 'stuck' : 'busy';
}
