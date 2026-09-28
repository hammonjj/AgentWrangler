/**
 * Classified rate-limit stoppages (#75).
 *
 * Before this, every capacity stoppage collapsed into one generic "rate
 * limited" state, regardless of provider, which window it hit, or whether we
 * actually knew when it would clear. That made a Claude five-hour session
 * limit indistinguishable from its weekly limit, and a Codex context overflow
 * look the same as a Codex rate limit.
 *
 * This module is the one place that turns raw provider evidence into a
 * `RateLimitStoppage`. It is deliberately conservative: a signal that does not
 * say which window it hit, or does not carry a reset time, classifies as
 * `unknown` rather than guessing. In particular, a bare API-level 429 with no
 * `rate_limit_event` alongside it must never be assumed to be the weekly
 * limit — Claude Code's `rate_limit_event` message is the only thing that
 * actually distinguishes five-hour from weekly, and a plain 429 carries no
 * such distinction.
 *
 * Pure, no Node/DOM imports: this file is bundled into the webviews too.
 */

export type RateLimitProvider = 'claude' | 'codex';

export type RateLimitCategory =
  | 'claude-five-hour'
  | 'claude-weekly'
  | 'codex-primary'
  | 'codex-secondary'
  | 'unknown';

export interface RateLimitStoppage {
  provider: RateLimitProvider;
  category: RateLimitCategory;
  /** Human-readable, e.g. "Claude five-hour session limit", "Codex primary rate limit". */
  reason: string;
  /** Reported reset/retry time, in ms epoch — only when the source actually gave one. */
  resetAtMs?: number;
  /** Raw source evidence, verbatim, for troubleshooting. */
  raw: unknown;
}

/**
 * What Claude Code told us about a rate limit.
 *
 * `rate-limit-event`: the SDK's own `rate_limit_event` message, which is the
 * only thing that says which window (`rateLimitType`) was hit and, sometimes,
 * when it resets.
 *
 * `generic-429`: a bare API-level 429 (a `result` line's `is_error`/
 * `api_error_status`, or an SDK-level 429) with no accompanying
 * `rate_limit_event`. This carries no window information at all.
 */
export type ClaudeRateLimitSignal =
  | { kind: 'rate-limit-event'; rateLimitType?: string; resetsAtMs?: number; raw: unknown }
  | { kind: 'generic-429'; raw: unknown };

/**
 * What Codex told us about a rate limit.
 *
 * `codex-window`: an App Server `account/rateLimits/read` window (primary or
 * secondary) that is actually over its limit.
 *
 * `codex-error-code`: a turn failed with a Codex error code that names a
 * usage-limit condition, but without a specific window snapshot to attach.
 */
export type CodexRateLimitSignal =
  | { kind: 'codex-window'; windowKind: 'primary' | 'secondary'; limitId?: string; limitName?: string; resetsAtMs?: number; raw: unknown }
  | { kind: 'codex-error-code'; code?: string; raw: unknown };

/** Tolerant match for the five-hour session window, whatever casing/format the wire uses. */
function isFiveHour(rateLimitType: string): boolean {
  const norm = rateLimitType.toLowerCase().replace(/[\s_-]+/g, '-');
  return norm === 'five-hour' || norm === '5-hour' || norm === '5h';
}

/** Tolerant match for the weekly window (`weekly`, `seven_day`, `7d`, …). */
function isWeekly(rateLimitType: string): boolean {
  const norm = rateLimitType.toLowerCase().replace(/[\s_-]+/g, '-');
  return norm === 'weekly' || norm === 'seven-day' || norm === '7-day' || norm === '7d';
}

export function classifyClaudeRateLimit(signal: ClaudeRateLimitSignal): RateLimitStoppage {
  if (signal.kind === 'generic-429') {
    // Never infer a weekly (or five-hour) reset from a generic 429: a bare
    // API-level error names no window, so this is always `unknown`, with no
    // resetAtMs conjured from nowhere.
    return {
      provider: 'claude',
      category: 'unknown',
      reason: 'Unknown rate limit',
      raw: signal.raw,
    };
  }

  const type = signal.rateLimitType?.trim();
  if (type && isFiveHour(type)) {
    return {
      provider: 'claude',
      category: 'claude-five-hour',
      reason: 'Claude five-hour session limit',
      resetAtMs: signal.resetsAtMs,
      raw: signal.raw,
    };
  }
  if (type && isWeekly(type)) {
    return {
      provider: 'claude',
      category: 'claude-weekly',
      reason: 'Claude weekly limit',
      resetAtMs: signal.resetsAtMs,
      raw: signal.raw,
    };
  }
  return {
    provider: 'claude',
    category: 'unknown',
    reason: 'Unknown rate limit',
    raw: signal.raw,
  };
}

export function classifyCodexRateLimit(signal: CodexRateLimitSignal): RateLimitStoppage {
  if (signal.kind === 'codex-window') {
    const category: RateLimitCategory = signal.windowKind === 'primary' ? 'codex-primary' : 'codex-secondary';
    const fallback = signal.windowKind === 'primary' ? 'Codex primary rate limit' : 'Codex secondary rate limit';
    const reason = signal.limitName?.trim() ? signal.limitName.trim() : fallback;
    return {
      provider: 'codex',
      category,
      reason,
      resetAtMs: signal.resetsAtMs,
      raw: signal.raw,
    };
  }

  const code = signal.code?.trim();
  return {
    provider: 'codex',
    category: 'unknown',
    reason: code ? `Unknown rate limit (${code})` : 'Unknown rate limit',
    raw: signal.raw,
  };
}
