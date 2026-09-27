/**
 * The little of the OpenAI-compatible wire that AW speaks to a local server
 * directly (#51): JSON GETs for probing, and `chat/completions` — streamed, so
 * time to first token and tokens/s can be measured on the client when the
 * server does not report them (§19.6 point 5).
 *
 * No agent loop and no protocol translation (§19.6 point 2): a request goes
 * out, one answer comes back.
 */

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface WireOptions {
  fetch?: FetchFn;
  /** Bearer key, from `safeStorage`. */
  key?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type GetResult = { ok: true; status: number; json: unknown } | { ok: false; status?: number; error: string };

/** Why a request failed, as a category a caller can act on. `connection`: the server is not there. */
export type WireFailure = 'connection' | 'timeout' | 'aborted' | 'http' | 'protocol';

export class WireError extends Error {
  constructor(
    readonly kind: WireFailure,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'WireError';
  }
}

function headers(key: string | undefined, json: boolean): Record<string, string> {
  return {
    accept: 'application/json',
    ...(json ? { 'content-type': 'application/json' } : {}),
    ...(key ? { authorization: `Bearer ${key}` } : {}),
  };
}

function withTimeout(ms: number, outer?: AbortSignal): { signal: AbortSignal; timedOut: () => boolean; done: () => void } {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, ms);
  const onAbort = () => ctl.abort();
  if (outer?.aborted) ctl.abort();
  outer?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctl.signal,
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

/** What a thrown fetch error means. Node's undici wraps ECONNREFUSED and friends in `cause`. */
export function failureOf(err: unknown, timedOut: boolean, aborted: boolean): WireError {
  if (err instanceof WireError) return err;
  if (timedOut) return new WireError('timeout', 'the server did not answer in time');
  if (aborted) return new WireError('aborted', 'the request was aborted');
  const cause = (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
  return new WireError('connection', cause ? `could not reach the server (${cause})` : 'could not reach the server');
}

export function joinUrl(base: string, route: string): string {
  return `${base.replace(/\/+$/, '')}${route.startsWith('/') ? route : `/${route}`}`;
}

/** GET a JSON document. Never throws; the error text never quotes the body. */
export async function getJson(base: string, route: string, opts: WireOptions = {}): Promise<GetResult> {
  const f = opts.fetch ?? fetch;
  const t = withTimeout(opts.timeoutMs ?? 4000, opts.signal);
  try {
    const res = await f(joinUrl(base, route), { method: 'GET', headers: headers(opts.key, false), signal: t.signal });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    try {
      return { ok: true, status: res.status, json: text === '' ? undefined : JSON.parse(text) };
    } catch {
      return { ok: true, status: res.status, json: text };
    }
  } catch (err) {
    return { ok: false, error: failureOf(err, t.timedOut(), !!opts.signal?.aborted).message };
  } finally {
    t.done();
  }
}

/** POST JSON and return the status alone: how route presence is probed without generating anything. */
export async function postStatus(base: string, route: string, body: unknown, opts: WireOptions = {}): Promise<number | undefined> {
  const f = opts.fetch ?? fetch;
  const t = withTimeout(opts.timeoutMs ?? 4000, opts.signal);
  try {
    const res = await f(joinUrl(base, route), { method: 'POST', headers: headers(opts.key, true), body: JSON.stringify(body), signal: t.signal });
    await res.text().catch(() => undefined);
    return res.status;
  } catch {
    return undefined;
  } finally {
    t.done();
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  tools?: unknown[];
  response_format?: unknown;
  [key: string]: unknown;
}

export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

export interface ChatResult {
  content: string;
  toolCalls: { name: string; arguments: string }[];
  finishReason?: string;
  usage: ChatUsage;
  /** Client-measured: request sent → first content or reasoning delta. */
  ttftMs?: number;
  durationMs: number;
  /** Output tokens per second after the first token: the server's figure when it gives one (llama.cpp `timings`), else the client's. */
  outTokPerSec?: number;
  tokPerSecFrom?: 'server' | 'client';
}

function usageOf(raw: unknown): ChatUsage {
  if (!raw || typeof raw !== 'object') return {};
  const u = raw as Record<string, unknown>;
  const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
  return {
    ...(typeof u.prompt_tokens === 'number' ? { inputTokens: u.prompt_tokens } : {}),
    ...(typeof u.completion_tokens === 'number' ? { outputTokens: u.completion_tokens } : {}),
    ...(typeof details?.cached_tokens === 'number' ? { cacheReadTokens: details.cached_tokens } : {}),
  };
}

/**
 * One streamed `chat/completions` call. Throws `WireError`: `connection` when
 * the server is not there or drops the stream part-way (the case #51 calls
 * infra), `http` for an error status, `timeout`/`aborted` when cut off.
 */
export async function streamChat(base: string, body: ChatRequest, opts: WireOptions & { now?: () => number } = {}): Promise<ChatResult> {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? (() => performance.now());
  const t = withTimeout(opts.timeoutMs ?? 120_000, opts.signal);
  const started = now();
  let ttft: number | undefined;
  let content = '';
  let finishReason: string | undefined;
  let usage: ChatUsage = {};
  let serverTps: number | undefined;
  let chunks = 0;
  const calls = new Map<number, { name: string; arguments: string }>();
  try {
    const res = await f(joinUrl(base, '/v1/chat/completions'), {
      method: 'POST',
      headers: { ...headers(opts.key, true), accept: 'text/event-stream' },
      body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
      signal: t.signal,
    });
    if (!res.ok) {
      await res.text().catch(() => undefined);
      throw new WireError('http', `the server answered HTTP ${res.status}`, res.status);
    }
    if (!res.body) throw new WireError('protocol', 'the server sent no body');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let sawDone = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          sawDone = true;
          continue;
        }
        let ev: Record<string, any>;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = ev.choices?.[0];
        const d = choice?.delta ?? choice?.message;
        if (d && (d.content || d.reasoning || d.reasoning_content || d.tool_calls)) {
          ttft ??= now() - started;
          chunks++;
        }
        if (typeof d?.content === 'string') content += d.content;
        if (Array.isArray(d?.tool_calls)) {
          for (const tc of d.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : calls.size;
            const cur = calls.get(idx) ?? { name: '', arguments: '' };
            if (typeof tc.function?.name === 'string') cur.name += tc.function.name;
            if (typeof tc.function?.arguments === 'string') cur.arguments += tc.function.arguments;
            else if (tc.function?.arguments && typeof tc.function.arguments === 'object') cur.arguments += JSON.stringify(tc.function.arguments);
            calls.set(idx, cur);
          }
        }
        if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
        if (ev.usage) usage = usageOf(ev.usage);
        const tps = ev.timings?.predicted_per_second;
        if (typeof tps === 'number' && tps > 0) serverTps = tps;
      }
    }
    // A stream that stops without a finish reason or `[DONE]` was cut off: the server went away.
    if (!sawDone && finishReason === undefined) throw new WireError('connection', 'the server closed the stream part-way');
  } catch (err) {
    throw failureOf(err, t.timedOut(), !!opts.signal?.aborted);
  } finally {
    t.done();
  }
  const durationMs = Math.max(0, now() - started);
  const out = usage.outputTokens ?? chunks;
  const decodeMs = durationMs - (ttft ?? 0);
  const clientTps = out > 0 && decodeMs > 0 ? out / (decodeMs / 1000) : undefined;
  const outTokPerSec = serverTps ?? clientTps;
  return {
    content,
    toolCalls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c),
    finishReason,
    usage,
    ...(ttft !== undefined ? { ttftMs: Math.round(ttft) } : {}),
    durationMs: Math.round(durationMs),
    ...(outTokPerSec !== undefined ? { outTokPerSec: Math.round(outTokPerSec * 10) / 10, tokPerSecFrom: serverTps !== undefined ? 'server' : 'client' } : {}),
  };
}
