import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationHost } from '../src/ui/conversation/conversationHost';
import { createAccessGate, ownerContext } from '../src/core/access';
import type { SessionHandle } from '../src/core/session/sessionHandle';
import type { ConversationToHost, HostToConversation } from '../src/shared/messages';
import type { AgentSession } from '../src/shared/model';

// #196: a phone that reconnects gets a fresh host, which may be bound to nothing.

const hosts: ConversationHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.dispose());
  vi.useRealTimers();
});

function rig() {
  const disposable = () => ({ dispose() {} });
  let receive!: (m: ConversationToHost) => void;
  let storeUpdated!: () => void;
  const messages: HostToConversation[] = [];
  const lines: string[] = [];
  const sessions = new Map<string, AgentSession>();
  const handles = new Map<string, SessionHandle>();
  const send = vi.fn(async () => 'applied');
  const add = (id: string) => {
    const session = { key: `claude:${id}`, sessionId: id, provider: 'claude', cwd: '/Users/test/proj' } as AgentSession;
    sessions.set(session.key, session);
    handles.set(id, { provider: 'claude', sessionId: id, liveSession: session, canSend: true,
      composer: { busy: false }, send, onReset: disposable, onAppend: disposable, onPatch: disposable, onComposer: disposable,
      history: async () => ({ blocks: [], truncated: false }), snapshot: () => ({ blocks: [], truncated: false }),
    } as unknown as SessionHandle);
    return session;
  };
  type Args = ConstructorParameters<typeof ConversationHost>;
  const host = new ConversationHost(
    { postMessage: async (m) => { messages.push(m as HostToConversation); return true; }, onDidReceiveMessage: (listener) => { receive = listener; return disposable(); } },
    { onDidUpdate: (l: () => void) => { storeUpdated = l; return disposable(); }, get: (key: string) => sessions.get(key) } as unknown as Args[1],
    {} as Args[2], {} as Args[3],
    { onDidChange: disposable, get: (id: string) => handles.get(id) } as unknown as Args[4],
    { touch() {} }, {} as Args[6], {} as Args[7], {} as Args[8], () => {},
    { dialogs: {} as Args[10]['dialogs'], offerDictationSetup: async () => {}, log: (line) => lines.push(line) },
    { context: { ...ownerContext('browser'), connectionId: 'web-7' }, gate: createAccessGate() },
  );
  hosts.push(host);
  const submit = (sessionKey: string) => receive({ type: 'send', requestId: 'send1', sessionKey, text: 'hello' });
  const result = () => messages.find((m) => m.type === 'sendResult');
  return { host, receive, add, submit, result, send, lines, storeUpdated: () => storeUpdated() };
}

describe('conversation host send guard (#196)', () => {
  it('binds the conversation a send names when the host is bound to nothing', async () => {
    const r = rig();
    const s = r.add('aaa');
    r.submit(s.key);
    await vi.waitFor(() => expect(r.result()).toMatchObject({ type: 'sendResult', requestId: 'send1' }));
    expect(r.result()).not.toHaveProperty('error');
    expect(r.send).toHaveBeenCalledWith('hello', undefined);
    expect(r.lines).toContain(`conversation: web-7 was bound to nothing; bound ${s.key} for a send from its pane`);
  });

  it('refuses and logs a send for a key the store does not have', async () => {
    const r = rig();
    r.submit('claude:gone');
    await vi.waitFor(() => expect(r.result()).toMatchObject({ error: 'Conversation changed; your draft was not sent.' }));
    expect(r.send).not.toHaveBeenCalled();
    expect(r.lines).toContain('conversation: web-7 refused a send for claude:gone: this pane\'s host is bound to nothing (waiting for claude:gone)');
  });

  it('still refuses a send meant for another conversation than the bound one', async () => {
    const r = rig();
    const a = r.add('aaa');
    const b = r.add('bbb');
    r.host.show(a.key);
    r.submit(b.key);
    await vi.waitFor(() => expect(r.result()).toMatchObject({ error: 'Conversation changed; your draft was not sent.' }));
    expect(r.send).not.toHaveBeenCalled();
    expect(r.lines).toContain(`conversation: web-7 refused a send for ${b.key}: this pane's host is bound to ${a.key}`);
  });

  it('logs a key the pane asks for before the store has it, and how long it waited', async () => {
    vi.useFakeTimers();
    const r = rig();
    r.receive({ type: 'ready', key: 'claude:late' });
    await vi.waitFor(() => expect(r.lines).toContain('conversation: web-7 asked for claude:late, which the store does not have; waiting for it'));
    vi.advanceTimersByTime(30_000);
    expect(r.lines).toContain('conversation: web-7 still waiting for claude:late after 30 s; it has not appeared');
    r.add('late');
    r.storeUpdated();
    expect(r.lines.at(-1)).toMatch(/^conversation: web-7 bound claude:late after waiting 3\d\.\d s for it$/);
  });
});
