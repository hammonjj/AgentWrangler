/**
 * Whether a restart should bring the last runner back, and why not when it
 * shouldn't.
 *
 * Pulled out of `createApp`'s `resumeLastRunner` so the guards — running
 * elsewhere, a recently written transcript — are testable without a host, a
 * session store or the filesystem. Everything that actually touches disk or
 * the session list is still gathered by the caller; this function only
 * decides, in the same order `resumeLastRunner` always checked in.
 */

export interface ResumeRecord {
  sessionId: string;
  cwd: string;
}

export interface ShouldAutoResumeInput {
  /** `runner.autoResumeLastOnStartup`. */
  enabled: boolean;
  /** `RunnerRegistry.resumable()` — undefined when there is nothing recent enough. */
  record: ResumeRecord | undefined;
  /** Whether `record.cwd` still exists on disk. */
  cwdExists: boolean;
  /**
   * Whether the Claude Code registry already shows this session id live —
   * another window, or a terminal, picked it up first.
   */
  runningElsewhere: boolean;
  /**
   * How long ago the transcript was last written, or undefined when there is
   * no transcript yet or it could not be read. A recent write is treated as
   * proof something else is driving the session right now, even though the
   * Claude Code registry does not know about it (another Agent Wrangler
   * runner has no registry entry at all).
   */
  transcriptWrittenMsAgo: number | undefined;
  /** Below this, a transcript write is "recent" (see `RECENT_TRANSCRIPT_WRITE_MS`). */
  recentWriteThresholdMs: number;
}

export type ResumeRefusalReason =
  | 'disabled'
  | 'no-record'
  | 'cwd-missing'
  | 'running-elsewhere'
  | 'recent-transcript-write';

export type ResumeDecision =
  | { resume: true; sessionId: string; cwd: string }
  | {
      resume: false;
      reason: ResumeRefusalReason;
      sessionId?: string;
      /** Present only for `recent-transcript-write`. */
      writtenMsAgo?: number;
    };

/** Decide whether to auto-resume, and if not, exactly why not. No I/O. */
export function shouldAutoResume(input: ShouldAutoResumeInput): ResumeDecision {
  if (!input.enabled) return { resume: false, reason: 'disabled' };
  const { record } = input;
  if (!record) return { resume: false, reason: 'no-record' };
  if (!input.cwdExists) return { resume: false, reason: 'cwd-missing', sessionId: record.sessionId };
  if (input.runningElsewhere) return { resume: false, reason: 'running-elsewhere', sessionId: record.sessionId };
  if (input.transcriptWrittenMsAgo !== undefined && input.transcriptWrittenMsAgo < input.recentWriteThresholdMs) {
    return {
      resume: false,
      reason: 'recent-transcript-write',
      sessionId: record.sessionId,
      writtenMsAgo: input.transcriptWrittenMsAgo,
    };
  }
  return { resume: true, sessionId: record.sessionId, cwd: record.cwd };
}
