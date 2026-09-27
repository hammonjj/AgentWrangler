/**
 * Structured completions served directly by a local endpoint
 * (`docs/plans/intelligent-orchestration.md` §19.1 path 2, §19.6 slice A; #51):
 * one OpenAI-compatible `chat/completions` call, no tools, no files, no agent
 * loop.
 *
 * Constrained decoding (`response_format: json_schema`) is used only where the
 * probe found it; everywhere else the schema goes into the instructions and
 * the answer is validated, with one retry that names the problems — the path
 * that measured 20/20 on `mlx_lm.server`, which ignores `response_format`.
 *
 * The call waits for a server slot first (slots are concurrency, §19.2), and
 * measures what §19.4 asks for: tokens, time to first token, tokens/s (the
 * server's own figure when it reports one), runtime and queue delay. A server
 * that goes away mid-call is reported as `infra`, never as bad output.
 *
 * `RoutedCompletion` puts it in front of the hosted completion: a request goes
 * to the local model when one is assigned the tier completions route to, and
 * falls back to the hosted one when the local call fails for any reason but
 * being aborted.
 */
import type { StructuredOutputLevel } from '../../shared/orchestration/localEndpoints';
import type { LocalRunMetrics } from '../../shared/orchestration/telemetry';
import type { ModelSourceId } from '../../shared/orchestration/types';
import { parseJsonReply } from '../local/probe';
import { streamChat, WireError, type FetchFn } from '../local/openaiWire';
import { validateJson } from './jsonSchema';
import type { CompletionRequest, CompletionResult, CompletionUsage, StructuredCompletion } from './structuredCompletion';

/** One local model a completion can be served by. */
export interface LocalCompletionTarget {
  source: ModelSourceId;
  baseUrl: string;
  model: string;
  /** From the catalog: `schema` sends `response_format`; anything else asks by instruction. */
  structuredOutput?: StructuredOutputLevel;
  contextWindow?: number;
  runtime?: string;
  device?: string;
  external?: boolean;
  /** The endpoint's key, read from `safeStorage` per call. */
  key?: () => Promise<string | undefined>;
}

/** A held server slot. */
export interface SlotLease {
  queuedMs: number;
  release(): void;
}

export interface LocalCompletionDeps {
  fetch?: FetchFn;
  /** Wait for a free slot on the source. Absent: no gate. */
  acquire?: (source: ModelSourceId, signal?: AbortSignal) => Promise<SlotLease>;
  /** Told when the server went away mid-call, so health is checked now rather than at the next tick. */
  onConnectionLost?: (source: ModelSourceId) => void;
  log?: (msg: string) => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 2;

function instructionsWithSchema(req: CompletionRequest, constrained: boolean): string {
  const shape = JSON.stringify(req.schema);
  return constrained
    ? `${req.instructions}\n\nAnswer with JSON matching this schema: ${shape}`
    : `${req.instructions}\n\nReply with ONE JSON object and nothing else — no prose, no code fence. It must match this JSON schema exactly: ${shape}`;
}

function addUsage(a: CompletionUsage, b: CompletionUsage): CompletionUsage {
  const out: CompletionUsage = { ...a };
  for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens'] as const) {
    if (b[k] !== undefined) out[k] = (out[k] ?? 0) + b[k]!;
  }
  return out;
}

export class LocalStructuredCompletion implements StructuredCompletion {
  constructor(
    private target: LocalCompletionTarget,
    private deps: LocalCompletionDeps = {},
  ) {}

  get source(): ModelSourceId {
    return this.target.source;
  }

