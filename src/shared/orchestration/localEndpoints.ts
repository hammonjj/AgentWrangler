/**
 * The local endpoint registry (`docs/plans/intelligent-orchestration.md` §19;
 * #51): the OpenAI-compatible servers the user has told Agent Wrangler about,
 * as they are stored in settings (`orchestration.localEndpoints`).
 *
 * Rules this file owns:
 * - **Loopback or not decides where the data goes.** An endpoint on
 *   `localhost`, `127.0.0.0/8` or `::1` is local. Anything else — a LAN box, a
 *   hosted OpenAI-compatible API — is treated as hosted/external (§24): it is
 *   **off until the user turns it on**, and it is labelled "data leaves this
 *   machine" wherever it is shown.
 * - **A key is never a setting.** The endpoint records only that it has one;
 *   the key itself is in `safeStorage` under `endpointKeyRef(id)`.
 * - **Declared facts say so.** What the user states about a model (context
 *   window, slots, tool calling) becomes `Known<…>` with `from: 'declared'`,
 *   and a probed or measured value beats it.
 *
 * Pure and shared: no Node or DOM here.
 */

import type { SourceHealth } from './sourceHealth';
import type { ModelSourceId } from './types';

/** Settings key for the registry: an array of `LocalEndpointConfig`. */
export const LOCAL_ENDPOINTS_KEY = 'orchestration.localEndpoints';

/** Shown beside every non-loopback endpoint and its models. */
export const DATA_LEAVES_MACHINE = 'data leaves this machine';

/** Runtimes the probes know by name (§19.2). `openai-compatible`: none of them, or not told. */
export type LocalRuntime = 'ollama' | 'llama.cpp' | 'vllm' | 'lmstudio' | 'mlx' | 'openai-compatible';
export const LOCAL_RUNTIMES: readonly LocalRuntime[] = ['ollama', 'llama.cpp', 'vllm', 'lmstudio', 'mlx', 'openai-compatible'];

export type ToolCallingLevel = 'reliable' | 'basic' | 'none';
export type StructuredOutputLevel = 'schema' | 'json' | 'none';

/** What the user states about one model at an endpoint. Every field optional. */
export interface DeclaredModelFacts {
  contextWindow?: number;
  maxOutputTokens?: number;
  toolCalling?: ToolCallingLevel;
  structuredOutput?: StructuredOutputLevel;
  vision?: boolean;
}

export interface LocalEndpointConfig {
  /** Stable, `[a-z0-9-]`; the source is `local:<id>`. */
  id: string;
  name: string;
  /** The server's base URL, without `/v1` (it is added per route). */
  url: string;
  /** Absent: on for loopback, off for anything else. */
  enabled?: boolean;
  /** Absent: detected by the probe. */
  runtime?: LocalRuntime;
  /** A key is stored in `safeStorage` for it. The key is never here. */
  hasKey?: boolean;
  /** Concurrent requests the server takes, when it cannot say (`OLLAMA_NUM_PARALLEL`, MLX). */
  maxConcurrency?: number;
  /** Display only (§19.2 "hardware"): "M5 Pro, 24 GB". */
  device?: string;
  /**
   * A Codex model catalog file (§19.6: without an entry Codex does not offer
   * `apply_patch` to an unknown model). Optional, and **not sent yet**: Codex
   * ignores `model_catalog_json` in a thread's config, and server-wide it
   * replaces the built-in catalog (measured, §19.7 (c)).
   */
  codexModelCatalog?: string;
  /** Per model id. */
  models?: Record<string, DeclaredModelFacts>;
}

/** What Preferences shows for one endpoint. */
export interface LocalEndpointView {
  id: string;
  name: string;
  url: string;
  source: ModelSourceId;
  enabled: boolean;
  loopback: boolean;
  /** "data leaves this machine", for a non-loopback endpoint. */
  warning?: string;
  hasKey: boolean;
  health: SourceHealth;
  runtime?: string;
  slots?: string;
  routes: string;
  probedAt?: number;
  error?: string;
  /** `/v1/responses` as probed. Undefined: not probed, or the probe could not say. */
  responses?: boolean;
  messages?: boolean;
  models: LocalEndpointModelView[];
  busy?: boolean;
}

