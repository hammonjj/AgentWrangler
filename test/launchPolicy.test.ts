/**
 * A session's launch policy (#71): parsed defensively, applied to the agent,
 * recorded with the session, and carried into every resume, migration and
 * rejoin. The end-to-end halves (a real session host resuming and migrating
 * under a deny rule) are in `launchPolicy.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSdkSession, claudePolicyOptions, type QueryFn } from '../src/claude/runner/claudeSdkSession';
import { RunnerView, type ClaudeExecution, type MigrateExecution } from '../src/claude/runner/runnerView';
import { RunnerService } from '../src/claude/runner/runnerService';
import { Emitter } from '../src/core/events';
import { LaunchDefaults } from '../src/core/launchDefaults';
import { SessionRegistry } from '../src/core/session/sessionRegistry';
import { recordFromManifest } from '../src/core/session/recovery';
import { ClaudeCodeHarness } from '../src/orchestration/harness/claudeCodeHarness';
import { codexPolicyParams, CodexRunnerService } from '../src/codex/runner';
import { parseLaunchPolicy, type LaunchPolicy } from '../src/shared/launchPolicy';
import { emptyHostState, type HostEvent, type HostSnapshot } from '../src/shared/sessionProtocol';
import { localClaudeEnv } from '../src/sessionHost/env';
import { inProcessHosts } from '../src/sessionHost/inProcessHosts';
import { CONVERSATION_DELEGATION_INSTRUCTIONS, withConversationDelegation } from '../src/shared/conversationDelegation';

const POLICY: LaunchPolicy = {
  claude: {
    allowedTools: ['Bash(npm test:*)'],
    disallowedTools: ['Bash(git push:*)'],
    maxTurns: 40,
    maxBudgetUsd: 2.5,
    fallbackModel: 'sonnet',
    outputFormat: { type: 'json_schema', schema: { type: 'object' } },
  },
  codex: { sandbox: 'workspace-write', approvalPolicy: 'on-request', developerInstructions: 'Stay in the worktree.' },
};

const MINE = 'eeeeeeee-0000-4000-8000-000000000001';

function memento(initial: Record<string, unknown> = {}) {
  const doc: Record<string, unknown> = { ...initial };
  return {
    doc,
    get: <T>(key: string, fallback: T): T => (key in doc ? (doc[key] as T) : fallback),
    update: (key: string, value: unknown) => {
      doc[key] = value;
    },
  };
}

describe('parseLaunchPolicy', () => {
  it('keeps only a validated local Claude provider and never serializes a key', () => {
    const provider = { source: 'local:box', baseUrl: 'http://127.0.0.1:18080', model: 'qwen', contextWindow: 65536, maxOutputTokens: 4096, keyRef: 'localEndpoint:box' };
    expect(parseLaunchPolicy({ claude: { localProvider: { ...provider, key: 'synthetic-secret' } } })?.claude?.localProvider).toEqual(provider);
    expect(JSON.stringify(parseLaunchPolicy({ claude: { localProvider: { ...provider, key: 'synthetic-secret' } } }))).not.toContain('synthetic-secret');
    expect(parseLaunchPolicy({ claude: { localProvider: { ...provider, model: '' } } })).toBeUndefined();
    expect(parseLaunchPolicy({ claude: { localProvider: { ...provider, keyRef: 'localEndpoint:other' } } })).toBeUndefined();
  });
  it('keeps a local Claude provider at the server root, since Claude Code appends /v1/messages itself', () => {
    const provider = { source: 'local:box', baseUrl: 'http://127.0.0.1:18080', model: 'qwen', contextWindow: 65536 };
    const baseUrlOf = (baseUrl: unknown) => parseLaunchPolicy({ claude: { localProvider: { ...provider, baseUrl } } })?.claude?.localProvider?.baseUrl;
    expect(baseUrlOf('http://127.0.0.1:18080')).toBe('http://127.0.0.1:18080');
    expect(baseUrlOf('http://127.0.0.1:18080/')).toBe('http://127.0.0.1:18080');
    expect(baseUrlOf('http://127.0.0.1:18080/v1')).toBe('http://127.0.0.1:18080');
    expect(baseUrlOf('https://box.test/proxy')).toBe('https://box.test/proxy');
    for (const bad of ['', 'ftp://box.test', 'http://user@box.test', 'http://', 3]) expect(baseUrlOf(bad)).toBeUndefined();
  });
  it('keeps a well-formed policy as it is', () => {
    expect(parseLaunchPolicy(JSON.parse(JSON.stringify(POLICY)))).toEqual(POLICY);
  });

  it('is undefined for nothing, junk, or a policy with no valid field', () => {
    for (const raw of [undefined, null, 'x', 3, [], {}, { claude: {} }, { claude: { maxTurns: -1 } }, { codex: { sandbox: 'danger-full-access' } }]) {
      expect(parseLaunchPolicy(raw)).toBeUndefined();
    }
  });

  it('drops anything that could widen it: no mode, no bypass, no full-access sandbox', () => {
    const parsed = parseLaunchPolicy({
      claude: { disallowedTools: ['Bash(git push:*)', 3, ''], permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true },
      codex: { sandbox: 'danger-full-access', approvalPolicy: 'on-request' },
      permissionMode: 'bypassPermissions',
    });
    expect(parsed).toEqual({ claude: { disallowedTools: ['Bash(git push:*)'] }, codex: { approvalPolicy: 'on-request' } });
  });

  it("drops Codex approvalPolicy 'never' unless the policy names the sandbox too", () => {
    expect(parseLaunchPolicy({ codex: { approvalPolicy: 'never' } })).toBeUndefined();
    expect(parseLaunchPolicy({ codex: { approvalPolicy: 'never', sandbox: 'workspace-write' } })).toEqual({
      codex: { approvalPolicy: 'never', sandbox: 'workspace-write' },
    });
    expect(codexPolicyParams({ codex: { approvalPolicy: 'never' } })).toEqual({});
  });

  it('rejects malformed limits and output formats field by field', () => {
    expect(
      parseLaunchPolicy({ claude: { maxTurns: 1.5, maxBudgetUsd: Number.NaN, fallbackModel: ' ', outputFormat: { type: 'text' }, allowedTools: ['Read'] } }),
    ).toEqual({ claude: { allowedTools: ['Read'] } });
  });
});

describe('claudePolicyOptions', () => {
  it('adds the same consent instruction once when an ordinary session resumes with earlier guidance', () => {
    expect(withConversationDelegation(undefined)).toBe(CONVERSATION_DELEGATION_INSTRUCTIONS);
    expect(withConversationDelegation('Keep answers short.')).toBe(`Keep answers short.\n\n${CONVERSATION_DELEGATION_INSTRUCTIONS}`);
    expect(withConversationDelegation(withConversationDelegation('Keep answers short.'))).toBe(withConversationDelegation('Keep answers short.'));
    expect(CONVERSATION_DELEGATION_INSTRUCTIONS).toMatch(/do not independently repeat that offer/);
  });
  it('replaces the old model-driven offer instruction on resume, preserving other guidance', () => {
    const old = 'Agent Wrangler can take a substantial, separable piece of work out of this conversation and put it in a task or mission with its own review card. For multi-step repository work that can be checked independently, briefly offer to Delegate it. Handle small questions and quick edits here without suggesting delegation. Before running aw delegate, ask the user explicitly and wait for a clear yes. If they agree, run aw delegate with --folder and, when there are acceptance criteria, --criteria. Do not pass --claude or --codex unless the user asks for a harness. Creating a delegation only creates a proposal or plan; Agent Wrangler waits for approval before work starts.';
    expect(withConversationDelegation(`Keep answers short.\n\n${old}`)).toBe(`Keep answers short.\n\n${CONVERSATION_DELEGATION_INSTRUCTIONS}`);
  });
  it('builds a local-only SDK environment and preserves a simultaneous hosted launch', async () => {
    const inherited = { PATH: '/bin', ANTHROPIC_API_KEY: 'inherited-key', ANTHROPIC_BASE_URL: 'https://old.invalid', ANTHROPIC_MODEL: 'old', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'old-oauth', OPENAI_API_KEY: 'other-key' };
    const processBefore = { ...process.env };
    const provider = { source: 'local:box', baseUrl: 'http://127.0.0.1:18080', model: 'qwen', contextWindow: 65536, maxOutputTokens: 4096, keyRef: 'localEndpoint:box' };
    const seen: any[] = [];
    const query: QueryFn = ({ options }) => { seen.push(options); return (async function* () {})() as any; };
    new ClaudeSdkSession({ cwd: '/Users/test/proj', model: 'qwen', policy: { localProvider: provider } }, { query, binary: '/fake/claude', log: () => undefined, sdkOptions: { env: inherited }, localKey: async () => 'synthetic-secret' }).start();
    new ClaudeSdkSession({ cwd: '/Users/test/proj', model: 'sonnet' }, { query, binary: '/fake/claude', log: () => undefined, sdkOptions: { env: inherited } }).start();
    await Promise.resolve();
    expect(seen).toHaveLength(2);
    const local = seen.find((x) => x.model === 'qwen').env;
    const hosted = seen.find((x) => x.model === 'sonnet').env;
    expect(local).toMatchObject({ PATH: '/bin', ANTHROPIC_BASE_URL: provider.baseUrl, ANTHROPIC_API_KEY: 'synthetic-secret', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '65536', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096' });
    for (const key of ['ANTHROPIC_MODEL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY']) expect(local).not.toHaveProperty(key);
    expect(hosted).toEqual(inherited);
    expect(inherited.ANTHROPIC_API_KEY).toBe('inherited-key');
    expect(process.env).toEqual(processBefore);
    expect(localClaudeEnv(inherited, provider).ANTHROPIC_API_KEY).toBe('agent-wrangler-local');
  });

  it('appends the shared instruction only when the conversation policy requests it', () => {
    const seen: any[] = [];
    const query: QueryFn = ({ options }) => { seen.push(options); return (async function* () {})() as any; };
    const deps = { query, binary: '/fake/claude', log: () => undefined };
    new ClaudeSdkSession({ cwd: '/Users/test/proj', policy: { conversationInstructions: CONVERSATION_DELEGATION_INSTRUCTIONS } }, deps).start();
    new ClaudeSdkSession({ cwd: '/Users/test/proj' }, deps).start();
    expect(seen[0].systemPrompt).toMatchObject({ type: 'preset', append: CONVERSATION_DELEGATION_INSTRUCTIONS });
    expect(seen[1].systemPrompt).toBeUndefined();
  });
  it('maps the claude half onto SDK options, and nothing else', () => {
    expect(claudePolicyOptions(POLICY.claude)).toEqual(POLICY.claude);
    expect(claudePolicyOptions(undefined)).toEqual({});
  });

  it('leaves out a fallback model that is the model itself (the SDK would refuse to start)', () => {
    expect(claudePolicyOptions({ fallbackModel: 'sonnet', maxTurns: 3 }, 'sonnet')).toEqual({ maxTurns: 3 });
    expect(claudePolicyOptions({ fallbackModel: 'sonnet' }, 'opus')).toEqual({ fallbackModel: 'sonnet' });
  });

  it('reaches the SDK options, after anything merged in, and changes nothing without a policy', () => {
    const seen: any[] = [];
    const query: QueryFn = ({ options }) => {
      seen.push(options);
      return (async function* () {})() as any;
    };
    const base = { cwd: '/Users/test/proj', permissionMode: 'auto' };
    const deps = { query, binary: '/fake/claude', log: () => undefined, sdkOptions: { disallowedTools: [] as string[] } };
    new ClaudeSdkSession({ ...base, policy: POLICY.claude }, deps).start();
    new ClaudeSdkSession(base, deps).start();
    expect(seen[0]).toMatchObject({ ...POLICY.claude, permissionMode: 'auto' });
    expect(seen[0].allowDangerouslySkipPermissions).toBeUndefined();
    // Without a policy, none of its options are set (the merged-in one stays as it was).
    for (const key of ['allowedTools', 'maxTurns', 'maxBudgetUsd', 'fallbackModel', 'outputFormat']) expect(seen[1]).not.toHaveProperty(key);
    expect(seen[1].disallowedTools).toEqual([]);
  });
});

describe('codexPolicyParams', () => {
  it('is the thread params of the codex half, or nothing', () => {
    expect(codexPolicyParams(POLICY)).toEqual(POLICY.codex);
    expect(codexPolicyParams({ claude: POLICY.claude })).toEqual({});
    expect(codexPolicyParams(undefined)).toEqual({});
  });
});

describe('the registry keeps a policy', () => {
  it('round-trips it, and loads a record from before policies with none', () => {
    const store = memento({
      'agentWrangler.sessions': [
        { v: 1, sessionId: 'old', provider: 'claude', cwd: '/Users/test/proj', launch: { model: 'opus' }, state: 'stopped', createdAt: 1, lastShownAt: 1, updatedAt: 1 },
      ],
    });
    const registry = new SessionRegistry(store);
    registry.live({ sessionId: 'new', provider: 'claude', cwd: '/Users/test/proj', launch: { model: 'opus', policy: POLICY } });
    const reread = new SessionRegistry(memento(JSON.parse(JSON.stringify(store.doc))));
    expect(reread.get('new')?.launch.policy).toEqual(POLICY);
    expect(reread.get('old')?.launch).toEqual({ model: 'opus' });
  });

  it('keeps it when the id is announced again by a caller that knows less', () => {
    const registry = new SessionRegistry(memento());
    registry.live({ sessionId: 's1', provider: 'claude', cwd: '/Users/test/proj', launch: { model: 'opus', policy: POLICY } });
    registry.live({ sessionId: 's1', provider: 'claude', cwd: '/Users/test/proj', launch: { model: undefined, policy: undefined } });
    registry.live({ sessionId: 's1', provider: 'claude', cwd: '/Users/test/proj' });
    expect(registry.get('s1')?.launch).toEqual({ model: 'opus', policy: POLICY });
  });

  it('reads a hand-edited policy through the parser', () => {
    const registry = new SessionRegistry(
      memento({
        'agentWrangler.sessions': [
          {
            v: 1, sessionId: 's1', provider: 'codex', cwd: '/Users/test/proj', state: 'stopped', createdAt: 1, lastShownAt: 1, updatedAt: 1,
            launch: { policy: { codex: { sandbox: 'danger-full-access', approvalPolicy: 'on-request' } } },
          },
          {
            v: 1, sessionId: 's2', provider: 'codex', cwd: '/Users/test/proj', state: 'stopped', createdAt: 1, lastShownAt: 1, updatedAt: 1,
            launch: { model: 'm', policy: 'nonsense' },
          },
        ],
      }),
    );
    expect(registry.get('s1')?.launch.policy).toEqual({ codex: { approvalPolicy: 'on-request' } });
    expect(registry.get('s2')?.launch).toEqual({ model: 'm' });
  });
});

describe('a resume gets the policy back', () => {
  it('LaunchDefaults.resumed carries the recorded policy, and a new launch has none', () => {
    const defaults = new LaunchDefaults({ get: <T>(_k: string, d: T) => d });
    expect(defaults.resumed('claude', { model: 'opus', policy: POLICY }).policy).toEqual(POLICY);
    expect(defaults.resumed('codex', { policy: POLICY }).policy).toEqual(POLICY);
    expect(defaults.resumed('claude', { model: 'opus' })).not.toHaveProperty('policy');
    expect(defaults.for('claude')).not.toHaveProperty('policy');
  });

  it('RunnerService records it at launch and applies it to the agent on Resume', async () => {
    const seen: any[] = [];
    const query: QueryFn = ({ options }) => {
      seen.push(options);
      return (async function* () {})() as any;
    };
    const registry = new SessionRegistry(memento());
    const service = new RunnerService({
      binary: () => '/fake/claude',
      log: () => undefined,
      registry,
      loadHistory: async () => ({ blocks: [], truncated: false }),
      hosts: { supervisor: inProcessHosts({ query }) },
    });
    await service.launch({ provider: 'claude', cwd: '/Users/test/proj', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', policy: POLICY });
    expect(registry.get('aaaaaaaa-0000-4000-8000-000000000001')?.launch.policy).toEqual(POLICY);
    expect(seen[0].disallowedTools).toEqual(['Bash(git push:*)']);

    const record = registry.get('aaaaaaaa-0000-4000-8000-000000000001')!;
    const defaults = new LaunchDefaults({ get: <T>(_k: string, d: T) => d });
    await service.launch({ provider: 'claude', cwd: record.cwd, resume: record.sessionId, ...defaults.resumed('claude', record.launch) });
    expect(seen[1]).toMatchObject({ resume: record.sessionId, disallowedTools: ['Bash(git push:*)'], maxTurns: 40 });

    // A resume that says nothing about policy (the orchestrator's "continue") still gets it.
    await service.launch({ provider: 'claude', cwd: record.cwd, resume: record.sessionId });
    expect(seen[2]).toMatchObject({ resume: record.sessionId, disallowedTools: ['Bash(git push:*)'] });
    service.dispose();
  });

  it('recordFromManifest rebuilds a lost record with the host’s policy', () => {
    const rebuilt = recordFromManifest({ sessionId: 's1', cwd: '/Users/test/proj', launch: { model: 'opus', policy: POLICY } });
    expect(rebuilt?.launch).toEqual({ model: 'opus', policy: POLICY });
    expect(recordFromManifest({ sessionId: 's1', cwd: '/Users/test/proj', launch: { model: 'opus' } })?.launch).toEqual({ model: 'opus' });
  });

  it('the harnesses forward an attempt policy', async () => {
    const launched: any[] = [];
    const sessions = { launch: async (r: any) => (launched.push(r), {} as any) };
    const claude = new ClaudeCodeHarness({ sessions, models: () => [] } as any);
    await claude.launch({ cwd: '/Users/test/proj', prompt: 'p', target: { harness: 'claude-code', model: 'opus', effortNative: 'none' }, origin: {} as any, policy: POLICY });
    expect(launched[0].policy).toEqual(POLICY);
  });
});

/** An execution that is idle on an older host build, so the next send migrates. */
function outdatedExec(): ClaudeExecution & { sent: SDKUserMessage[] } {
  const events = new Emitter<HostEvent>();
  const snap: HostSnapshot = { ...emptyHostState(), state: 'idle', epoch: 'e', ring: { fromSeq: 0, truncated: false } };
  const sent: SDKUserMessage[] = [];
  let seq = 0;
  return {
    sent,
    cwd: '/Users/test/proj',
    startedAt: 0,
    outdated: true,
    snapshot: () => snap,
    subscribe: (_from, listener) => events.event(listener),
    start: () => events.fire({ seq: ++seq, type: 'state', state: 'idle' }),
    send: (m) => {
      sent.push(m);
      return { accepted: true, duplicate: false };
    },
    respondAsk: () => 'gone',
    control: async () => undefined,
    end: async () => undefined,
    detach: () => undefined,
    waitGone: async () => true,
  };
}

