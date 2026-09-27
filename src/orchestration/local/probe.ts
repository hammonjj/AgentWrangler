/**
 * Probing a local endpoint (`docs/plans/intelligent-orchestration.md` §19.2,
 * §19.6; #51): what runtime it is, which models it lists, what each can do as
 * far as the server says, how many slots it has, and — the gate for agentic
 * work — whether it serves a harness's wire protocol natively.
 *
 * Read-only and cheap: GETs, plus two POSTs of an empty body that can only be
 * answered "no such route" or "bad request". Nothing is generated. The
 * qualification probe below is the part that does generate, and it runs only
 * when the user asks for it.
 */
import { validateJson, type JsonSchema } from '../completion/jsonSchema';
import { UNKNOWN, known, type Known } from '../../shared/orchestration/catalog';
import type { LocalEndpointConfig, LocalRuntime, StructuredOutputLevel, ToolCallingLevel } from '../../shared/orchestration/localEndpoints';
import type { EndpointProbe, ProbedModel, Qualification } from '../../shared/orchestration/localModels';
import { getJson, joinUrl, postStatus, streamChat, type ChatMessage, type WireOptions } from './openaiWire';

export interface ProbeOptions extends WireOptions {
  now?: () => number;
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function positive(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

function openaiModelIds(json: unknown): { id: string; raw: Json }[] {
  return arr(obj(json)?.data)
    .map((m) => obj(m))
    .filter((m): m is Json => !!m && typeof m.id === 'string' && m.id !== '')
    .map((m) => ({ id: m.id as string, raw: m }));
}

/** Present when the server answers anything but "no such route". Unknown when it did not answer. */
async function routePresent(base: string, route: string, opts: WireOptions): Promise<Known<boolean>> {
  const status = await postStatus(base, route, {}, opts);
  if (status === undefined) return UNKNOWN;
  return known(status !== 404 && status !== 405 && status !== 501, 'probed');
}

async function detectRuntime(base: string, opts: WireOptions): Promise<{ runtime: LocalRuntime; evidence: Record<string, unknown> } | { error: string }> {
  const tags = await getJson(base, '/api/tags', opts);
  if (tags.ok && Array.isArray(obj(tags.json)?.models)) return { runtime: 'ollama', evidence: { tags: tags.json } };
  const lms = await getJson(base, '/api/v0/models', opts);
  if (lms.ok && arr(obj(lms.json)?.data).some((m) => obj(m) && ('type' in obj(m)! || 'state' in obj(m)!))) {
    return { runtime: 'lmstudio', evidence: { lms: lms.json } };
  }
  const props = await getJson(base, '/props', opts);
  const p = props.ok ? obj(props.json) : undefined;
  if (p && ('total_slots' in p || 'default_generation_settings' in p)) return { runtime: 'llama.cpp', evidence: { props: p } };
  const models = await getJson(base, '/v1/models', opts);
  if (!models.ok) {
    // Nothing answered at all: the first error says why (refused, timed out, HTTP 401).
    return { error: tags.ok ? models.error : tags.error };
  }
  const ids = openaiModelIds(models.json);
  if (ids.some((m) => m.raw.owned_by === 'vllm')) return { runtime: 'vllm', evidence: { models: models.json } };
  const health = await getJson(base, '/health', opts);
  if (health.ok && obj(health.json)?.status === 'ok') return { runtime: 'mlx', evidence: { models: models.json } };
  return { runtime: 'openai-compatible', evidence: { models: models.json } };
}

const SCHEMA_RUNTIMES: readonly LocalRuntime[] = ['ollama', 'llama.cpp', 'vllm', 'lmstudio'];
const HEALTH_PATH: Record<LocalRuntime, string> = {
  ollama: '/api/tags',
  'llama.cpp': '/health',
  vllm: '/v1/models',
  lmstudio: '/api/v0/models',
  mlx: '/health',
  'openai-compatible': '/v1/models',
};

async function ollamaModels(base: string, tags: unknown, opts: WireOptions): Promise<ProbedModel[]> {
  const names = arr(obj(tags)?.models)
    .map((m) => obj(m)?.name ?? obj(m)?.model)
    .filter((n): n is string => typeof n === 'string' && n !== '');
  const out: ProbedModel[] = [];
  for (const name of names) {
    const show = await postJson(base, '/api/show', { model: name }, opts);
    const info = obj(obj(show)?.model_info) ?? {};
    const ctxKey = Object.keys(info).find((k) => k.endsWith('.context_length'));
    const ctx = ctxKey ? positive(info[ctxKey]) : undefined;
    const caps = arr(obj(show)?.capabilities).filter((c): c is string => typeof c === 'string');
    out.push({
      id: name,
      contextWindow: ctx ? known(ctx, 'probed') : UNKNOWN,
      vision: show ? known(caps.includes('vision'), 'probed') : UNKNOWN,
      ...(show ? { toolTemplate: caps.includes('tools') } : {}),
    });
  }
  return out;
}

async function postJson(base: string, route: string, body: unknown, opts: WireOptions): Promise<unknown> {
  const f = opts.fetch ?? fetch;
  try {
    const res = await f(joinUrl(base, route), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 4000),
    });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

/** Probe one endpoint. Never throws: an unreachable server is a probe that says so. */
export async function probeEndpoint(cfg: LocalEndpointConfig, opts: ProbeOptions = {}): Promise<EndpointProbe> {
  const at = (opts.now ?? Date.now)();
  const base = cfg.url;
  const unreachable = (error: string): EndpointProbe => ({
    at,
    reachable: false,
    error,
    runtime: cfg.runtime ? known(cfg.runtime, 'declared') : UNKNOWN,
    models: [],
    slots: UNKNOWN,
    routes: { responses: UNKNOWN, messages: UNKNOWN },
    structuredOutput: UNKNOWN,
    healthPath: HEALTH_PATH[cfg.runtime ?? 'openai-compatible'],
  });

  let runtime: LocalRuntime;
  let runtimeFact: Known<LocalRuntime>;
  let evidence: Record<string, unknown> = {};
  if (cfg.runtime) {
    runtime = cfg.runtime;
    runtimeFact = known(runtime, 'declared');
  } else {
    const found = await detectRuntime(base, opts);
    if ('error' in found) return unreachable(found.error);
    runtime = found.runtime;
    runtimeFact = known(runtime, 'probed');
    evidence = found.evidence;
  }

  let models: ProbedModel[] = [];
  let slots: Known<number> = UNKNOWN;
  /** A listing the detection already read, or read now (a declared runtime skips detection). */
  const listing = async (have: unknown, route: string): Promise<unknown> => {
    if (have !== undefined) return have;
    const r = await getJson(base, route, opts);
    return r.ok ? r.json : undefined;
  };
  if (runtime === 'ollama') {
    const json = await listing(evidence.tags, '/api/tags');
    if (json === undefined) return unreachable('the server did not list its models');
    models = await ollamaModels(base, json, opts);
  } else if (runtime === 'lmstudio') {
    const json = await listing(evidence.lms, '/api/v0/models');
    if (json === undefined) return unreachable('the server did not list its models');
    models = arr(obj(json)?.data)
      .map((m) => obj(m))
      .filter((m): m is Json => !!m && typeof m.id === 'string' && m.type !== 'embeddings')
      .map((m) => {
        const ctx = positive(m.max_context_length);
        return { id: m.id as string, contextWindow: ctx ? known(ctx, 'probed') : UNKNOWN, vision: typeof m.type === 'string' ? known(m.type === 'vlm', 'probed') : UNKNOWN };
      });
  } else {
    const listing = await getJson(base, '/v1/models', opts);
    if (!listing.ok) return unreachable(listing.error);
    const ids = openaiModelIds(listing.json);
    let ctx: number | undefined;
    let vision: Known<boolean> = UNKNOWN;
    if (runtime === 'llama.cpp') {
      const props = obj(evidence.props) ?? (await getJson(base, '/props', opts).then((r) => (r.ok ? obj(r.json) : undefined)));
      ctx = positive(obj(props?.default_generation_settings)?.n_ctx) ?? positive(props?.n_ctx);
      const total = positive(props?.total_slots);
      if (total) slots = known(total, 'probed');
      const modalities = obj(props?.modalities);
      if (modalities && typeof modalities.vision === 'boolean') vision = known(modalities.vision, 'probed');
    }
    models = ids.map(({ id, raw }) => {
      const perModel = runtime === 'vllm' ? positive(raw.max_model_len) : undefined;
      const window = perModel ?? ctx;
      return { id, contextWindow: window ? known(window, 'probed') : UNKNOWN, vision };
    });
  }

  const [responses, messages] = await Promise.all([routePresent(base, '/v1/responses', opts), routePresent(base, '/v1/messages', opts)]);
  const structuredOutput: Known<StructuredOutputLevel> = SCHEMA_RUNTIMES.includes(runtime)
    ? known('schema', 'probed')
    : runtime === 'mlx'
      ? // `mlx_lm.server` ignores `response_format` (§19.6, measured): JSON by instruction only.
        known('none', 'probed')
      : UNKNOWN;
  return { at, reachable: true, runtime: runtimeFact, models, slots, routes: { responses, messages }, structuredOutput, healthPath: HEALTH_PATH[runtime] };
}

/** One health read: the runtime's cheapest route. `loading` for llama.cpp's 503 while a model loads. */
export async function checkHealth(
  cfg: Pick<LocalEndpointConfig, 'url'>,
  healthPath: string,
  opts: WireOptions = {},
): Promise<{ ok: true } | { ok: false; loading?: boolean; error: string }> {
  const r = await getJson(cfg.url, healthPath, { timeoutMs: 3000, ...opts });
  if (r.ok) return { ok: true };
  if (r.status === 503) return { ok: false, loading: true, error: 'the server is loading a model' };
  return { ok: false, error: r.error };
}

// ---------------------------------------------------------------------------
// Qualification, stage 1 (§19.6): tool calls, tool-result round trips, JSON.
// Synthetic prompts only; nothing from a real session goes near it.
// ---------------------------------------------------------------------------

const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' }, unit: { type: 'string', enum: ['c', 'f'] } }, required: ['city', 'unit'] },
  },
};
const READ_TOOL = {
  type: 'function',
  function: { name: 'read_file', description: 'Read a file from the workspace', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
};
const QUALIFY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { tier: { type: 'string', enum: ['basic', 'standard', 'expert'] }, risk: { type: 'integer', minimum: 1, maximum: 5 } },
  required: ['tier', 'risk'],
  additionalProperties: false,
};
const QUALIFY_TASKS = ['rename a variable in one file', 'fix a typo in the README', 'add a settings toggle with tests', 'migrate storage to a database', 'redesign routing across modules'];

