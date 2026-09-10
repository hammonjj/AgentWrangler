import type { AgentSession } from '../shared/model';
import type { Disposable } from './events';

export interface TranscriptAppendEvent {
  sessionId: string;
  path: string;
}

/**
 * A source of agent sessions (Claude Code today; Codex later would read
 * ~/.codex/state_5.sqlite `threads` and implement this same interface).
 */
export interface AgentProvider extends Disposable {
  readonly id: string;
  readonly displayName: string;
  /** "My session set (or some status) may have changed — call scan()." */
  onDidChange(listener: () => void): Disposable;
  /** Full current truth. Cheap after warm-up (summaries are cached). */
  scan(): Promise<AgentSession[]>;
  /** Begin watchers + reconcile timer. Idempotent. */
  start(): Promise<void>;
  /** Force a full re-read (registry + all transcripts). */
  refresh(): Promise<void>;
  /** Fires when a session's transcript file grows (used by the live viewer). */
  onTranscriptAppended?(listener: (e: TranscriptAppendEvent) => void): Disposable;
}
