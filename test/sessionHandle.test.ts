import { describe, expect, it } from 'vitest';
import type { QueryFn } from '../src/claude/runner/claudeSdkSession';
import { Emitter } from '../src/core/events';
import { createLocalClaudeHandle } from '../src/core/session/localClaudeHandle';
import { SessionExecutors } from '../src/core/session/sessionExecutors';
import type { SessionHandle, SessionViewEvent, SessionViewSnapshot } from '../src/core/session/sessionHandle';
import { CodexRunnerService } from '../src/codex/runner';
import type { BlockPatch, ConvBlock } from '../src/shared/conversation';

/**
 * The provider-agnostic surface: a snapshot equals the replay of the view
 * events, whichever handle it is, and one lookup finds either provider's session.
 */

function fakeQuery() {
  const pending: unknown[] = [];
  let wake: (() => void) | undefined;
  const emit = (msg: unknown) => {
    pending.push(msg);
    wake?.();
    wake = undefined;
  };
  const stream = (async function* () {
    for (;;) {
      if (pending.length > 0) {
        yield pending.shift();
        continue;
      }
      await new Promise<void>((r) => (wake = r));
    }
  })();
  let options: any;
  const query: QueryFn = ({ prompt, options: o }) => {
    options = o;
    void (async () => {
      for await (const _ of prompt) {
        /* drained */
      }
    })();
    return Object.assign(stream, {
      interrupt: async () => undefined,
      setPermissionMode: async () => undefined,
      setModel: async () => undefined,
      supportedModels: async () => [],
      close: () => undefined,
    }) as never;
  };
  return { query, emit, canUseTool: (...args: unknown[]) => options.canUseTool(...args) };
}

class FakeCodexServer {
  notifications = new Emitter<any>();
  requests = new Emitter<any>();
  onNotification = this.notifications.event;
  onRequest = this.requests.event;
  async request(method: string, params: any): Promise<any> {
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    if (method === 'model/list') return { data: [] };
    return { params };
  }
  respond(): void {}
  dispose(): void {}
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Rebuild the view from events alone, the way a late subscriber would. */
function replay(events: SessionViewEvent[], base: SessionViewSnapshot): SessionViewSnapshot {
  const view = { ...base, blocks: [...base.blocks], composer: { ...base.composer } };
  for (const e of events) {
    if (e.type === 'append') view.blocks.push(...e.blocks);
    else if (e.type === 'patch') applyPatch(view.blocks, e.patch);
    else if (e.type === 'composer') view.composer = { ...e.composer };
    else if (e.type === 'lifecycle') view.lifecycle = e.lifecycle;
    else if (e.type === 'reset') view.blocks = [];
    view.seq = e.seq;
  }
  return view;
}

function applyPatch(blocks: ConvBlock[], patch: BlockPatch): void {
  const at = blocks.findIndex((b) => b.id === patch.id);
  if (at >= 0) blocks[at] = { ...blocks[at], ...patch.block } as ConvBlock;
}

function comparable(s: SessionViewSnapshot) {
  return { seq: s.seq, lifecycle: s.lifecycle, composer: s.composer, blocks: s.blocks };
}

describe('SessionHandle: snapshot = replay', () => {
  it('holds for a Claude handle across a turn with an ask', async () => {
    const fake = fakeQuery();
    const handle = createLocalClaudeHandle({ cwd: '/Users/test/proj' }, { query: fake.query, binary: '/b', log: () => undefined });
    const start = handle.snapshot();
    const events: SessionViewEvent[] = [];
    handle.subscribe(start.seq, (e) => events.push(e));
    handle.start();

    fake.emit({ type: 'system', subtype: 'init', session_id: 's1' });
    await handle.send('hello');
    fake.emit({
      type: 'assistant',
      message: { id: 'm1', model: 'claude-opus-5', content: [{ type: 'text', text: 'working' }], stop_reason: null },
      parent_tool_use_id: null,
    });
    void fake.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, requestId: 'r1', toolUseID: 't1' });
    await settle();
    await handle.decide('r1', 'allow');
    fake.emit({ type: 'result', subtype: 'success', is_error: false, queued_turn_count: 0 });
    await settle();

    expect(comparable(replay(events, start))).toEqual(comparable(handle.snapshot()));
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => start.seq + i + 1));
  });

  it('holds for a Codex handle', async () => {
    const server = new FakeCodexServer();
    const service = new CodexRunnerService(server as any);
    const handle = await service.launch({ provider: 'codex', cwd: '/Users/test/proj' });
    const start = handle.snapshot();
    const events: SessionViewEvent[] = [];
    handle.subscribe(start.seq, (e) => events.push(e));

    await handle.send('hi');
    server.notifications.fire({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', delta: 'Hel' } });
    server.notifications.fire({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', delta: 'lo' } });
    server.notifications.fire({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });

    expect(comparable(replay(events, start))).toEqual(comparable(handle.snapshot()));
    service.dispose();
  });

  it('lets a late subscriber catch up from any seq it saw', async () => {
    const fake = fakeQuery();
    const handle = createLocalClaudeHandle({ cwd: '/Users/test/proj' }, { query: fake.query, binary: '/b', log: () => undefined });
    handle.start();
    await handle.send('one');
    const mid = handle.snapshot();
    await handle.send('two');
    const late: SessionViewEvent[] = [];
    handle.subscribe(mid.seq, (e) => late.push(e)).dispose();
    expect(comparable(replay(late, mid))).toEqual(comparable(handle.snapshot()));
  });
});

describe('SessionExecutors', () => {
  it('finds a session by id whichever provider runs it', async () => {
    const fake = fakeQuery();
    const claude: SessionHandle = createLocalClaudeHandle(
      { cwd: '/Users/test/a', sessionId: 'claude-1' },
      { query: fake.query, binary: '/b', log: () => undefined },
    );
    const change = new Emitter<void>();
    const claudeExecutor = {
      provider: 'claude' as const,
      launch: async () => claude,
      get: (id: string | undefined) => (id?.toLowerCase() === 'claude-1' ? claude : undefined),
      owns: (id: string | undefined) => id?.toLowerCase() === 'claude-1',
      list: () => [claude],
      onDidChange: change.event,
    };
    const codex = new CodexRunnerService(new FakeCodexServer() as any);
    const all = new SessionExecutors([claudeExecutor, codex]);

    const thread = await all.launch({ provider: 'codex', cwd: '/Users/test/b' });
    expect(all.get('CLAUDE-1')).toBe(claude);
    expect(all.get('thread-1')).toBe(thread);
    expect(all.owns('nobody')).toBe(false);
    expect(all.list()).toHaveLength(2);

    let changes = 0;
    const sub = all.onDidChange(() => changes++);
    change.fire();
    await codex.launch({ provider: 'codex', cwd: '/Users/test/c' });
    expect(changes).toBe(2);
    sub.dispose();
    codex.dispose();
  });
});
