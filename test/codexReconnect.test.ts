/**
 * Stage 5: Codex threads across a dropped connection and a server restart,
 * with an injected transport standing in for `codex app-server --listen`.
 * The behaviour scripted here is what spike S4 measured on the real server
 * (`docs/plans/spikes/s4-codex-restart.md`).
 */
import { describe, expect, it } from 'vitest';
import { CodexAppServer, type CodexConnector, type CodexTransport } from '../src/codex/appServer';
import { classifyResumeError, CodexRunnerService, OPEN_ELSEWHERE_REASON } from '../src/codex/runner';

/** One scripted server process. Request ids it sends count from 0, as Codex's do. */
class FakeCodexServer {
  nextRequestId = 0;
  handlers: Record<string, (params: any) => any> = {};
  /** What each connection sent, by connection. */
  received: any[][] = [];
  connections: FakeConnection[] = [];
  constructor(readonly instance: string) {
    this.handlers.initialize = () => ({ userAgent: `agent-wrangler/0.155.0-test (test)` });
    this.handlers['thread/loaded/list'] = () => ({ data: [], nextCursor: null });
    this.handlers['model/list'] = () => ({ data: [] });
  }
  connect(): FakeConnection {
    const connection = new FakeConnection(this, this.received.length);
    this.received.push([]);
    this.connections.push(connection);
    return connection;
  }
  get live(): FakeConnection {
    return this.connections[this.connections.length - 1];
  }
}

class FakeConnection implements CodexTransport {
  private messageListeners: ((text: string) => void)[] = [];
  private closeListeners: ((reason: string) => void)[] = [];
  closed = false;
  /** Frames to push right after a response to a method, in the same breath (as Codex does after resume). */
  after: Record<string, () => void> = {};
  constructor(private server: FakeCodexServer, private index: number) {}
  send(text: string): void {
    if (this.closed) throw new Error('closed');
    const message = JSON.parse(text);
    this.server.received[this.index].push(message);
    if (message.method && message.id !== undefined) {
      const handler = this.server.handlers[message.method];
      let reply: any;
      try {
        reply = { id: message.id, result: handler ? handler(message.params) : {} };
      } catch (error) {
        reply = { id: message.id, error: { code: -32600, message: (error as Error).message } };
      }
      queueMicrotask(() => {
        this.push(reply);
        this.after[message.method]?.();
      });
    }
  }
  close(): void { this.drop('closed by client'); }
  onMessage(listener: (text: string) => void): void { this.messageListeners.push(listener); }
  onClose(listener: (reason: string) => void): void { this.closeListeners.push(listener); }
  push(message: unknown): void {
    if (this.closed) return;
    for (const listener of this.messageListeners) listener(JSON.stringify(message));
  }
  /** The server sends a request of its own. */
  ask(method: string, params: unknown, id = this.server.nextRequestId++): number {
    this.push({ id, method, params });
    return id;
  }
  drop(reason = 'socket closed'): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener(reason);
  }
}