/** One model an endpoint lists, as Preferences shows it: beside the endpoint and beside its tier picker. */
export interface LocalEndpointModelView {
  id: string;
  label: string;
  harnesses?: ('codex' | 'claude-code')[];
  qualifications?: Partial<Record<'codex' | 'claude-code', string>>;
  taskQualifications?: Partial<Record<'codex' | 'claude-code', string>>;
  /** The catalog key, to find its tier-map entry. */
  key: string;
  /** Stage 1's line (`qualificationText`). */
  qualification?: string;
  qualifying?: boolean;
  /** Stage 1's verdict and tool-call count, for the status line. */
  stage1?: { verdict: 'agentic' | 'completion-only'; toolCalls: { ok: number; runs: number }; error?: string };
  /** Stage 2's line (`taskQualificationText`). */
  tasks?: string;
  /** Stage 2 is running: how far it has got. */
  tasksRunning?: string;
  /** The window fits a repository excerpt for the local planner (§11.5). */
  plannerWindowFits?: boolean;
}

export function endpointSource(id: string): ModelSourceId {
  return `local:${id}`;
}

/** The endpoint id of a `local:<id>` source, or undefined for any other source. */
export function endpointIdOf(source: ModelSourceId | undefined): string | undefined {
  return typeof source === 'string' && source.startsWith('local:') ? source.slice('local:'.length) : undefined;
}

export function isEndpointSource(source: ModelSourceId | undefined): boolean {
  return endpointIdOf(source) !== undefined;
}

/** Where an endpoint's key is kept in `safeStorage`. */
export function endpointKeyRef(id: string): string {
  return `localEndpoint:${id}`;
}

/**
 * Whether a URL names this machine. By literal host only: a name that
 * resolves to loopback through `/etc/hosts` is not trusted to keep doing so.
 */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return !!v4 && Number(v4[1]) === 127 && v4.slice(1).every((o) => Number(o) <= 255);
}

/** On, as stored, or by default: loopback on, anything else off. */
export function endpointEnabled(cfg: Pick<LocalEndpointConfig, 'enabled' | 'url'>): boolean {
  return cfg.enabled ?? isLoopbackUrl(cfg.url);
}

/** `local` on loopback; anything else is hosted/external as far as routing and caps are concerned. */
export function endpointLocation(cfg: Pick<LocalEndpointConfig, 'url'>): 'local' | 'hosted' {
  return isLoopbackUrl(cfg.url) ? 'local' : 'hosted';
}

/** A base URL as stored: http(s) only, no trailing slash, no trailing `/v1`. Undefined when unusable. */
export function normaliseEndpointUrl(raw: string): string | undefined {
  const text = raw.trim();
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  // A URL with a password in it would put a credential in settings.json.
  if (u.username || u.password) return undefined;
  u.hash = '';
  u.search = '';
  let out = u.toString().replace(/\/+$/, '');
  if (out.endsWith('/v1')) out = out.slice(0, -3);
  return out;
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

function parseDeclared(raw: unknown): DeclaredModelFacts | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: DeclaredModelFacts = {};
  const cw = positiveInt(r.contextWindow);
  if (cw) out.contextWindow = cw;
  const mo = positiveInt(r.maxOutputTokens);
  if (mo) out.maxOutputTokens = mo;
  if (r.toolCalling === 'reliable' || r.toolCalling === 'basic' || r.toolCalling === 'none') out.toolCalling = r.toolCalling;
  if (r.structuredOutput === 'schema' || r.structuredOutput === 'json' || r.structuredOutput === 'none') out.structuredOutput = r.structuredOutput;
  if (typeof r.vision === 'boolean') out.vision = r.vision;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Trust nothing in `settings.json`: a person may have typed it. Bad entries are dropped, one at a time. */
export function parseLocalEndpoints(raw: unknown): LocalEndpointConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: LocalEndpointConfig[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || !ID.test(r.id) || seen.has(r.id)) continue;
    if (typeof r.url !== 'string') continue;
    const url = normaliseEndpointUrl(r.url);
    if (!url) continue;
    seen.add(r.id);
    const cfg: LocalEndpointConfig = {
      id: r.id,
      name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 60) : r.id,
      url,
    };
    if (typeof r.enabled === 'boolean') cfg.enabled = r.enabled;
    if (typeof r.runtime === 'string' && (LOCAL_RUNTIMES as readonly string[]).includes(r.runtime)) cfg.runtime = r.runtime as LocalRuntime;
    if (r.hasKey === true) cfg.hasKey = true;
    const slots = positiveInt(r.maxConcurrency);
    if (slots) cfg.maxConcurrency = slots;
    if (typeof r.device === 'string' && r.device.trim()) cfg.device = r.device.trim().slice(0, 80);
    if (typeof r.codexModelCatalog === 'string' && r.codexModelCatalog.trim().startsWith('/')) cfg.codexModelCatalog = r.codexModelCatalog.trim();
    if (r.models && typeof r.models === 'object' && !Array.isArray(r.models)) {
      const models: Record<string, DeclaredModelFacts> = {};
      for (const [id, facts] of Object.entries(r.models as Record<string, unknown>)) {
        const d = parseDeclared(facts);
        if (d && id.trim()) models[id] = d;
      }
      if (Object.keys(models).length > 0) cfg.models = models;
    }
    out.push(cfg);
  }
  return out;
}