describe('RunnerView', () => {
  it('moves to a new host under the policy it was launched with (§7.4)', async () => {
    const launches: Parameters<MigrateExecution>[0][] = [];
    const next = outdatedExec();
    (next as { outdated: boolean }).outdated = false;
    const view = new RunnerView(
      { cwd: '/Users/test/proj', sessionId: 's1', permissionMode: 'auto', policy: POLICY },
      {
        exec: outdatedExec(),
        log: () => undefined,
        migrate: async (launch) => {
          launches.push(launch);
          return next;
        },
      },
    );
    view.start();
    expect(view.lifecycle).toBe('idle');
    expect(await view.send('hello')).toBe('applied');
    expect(launches).toEqual([expect.objectContaining({ sessionId: 's1', permissionMode: 'auto', policy: POLICY })]);
    expect(next.sent).toHaveLength(1);
  });

  it("sends with the caller's own message id, and mints one otherwise", async () => {
    const exec = outdatedExec();
    (exec as { outdated: boolean }).outdated = false;
    const view = new RunnerView({ cwd: '/Users/test/proj', sessionId: 's1' }, { exec, log: () => undefined, newUuid: () => 'minted' });
    view.start();
    await view.send('one', undefined, { clientMessageId: MINE });
    await view.send('two');
    expect(await view.send('three', undefined, { clientMessageId: 'not-a-uuid' })).toBe('unsupported');
    expect(exec.sent.map((m) => m.uuid)).toEqual([MINE, 'minted']);
  });
});

