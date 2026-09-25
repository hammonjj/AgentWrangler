/**
 * Structured completion (`docs/plans/intelligent-orchestration.md` §6.1, #30):
 * one non-agentic call that returns JSON matching a schema, for the assessor,
 * the plan validator's repair step and the review verifier.
 *
 * **A completion is not a session** (amended at the #25 gate). It runs an
 * in-process, one-shot SDK `query()` with no tools, `maxTurns: 1` and
 * `outputFormat: json_schema`: no session host, no registry record, no row,
 * no transcript (`persistSession: false`), and no user or project settings
 * (`settingSources: []`, so AW's own status hooks do not fire and no
 * `CLAUDE.md` is read). AW holds no API key; the call runs on the Claude Code
 * login like every other session. A completion cut off by a restart is simply
 * asked again.
 *
 * The output is checked against the schema here as well, whatever the CLI
 * says: invalid output is retried once, with the problems named, and then
 * reported as `invalid-output`. API errors are reported at once; whether to
 * wait and ask again is the caller's decision.
 */
import * as os from 'node:os';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RouteRequirement } from '../../shared/orchestration/types';
import { validateJson, type JsonSchema } from './jsonSchema';

export interface CompletionRequest {
  schema: JsonSchema;
  /** The system prompt: what to do with the input. */
  instructions: string;
  input: string;
  /** Model to call (default: the cheapest, `haiku`). Routing (#38) fills this from `requirement` later. */
  model?: string;
  /** Native effort level; absent means the CLI's default. */
  effort?: string;
  /** What the call needs, recorded for when completions are routed like tasks (§6.1). */
  requirement?: RouteRequirement;
  /** Give up after this long (default 120 s). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CompletionUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export type CompletionResult<T> =
  | { ok: true; value: T; model: string; attempts: number; usage: CompletionUsage; durationMs: number }
  | {
      ok: false;
      /** `invalid-output`: never schema-valid, after the retry. `error`: the call failed. `timeout`/`aborted`: it was cut off. */
      reason: 'invalid-output' | 'error' | 'timeout' | 'aborted';
      message: string;
      model: string;
      attempts: number;
      usage: CompletionUsage;
      durationMs: number;
      /** HTTP status of an API error, when the CLI reported one (429: rate limited). */
      apiErrorStatus?: number;
      /** The last output that failed validation. */
      raw?: unknown;
      /** What was wrong with it. */
      problems?: string[];
    };

export interface StructuredCompletion {
  complete<T>(req: CompletionRequest): Promise<CompletionResult<T>>;
}

/** The SDK's `query`, in the one-shot form a completion uses. `sdkQuery` satisfies it. */
export type CompletionQueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export interface ClaudeCompletionDeps {
  query: CompletionQueryFn;
  /** The `claude` to run, re-read per call; undefined uses the SDK's own. */
  binary?: () => string | undefined;
  log?: (msg: string) => void;
  /** Where the call runs. Default: the temp dir, so no project's settings or memory apply. */
  cwd?: string;
}

/** The cheapest Claude model, by alias, so it follows the CLI's own mapping. */
export const DEFAULT_COMPLETION_MODEL = 'haiku';
const DEFAULT_TIMEOUT_MS = 120_000;
/** One try, then one retry. */
const MAX_ATTEMPTS = 2;

type Outcome =
  | { kind: 'output'; value: unknown; usage: CompletionUsage }
  | { kind: 'invalid'; raw: unknown; problems: string[]; usage: CompletionUsage }
  | { kind: 'error'; message: string; apiErrorStatus?: number; usage: CompletionUsage }
  | { kind: 'cut'; reason: 'timeout' | 'aborted'; usage: CompletionUsage };

function add(a: CompletionUsage, b: CompletionUsage): CompletionUsage {
  const out: CompletionUsage = {};
  for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd'] as const) {
    if (a[k] !== undefined || b[k] !== undefined) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  }
  return out;
}

/** Usage from a one-shot `result`: its `modelUsage` summed over models (one query, so totals are this call's). */
function usageOf(result: Record<string, unknown>): CompletionUsage {
  const out: CompletionUsage = {};
  const fields = [
    ['inputTokens', 'inputTokens'],
    ['outputTokens', 'outputTokens'],
    ['cacheReadTokens', 'cacheReadInputTokens'],
    ['cacheWriteTokens', 'cacheCreationInputTokens'],
  ] as const;
  const models = result.modelUsage && typeof result.modelUsage === 'object' ? Object.values(result.modelUsage) : [];
  for (const raw of models as Record<string, unknown>[]) {
    for (const [to, from] of fields) {
      if (typeof raw?.[from] === 'number') out[to] = (out[to] ?? 0) + (raw[from] as number);
    }
  }
  if (typeof result.total_cost_usd === 'number') out.costUsd = result.total_cost_usd;
  return out;
}

