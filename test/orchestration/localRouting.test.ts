/**
 * Agentic routing to a local model (#51, plan §19.6 slice B): the resolver's
 * gates for an endpoint's model, and a local target becoming a Codex thread
 * with a Responses-wire model provider — key read per request, never recorded.
 */
import { describe, expect, it } from 'vitest';
import { Emitter } from '../../src/core/events';
import type { LaunchRequest, SessionHandle } from '../../src/core/session/sessionHandle';
import { CodexRunnerService, codexThreadParams } from '../../src/codex/runner';
import { CodexHarness } from '../../src/orchestration/harness/codexHarness';
import { resolveRoute } from '../../src/orchestration/policy/resolver';
import { proposalChoice } from '../../src/orchestration/view/proposalView';
import { buildCatalog, known, UNKNOWN, type ModelDescriptor } from '../../src/shared/orchestration/catalog';
import { parseLaunchPolicy, type CodexModelProvider } from '../../src/shared/launchPolicy';
import type { LocalModelReport } from '../../src/shared/orchestration/localModels';
import type { SourceStatus } from '../../src/shared/orchestration/sourceHealth';
import type { RouteRequirement } from '../../src/shared/orchestration/types';

function localReport(over: Partial<ModelDescriptor> = {}, extra: Partial<LocalModelReport> = {}): LocalModelReport {
  return {
    descriptor: {
      source: 'local:box',
      modelId: 'coder',
      label: 'coder · Box',
      location: 'local',
      contextWindow: known(65536, 'probed'),
      maxOutputTokens: UNKNOWN,
      toolCalling: known('basic', 'measured'),
      structuredOutput: known('json', 'measured'),
      vision: UNKNOWN,
      streaming: known(true, 'measured'),
      nativeEffort: known([], 'probed'),
      maxConcurrency: known(2, 'probed'),
      throughput: UNKNOWN,
      costBasis: 'none',
      qualifiedHarnesses: ['codex'],
      ...over,
    },
    harnesses: ['codex'],
    endpointEnabled: true,
    external: false,
    ...extra,
  };
}

const REQ: RouteRequirement = { minTier: 'standard', maxTier: 'expert', effort: 'medium', needs: ['edit', 'shell'], gates: [] };
const tiered = (reports: LocalModelReport[]) =>
  buildCatalog({ reported: [], local: reports, policy: Object.fromEntries(reports.map((r) => [`${r.descriptor.source}:${r.descriptor.modelId}`, { tier: 'standard' }])) });

const reachable = (freeSlots?: number): SourceStatus => ({
  source: 'local:box',
  health: { state: 'reachable', reason: 'ok' },
  capacity: { windowPercent: UNKNOWN, freeSlots: freeSlots === undefined ? UNKNOWN : known(freeSlots, 'probed') },
});

