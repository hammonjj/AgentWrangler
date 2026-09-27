/**
 * Probing a local endpoint, one fixture per runtime (#51, plan §19.2), and
 * what the probe's facts become in the catalog: unassigned until a tier is
 * given, then routable only where a harness can drive the model.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CapabilityCatalog } from '../../src/core/capabilityCatalog';
import { probeEndpoint } from '../../src/orchestration/local/probe';
import type { FetchFn } from '../../src/orchestration/local/openaiWire';
import { buildCatalog, isKnown, modelsInTierRange } from '../../src/shared/orchestration/catalog';
import type { LocalEndpointConfig, LocalRuntime } from '../../src/shared/orchestration/localEndpoints';
import { localModelReports, type EndpointProbe, type Qualification } from '../../src/shared/orchestration/localModels';

type Fixture = Record<string, { status: number; body: unknown }>;

function fixture(runtime: string): Fixture {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'local', `${runtime}.json`), 'utf8'));
  delete raw._note;
  return raw;
}

/** A fetch that answers from a fixture: `METHOD /path`, or `POST /api/show <model>` for Ollama. */
function fixtureFetch(fx: Fixture, seen: string[] = []): FetchFn {
  return async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    let key = `${method} ${url.pathname}`;
    if (url.pathname === '/api/show') key += ` ${JSON.parse(String(init?.body)).model}`;
    seen.push(key);
    const hit = fx[key];
    if (!hit) return new Response('not found', { status: 404 });
    return new Response(typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body), { status: hit.status });
  };
}

const at = () => 1_700_000_000_000;

function cfg(extra: Partial<LocalEndpointConfig> = {}): LocalEndpointConfig {
  return { id: 'box', name: 'Box', url: 'http://127.0.0.1:18080', ...extra };
}

async function probe(runtime: string, extra: Partial<LocalEndpointConfig> = {}): Promise<EndpointProbe> {
  return probeEndpoint(cfg(extra), { fetch: fixtureFetch(fixture(runtime)), now: at });
}

describe('probeEndpoint, per runtime', () => {
  it('ollama: models from /api/tags, context and capabilities from /api/show', async () => {
    const p = await probe('ollama');
    expect(p.reachable).toBe(true);
    expect(p.runtime).toEqual({ value: 'ollama', from: 'probed' });
    expect(p.models.map((m) => m.id)).toEqual(['qwen-coder:7b', 'llava:7b']);
    expect(p.models[0]).toMatchObject({ contextWindow: { value: 32768, from: 'probed' }, vision: { value: false, from: 'probed' }, toolTemplate: true });
    expect(p.models[1]).toMatchObject({ contextWindow: { value: 4096, from: 'probed' }, vision: { value: true, from: 'probed' } });
    expect(p.structuredOutput).toEqual({ value: 'schema', from: 'probed' });
    expect(p.routes).toEqual({ responses: { value: true, from: 'probed' }, messages: { value: false, from: 'probed' } });
    expect(p.healthPath).toBe('/api/tags');
  });

  it('llama.cpp: slots and context from /props, both harness routes', async () => {
    const p = await probe('llama.cpp');
    expect(p.runtime).toEqual({ value: 'llama.cpp', from: 'probed' });
    expect(p.slots).toEqual({ value: 4, from: 'probed' });
    expect(p.models).toEqual([{ id: 'qwen-coder-q4.gguf', contextWindow: { value: 65536, from: 'probed' }, vision: { value: false, from: 'probed' } }]);
    expect(p.routes.responses).toEqual({ value: true, from: 'probed' });
    expect(p.routes.messages).toEqual({ value: true, from: 'probed' });
    expect(p.healthPath).toBe('/health');
  });

  it('vllm: max_model_len per model', async () => {
    const p = await probe('vllm');
    expect(p.runtime).toEqual({ value: 'vllm', from: 'probed' });
    expect(p.models[0]).toMatchObject({ id: 'example/coder-14b', contextWindow: { value: 131072, from: 'probed' } });
    expect(p.slots).toEqual({ unknown: true });
    expect(p.routes.responses).toEqual({ value: true, from: 'probed' });
  });

  it('lmstudio: chat models only, vision from type', async () => {
    const p = await probe('lmstudio');
    expect(p.runtime).toEqual({ value: 'lmstudio', from: 'probed' });
    expect(p.models.map((m) => [m.id, isKnown(m.vision) && m.vision.value])).toEqual([
      ['example-coder-7b', false],
      ['example-vision-3b', true],
    ]);
    expect(p.routes.responses).toEqual({ value: false, from: 'probed' });
  });

  it('mlx: weights path as id, nothing else known, no constrained decoding, no harness route', async () => {
    const p = await probe('mlx');
    expect(p.runtime).toEqual({ value: 'mlx', from: 'probed' });
    expect(p.models).toEqual([{ id: '/Users/test/models/Example-4B-4bit', contextWindow: { unknown: true }, vision: { unknown: true } }]);
    expect(p.structuredOutput).toEqual({ value: 'none', from: 'probed' });
    expect(p.routes).toEqual({ responses: { value: false, from: 'probed' }, messages: { value: false, from: 'probed' } });
  });

  it('a generic server: listed, everything else unknown', async () => {
    const p = await probe('openai-compatible');
    expect(p.runtime).toEqual({ value: 'openai-compatible', from: 'probed' });
    expect(p.structuredOutput).toEqual({ unknown: true });
    expect(p.healthPath).toBe('/v1/models');
  });

  it('a declared runtime skips detection', async () => {
    const seen: string[] = [];
    const p = await probeEndpoint(cfg({ runtime: 'llama.cpp' as LocalRuntime }), { fetch: fixtureFetch(fixture('llama.cpp'), seen), now: at });
    expect(p.runtime).toEqual({ value: 'llama.cpp', from: 'declared' });
    expect(seen).not.toContain('GET /api/tags');
    expect(p.slots).toEqual({ value: 4, from: 'probed' });
  });

  it('an unreachable server is a probe that says so, never a throw', async () => {
    const refused: FetchFn = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    };
    const p = await probeEndpoint(cfg(), { fetch: refused, now: at });
    expect(p.reachable).toBe(false);
    expect(p.error).toMatch(/ECONNREFUSED/);
    expect(p.models).toEqual([]);
  });
});