/** An id for a new endpoint, from its name, not already taken. */
export function newEndpointId(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'endpoint';
  const head = /^[a-z0-9]/.test(base) ? base : `e-${base}`;
  if (!taken.includes(head)) return head;
  for (let n = 2; ; n++) {
    const id = `${head}-${n}`;
    if (!taken.includes(id)) return id;
  }
}

/** A change from Preferences → Local endpoints. */
export type LocalEndpointChange =
  | { op: 'add'; url: string; name?: string }
  | { op: 'remove'; id: string }
  | { op: 'enable'; id: string; enabled: boolean }
  | { op: 'setKey'; id: string }
  | { op: 'clearKey'; id: string }
  | { op: 'probe'; id: string }
  | { op: 'qualify'; id: string; model: string; harness?: 'codex' | 'claude-code' }
  /** Stage 2 (§19.6): scratch-repo tasks through Codex on the endpoint. */
  | { op: 'qualifyTasks'; id: string; model: string; harness?: 'codex' | 'claude-code' };

/** A `localEndpoint` message's change, or nothing if it is not well formed. */
export function localEndpointChange(raw: unknown): LocalEndpointChange | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  const id = typeof c.id === 'string' && ID.test(c.id) ? c.id : undefined;
  switch (c.op) {
    case 'add':
      return typeof c.url === 'string' && c.url.trim()
        ? { op: 'add', url: c.url, ...(typeof c.name === 'string' && c.name.trim() ? { name: c.name } : {}) }
        : undefined;
    case 'remove':
    case 'setKey':
    case 'clearKey':
    case 'probe':
      return id ? { op: c.op, id } : undefined;
    case 'enable':
      return id && typeof c.enabled === 'boolean' ? { op: 'enable', id, enabled: c.enabled } : undefined;
    case 'qualify':
    case 'qualifyTasks':
      return id && typeof c.model === 'string' && c.model !== '' && (c.harness === undefined || c.harness === 'codex' || c.harness === 'claude-code')
        ? { op: c.op, id, model: c.model, ...(c.harness ? { harness: c.harness } : {}) }
        : undefined;
    default:
      return undefined;
  }
}

/** The registry after adding an endpoint, or why not. */
export function addEndpoint(
  list: readonly LocalEndpointConfig[],
  input: { url: string; name?: string },
): { ok: true; list: LocalEndpointConfig[]; endpoint: LocalEndpointConfig } | { ok: false; error: string } {
  const url = normaliseEndpointUrl(input.url);
  if (!url) return { ok: false, error: 'That is not an http(s) URL Agent Wrangler can use (and it must not carry a password).' };
  if (list.some((e) => e.url === url)) return { ok: false, error: 'That endpoint is already registered.' };
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // normalised above
  }
  const name = input.name?.trim().slice(0, 60) || host;
  const endpoint: LocalEndpointConfig = { id: newEndpointId(name, list.map((e) => e.id)), name, url };
  return { ok: true, list: [...list, endpoint], endpoint };
}