describe('the resolver and a local model', () => {
  it('chooses a qualified standard local route before same-tier hosted and records hosted fallback reasons', () => {
    const hosted = buildCatalog({ reported: [{ source: 'anthropic', models: [{ value: 'sonnet', label: 'Sonnet', resolved: 'claude-sonnet-5' }, { value: 'opus', label: 'Opus', resolved: 'claude-opus-5-5' }], at: 1 }], local: [] });
    const local = tiered([localReport()]);
    const snap = { catalog: { ...hosted, entries: [...hosted.entries, ...local.entries] }, sources: { 'local:box': reachable(2) }, now: 0 };
    const selected = resolveRoute(REQ, snap);
    expect(selected.target?.source).toBe('local:box');
    const high = resolveRoute({ ...REQ, minTier: 'expert' }, snap);
    expect(high.target?.source).toBe('anthropic');
    expect(high.candidates.find((c) => c.target.source === 'local:box')?.reason).toMatch(/below the required expert/);
    const oversized = resolveRoute({ ...REQ, needs: ['context:100000'] }, snap);
    expect(oversized.target?.source).toBe('anthropic');
    expect(oversized.candidates.find((c) => c.target.source === 'local:box')?.reason).toMatch(/context 66k < needed 100k/);
    const down = resolveRoute(REQ, { ...snap, sources: { 'local:box': { ...reachable(), health: { state: 'down' as const, reason: 'endpoint stopped' } } } });
    expect(down.target?.source).toBe('anthropic');
    expect(down.candidates.find((c) => c.target.source === 'local:box')?.reason).toMatch(/endpoint stopped/);
    const unqualified = resolveRoute(REQ, { ...snap, catalog: { ...snap.catalog, entries: snap.catalog.entries.map((e) => e.descriptor.source === 'local:box' ? { ...e, descriptor: { ...e.descriptor, qualifiedHarnesses: [] } } : e) } });
    expect(unqualified.target?.source).toBe('anthropic');
    expect(unqualified.candidates.find((c) => c.target.source === 'local:box')?.reason).toMatch(/has not qualified/);
  });

  it('routes to it once it has a tier and its tool calls are measured', () => {
    const r = resolveRoute(REQ, { catalog: tiered([localReport()]), sources: { 'local:box': reachable(2) }, now: 0 });
    expect(r.outcome).toBe('resolved');
    expect(r.target).toMatchObject({ harness: 'codex', source: 'local:box', model: 'coder', tier: 'standard', location: 'local', effortNative: 'none' });
  });

  it('a local-only cap keeps a local model (loopback or declared LAN) and rejects a hosted one', () => {
    const snap = (location: 'local' | 'hosted') => ({ catalog: tiered([localReport({ location })]), sources: { 'local:box': reachable(2) }, now: 0 });
    expect(resolveRoute(REQ, snap('local'), { caps: { location: 'local-only' } }).target?.source).toBe('local:box');
    expect(resolveRoute(REQ, snap('hosted'), { caps: { location: 'local-only' } }).outcome).toBe('needs-human');
  });

  it('never gives agentic work to a model whose tool calling is unknown or none', () => {
    const unknown = resolveRoute(REQ, { catalog: tiered([localReport({ toolCalling: UNKNOWN })]), sources: {}, now: 0 });
    expect(unknown.outcome).toBe('needs-human');
    expect(unknown.candidates[0].reason).toMatch(/tool calling not measured/);
    const none = resolveRoute(REQ, { catalog: tiered([localReport({ toolCalling: known('none', 'measured') })]), sources: {}, now: 0 });
    expect(none.candidates[0].reason).toMatch(/completion only/);
  });

  it('no free slot is capacity: blocked, not a worse model', () => {
    const r = resolveRoute(REQ, { catalog: tiered([localReport()]), sources: { 'local:box': reachable(0) }, now: 0 });
    expect(r.outcome).toBe('blocked');
    expect(r.candidates[0].reason).toMatch(/every server slot is busy/);
  });

  it('a down endpoint is rejected with its reason', () => {
    const down: SourceStatus = { ...reachable(), health: { state: 'down', reason: 'Not answering: refused' } };
    const r = resolveRoute(REQ, { catalog: tiered([localReport()]), sources: { 'local:box': down }, now: 0 });
    expect(r.outcome).toBe('needs-human');
    expect(r.candidates[0].reason).toMatch(/Not answering/);
  });

  it('an endpoint model never gets the assumed hosted window, even when external', () => {
    const external = localReport({ location: 'hosted', contextWindow: UNKNOWN }, { external: true });
    const r = resolveRoute({ ...REQ, needs: ['context:50000'] }, { catalog: tiered([external]), sources: {}, now: 0 });
    expect(r.outcome).toBe('needs-human');
    expect(r.candidates[0].reason).toMatch(/local context window is unknown/);
  });

  it('`disableLocal` turns off loopback endpoints; an external one counts as hosted', () => {
    const r = resolveRoute(REQ, { catalog: tiered([localReport()]), sources: {}, now: 0 }, { exclusions: { disableLocal: true } });
    expect(r.outcome).toBe('needs-human');
    expect(r.candidates[0].reason).toMatch(/local models are off/);
  });
});

