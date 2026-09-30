/**
 * Local endpoints against a fake OpenAI-compatible server on loopback (#51):
 * real HTTP, real SSE, real sockets that die. The endpoint service (registry,
 * probe, keys, health, slots, qualification) and the direct completion
 * client, with the hosted completion behind it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Emitter } from '../../src/core/events';
import { LocalStructuredCompletion, RoutedCompletion } from '../../src/orchestration/completion/localCompletion';
import { SimulatedCompletion } from '../../src/orchestration/completion/simulatedCompletion';
import type { CompletionRequest } from '../../src/orchestration/completion/structuredCompletion';
import { LocalEndpointService, type EndpointSecrets, type EndpointSettings } from '../../src/orchestration/local/localEndpointService';
import { buildCatalog } from '../../src/shared/orchestration/catalog';
import { LOCAL_ENDPOINTS_KEY } from '../../src/shared/orchestration/localEndpoints';
import type { LocalCallRecord, TelemetryRecord } from '../../src/shared/orchestration/telemetry';
import { startFakeServer, type FakeServer } from './fakeOpenAIServer';

const SCHEMA = {
  type: 'object',
  properties: { tier: { type: 'string', enum: ['basic', 'standard'] }, risk: { type: 'integer', minimum: 1, maximum: 5 } },
  required: ['tier', 'risk'],
  additionalProperties: false,
};
const REQ: CompletionRequest = { schema: SCHEMA, instructions: 'Classify the synthetic task.', input: 'Task: rename a variable' };

function settings(initial: Record<string, unknown> = {}): EndpointSettings & { doc: Record<string, unknown> } {
  const doc: Record<string, unknown> = { ...initial };
  const changed = new Emitter<string>();
  return {
    doc,
    get: <T>(key: string, fallback: T): T => (key in doc ? (doc[key] as T) : fallback),
    update: async (key, value) => {
      if (value === undefined) delete doc[key];
      else doc[key] = JSON.parse(JSON.stringify(value));
      changed.fire(key);
    },
    onDidChange: (listener) => changed.event((key) => listener((k) => k === key)),
  };
}

function secrets(): EndpointSecrets & { vault: Record<string, string> } {
  const vault: Record<string, string> = {};
  return {
    vault,
    available: true,
    get: async (k) => vault[k],
    store: async (k, v) => void (vault[k] = v),
    delete: async (k) => void delete vault[k],
  };
}

let servers: FakeServer[] = [];
let services: LocalEndpointService[] = [];
beforeEach(() => {
  servers = [];
  services = [];
});
afterEach(async () => {
  for (const s of services) s.dispose();
  await Promise.all(servers.map((s) => s.close()));
});

async function server(opts: Parameters<typeof startFakeServer>[0] = {}): Promise<FakeServer> {
  const s = await startFakeServer(opts);
  servers.push(s);
  return s;
}

function service(opts: Partial<ConstructorParameters<typeof LocalEndpointService>[0]> = {}) {
  const st = (opts.settings as ReturnType<typeof settings>) ?? settings();
  const sec = (opts.secrets as ReturnType<typeof secrets>) ?? secrets();
  const telemetry: TelemetryRecord[] = [];
  const svc = new LocalEndpointService({
    settings: st,
    secrets: sec,
    telemetry: { append: (r) => (telemetry.push(r), true) },
    qualifyRuns: { toolCalls: 2, roundTrips: 2, json: 2 },
    ...opts,
  });
  services.push(svc);
  return { svc, settings: st, secrets: sec, telemetry };
}

describe('the endpoint registry', () => {
  it('uses the server root for Claude Code so its /v1/messages request reaches the endpoint', async () => {
    const s = await server({ models: ['local-model'], props: { nCtx: 32768 }, messages: true });
    const { svc } = service();
    await svc.apply({ op: 'add', url: s.url, name: 'Claude box' });

    expect(svc.claudeProvider('local:claude-box', 'local-model')).toMatchObject({
      baseUrl: s.url,
      model: 'local-model',
      contextWindow: 32768,
    });
    expect(svc.codexProvider('local:claude-box', 'local-model')?.baseUrl).toBe(`${s.url}/v1`);
  });

  it('adds a loopback endpoint on and probes it; its models reach the catalog unassigned', async () => {
    const s = await server({ models: ['coder-7b'], props: { totalSlots: 2, nCtx: 32768 }, responses: true });
    const { svc, settings: st } = service();
    const r = await svc.apply({ op: 'add', url: s.url, name: 'Test box' });
    expect(r.ok).toBe(true);
    expect(st.doc[LOCAL_ENDPOINTS_KEY]).toEqual([{ id: 'test-box', name: 'Test box', url: s.url }]);
    const reports = svc.reports();
    expect(reports.map((x) => x.descriptor.modelId)).toEqual(['coder-7b']);
    const c = buildCatalog({ reported: [], local: reports });
    expect(c.entries[0]).toMatchObject({ key: 'local:test-box:coder-7b', routable: false, notRoutableBecause: 'Unassigned' });
    expect(svc.status('local:test-box').health.state).toBe('reachable');
    expect(svc.status('local:test-box').capacity.freeSlots).toEqual({ value: 2, from: 'probed' });
  });

  it('a non-loopback endpoint is added off, labelled, and never contacted until turned on', async () => {
    let calls = 0;
    const { svc } = service({ fetch: async () => (calls++, new Response('{}', { status: 200 })) });
    const r = await svc.apply({ op: 'add', url: 'http://192.168.1.20:8080', name: 'LAN box' });
    expect(r.lines.join(' ')).toMatch(/data leaves this machine/);
    await svc.probeAll();
    await svc.tick();
    expect(calls).toBe(0);
    const [view] = svc.view();
    expect(view).toMatchObject({ enabled: false, loopback: false, warning: 'data leaves this machine' });
    expect(svc.status('local:lan-box').health.reason).toBe('Off (data leaves this machine)');
    expect(svc.codexProvider('local:lan-box', 'x')).toBeUndefined();
  });

  it('stores the key in safeStorage only, and sends it as a bearer token', async () => {
    const s = await server({ key: 'sk-test-local', models: ['m'] });
    const st = settings();
    const sec = secrets();
    const { svc } = service({ settings: st, secrets: sec, promptKey: async () => ' sk-test-local ' });
    await svc.apply({ op: 'add', url: s.url, name: 'Keyed' });
    // Without the key the server refuses, so nothing is listed.
    expect(svc.reports()).toEqual([]);
    const r = await svc.apply({ op: 'setKey', id: 'keyed' });
    expect(r.ok).toBe(true);
    expect(sec.vault['localEndpoint:keyed']).toBe('sk-test-local');
    expect(JSON.stringify(st.doc)).not.toContain('sk-test-local');
    expect(st.doc[LOCAL_ENDPOINTS_KEY]).toEqual([{ id: 'keyed', name: 'Keyed', url: s.url, hasKey: true }]);
    expect(svc.reports().map((x) => x.descriptor.modelId)).toEqual(['m']);
    expect(s.requests.filter((q) => q.path === '/v1/models').at(-1)?.auth).toBe('Bearer sk-test-local');
    // The Codex provider names where the key is, never the key.
    expect(svc.codexProvider('local:keyed', 'm')).toEqual({ id: 'aw-keyed', name: 'Agent Wrangler: Keyed', baseUrl: `${s.url}/v1`, keyRef: 'localEndpoint:keyed' });
    expect(await svc.keyByRef('localEndpoint:keyed')).toBe('sk-test-local');
    await svc.apply({ op: 'clearKey', id: 'keyed' });
    expect(sec.vault).toEqual({});
  });

  it('refuses to store a key when the OS cannot encrypt', async () => {
    const sec = { ...secrets(), available: false };
    const { svc } = service({ secrets: sec, promptKey: async () => 'k' });
    await svc.apply({ op: 'add', url: 'http://127.0.0.1:9', name: 'x' });
    const r = await svc.apply({ op: 'setKey', id: 'x' });
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(/cannot store secrets/);
  });
});

describe('health', () => {
  it('one miss is degraded, two is down and fires onDown; back up is reachable', async () => {
    const s = await server({ models: ['m'] });
    const { svc } = service();
    await svc.apply({ op: 'add', url: s.url, name: 'box' });
    const downs: string[] = [];
    svc.onDown((src) => downs.push(src));
    expect(svc.status('local:box').health.state).toBe('reachable');
    s.kill();
    await svc.tick();
    expect(svc.status('local:box').health.state).toBe('degraded');
    expect(downs).toEqual([]);
    await svc.tick();
    expect(svc.status('local:box').health.state).toBe('down');
    expect(downs).toEqual(['local:box']);
    s.revive();
    await svc.tick();
    expect(svc.status('local:box').health.state).toBe('reachable');
  });

  it('a call that loses the server reads health at once', async () => {
    const s = await server({ models: ['m'] });
    const { svc } = service();
    await svc.apply({ op: 'add', url: s.url, name: 'box' });
    s.kill();
    await svc.connectionLost('local:box');
    expect(svc.status('local:box').health.state).toBe('down');
  });
});

describe('slots are concurrency', () => {
  it('a second call waits for the only slot, and the wait is its queue delay', async () => {
    const { svc } = service({ settings: settings({ [LOCAL_ENDPOINTS_KEY]: [{ id: 'box', name: 'box', url: 'http://127.0.0.1:9', maxConcurrency: 1 }] }) });
    const first = await svc.acquire('local:box');
    expect(svc.status('local:box').capacity.freeSlots).toEqual({ value: 0, from: 'probed' });
    let second: Awaited<ReturnType<typeof svc.acquire>> | undefined;
    const waiting = svc.acquire('local:box').then((l) => (second = l));
    await new Promise((r) => setTimeout(r, 30));
    expect(second).toBeUndefined();
    first.release();
    await waiting;
    expect(second!.queuedMs).toBeGreaterThanOrEqual(20);
    second!.release();
    // Attempts running on it count against the slots too.
    expect(svc.status('local:box', 1).capacity.freeSlots).toEqual({ value: 0, from: 'probed' });
  });
});

describe('the direct completion client', () => {
  function client(s: FakeServer, extra: Partial<ConstructorParameters<typeof LocalStructuredCompletion>[0]> = {}, deps: ConstructorParameters<typeof LocalStructuredCompletion>[1] = {}) {
    return new LocalStructuredCompletion({ source: 'local:box', baseUrl: s.url, model: 'm', runtime: 'mlx', device: 'Test device', contextWindow: 32768, ...extra }, deps);
  }

  it('asks by instruction where the server has no constrained decoding, and validates', async () => {
    const s = await server({ replies: [{ content: '```json\n{"tier":"basic","risk":2}\n```', timings: { predicted_per_second: 42.5 } }] });
    const r = await client(s).complete<{ tier: string }>(REQ);
    expect(r).toMatchObject({ ok: true, value: { tier: 'basic', risk: 2 }, model: 'm', attempts: 1, usage: { inputTokens: 20, outputTokens: 10 } });
    expect(r.local).toMatchObject({ source: 'local:box', runtime: 'mlx', device: 'Test device', contextWindow: 32768, outTokPerSec: 42.5, tokPerSecFrom: 'server' });
    expect(r.local?.ttftMs).toBeGreaterThanOrEqual(0);
    const body = s.requests.find((q) => q.path === '/v1/chat/completions')!.body!;
    expect(body.response_format).toBeUndefined();
    expect(body.stream).toBe(true);
    expect(body.messages[0].content).toMatch(/ONE JSON object/);
  });

  it('sends response_format where the probe found schema support', async () => {
    const s = await server({ replies: [{ content: '{"tier":"standard","risk":3}' }] });
    const r = await client(s, { structuredOutput: 'schema' }).complete(REQ);
    expect(r.ok).toBe(true);
    expect(s.requests.find((q) => q.path === '/v1/chat/completions')!.body!.response_format).toMatchObject({ type: 'json_schema' });
  });

  it('retries once with the problems named, then reports invalid-output', async () => {
    const s = await server({ replies: [{ content: '{"tier":"huge","risk":9}' }, { content: '{"tier":"basic","risk":1}' }] });
    const ok = await client(s).complete(REQ);
    expect(ok).toMatchObject({ ok: true, attempts: 2 });
    expect(s.requests.filter((q) => q.path === '/v1/chat/completions')[1].body!.messages[1].content).toMatch(/did not match the required JSON schema/);
    s.setReplies([{ content: 'not json at all' }]);
    const bad = await client(s).complete(REQ);
    expect(bad).toMatchObject({ ok: false, reason: 'invalid-output', attempts: 2 });
  });

  it('a server that dies mid-stream is infra, not bad output', async () => {
    const s = await server({ replies: [{ content: '{"tier":"basic","risk":2}', stall: true }] });
    const lost: string[] = [];
    const pending = client(s, {}, { onConnectionLost: (src) => lost.push(src) }).complete(REQ);
    await new Promise((r) => setTimeout(r, 50));
    s.kill();
    const r = await pending;
    expect(r).toMatchObject({ ok: false, reason: 'error', infra: true });
    expect(lost).toEqual(['local:box']);
  });

  it('refuses a workspace request: it has no tools', async () => {
    const s = await server();
    const r = await client(s).complete({ ...REQ, workspace: { cwd: '/Users/test/proj' } });
    expect(r).toMatchObject({ ok: false, reason: 'error' });
    expect(s.requests).toEqual([]);
  });

  it('routed: local first; on losing the server, the hosted completion answers', async () => {
    const s = await server({ replies: [{ content: '{"tier":"basic","risk":2}' }] });
    const hosted = new SimulatedCompletion([{ output: { tier: 'standard', risk: 4 } }]);
    const seen: { ok: boolean; fellBack: boolean }[] = [];
    const routed = new RoutedCompletion(hosted, () => client(s), { onLocal: (r, fellBack) => seen.push({ ok: r.ok, fellBack }) });
    expect(await routed.complete(REQ)).toMatchObject({ ok: true, value: { tier: 'basic' }, model: 'm' });
    s.kill();
    const r = await routed.complete(REQ);
    expect(r).toMatchObject({ ok: true, value: { tier: 'standard', risk: 4 }, fellBackFrom: 'm' });
    expect(seen).toEqual([
      { ok: true, fellBack: false },
      { ok: false, fellBack: true },
    ]);
    // A workspace request never goes local.
    s.revive();
    const before = s.requests.length;
    await routed.complete({ ...REQ, workspace: { cwd: '/Users/test/proj' } });
    expect(s.requests.length).toBe(before);
  });

  it('the service picks the weakest-tier local model for completions, not a down one', async () => {
    const s = await server({ models: ['m'], replies: [{ content: '{"tier":"basic","risk":2}' }] });
    const { svc } = service();
    await svc.apply({ op: 'add', url: s.url, name: 'box' });
    const unassigned = buildCatalog({ reported: [], local: svc.reports() });
    expect(svc.pickCompletion(unassigned)).toBeUndefined();
    const tiered = buildCatalog({ reported: [], local: svc.reports(), policy: { 'local:box:m': { tier: 'basic' } } });
    const entry = svc.pickCompletion(tiered)!;
    expect(entry.key).toBe('local:box:m');
    expect(await svc.completionFor(entry).complete(REQ)).toMatchObject({ ok: true });
    s.kill();
    await svc.tick();
    await svc.tick();
    expect(svc.pickCompletion(tiered)).toBeUndefined();
  });
});

describe('qualification (stage 1)', () => {
  it('a model whose tool calls parse is agentic, measured; the record is metadata only', async () => {
    // Qualification runs on Codex by default, which needs the endpoint's native `/v1/responses`.
    const s = await server({
      models: ['m'],
      responses: true,
      replies: (body) => {
        if (body.tools?.length === 2) return { toolCall: { name: 'get_weather', arguments: '{"city":"Paris","unit":"c"}' } };
        if (body.tools?.length === 1) return { content: 'The version is 4.17.2.' };
        if (String(body.messages?.[0]?.content).includes('classify')) return { content: '{"tier":"basic","risk":1}' };
        return { content: '1, 2, 3, 4, 5' };
      },
    });
    const { svc, telemetry } = service();
    await svc.apply({ op: 'add', url: s.url, name: 'box' });
    const r = await svc.apply({ op: 'qualify', id: 'box', model: 'm' });
    expect(r.ok).toBe(true);
    expect(r.lines[0]).toMatch(/^Agentic: tool calls 2\/2 · round trips 2\/2 · JSON 2\/2/);
    const [report] = svc.reports();
    expect(report.descriptor.toolCalling).toEqual({ value: 'basic', from: 'measured' });
    expect(report.descriptor.structuredOutput).toEqual({ value: 'json', from: 'measured' });
    const rec = telemetry.find((t) => t.type === 'local-call') as LocalCallRecord;
    expect(rec).toMatchObject({ type: 'local-call', purpose: 'qualification', source: 'local:box', model: 'm', ok: true });
    expect(JSON.stringify(rec)).not.toMatch(/Paris|4\.17\.2/);
  });

  it('a model that writes its call as text is completion-only (§19.6)', async () => {
    const s = await server({ models: ['m'], responses: true, replies: [{ content: '<tools>{"name":"get_weather"}</tools>' }] });
    const { svc } = service();
    await svc.apply({ op: 'add', url: s.url, name: 'box' });
    const r = await svc.apply({ op: 'qualify', id: 'box', model: 'm' });
    expect(r.lines[0]).toMatch(/^Completion only/);
    expect(svc.reports()[0].descriptor.toolCalling).toEqual({ value: 'none', from: 'measured' });
  });
});