  async complete<T>(req: CompletionRequest): Promise<CompletionResult<T>> {
    const started = Date.now();
    const t = this.target;
    const model = t.model;
    const base = { model, usage: {} as CompletionUsage };
    if (req.workspace) {
      return { ok: false, reason: 'error', message: 'a local completion has no tools, so it cannot read a workspace', attempts: 0, durationMs: 0, ...base };
    }
    let lease: SlotLease | undefined;
    try {
      lease = this.deps.acquire ? await this.deps.acquire(t.source, req.signal) : undefined;
    } catch {
      return { ok: false, reason: 'aborted', message: 'aborted while waiting for a server slot', attempts: 0, durationMs: Date.now() - started, ...base };
    }
    const metrics: LocalRunMetrics = {
      source: t.source,
      ...(t.runtime ? { runtime: t.runtime } : {}),
      ...(t.device ? { device: t.device } : {}),
      ...(t.contextWindow ? { contextWindow: t.contextWindow } : {}),
      ...(lease ? { queueMs: lease.queuedMs } : {}),
      ...(t.external ? { external: true } : {}),
    };
    const constrained = t.structuredOutput === 'schema';
    let usage: CompletionUsage = {};
    let problems: string[] | undefined;
    let raw: unknown;
    try {
      const key = await t.key?.();
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const input = problems
          ? `${req.input}\n\nYour previous answer did not match the required JSON schema:\n${problems.slice(0, 20).map((p) => `- ${p}`).join('\n')}\nAnswer again with JSON that matches the schema exactly.`
          : req.input;
        let r;
        try {
          r = await streamChat(
            t.baseUrl,
            {
              model,
              temperature: 0,
              messages: [
                { role: 'system', content: instructionsWithSchema(req, constrained) },
                { role: 'user', content: input },
              ],
              ...(constrained ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: req.schema, strict: true } } } : {}),
            },
            { fetch: this.deps.fetch, key, timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal: req.signal },
          );
        } catch (err) {
          const e = err instanceof WireError ? err : new WireError('connection', String(err));
          const durationMs = Date.now() - started;
          if (e.kind === 'timeout' || e.kind === 'aborted') {
            return { ok: false, reason: e.kind, message: `the completion was ${e.kind === 'timeout' ? 'timed out' : 'aborted'}`, model, attempts: attempt, usage, durationMs, local: metrics };
          }
          const infra = e.kind === 'connection';
          if (infra) this.deps.onConnectionLost?.(t.source);
          return {
            ok: false,
            reason: 'error',
            message: e.message,
            model,
            attempts: attempt,
            usage,
            durationMs,
            local: metrics,
            ...(infra ? { infra: true } : {}),
            ...(e.status !== undefined ? { apiErrorStatus: e.status } : {}),
          };
        }
        usage = addUsage(usage, r.usage);
        // The first call's timing is the one worth keeping: a retry's prompt is longer by design.
        if (metrics.ttftMs === undefined && r.ttftMs !== undefined) metrics.ttftMs = r.ttftMs;
        if (metrics.outTokPerSec === undefined && r.outTokPerSec !== undefined) {
          metrics.outTokPerSec = r.outTokPerSec;
          metrics.tokPerSecFrom = r.tokPerSecFrom;
        }
        const value = parseJsonReply(r.content);
        if (value === undefined) {
          raw = r.content.slice(0, 200);
          problems = ['$: no JSON in the output'];
        } else {
          const found = validateJson(req.schema, value);
          if (found.length === 0) {
            return { ok: true, value: value as T, model, attempts: attempt, usage, durationMs: Date.now() - started, local: metrics };
          }
          raw = value;
          problems = found;
        }
        this.deps.log?.(`local completion: output did not match the schema (attempt ${attempt}): ${problems.slice(0, 3).join('; ')}`);
      }
      return {
        ok: false,
        reason: 'invalid-output',
        message: 'the output did not match the schema, twice',
        model,
        attempts: MAX_ATTEMPTS,
        usage,
        durationMs: Date.now() - started,
        raw,
        problems,
        local: metrics,
      };
    } finally {
      lease?.release();
    }
  }
}

/** Something that can pick the local completion to use now, or none. */
export type LocalCompletionPicker = () => StructuredCompletion | undefined;

/**
 * Local first, hosted behind it (§19.6 slice A). Workspace requests (the
 * review verifier reads files) always go to the hosted completion: a local
 * one has no tools.
 */
export class RoutedCompletion implements StructuredCompletion {
  constructor(
    private hosted: StructuredCompletion | undefined,
    private pickLocal: LocalCompletionPicker,
    private deps: { log?: (msg: string) => void; onLocal?: (result: CompletionResult<unknown>, fellBack: boolean) => void } = {},
  ) {}

  async complete<T>(req: CompletionRequest): Promise<CompletionResult<T>> {
    const local = req.workspace ? undefined : this.pickLocal();
    if (local) {
      const r = await local.complete<T>(req);
      const fallBack = !r.ok && r.reason !== 'aborted' && this.hosted !== undefined;
      this.deps.onLocal?.(r as CompletionResult<unknown>, fallBack);
      if (!fallBack) return r;
      this.deps.log?.(`local completion failed (${r.ok ? '' : r.reason}${r.infra ? ', server lost' : ''}); asking the hosted model instead`);
      const h = await this.hosted!.complete<T>(req);
      return { ...h, fellBackFrom: r.model };
    }
    if (!this.hosted) {
      return { ok: false, reason: 'error', message: 'no completion is available', model: '', attempts: 0, usage: {}, durationMs: 0 };
    }
    return this.hosted.complete<T>(req);
  }
}
