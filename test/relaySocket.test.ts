/**
 * A relay tab is an ordinary workbench connection (#176): through the real `browserConnections`
 * it gets the handshake, its messages are acknowledged, and a mutating one resent after a drop
 * is acted on once, exactly as for a LAN tab. What it may do is decided by the same pane hosts
 * and `authorize()`, with the context the relay gave it.
 */
import { describe, expect, it } from 'vitest';
import type { RequestContext } from '../src/core/access';
import { ownerContext } from '../src/core/access';
import { ClientRegistry } from '../src/core/clients';
import { createBrowserConnections } from '../src/core/web/browserConnections';
import { RelaySocket } from '../src/remote/relay/virtualSocket';
import type { RelayItem } from '../src/shared/relay';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const sent: RelayItem[] = [];
  let ended = false;
  const socket = new RelaySocket({
    batchMs: 1,
    send: async (items) => void sent.push(...items),
    onEnd: () => {
      ended = true;
    },
  });
  const received: unknown[] = [];
  const contexts: RequestContext[] = [];
  const conns = createBrowserConnections({
    clients: new ClientRegistry({ log: () => undefined }),
    log: () => undefined,
    build: () => 'b1',
    isMutating: (_pane, body) => (body as { type?: string }).type === 'send',
    createPanes: (transport, context) => {
      contexts.push(context);
      transport.onDidReceiveMessage((m) => received.push(m));
      return { dashboard: { dispose() {} }, conversation: { dispose() {} } as never };
    },
    limits: { pingIntervalMs: 0 },
  });
  conns.attach(socket, ownerContext('browser', { deviceId: 'dev1', deviceScope: 'relay' }));
  return { socket, sent, received, contexts, conns, isEnded: () => ended };
}

describe('a relay tab in browserConnections', () => {
  it('gets the hello first and its messages acknowledged', async () => {
    const t = setup();
    await tick();
    const first = t.sent[0] as { k: string; line: string };
    expect(first.k).toBe('data');
    expect(JSON.parse(first.line)).toMatchObject({ pane: 'shell', body: { type: 'hello', build: 'b1' } });
    t.socket.receive([{ k: 'data', line: JSON.stringify({ pane: 'dashboard', commandId: 'c1', body: { type: 'ready' } }) }]);
    await tick();
    expect(t.received).toHaveLength(1);
    expect(t.sent.some((i) => i.k === 'data' && i.line.includes('"ack"') && i.line.includes('c1'))).toBe(true);
    // Attribution, not authority: the owner, through a browser, from this device.
    expect(t.contexts[0]).toMatchObject({ via: 'browser', deviceId: 'dev1' });
    t.conns.dispose();
  });

  it('acts on a resent mutation once', async () => {
    const t = setup();
    const send = { k: 'data' as const, line: JSON.stringify({ pane: 'conversation', commandId: 'm1', body: { type: 'send', text: 'x' } }) };
    t.socket.receive([send]);
    t.socket.receive([send]);
    await tick();
    expect(t.received).toHaveLength(1);
    t.conns.dispose();
  });

  it('answers a ping and ends on close', async () => {
    const t = setup();
    t.socket.receive([{ k: 'ping' }]);
    await tick();
    expect(t.sent.some((i) => i.k === 'pong')).toBe(true);
    t.socket.receive([{ k: 'close' }]);
    expect(t.isEnded()).toBe(true);
    expect(t.conns.size).toBe(0);
  });
});
