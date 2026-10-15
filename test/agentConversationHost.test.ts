import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationHost } from '../src/ui/conversation/conversationHost';
import { createAccessGate, ownerContext } from '../src/core/access';
import type { ConversationToHost, HostToConversation } from '../src/shared/messages';
import type { AgentSession } from '../src/shared/model';
import type { AgentConversations } from '../src/ui/agentDirectory';

const hosts: ConversationHost[] = [];
afterEach(() => { hosts.splice(0).forEach((host) => host.dispose()); });

/** A conversation pane with no sessions at all, and one durable agent with nothing to continue (#179). */
function rig(notice?: string) {
  const disposable = () => ({ dispose() {} });
  let receive!: (m: ConversationToHost) => void;
  const messages: HostToConversation[] = [];
  const draft: AgentSession = { provider: 'claude', sessionId: 'agent:a1', key: 'agent:a1', title: 'PO', subtitle: 'Your first message starts it.', status: 'done', lastActivityAt: 1 };
  const start = vi.fn(async () => {});
  const agents: AgentConversations = { draft: (id) => (id === 'a1' ? { session: draft, ...(notice ? { notice } : {}) } : undefined), start };
  type Args = ConstructorParameters<typeof ConversationHost>;
  const host = new ConversationHost(
    { postMessage: async (m) => { messages.push(m as HostToConversation); return true; }, onDidReceiveMessage: (listener) => { receive = listener; return disposable(); } },
    { onDidUpdate: disposable, get: () => undefined } as unknown as Args[1],
    {} as Args[2], {} as Args[3],
    { onDidChange: disposable, get: () => undefined } as unknown as Args[4],
    { touch() {} }, {} as Args[6], {} as Args[7], {} as Args[8], () => {}, {} as Args[10],
    { context: ownerContext('browser'), gate: createAccessGate() },
    undefined,
    agents,
  );
  hosts.push(host);
  return { host, receive: (m: ConversationToHost) => receive(m), messages, start };
}

describe("a durable agent's empty conversation", () => {
  it('is shown by its key, can be typed into, and runs nothing until the first message', async () => {
    const r = rig();
    r.receive({ type: 'ready' });
    r.host.show('agent:a1');
    const init = await vi.waitFor(() => {
      const m = r.messages.find((x) => x.type === 'init');
      if (!m || m.type !== 'init') throw new Error('no init yet');
      return m;
    });
    expect(init.session.key).toBe('agent:a1');
    expect(init.caps).toMatchObject({ canSend: true, canAdopt: false, canResumeHere: false });
    expect(init.blocks.some((b) => b.kind === 'note')).toBe(true);
    expect(r.start).not.toHaveBeenCalled();

    r.receive({ type: 'send', requestId: 's1', sessionKey: 'agent:a1', text: 'Where did we leave the roadmap?' });
    await vi.waitFor(() => expect(r.messages.find((m) => m.type === 'sendResult')).toBeDefined());
    expect(r.start).toHaveBeenCalledWith('a1', 'Where did we leave the roadmap?', undefined);
    expect(r.messages.find((m) => m.type === 'sendResult')).not.toHaveProperty('error');
  });

  it('says so when the last conversation is lost', async () => {
    const r = rig('Its last conversation could not be found.');
    r.receive({ type: 'ready' });
    r.host.show('agent:a1');
    await vi.waitFor(() => {
      const m = r.messages.find((x) => x.type === 'init');
      expect(m?.type === 'init' && m.blocks.some((b) => b.kind === 'note' && b.tone === 'warn')).toBe(true);
    });
  });

  it('shows nothing for an agent that no longer exists', async () => {
    const r = rig();
    r.receive({ type: 'ready' });
    r.host.show('agent:gone');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.messages.some((m) => m.type === 'init')).toBe(false);
  });
});