describe('the proposal card and a local model', () => {
  it('a card choice of a local model carries its source to the runner', () => {
    const catalog = tiered([localReport()]);
    const rec = {
      assessmentId: 'a',
      policyVersion: 'v',
      requirement: REQ,
      reasons: [],
      verdict: 'needs-human' as const,
      resolution: { candidates: [], catalogVersion: catalog.version },
      at: 0,
    };
    expect(proposalChoice(rec, catalog, { kind: 'run', route: { harness: 'codex', model: 'coder' } })).toEqual({
      route: { harness: 'codex', source: 'local:box', model: 'coder' },
    });
  });
});

function recorder() {
  const requests: LaunchRequest[] = [];
  const handle = { sessionId: 'sid', setEffort: async () => 'applied', send: async () => 'applied' } as unknown as SessionHandle;
  return { requests, sessions: { launch: async (r: LaunchRequest) => (requests.push(r), handle) } };
}

const PROVIDER: CodexModelProvider = { id: 'aw-box', name: 'Agent Wrangler: Box', baseUrl: 'http://127.0.0.1:18080/v1', contextWindow: 65536, keyRef: 'localEndpoint:box' };
const origin = { kind: 'orchestration', missionId: 'm1', taskId: 't1', attemptId: 'a1' } as const;