function parseText(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

export class ClaudeStructuredCompletion implements StructuredCompletion {
  constructor(private deps: ClaudeCompletionDeps) {}

  async complete<T>(req: CompletionRequest): Promise<CompletionResult<T>> {
    const started = Date.now();
    const model = req.model || DEFAULT_COMPLETION_MODEL;
    let usage: CompletionUsage = {};
    let last: Extract<Outcome, { kind: 'invalid' }> | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const input = last
        ? `${req.input}\n\nYour previous answer did not match the required JSON schema:\n${last.problems.slice(0, 20).map((p) => `- ${p}`).join('\n')}\nAnswer again with JSON that matches the schema exactly.`
        : req.input;
      const outcome = await this.once(req, model, input);
      usage = add(usage, outcome.usage);
      const base = { model, attempts: attempt, usage, durationMs: Date.now() - started };
      if (outcome.kind === 'output') return { ok: true, value: outcome.value as T, ...base };
      if (outcome.kind === 'error') return { ok: false, reason: 'error', message: outcome.message, apiErrorStatus: outcome.apiErrorStatus, ...base };
      if (outcome.kind === 'cut') return { ok: false, reason: outcome.reason, message: `the completion was ${outcome.reason === 'timeout' ? 'timed out' : 'aborted'}`, ...base };
      last = outcome;
      this.deps.log?.(`completion: output did not match the schema (attempt ${attempt}): ${outcome.problems.slice(0, 3).join('; ')}`);
    }
    return {
      ok: false,
      reason: 'invalid-output',
      message: 'the output did not match the schema, twice',
      model,
      attempts: MAX_ATTEMPTS,
      usage,
      durationMs: Date.now() - started,
      raw: last?.raw,
      problems: last?.problems,
    };
  }

  private async once(req: CompletionRequest, model: string, input: string): Promise<Outcome> {
    const abort = new AbortController();
    let why: 'timeout' | 'aborted' | undefined;
    const timer = setTimeout(() => {
      why = 'timeout';
      abort.abort();
    }, req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = () => {
      why ??= 'aborted';
      abort.abort();
    };
    if (req.signal?.aborted) onAbort();
    req.signal?.addEventListener('abort', onAbort, { once: true });
    const binary = this.deps.binary?.();
    const options: Options = {
      cwd: this.deps.cwd ?? os.tmpdir(),
      model,
      ...(req.effort ? { effort: req.effort as Options['effort'] } : {}),
      systemPrompt: req.instructions,
      tools: [],
      maxTurns: 1,
      outputFormat: { type: 'json_schema', schema: req.schema as Record<string, unknown> },
      persistSession: false,
      settingSources: [],
      abortController: abort,
      ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
    };
    let q: Query | undefined;
    // An abort that fires while the stream is waiting may never wake it: race it.
    const cut = new Promise<'cut'>((r) => abort.signal.addEventListener('abort', () => r('cut'), { once: true }));
    try {
      q = this.deps.query({ prompt: input, options });
      const read = (async (): Promise<Outcome> => {
        for await (const msg of q!) {
          const m = msg as Record<string, unknown>;
          if (m.type !== 'result') continue;
          return this.judge(req.schema, m);
        }
        return { kind: 'error', message: 'the agent ended without a result', usage: {} };
      })();
      const first = await Promise.race([read, cut]);
      if (first === 'cut') {
        void read.catch(() => undefined);
        return { kind: 'cut', reason: why ?? 'aborted', usage: {} };
      }
      return first;
    } catch (err) {
      if (why) return { kind: 'cut', reason: why, usage: {} };
      return { kind: 'error', message: err instanceof Error ? err.message : String(err), usage: {} };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      // Ends the `claude` child if it has not exited on its own: nothing is left behind.
      try {
        q?.close();
      } catch {
        // Already closed.
      }
    }
  }

  private judge(schema: JsonSchema, m: Record<string, unknown>): Outcome {
    const usage = usageOf(m);
    if (m.subtype === 'error_max_structured_output_retries') {
      return { kind: 'invalid', raw: undefined, problems: ['the CLI could not produce schema-valid output'], usage };
    }
    if (m.subtype !== 'success' || m.is_error === true) {
      const errors = Array.isArray(m.errors) ? m.errors.filter((e): e is string => typeof e === 'string') : [];
      const message = (typeof m.result === 'string' && m.result) || errors.join('; ') || String(m.subtype);
      return { kind: 'error', message, apiErrorStatus: typeof m.api_error_status === 'number' ? m.api_error_status : undefined, usage };
    }
    const value = m.structured_output !== undefined ? m.structured_output : parseText(m.result);
    if (value === undefined) return { kind: 'invalid', raw: m.result, problems: ['$: no JSON in the output'], usage };
    const problems = validateJson(schema, value);
    return problems.length === 0 ? { kind: 'output', value, usage } : { kind: 'invalid', raw: value, problems, usage };
  }
}