export interface QualifyOptions extends WireOptions {
  /** Runs per check: 10 tool calls, 10 round trips, 20 JSON replies by default (§19.6). */
  runs?: { toolCalls?: number; roundTrips?: number; json?: number };
  /** Constrained decoding, when the probe found it. */
  structuredOutput?: StructuredOutputLevel;
  now?: () => number;
}

export function parseJsonReply(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    // A reply with prose around the object: take the outermost braces.
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

export async function qualifyModel(cfg: LocalEndpointConfig, model: string, opts: QualifyOptions = {}): Promise<Qualification> {
  const at = (opts.now ?? Date.now)();
  const runs = { toolCalls: opts.runs?.toolCalls ?? 10, roundTrips: opts.runs?.roundTrips ?? 10, json: opts.runs?.json ?? 20 };
  const wire = { fetch: opts.fetch, key: opts.key, signal: opts.signal, timeoutMs: opts.timeoutMs ?? 60_000 };
  const result: Qualification = {
    model,
    at,
    toolCalls: { ok: 0, runs: runs.toolCalls },
    roundTrips: { ok: 0, runs: runs.roundTrips },
    json: { ok: 0, runs: runs.json },
    toolCalling: 'none',
    structuredOutput: 'none',
    streaming: false,
    verdict: 'completion-only',
  };
  try {
    const speed = await streamChat(cfg.url, { model, temperature: 0, max_tokens: 120, messages: [{ role: 'user', content: 'Count from 1 to 30, comma separated.' }] }, wire);
    result.streaming = true;
    if (speed.ttftMs !== undefined && speed.outTokPerSec !== undefined) result.throughput = { outTokPerSec: speed.outTokPerSec, ttftMs: speed.ttftMs };

    for (let i = 0; i < runs.toolCalls; i++) {
      const r = await streamChat(
        cfg.url,
        { model, temperature: 0, max_tokens: 256, tools: [WEATHER_TOOL, READ_TOOL], messages: [{ role: 'user', content: `What's the weather in Paris${i % 2 ? '' : ', France'}? Use celsius.` }] },
        wire,
      );
      const call = r.toolCalls[0];
      if (call?.name !== 'get_weather') continue;
      const args = parseJsonReply(call.arguments) as { city?: unknown; unit?: unknown } | undefined;
      if (args && typeof args.city === 'string' && /paris/i.test(args.city) && args.unit === 'c') result.toolCalls.ok++;
    }

    const roundTrip: ChatMessage[] = [
      { role: 'user', content: 'What is the version field in package.json?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"package.json"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"name":"demo","version":"4.17.2"}' },
    ];
    for (let i = 0; i < runs.roundTrips; i++) {
      const r = await streamChat(cfg.url, { model, temperature: 0, max_tokens: 256, tools: [READ_TOOL], messages: roundTrip }, wire);
      if (/4\.17\.2/.test(r.content)) result.roundTrips.ok++;
    }

    const constrained = opts.structuredOutput === 'schema';
    for (let i = 0; i < runs.json; i++) {
      const r = await streamChat(
        cfg.url,
        {
          model,
          temperature: 0.3,
          max_tokens: 200,
          ...(constrained ? { response_format: { type: 'json_schema', json_schema: { name: 'assessment', schema: QUALIFY_SCHEMA, strict: true } } } : {}),
          messages: [
            { role: 'system', content: `You classify coding tasks. Reply with ONE JSON object and nothing else, matching this JSON schema: ${JSON.stringify(QUALIFY_SCHEMA)}` },
            { role: 'user', content: `Task: ${QUALIFY_TASKS[i % QUALIFY_TASKS.length]}` },
          ],
        },
        wire,
      );
      const value = parseJsonReply(r.content);
      if (value !== undefined && validateJson(QUALIFY_SCHEMA, value).length === 0) result.json.ok++;
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  const allTools = !result.error && result.toolCalls.ok === runs.toolCalls && result.roundTrips.ok === runs.roundTrips;
  const allJson = !result.error && result.json.ok === runs.json;
  // Any miss means completion-only (§19.6). Passing a probe is basic evidence, never "reliable".
  const toolCalling: ToolCallingLevel = allTools ? 'basic' : 'none';
  result.toolCalling = toolCalling;
  result.structuredOutput = allJson ? (opts.structuredOutput === 'schema' ? 'schema' : 'json') : 'none';
  result.verdict = toolCalling === 'none' ? 'completion-only' : 'agentic';
  return result;
}