function qual(model: string, toolCalling: 'basic' | 'none'): Qualification {
  return {
    model,
    at: at(),
    toolCalls: { ok: toolCalling === 'basic' ? 10 : 3, runs: 10 },
    roundTrips: { ok: 10, runs: 10 },
    json: { ok: 20, runs: 20 },
    throughput: { outTokPerSec: 41, ttftMs: 300 },
    toolCalling,
    structuredOutput: 'json',
    streaming: true,
    verdict: toolCalling === 'basic' ? 'agentic' : 'completion-only',
  };
}

describe('local models in the catalog', () => {
  it('a probed model is unassigned, and becomes routable only once a tier is assigned', async () => {
    const endpoint = cfg();
    const p = await probe('llama.cpp');
    const local = localModelReports(endpoint, p);
    const before = buildCatalog({ reported: [], local });
    const entry = before.entries[0];
    expect(entry.key).toBe('local:box:qwen-coder-q4.gguf');
    expect(entry.tier).toBeUndefined();
    expect(entry.defaultTier).toBeUndefined();
    expect(entry.routable).toBe(false);
    expect(entry.notRoutableBecause).toBe('Unassigned');
    expect(entry.harnesses).toEqual(['codex']);
    expect(entry.descriptor).toMatchObject({
      location: 'local',
      costBasis: 'none',
      contextWindow: { value: 65536, from: 'probed' },
      maxConcurrency: { value: 4, from: 'probed' },
      toolCalling: { unknown: true },
    });
    expect(modelsInTierRange(before, 'basic', 'expert')).toEqual([]);

    const after = buildCatalog({ reported: [], local, policy: { [entry.key]: { tier: 'standard' } } });
    expect(after.entries[0]).toMatchObject({ tier: 'standard', routable: true, completions: true, tierDeclared: true });
    expect(modelsInTierRange(after, 'standard', 'standard').map((e) => e.key)).toEqual([entry.key]);
    expect(after.version).not.toBe(before.version);
  });

  it('through the CapabilityCatalog: a tier set from Preferences makes it routable, and Reset makes it unassigned again', async () => {
    const doc: Record<string, unknown> = {};
    const listeners: ((affects: (k: string) => boolean) => void)[] = [];
    const settings = {
      get: <T>(k: string, f: T): T => (k in doc ? (doc[k] as T) : f),
      update: async (k: string, v: unknown) => {
        if (v === undefined) delete doc[k];
        else doc[k] = v;
        for (const l of listeners) l((x) => x === k);
      },
      onDidChange: (l: (affects: (k: string) => boolean) => void) => (listeners.push(l), { dispose: () => undefined }),
    };
    const storage = { get: <T>(_k: string, f: T): T => f, update: async () => undefined };
    const catalog = new CapabilityCatalog(storage, settings);
    catalog.setLocal(localModelReports(cfg(), await probe('llama.cpp')));
    const key = 'local:box:qwen-coder-q4.gguf';
    expect(catalog.catalog.entries.find((e) => e.key === key)).toMatchObject({ routable: false, notRoutableBecause: 'Unassigned' });
    expect(await catalog.setPolicy({ key, tier: 'standard' })).toBe(true);
    expect(doc['orchestration.models']).toEqual({ [key]: { tier: 'standard' } });
    expect(catalog.catalog.entries.find((e) => e.key === key)).toMatchObject({ tier: 'standard', routable: true });
    await catalog.setPolicy({ key, reset: 'all' });
    expect(catalog.catalog.entries.find((e) => e.key === key)?.routable).toBe(false);
    catalog.dispose();
  });

  it('a model on a server with no /v1/responses is completion-only, even with a tier', async () => {
    const p = await probe('mlx');
    const local = localModelReports(cfg(), p);
    const key = 'local:box:/Users/test/models/Example-4B-4bit';
    const c = buildCatalog({ reported: [], local, policy: { [key]: { tier: 'basic' } } });
    expect(c.entries[0]).toMatchObject({ routable: false, completions: true, harnesses: [] });
    expect(c.entries[0].notRoutableBecause).toMatch(/v1\/responses/);
    expect(c.entries[0].descriptor.label).toBe('Example-4B-4bit · Box');
  });

  it('measured beats probed beats declared, and unknown stays unknown', async () => {
    const endpoint = cfg({ maxConcurrency: 2, models: { 'qwen-coder-q4.gguf': { contextWindow: 4096, toolCalling: 'reliable' } } });
    const p = await probe('llama.cpp');
    const [declaredOnly] = localModelReports(endpoint, p);
    // Probed window and slots win over the declared ones; tool calling is only declared.
    expect(declaredOnly.descriptor.contextWindow).toEqual({ value: 65536, from: 'probed' });
    expect(declaredOnly.descriptor.maxConcurrency).toEqual({ value: 4, from: 'probed' });
    expect(declaredOnly.descriptor.toolCalling).toEqual({ value: 'reliable', from: 'declared' });
    const [measured] = localModelReports(endpoint, p, { 'qwen-coder-q4.gguf': qual('qwen-coder-q4.gguf', 'none') });
    expect(measured.descriptor.toolCalling).toEqual({ value: 'none', from: 'measured' });
    expect(measured.descriptor.throughput).toEqual({ value: { outTokPerSec: 41, ttftMs: 300 }, from: 'measured' });
  });

  it('a non-loopback endpoint is hosted/external, off by default, and says data leaves this machine', async () => {
    const endpoint = cfg({ url: 'http://192.168.1.20:8080' });
    const p = await probe('llama.cpp');
    const local = localModelReports(endpoint, p);
    expect(local[0]).toMatchObject({ external: true, endpointEnabled: false });
    expect(local[0].descriptor.location).toBe('hosted');
    expect(local[0].descriptor.description).toMatch(/data leaves this machine/);
    const c = buildCatalog({ reported: [], local, policy: { [`local:box:qwen-coder-q4.gguf`]: { tier: 'standard' } } });
    expect(c.entries[0]).toMatchObject({ routable: false, completions: false, external: true });
    expect(c.entries[0].notRoutableBecause).toBe('Its endpoint is off (data leaves this machine)');
    // Turned on by the user, it routes like any other.
    const on = buildCatalog({ reported: [], local: localModelReports({ ...endpoint, enabled: true }, p), policy: { [`local:box:qwen-coder-q4.gguf`]: { tier: 'standard' } } });
    expect(on.entries[0].routable).toBe(true);
  });
});
