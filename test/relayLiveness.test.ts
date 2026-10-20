/**
 * The relay's liveness (#189): the daemon's ping period and the tab's silence timeout are one
 * rule, so a quiet link survives many heartbeats and a dead one is still found.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownerContext } from '../src/core/access';
import { ClientRegistry } from '../src/core/clients';
import { createBrowserConnections } from '../src/core/web/browserConnections';
import { RELAY_CONNECTION_LIMITS } from '../src/app/webWorkbench';
import { RelaySocket } from '../src/remote/relay/virtualSocket';
import {
  RELAY_PING_MS,
  RELAY_SILENCE_MS,
  RELAY_SILENCE_PROBE_MS,
  silenceVerdict,
  type RelayItem,
} from '../src/shared/relay';

describe('silenceVerdict', () => {
  it('keeps the timeout above two ping periods', () => {
    expect(RELAY_SILENCE_MS).toBeGreaterThan(2 * RELAY_PING_MS);
  });

  it('is ok while quiet for less than the timeout, probes past it, and dies unanswered', () => {
    expect(silenceVerdict(RELAY_SILENCE_MS, 0, undefined)).toBe('ok');
    expect(silenceVerdict(RELAY_SILENCE_MS + 1, 0, undefined)).toBe('probe');
    const probedAt = RELAY_SILENCE_MS + 1;
    expect(silenceVerdict(probedAt + RELAY_SILENCE_PROBE_MS, 0, probedAt)).toBe('ok');
    expect(silenceVerdict(probedAt + RELAY_SILENCE_PROBE_MS + 1, 0, probedAt)).toBe('dead');
  });

  it('forgets a probe once something is heard after it', () => {
    const probedAt = RELAY_SILENCE_MS + 1;
    const heard = probedAt + 5_000;
    expect(silenceVerdict(heard + RELAY_SILENCE_MS, heard, probedAt)).toBe('ok');
    expect(silenceVerdict(heard + RELAY_SILENCE_MS + 1, heard, probedAt)).toBe('probe');
  });

  it('does not end a tab that wakes from a long sleep until the daemon fails to answer', () => {
    const slept = 10 * RELAY_SILENCE_MS;
    expect(silenceVerdict(slept, 0, undefined)).toBe('probe');
    expect(silenceVerdict(slept + 1_000, 0, slept)).toBe('ok');
  });
});

describe('daemon ping over a relay socket', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(answerPings: boolean) {
    const sent: RelayItem[] = [];
    let ended = false;
    const socket = new RelaySocket({
      batchMs: 1,
      send: async (items) => {
        sent.push(...items);
        if (answerPings && items.some((i) => i.k === 'ping')) queueMicrotask(() => socket.receive([{ k: 'pong' }]));
      },
      onEnd: () => {
        ended = true;
      },
    });
    const conns = createBrowserConnections({
      clients: new ClientRegistry({ log: () => undefined }),
      log: () => undefined,
      build: () => 'b1',
      isMutating: () => false,
      createPanes: () => ({ dashboard: { dispose() {} }, conversation: { dispose() {} } as never }),
      limits: RELAY_CONNECTION_LIMITS,
    });
    conns.attach(socket, ownerContext('browser', { deviceId: 'dev1', deviceScope: 'relay' }));
    return { sent, conns, isEnded: () => ended };
  }

  it('survives more than two heartbeat periods of silence while the tab answers', async () => {
    const t = setup(true);
    await vi.advanceTimersByTimeAsync(5 * RELAY_PING_MS + 1_000);
    expect(t.sent.filter((i) => i.k === 'ping').length).toBeGreaterThanOrEqual(4);
    expect(t.isEnded()).toBe(false);
    expect(t.conns.size).toBe(1);
  });

  it('drops a tab that stops answering, once, and leaves no connection behind', async () => {
    const t = setup(false);
    await vi.advanceTimersByTimeAsync(3 * RELAY_PING_MS + 1_000);
    expect(t.isEnded()).toBe(true);
    expect(t.conns.size).toBe(0);
  });
});