describe('a local target as a Codex thread', () => {
  it('the Codex harness adds the endpoint as the thread model provider, beside the attempt sandbox', async () => {
    const r = recorder();
    const h = new CodexHarness({ sessions: r.sessions, models: () => [], localProvider: (s, m) => (s === 'local:box' && m === 'coder' ? PROVIDER : undefined) });
    await h.launch({
      cwd: '/Users/test/proj-wt',
      prompt: 'Synthetic',
      target: { harness: 'codex', source: 'local:box', model: 'coder', effortNative: 'none' },
      origin,
      policy: { codex: { sandbox: 'workspace-write', approvalPolicy: 'on-request' } },
    });
    expect(r.requests[0]).toMatchObject({
      provider: 'codex',
      model: 'coder',
      policy: { codex: { sandbox: 'workspace-write', approvalPolicy: 'on-request', modelProvider: PROVIDER } },
    });
    expect(r.requests[0].effort).toBeUndefined();
  });

  it('refuses a local target whose endpoint is gone or off, and one with no model', async () => {
    const h = new CodexHarness({ sessions: recorder().sessions, models: () => [], localProvider: () => undefined });
    await expect(h.launch({ cwd: '/x', prompt: 'p', target: { harness: 'codex', source: 'local:box', model: 'coder', effortNative: 'none' }, origin })).rejects.toThrow(/not registered, or is off/);
    await expect(h.launch({ cwd: '/x', prompt: 'p', target: { harness: 'codex', source: 'local:box', model: '', effortNative: 'none' }, origin })).rejects.toThrow(/has to be named/);
  });

  it('thread params: modelProvider plus the provider table on the Responses wire, merged with effort', () => {
    const policy = { codex: { sandbox: 'workspace-write' as const, modelProvider: PROVIDER } };
    expect(codexThreadParams(policy, 'high', 'sk-test')).toEqual({
      modelProvider: 'aw-box',
      config: {
        model_providers: { 'aw-box': { name: 'Agent Wrangler: Box', base_url: 'http://127.0.0.1:18080/v1', wire_api: 'responses', experimental_bearer_token: 'sk-test' } },
        model_context_window: 65536,
        model_reasoning_effort: 'high',
      },
      sandbox: 'workspace-write',
    });
    // No provider: exactly what a hosted thread always sent.
    expect(codexThreadParams(undefined, 'high')).toEqual({ config: { model_reasoning_effort: 'high' } });
    expect(codexThreadParams(undefined, undefined)).toEqual({});
  });

  it('a provider survives the policy parser, and a key never can be put in it', () => {
    const parsed = parseLaunchPolicy({ codex: { modelProvider: { ...PROVIDER, key: 'sk-leak', keyRef: 'elsewhere' } } });
    expect(parsed?.codex?.modelProvider).toEqual({ ...PROVIDER, keyRef: undefined });
    expect(JSON.stringify(parsed)).not.toContain('sk-leak');
    expect(parseLaunchPolicy({ codex: { modelProvider: { id: 'bad id', baseUrl: 'http://x' } } })).toBeUndefined();
  });

  it('the runner reads the key per request and sends it only to the app-server, on start and on resume', async () => {
    const calls: { method: string; params: any }[] = [];
    const server = {
      notifications: new Emitter<any>(),
      onNotification: new Emitter<any>().event,
      onRequest: new Emitter<any>().event,
      request: async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'thread/resume') return { thread: { id: params.threadId } };
        return {};
      },
      respond: () => undefined,
    };
    const refs: string[] = [];
    const service = new CodexRunnerService(server as any, undefined, { endpointKey: async (ref) => (refs.push(ref), 'sk-test') });
    const policy = { codex: { modelProvider: PROVIDER } };
    await service.start('/Users/test/proj', 'coder', { policy });
    await service.resume('thread-2', '/Users/test/proj', [], 'coder', { policy });
    expect(calls[0].params).toMatchObject({ modelProvider: 'aw-box', config: { model_providers: { 'aw-box': { experimental_bearer_token: 'sk-test' } } } });
    expect(calls.find((c) => c.method === 'thread/resume')!.params).toMatchObject({ threadId: 'thread-2', modelProvider: 'aw-box' });
    expect(refs).toEqual(['localEndpoint:box', 'localEndpoint:box']);
    // What the runner keeps (and the registry records) is the policy, with no key in it.
    expect(JSON.stringify(service.get('thread-1')?.policy)).not.toContain('sk-test');
    service.dispose();
  });

  // Measured live (plan §19.7): a resume without `model` runs the local thread on
  // Codex's default hosted model, and the local server refuses the request.
  it('a local thread names its model on thread/start, thread/resume and thread/fork; a hosted one does not on resume', async () => {
    const calls: { method: string; params: any }[] = [];
    const server = {
      onNotification: new Emitter<any>().event,
      onRequest: new Emitter<any>().event,
      request: async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'thread-1' }, model: params.model };
        if (method === 'thread/resume') return { thread: { id: params.threadId, model: params.model ?? 'hosted-default' } };
        if (method === 'thread/fork') return { thread: { id: 'thread-4' } };
        return {};
      },
      respond: () => undefined,
    };
    const service = new CodexRunnerService(server as any);
    const local = { codex: { modelProvider: PROVIDER } };
    await service.start('/Users/test/proj', 'coder', { policy: local });
    await service.resume('thread-2', '/Users/test/proj', [], 'coder', { policy: local });
    await service.fork('thread-2', '/Users/test/proj', [], 'coder', local);
    await service.resume('thread-3', '/Users/test/proj', [], 'gpt-hosted', {});
    const byThread = (m: string, id?: string) => calls.find((c) => c.method === m && (!id || c.params.threadId === id))!.params;
    expect(byThread('thread/start')).toMatchObject({ model: 'coder', modelProvider: 'aw-box' });
    expect(byThread('thread/resume', 'thread-2')).toMatchObject({ model: 'coder', modelProvider: 'aw-box' });
    expect(byThread('thread/fork')).toMatchObject({ model: 'coder', modelProvider: 'aw-box' });
    expect(byThread('thread/resume', 'thread-3')).not.toHaveProperty('model');
    // The resumed local thread's turns go to its own model, not the server's default.
    expect(service.get('thread-2')?.session.model).toBe('coder');
    service.dispose();
  });

  it('codexThreadParams: model only with a provider, and never model_catalog_json (ignored per thread, replaces server-wide)', () => {
    const withCatalog = { codex: { modelProvider: { ...PROVIDER, modelCatalog: '/Users/test/catalog.json' } } };
    const params = codexThreadParams(withCatalog, undefined, undefined, 'coder');
    expect(params).toMatchObject({ model: 'coder', modelProvider: 'aw-box' });
    expect(JSON.stringify(params)).not.toContain('model_catalog_json');
    expect(codexThreadParams(undefined, 'high', undefined, 'gpt-hosted')).toEqual({ config: { model_reasoning_effort: 'high' } });
  });
});
