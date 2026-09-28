/**
 * Turning a Claude Code session's raw `latest` message cache (`HostReplayState.latest`,
 * `shared/sessionProtocol.ts`) into a classified rate-limit stoppage (#75).
 *
 * Two sources, checked in order:
 *
 * 1. `latest['rate_limit_event']` — the SDK's own event. Undocumented by
 *    Anthropic, but it is the only signal that says which window (five-hour
 *    vs weekly) was hit, and sometimes carries a reset time. Shape observed:
 *    `{ type: 'rate_limit_event', rate_limit_info: { status, resetsAt, rateLimitType } }`.
 * 2. `latest['result']` — the turn-end message. A bare API-level 429
 *    (`is_error: true, api_error_status: 429`) with no `rate_limit_event`
 *    classifies as `unknown`: it names no window, so it must never be read as
 *    the weekly (or five-hour) limit.
 *
 * Pure: takes the cache, returns a stoppage or undefined. No filesystem, no SDK import.
 */
import { classifyClaudeRateLimit, type RateLimitStoppage } from '../shared/rateLimitClassification';
import type { LastResultError } from './transcriptTail';

interface RateLimitInfo {
  rateLimitType?: unknown;
  resetsAt?: unknown;
}

/** Read off `latest['rate_limit_event']`. `resetsAt` is seconds epoch on the wire, per the simulated harness. */
function fromRateLimitEvent(msg: unknown): RateLimitStoppage | undefined {
  if (!msg || typeof msg !== 'object') return undefined;
  const info = (msg as { rate_limit_info?: RateLimitInfo }).rate_limit_info;
  const rateLimitType = typeof info?.rateLimitType === 'string' ? info.rateLimitType : undefined;
  const resetsAtSec = typeof info?.resetsAt === 'number' ? info.resetsAt : undefined;
  return classifyClaudeRateLimit({
    kind: 'rate-limit-event',
    rateLimitType,
    resetsAtMs: resetsAtSec !== undefined ? resetsAtSec * 1000 : undefined,
    raw: msg,
  });
}

/** Read off `latest['result']`: only a genuine API 429 counts, never any other error. */
function fromResult(msg: unknown): RateLimitStoppage | undefined {
  if (!msg || typeof msg !== 'object') return undefined;
  const r = msg as { is_error?: unknown; api_error_status?: unknown };
  const isError = r.is_error === true;
  const status = typeof r.api_error_status === 'number' ? r.api_error_status : undefined;
  if (!isError || status !== 429) return undefined;
  return classifyClaudeRateLimit({ kind: 'generic-429', raw: msg });
}

/**
 * The session's current rate-limit stoppage, from its host's `latest` cache —
 * or undefined when nothing there says it is rate limited.
 *
 * `rate_limit_event` wins over a bare `result` 429: when both are present the
 * event is strictly more informative (it names the window), and a session
 * that has since recovered clears `latest['result']`'s error status on its
 * next successful turn, at which point this correctly reports nothing.
 */
export function claudeRateLimitFromLatest(latest: Record<string, unknown> | undefined): RateLimitStoppage | undefined {
  if (!latest) return undefined;
  const fromEvent = fromRateLimitEvent(latest['rate_limit_event']);
  if (fromEvent) return fromEvent;
  return fromResult(latest['result']);
}

/**
 * The 429 fallback for a session Agent Wrangler only observes (registry +
 * transcript + hooks — no session host, so no `latest` cache): the
 * transcript's own most recent `result` line, when its Claude Code build
 * writes one. Never a `rate_limit_event`: that message is only ever seen on
 * the live host event stream, not in the transcript file, so an observed
 * session can only ever produce `unknown`, exactly as a bare 429 should.
 */
export function claudeRateLimitFromTranscript(lastResultError: LastResultError | undefined): RateLimitStoppage | undefined {
  if (!lastResultError?.isError || lastResultError.apiErrorStatus !== 429) return undefined;
  return classifyClaudeRateLimit({ kind: 'generic-429', raw: lastResultError });
}
