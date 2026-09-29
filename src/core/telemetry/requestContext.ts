/**
 * How much context a session's model requests carried (#54): the input side
 * (input + cache read + cache write) of the first and last main-thread
 * request of a turn. The first request of a cold session is what it starts
 * from; the last of any turn is what a session carried on starts from.
 *
 * The runners add it to their turn-end payload under `REQUEST_CONTEXT_KEY`
 * (Claude's SDK `result` and Codex's `turn/completed` report whole-turn
 * totals only), and turn telemetry copies it onto the `turn` record. Pure.
 */

export interface RequestContext {
  first?: number;
  last?: number;
}

/** The key the runners add to a turn-end payload. Ours, not the SDK's or Codex's. */
export const REQUEST_CONTEXT_KEY = 'awRequestContext';

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * The input side of one Claude SDK `assistant` message's request. Undefined
 * for a subagent's message (its own context, not the session's), for one
 * without usage, and for a usage of all zeros (nothing was reported).
 */
export function claudeRequestTokens(msg: unknown): number | undefined {
  const m = msg as { type?: unknown; parent_tool_use_id?: unknown; message?: { usage?: Record<string, unknown> } } | undefined;
  if (!m || m.type !== 'assistant' || typeof m.parent_tool_use_id === 'string') return undefined;
  const u = m.message?.usage;
  if (!u || typeof u !== 'object') return undefined;
  const n = count(u.input_tokens) + count(u.cache_read_input_tokens) + count(u.cache_creation_input_tokens);
  return n > 0 ? n : undefined;
}

/**
 * The input side of the request a Codex `thread/tokenUsage/updated` reports:
 * `last.inputTokens`, which already includes the cached part.
 */
export function codexRequestTokens(tokenUsage: unknown): number | undefined {
  const last = (tokenUsage as { last?: { inputTokens?: unknown } } | undefined)?.last;
  const n = count(last?.inputTokens);
  return n > 0 ? n : undefined;
}

/** One more request in the turn. */
export function foldRequest(ctx: RequestContext, tokens: number | undefined): RequestContext {
  if (tokens === undefined) return ctx;
  return { first: ctx.first ?? tokens, last: tokens };
}

/** What a turn-end payload says, when a runner added it. */
export function requestContextOf(raw: unknown): RequestContext | undefined {
  const rc = (raw as Record<string, unknown> | undefined)?.[REQUEST_CONTEXT_KEY] as RequestContext | undefined;
  if (!rc || typeof rc !== 'object') return undefined;
  const first = count(rc.first) || undefined;
  const last = count(rc.last) || undefined;
  if (first === undefined && last === undefined) return undefined;
  return { ...(first !== undefined ? { first } : {}), ...(last !== undefined ? { last } : {}) };
}