class FakeCodex {
  calls: { method: string; params: any }[] = [];
  notifications = new Emitter<any>();
  requests = new Emitter<any>();
  onNotification = this.notifications.event;
  onRequest = this.requests.event;
  async request(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 't1' } };
    if (method === 'thread/resume') return { thread: { id: params.threadId, status: { type: 'idle' }, turns: [] } };
    if (method === 'thread/fork') return { thread: { id: 't-fork' } };
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    return { data: [] };
  }
  respond(): void {}
  dispose(): void {}
  of(method: string) {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }
}

describe('CodexRunnerService', () => {
  it('starts a thread with its sandbox, approval policy and instructions, and records them', async () => {
    const server = new FakeCodex();
    const registry = new SessionRegistry(memento());
    const service = new CodexRunnerService(server as any, undefined, { registry });
    await service.launch({ provider: 'codex', cwd: '/Users/test/proj', model: 'gpt-test', effort: 'high', permissionMode: 'auto', origin: { kind: 'test' }, policy: POLICY });
    expect(server.of('thread/start')).toEqual([
      { cwd: '/Users/test/proj', model: 'gpt-test', config: { model_reasoning_effort: 'high' }, ...POLICY.codex },
    ]);
    expect(registry.get('t1')).toMatchObject({
      launch: { model: 'gpt-test', effort: 'high', permissionMode: 'auto', policy: POLICY },
      origin: { kind: 'test' },
    });
    service.dispose();
  });

  it('passes mode, effort, origin and policy on a resume launch too', async () => {
    const server = new FakeCodex();
    const registry = new SessionRegistry(memento());
    const service = new CodexRunnerService(server as any, undefined, { registry });
    const runner = await service.launch({
      provider: 'codex', cwd: '/Users/test/proj', resume: 't9', effort: 'low', permissionMode: 'auto', origin: { kind: 'test' }, policy: POLICY,
    });
    expect(server.of('thread/resume')).toEqual([{ threadId: 't9', config: { model_reasoning_effort: 'low' }, ...POLICY.codex }]);
    expect(runner.origin).toEqual({ kind: 'test' });
    expect(runner.composer.effort).toBe('low');
    expect(registry.get('t9')).toMatchObject({ launch: { effort: 'low', permissionMode: 'auto', policy: POLICY }, origin: { kind: 'test' } });
    service.dispose();
  });

  it('sends exactly what it always did without a policy', async () => {
    const server = new FakeCodex();
    const service = new CodexRunnerService(server as any);
    await service.launch({ provider: 'codex', cwd: '/Users/test/proj' });
    await service.launch({ provider: 'codex', cwd: '/Users/test/proj', resume: 't9' });
    expect(server.of('thread/start')).toEqual([{ cwd: '/Users/test/proj' }]);
    expect(server.of('thread/resume')).toEqual([{ threadId: 't9' }]);
    service.dispose();
  });

  it('re-sends the policy on reattach after a restart, from the registry record', async () => {
    // The first run of the app starts the thread and records it.
    const store = memento();
    const first = new CodexRunnerService(new FakeCodex() as any, undefined, { registry: new SessionRegistry(store) });
    await first.launch({ provider: 'codex', cwd: '/Users/test/proj', policy: POLICY });
    first.dispose();

    // The next run: a new service, a new connection, the record read back from disk.
    const registry = new SessionRegistry(memento(JSON.parse(JSON.stringify(store.doc))));
    const server = new FakeCodex();
    const service = new CodexRunnerService(server as any, undefined, { registry });
    const result = await service.reattach(registry.all().filter((r) => r.provider === 'codex'));
    expect(result.reattached).toEqual(['t1']);
    expect(server.of('thread/resume')).toEqual([{ threadId: 't1', ...POLICY.codex }]);
    expect(service.get('t1')?.policy).toEqual(POLICY);
    service.dispose();
  });

  it('a resume that names no policy gets the recorded one', async () => {
    const registry = new SessionRegistry(memento());
    registry.live({ sessionId: 't9', provider: 'codex', cwd: '/Users/test/proj', launch: { policy: POLICY } });
    const server = new FakeCodex();
    const service = new CodexRunnerService(server as any, undefined, { registry });
    await service.launch({ provider: 'codex', cwd: '/Users/test/proj', resume: 't9' });
    expect(server.of('thread/resume')).toEqual([{ threadId: 't9', ...POLICY.codex }]);
    service.dispose();
  });

  it('re-sends the policy when it rejoins after the connection comes back', async () => {
    const server = new FakeCodex();
    let reconnect!: (event: { instance?: string; restarted: boolean }) => void;
    (server as any).onReconnect = (listener: typeof reconnect) => {
      reconnect = listener;
      return { dispose: () => undefined };
    };
    const service = new CodexRunnerService(server as any);
    await service.launch({ provider: 'codex', cwd: '/Users/test/proj', policy: POLICY });
    reconnect({ restarted: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(server.of('thread/resume')).toEqual([{ threadId: 't1', ...POLICY.codex }]);
    service.dispose();
  });

  it('forks with the policy of the thread it came from', async () => {
    const server = new FakeCodex();
    const service = new CodexRunnerService(server as any);
    const fork = await service.fork('t1', '/Users/test/proj', [], undefined, POLICY);
    expect(server.of('thread/fork')).toEqual([{ threadId: 't1', cwd: '/Users/test/proj', ...POLICY.codex }]);
    expect(fork.policy).toEqual(POLICY);
    service.dispose();
  });

  it("sends the caller's message id as turn/start.clientUserMessageId", async () => {
    const server = new FakeCodex();
    const service = new CodexRunnerService(server as any);
    const runner = await service.launch({ provider: 'codex', cwd: '/Users/test/proj' });
    await runner.send('one', [], { clientMessageId: MINE });
    await runner.send('two');
    const turns = server.of('turn/start');
    expect(turns[0].clientUserMessageId).toBe(MINE);
    expect(turns[1]).not.toHaveProperty('clientUserMessageId');
    service.dispose();
  });
});
