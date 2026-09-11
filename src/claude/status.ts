import { needsReply } from '../core/needsReply';
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

/** A finished turn is `waiting` if its reply asks for something, else `done`. */
export function turnOver(replyText: string | undefined): SessionStatus {
  return needsReply(replyText) ? 'waiting' : 'done';
}

function busyOrStuck(i: StatusInput): SessionStatus {
  if (i.transcriptMtimeMs === undefined) return 'busy';
  return i.nowMs - i.transcriptMtimeMs > i.stuckThresholdMs ? 'stuck' : 'busy';
}
