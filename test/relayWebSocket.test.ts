import { describe, expect, it } from 'vitest';
import { RelayWebSocket, type RelayConnection } from '../src/webview/relayLoader/connection';
import type { RelayItem } from '../src/shared/relay';

/**
 * A connection whose daemon has already spoken: the `hello` arrived with `open`, before the
 * socket listened, so `onItems` hands it over at once (what a reconnect after unlocking a phone
 * does: the daemon's `open` and `hello` come in one batch).
 */
function connectionWithHeld(held: RelayItem[]) {
  const sent: RelayItem[] = [];
  const conn = {
    closed: false,
    build: 'b1',
    onClose: () => undefined,
    onItems: (listener: (items: RelayItem[]) => void) => listener(held),
    send: (item: RelayItem) => void sent.push(item),
    close: () => undefined,
  };
  return { conn: conn as unknown as RelayConnection, sent };
}

describe('RelayWebSocket', () => {
  it('opens before it delivers what arrived first, so a reply to it is sent', async () => {
    const { conn, sent } = connectionWithHeld([{ k: 'data', line: 'hello' }]);
    const ws = new RelayWebSocket(Promise.resolve(conn), () => undefined, () => undefined);
    const events: string[] = [];
    ws.addEventListener('open', () => events.push('open'));
    ws.addEventListener('message', (e) => {
      events.push(`message ${(e as MessageEvent).data}`);
      // The webshim answers the daemon's hello with the panes' `ready`s at once.
      ws.send('ready');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['open', 'message hello']);
    expect(sent).toEqual([{ k: 'data', line: 'ready' }]);
  });

  it('answers a held ping', async () => {
    const { conn, sent } = connectionWithHeld([{ k: 'ping' }]);
    new RelayWebSocket(Promise.resolve(conn), () => undefined, () => undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([{ k: 'pong' }]);
  });
});