/** A connector whose server can be swapped (a restart) and whose connections can be dropped. */
function harness() {
  const state = { server: new FakeCodexServer('A') };
  const connector: CodexConnector = {
    kind: 'host',
    persistent: false, // tests drive reconnects themselves with `start()`
    async connect() {
      return { transport: state.server.connect(), instance: state.server.instance };
    },
  };
  const app = new CodexAppServer(connector);
  return { state, app };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const approval = (threadId: string) => ({ threadId, turnId: 'turn-1', itemId: 'item-1', command: 'touch marker.txt', reason: 'Needs approval' });

function fakeRegistry() {
  const states: Record<string, { state: string; reason?: string }> = {};
  const forgotten: string[] = [];
  return {
    states,
    forgotten,
    live: (input: any) => { states[input.sessionId] = { state: 'live' }; return input; },
    touch: () => undefined,
    setState: (id: string, state: string, reason?: string) => { states[id] = { state, reason }; },
    isInterrupted: () => false,
    forget: (id: string) => { forgotten.push(id); },
  } as any;
}

describe('CodexAppServer reconnects', () => {
  it('rejects in-flight requests on a drop and reports the same server on reconnect', async () => {
    const { state, app } = harness();
    const events: any[] = [];
    app.onReconnect((event) => events.push(event));
    await app.start();
    expect(app.userAgent).toContain('0.155.0-test');
    state.server.handlers['slow'] = () => { throw new Error('never answered'); };
    const conn = state.server.live;
    conn.send = function (this: FakeConnection, text: string) { state.server.received[0].push(JSON.parse(text)); } as any;
    const pending = app.request('slow').catch((error: Error) => error.message);
    conn.drop('socket closed');
    expect(await pending).toBe('socket closed');
    expect(app.connected).toBe(false);

    await app.start();
    expect(events).toEqual([{ instance: 'A', restarted: false }]);
    app.dispose();
  });

  it('reports a restart when the server behind the socket is a new process', async () => {
    const { state, app } = harness();
    const events: any[] = [];
    app.onReconnect((event) => events.push(event));
    await app.start();
    state.server.live.drop();
    state.server = new FakeCodexServer('B');
    await app.start();
    expect(events).toEqual([{ instance: 'B', restarted: true }]);
    app.dispose();
  });
});

describe('CodexRunnerService across a reconnect', () => {
  it('keeps the same card when a pending approval is re-sent with its id after resume, and answers on the new connection', async () => {
    const { state, app } = harness();
    const service = new CodexRunnerService(app);
    state.server.handlers['thread/start'] = () => ({ thread: { id: 't1' } });
    const runner = await service.start('/Users/test/proj');
    const id = state.server.live.ask('item/commandExecution/requestApproval', approval('t1'));
    const cards = () => runner.blocks.filter((b) => b.kind === 'permission');
    expect(cards()).toHaveLength(1);
    expect(runner.session.status).toBe('blocked');

    // Drop; the server keeps the ask and re-sends it, same id, after resume.
    state.server.live.drop();
    state.server.handlers['thread/resume'] = () => ({ thread: { id: 't1', status: { type: 'active', activeFlags: ['waitingOnApproval'] }, turns: [] } });
    await app.start();
    state.server.live.after['thread/resume'] = () => state.server.live.ask('item/commandExecution/requestApproval', approval('t1'), id);
    // (the reconnect listener sent `thread/resume` synchronously; let it resolve and the re-send land)
    await flush();
    await flush();
    const resumeCalls = state.server.received[1].filter((m) => m.method === 'thread/resume');
    expect(resumeCalls).toEqual([{ id: expect.any(Number), method: 'thread/resume', params: { threadId: 't1' } }]);
    state.server.live.ask('item/commandExecution/requestApproval', approval('t1'), id);
    expect(cards()).toHaveLength(1);
    expect(runner.lifecycle).toBe('running');

    const card = cards()[0];
    expect(await runner.decide((card as any).requestId, 'allow')).toBe('applied');
    expect(state.server.received[1]).toContainEqual({ id, result: { decision: 'accept' } });
    expect(state.server.received[0]).not.toContainEqual({ id, result: { decision: 'accept' } });
    service.dispose();
  });

  it('clears a card another subscriber answered (serverRequest/resolved)', async () => {
    const { state, app } = harness();
    const service = new CodexRunnerService(app);
    state.server.handlers['thread/start'] = () => ({ thread: { id: 't1' } });
    const runner = await service.start('/Users/test/proj');
    const id = state.server.live.ask('item/tool/requestUserInput', { threadId: 't1', questions: [{ question: 'Which?', header: 'Pick', options: [] }] });
    expect(runner.pendingQuestion).toBeDefined();
    const requestId = runner.pendingQuestion!.requestId;

    state.server.live.push({ method: 'serverRequest/resolved', params: { threadId: 't1', requestId: id } });

    expect(runner.pendingQuestion).toBeUndefined();
    expect(runner.blocks.find((b) => b.id === requestId)).toMatchObject({ state: 'expired' });
    expect(await runner.answer(requestId, { Which: 'x' })).toBe('stale');
    service.dispose();
  });

  it('shows a thread another app-server holds as open elsewhere, read-only, and does not retry', async () => {
    const { state, app } = harness();
    const registry = fakeRegistry();
    const service = new CodexRunnerService(app, undefined, { registry });
    state.server.handlers['thread/start'] = () => ({ thread: { id: 't1' } });
    const runner = await service.start('/Users/test/proj');
    state.server.live.drop();
    state.server.handlers['thread/resume'] = (p) => { throw new Error(`thread ${p.threadId} already has an active writer`); };
    await app.start();
    await flush();
    await flush();

    expect(runner.openElsewhere).toBe(true);
    expect(runner.canSend).toBe(false);
    expect(runner.readOnlyReason).toBe(OPEN_ELSEWHERE_REASON);
    expect(await runner.send('hello')).toBe('unsupported');
    expect(registry.states.t1).toEqual({ state: 'stopped', reason: 'open-elsewhere' });
    expect(state.server.received[1].filter((m) => m.method === 'thread/resume')).toHaveLength(1);
    service.dispose();
  });

  it('keeps cards from two server processes apart though both used request id 0', async () => {
    const { state, app } = harness();
    const service = new CodexRunnerService(app);
    state.server.handlers['thread/start'] = () => ({ thread: { id: 't1' } });
    const runner = await service.start('/Users/test/proj');
    expect(state.server.live.ask('item/commandExecution/requestApproval', approval('t1'))).toBe(0);
    const before = runner.blocks.filter((b) => b.kind === 'permission');
    expect(before).toHaveLength(1);

    // The server restarts: the turn and its ask are gone; the new one counts from 0 again.
    state.server.live.drop();
    state.server = new FakeCodexServer('B');
    state.server.handlers['thread/resume'] = () => ({ thread: { id: 't1', status: { type: 'idle' }, turns: [] } });
    await app.start();
    await flush();
    await flush();
    expect(runner.blocks.find((b) => b.id === before[0].id)).toMatchObject({ state: 'expired' });
    expect(runner.blocks.some((b) => b.kind === 'note' && /restarted/.test(b.text))).toBe(true);
    expect(runner.lifecycle).toBe('idle');

    expect(state.server.live.ask('item/commandExecution/requestApproval', approval('t1'))).toBe(0);
    const after = runner.blocks.filter((b) => b.kind === 'permission');
    expect(after).toHaveLength(2);
    expect(after[1].id).not.toBe(after[0].id);
    expect(after[1]).toMatchObject({ state: 'pending' });
    // The old card is dead; answering it must not reach the new server's request 0.
    expect(await runner.decide((after[0] as any).requestId, 'allow')).toBe('stale');
    expect(await runner.decide((after[1] as any).requestId, 'allow')).toBe('applied');
    expect(state.server.received[0]).toContainEqual({ id: 0, result: { decision: 'accept' } });
    service.dispose();
  });

  it('drops a thread with no turns quietly when the server that knew it is gone', async () => {
    const { state, app } = harness();
    const registry = fakeRegistry();
    const service = new CodexRunnerService(app, undefined, { registry });
    state.server.handlers['thread/start'] = () => ({ thread: { id: 't1' } });
    await service.start('/Users/test/proj');
    state.server.live.drop();
    state.server = new FakeCodexServer('B');
    state.server.handlers['thread/resume'] = (p) => { throw new Error(`no rollout found for thread id ${p.threadId}`); };
    await app.start();
    await flush();
    await flush();
    expect(service.owns('t1')).toBe(false);
    expect(registry.forgotten).toEqual(['t1']);
    service.dispose();
  });
});

describe('CodexRunnerService.reattach (after an app restart)', () => {
  it('rejoins the threads that were live and claims asks re-sent before the runner existed', async () => {
    const { state, app } = harness();
    const registry = fakeRegistry();
    const history = [{ kind: 'user' as const, id: 'u1', text: 'Earlier prompt' }, { kind: 'assistant' as const, id: 'a1', text: 'Earlier answer' }];
    const service = new CodexRunnerService(app, undefined, {
      registry,
      readHistory: async (file) => { expect(file).toBe('/Users/test/.codex/sessions/rollout-t1.jsonl'); return { blocks: history }; },
    });
    state.server.handlers['thread/resume'] = (p) => p.threadId === 't1'
      ? { thread: { id: p.threadId, path: '/Users/test/.codex/sessions/rollout-t1.jsonl', status: { type: 'active', activeFlags: ['waitingOnApproval'] }, turns: [{ id: 'turn-9', status: 'inProgress', items: [] }] } }
      // Unloaded while nobody was attached: loaded again from disk, idle.
      : { thread: { id: p.threadId, status: { type: 'idle' }, turns: [] } };
    await app.start();
    // Pending since before the app quit: request id 3, re-sent right behind the resume response.
    state.server.live.after['thread/resume'] = () => state.server.live.ask('item/commandExecution/requestApproval', approval('t1'), 3);

    const result = await service.reattach([
      { sessionId: 't1', cwd: '/Users/test/proj' },
      { sessionId: 't-idle', cwd: '/Users/test/proj' },
    ]);

    expect(result).toEqual({ reattached: ['t1', 't-idle'], elsewhere: [], dropped: [], failed: [] });
    expect(service.get('t-idle')!.lifecycle).toBe('idle');
    const runner = service.get('t1')!;
    expect(runner.lifecycle).toBe('running');
    expect(runner.session.status).toBe('blocked');
    expect(runner.blocks.map((b) => b.id).slice(0, 2)).toEqual(['u1', 'a1']);
    const card = runner.blocks.find((b) => b.kind === 'permission') as any;
    expect(card).toMatchObject({ state: 'pending', body: 'touch marker.txt' });
    expect(await runner.decide(card.requestId, 'allow')).toBe('applied');
    expect(state.server.received[0]).toContainEqual({ id: 3, result: { decision: 'accept' } });
    // The interrupt goes to the turn the server said is running.
    await runner.interrupt();
    expect(state.server.received[0]).toContainEqual(expect.objectContaining({ method: 'turn/interrupt', params: { threadId: 't1', turnId: 'turn-9' } }));
    expect(registry.states.t1).toEqual({ state: 'live' });
    service.dispose();
  });

  it('records a thread held elsewhere as stopped and one with no turns as forgotten', async () => {
    const { state, app } = harness();
    const registry = fakeRegistry();
    const service = new CodexRunnerService(app, undefined, { registry });
    state.server.handlers['thread/resume'] = (p) => {
      if (p.threadId === 't-held') throw new Error('thread t-held already has an active writer');
      throw new Error('no rollout found for thread id t-empty');
    };
    const result = await service.reattach([
      { sessionId: 't-held', cwd: '/Users/test/proj' },
      { sessionId: 't-empty', cwd: '/Users/test/proj' },
    ]);
    expect(result).toEqual({ reattached: [], elsewhere: ['t-held'], dropped: ['t-empty'], failed: [] });
    expect(registry.states['t-held']).toEqual({ state: 'stopped', reason: 'open-elsewhere' });
    expect(registry.forgotten).toEqual(['t-empty']);
    service.dispose();
  });
});

describe('CodexRunner items that finished while nobody was connected', () => {
  it('makes blocks from item/completed when no item/started was seen', async () => {
    const { state, app } = harness();
    const service = new CodexRunnerService(app);
    state.server.handlers['thread/start'] = () => ({ thread: { id: 't1' } });
    const runner = await service.start('/Users/test/proj');
    state.server.live.push({ method: 'item/completed', params: { threadId: 't1', item: { id: 'i1', type: 'commandExecution', command: 'ls', aggregatedOutput: 'a\nb', status: 'completed' } } });
    state.server.live.push({ method: 'item/completed', params: { threadId: 't1', item: { id: 'i2', type: 'agentMessage', text: 'All done.' } } });
    expect(runner.blocks).toEqual([
      expect.objectContaining({ kind: 'tool', name: 'Shell', state: 'done', result: expect.objectContaining({ text: 'a\nb' }) }),
      expect.objectContaining({ kind: 'assistant', text: 'All done.' }),
    ]);
    service.dispose();
  });
});

describe('classifyResumeError', () => {
  it('names the two resume failures the app acts on', () => {
    expect(classifyResumeError(new Error('thread abc already has an active writer'))).toBe('open-elsewhere');
    expect(classifyResumeError(new Error('no rollout found for thread id abc'))).toBe('no-rollout');
    expect(classifyResumeError(new Error('connection reset'))).toBe('other');
  });
});
