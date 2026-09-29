import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationHost } from '../src/ui/conversation/conversationHost';
import type { SessionHandle } from '../src/core/session/sessionHandle';
import type { ConversationToHost, HostToConversation } from '../src/shared/messages';
import type { AgentSession } from '../src/shared/model';

const request = 'Implement a bounded retry policy for the importer with regression tests.';
const hosts: ConversationHost[] = [];
afterEach(() => { hosts.splice(0).forEach((host) => host.dispose()); });

function rig(provider: 'claude' | 'codex') {
  const disposable = () => ({ dispose() {} });
  let receive!: (m: ConversationToHost) => void;
  const messages: HostToConversation[] = [];
  const session = { key: `${provider}:synthetic`, sessionId: 'synthetic', provider, cwd: '/Users/test/proj' } as AgentSession;
  const send = vi.fn(async () => 'applied');
  const handle = { provider, sessionId: session.sessionId, liveSession: session, canSend: true,
    composer: { busy: false }, send, onReset: disposable, onAppend: disposable, onPatch: disposable, onComposer: disposable,
    history: async () => ({ blocks: [], truncated: false }), snapshot: () => ({ blocks: [], truncated: false }),
  } as unknown as SessionHandle;
  const delegate = vi.fn(async () => {});
  const record = vi.fn();
  type Args = ConstructorParameters<typeof ConversationHost>;
  const host = new ConversationHost(
    { postMessage: async (m) => { messages.push(m as HostToConversation); return true; }, onDidReceiveMessage: (listener) => { receive = listener; return disposable(); } },
    { onDidUpdate: disposable, get: () => session } as unknown as Args[1],
    {} as Args[2], {} as Args[3],
    { onDidChange: disposable, get: () => handle } as unknown as Args[4],
    { touch() {} }, {} as Args[6], {} as Args[7], {} as Args[8], () => {}, {} as Args[10],
    { viewFor: () => undefined, run: async () => {}, onDidChange: disposable,
      conversationDelegation: { context: () => ({ repoRoot: session.cwd!, policyVersion: 'default', verificationCommands: [] }), delegate, record } },
  );
  hosts.push(host);
  host.showSession(handle);
  const submit = (text = request) => receive({ type: 'send', requestId: 'send1', sessionKey: session.key, text });
  const offer = () => [...messages].reverse().find((m) => m.type === 'delegationOffer' && m.offer);
  const result = () => messages.find((m) => m.type === 'sendResult');
  return { host, receive, messages, session, handle, submit, offer, result, send, delegate, record };
}

describe.each(['claude', 'codex'] as const)('%s conversation host consent', (provider) => {
  it.each(['accepted', 'declined', 'ignored'] as const)('routes %s from the card without delivering twice', async (outcome) => {
    const r = rig(provider);
    r.submit();
    const offer = r.offer();
    expect(offer?.type).toBe('delegationOffer');
    expect(r.send).not.toHaveBeenCalled();
    expect(r.delegate).not.toHaveBeenCalled();
    if (offer?.type !== 'delegationOffer') throw new Error('missing offer');
    r.receive({ type: 'delegationOfferDecision', offerId: offer.offer!.id, outcome });
    await vi.waitFor(() => expect(r.result()).toMatchObject({ type: 'sendResult', requestId: 'send1' }));
    expect(r.result()).not.toHaveProperty('error');
    expect(r.send).toHaveBeenCalledTimes(outcome === 'accepted' ? 0 : 1);
    expect(r.delegate).toHaveBeenCalledTimes(outcome === 'accepted' ? 1 : 0);
    if (outcome !== 'accepted') expect(r.send).toHaveBeenCalledWith(request, undefined);
  });

  it('cancels an ignored offer on conversation switch and preserves the unsent draft', async () => {
    const r = rig(provider);
    r.submit();
    r.host.showSession({ ...r.handle, liveSession: { ...r.session, key: `${provider}:other`, sessionId: 'other' } } as SessionHandle);
    await vi.waitFor(() => expect(r.result()).toMatchObject({ error: expect.stringContaining('draft was kept') }));
    expect(r.send).not.toHaveBeenCalled();
    expect(r.delegate).not.toHaveBeenCalled();
    expect(r.record.mock.calls[0][0].outcome).toBe('ignored');
  });

  it.each(['delegate this', 'aw delegate implement retries', 'aw task implement retries', 'Explain the importer'])('preserves the existing send path: %s', async (text) => {
    const r = rig(provider);
    r.submit(text);
    await vi.waitFor(() => expect(r.send).toHaveBeenCalledWith(text, undefined));
    expect(r.offer()).toBeUndefined();
    expect(r.delegate).not.toHaveBeenCalled();
  });

  it('leaves requests with image context in the conversation', async () => {
    const r = rig(provider);
    r.receive({ type: 'send', requestId: 'send1', text: request, images: [{ mediaType: 'image/png', data: 'synthetic' }] });
    await vi.waitFor(() => expect(r.send).toHaveBeenCalled());
    expect(r.offer()).toBeUndefined();
  });
});
