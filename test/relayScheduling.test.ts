/**
 * Relay head-of-line blocking (#193): a click's reply must not wait behind a transcript. These
 * run on a fake clock against a link with a fixed acknowledgement time per batch, so the bounds
 * they check are exact and the same on every machine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyEnvelope, type SendMeta } from '../src/core/web/browserConnections';
import { RelaySocket, type BatchInfo } from '../src/remote/relay/virtualSocket';
import type { RelayItem } from '../src/shared/relay';

const ACK_MS = 300;
const BULK_LINE = 'x'.repeat(100 * 1024);

beforeEach(() => vi.useFakeTimers({ now: 1_700_000_000_000 }));
afterEach(() => vi.useRealTimers());

interface Sent {
  at: number;
  lane: BatchInfo['lane'];
  lines: string[];
}

/** A socket whose every batch takes `ACK_MS` to be acknowledged, and a log of what went when. */
function rig(opts: { bulkBatchBytes?: number; batchMs?: number; failAt?: number } = {}) {
  const log: Sent[] = [];
  let ended = false;
  let maxBuffered = 0;
  let calls = 0;
  const socket: RelaySocket = new RelaySocket({
    batchMs: opts.batchMs ?? 250,
    ...(opts.bulkBatchBytes ? { bulkBatchBytes: opts.bulkBatchBytes } : {}),
    send: async (items: RelayItem[], _traced, info) => {
      log.push({ at: Date.now(), lane: info.lane, lines: items.map((i) => (i.k === 'data' ? i.line : `<${i.k}>`)) });
      maxBuffered = Math.max(maxBuffered, socket.bufferedAmount);
      await new Promise((r) => setTimeout(r, ACK_MS));
      if (opts.failAt !== undefined && ++calls === opts.failAt) throw new Error('timed out');
    },
    onEnd: () => {
      ended = true;
    },
  });
  const put = (line: string, meta: SendMeta) => socket.sendWith(line, meta);
  const lines = () => log.flatMap((b) => b.lines);
  return { socket, log, put, lines, isEnded: () => ended, maxBuffered: () => maxBuffered };
}

describe('lanes', () => {
  it('classifies what a pane says', () => {
    expect(classifyEnvelope({ pane: 'dashboard', body: { type: 'snapshot' } }, 100)).toEqual({ lane: 'bulk', stream: 'dashboard' });
    expect(classifyEnvelope({ pane: 'conversation', body: { type: 'init' } }, 100)).toEqual({ lane: 'bulk', stream: 'conversation' });
    expect(classifyEnvelope({ pane: 'conversation', body: { type: 'append' } }, 100)).toEqual({ lane: 'live', stream: 'conversation' });
    expect(classifyEnvelope({ pane: 'shell', body: { type: 'ack' } }, 100)).toEqual({ lane: 'interactive', stream: 'shell' });
    expect(classifyEnvelope({ pane: 'shell', body: { type: 'prompt' } }, 100)).toEqual({ lane: 'interactive', stream: 'shell' });
    expect(classifyEnvelope({ pane: 'conversation', body: { type: 'sendResult' } }, 100)).toEqual({ lane: 'interactive', stream: 'conversation' });
    expect(classifyEnvelope({ pane: 'conversation', body: { type: 'sendResult' } }, 64 * 1024)).toEqual({ lane: 'bulk', stream: 'conversation' });
    expect(classifyEnvelope(undefined, 10)).toEqual({ lane: 'interactive', stream: '*' });
  });
});

describe('a click during a large transfer', () => {
  it('waits for the batch in flight, not for the transfer', async () => {
    const t = rig();
    // 40 bulk items of 100 KB: one per batch, so 40 batches and 12 s of acknowledgements.
    for (let i = 0; i < 40; i++) t.put(`${BULK_LINE}:${i}`, { lane: 'bulk', stream: 'conversation' });
    await vi.advanceTimersByTimeAsync(ACK_MS * 3 + 50);
    const queuedAt = Date.now();
    t.put('CLICK-REPLY', { lane: 'interactive', stream: 'shell' });
    await vi.advanceTimersByTimeAsync(ACK_MS * 3);
    const reply = t.log.find((b) => b.lines.includes('CLICK-REPLY'))!;
    expect(reply).toBeDefined();
    // At most the rest of the batch in flight when it was queued: one acknowledgement.
    expect(reply.at - queuedAt).toBeLessThanOrEqual(ACK_MS);
    expect(reply.lane).toBe('interactive');
    // Bulk went on afterwards, in order.
    await vi.advanceTimersByTimeAsync(ACK_MS * 50);
    const bulk = t.lines().filter((l) => l.startsWith('xxx')).map((l) => Number(l.split(':').pop()));
    expect(bulk).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it('is not held to the batch window either', async () => {
    const t = rig({ batchMs: 5_000 });
    t.put('first', { lane: 'live', stream: 'conversation' });
    await vi.advanceTimersByTimeAsync(ACK_MS + 10);
    const queuedAt = Date.now();
    t.put('REPLY', { lane: 'interactive', stream: 'shell' });
    await vi.advanceTimersByTimeAsync(10);
    expect(t.log.find((b) => b.lines.includes('REPLY'))!.at - queuedAt).toBeLessThanOrEqual(10);
  });

  it('does not hold a reply to a window timer that a live item set earlier', async () => {
    const t = rig({ batchMs: 5_000 });
    t.put('first', { lane: 'live', stream: 'conversation' });
    await vi.advanceTimersByTimeAsync(ACK_MS + 10);
    // A live item now waits out most of the window...
    t.put('streamed', { lane: 'live', stream: 'conversation' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.lines()).toEqual(['first']);
    // ...and a reply that arrives meanwhile goes at once, without it.
    const queuedAt = Date.now();
    t.put('REPLY', { lane: 'interactive', stream: 'shell' });
    await vi.advanceTimersByTimeAsync(10);
    expect(t.log.find((b) => b.lines.includes('REPLY'))!.at - queuedAt).toBeLessThanOrEqual(10);
    // The live item, small and already due, rides in the same batch, in the order it was queued.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.lines()).toEqual(['first', 'streamed', 'REPLY']);
  });

  it('bounds the batches bulk is cut into', async () => {
    const t = rig({ bulkBatchBytes: 250 * 1024 });
    for (let i = 0; i < 10; i++) t.put(`${BULK_LINE}:${i}`, { lane: 'bulk', stream: 'conversation' });
    await vi.advanceTimersByTimeAsync(ACK_MS * 12);
    expect(t.log.every((b) => b.lines.length <= 2)).toBe(true);
    expect(t.log.length).toBeGreaterThanOrEqual(5);
  });
});

describe('order', () => {
  it('never reorders a stream: what follows a snapshot is sent after it, whatever its lane', async () => {
    const t = rig();
    t.put('first-bulk', { lane: 'bulk', stream: 'conversation' });
    t.put('SNAPSHOT', { lane: 'bulk', stream: 'dashboard' });
    t.put('missionAck', { lane: 'interactive', stream: 'dashboard' });
    t.put('shell-toast', { lane: 'interactive', stream: 'shell' });
    await vi.advanceTimersByTimeAsync(ACK_MS * 6);
    const order = t.lines();
    expect(order.indexOf('SNAPSHOT')).toBeLessThan(order.indexOf('missionAck'));
    // A different stream may overtake: the toast does not wait for either bulk batch.
    expect(order.indexOf('shell-toast')).toBeLessThan(order.indexOf('SNAPSHOT'));
  });

  it('keeps an unclassified item ordered against everything', async () => {
    const t = rig();
    t.put('bulk-a', { lane: 'bulk', stream: 'conversation' });
    t.put('anything', {});
    t.put('shell-after', { lane: 'interactive', stream: 'shell' });
    await vi.advanceTimersByTimeAsync(ACK_MS * 6);
    expect(t.lines()).toEqual(['bulk-a', 'anything', 'shell-after']);
  });

  it('delivers every item exactly once with each stream in order, under a mixed load', async () => {
    const t = rig();
    const streams = ['dashboard', 'conversation', 'shell'];
    const lanes = ['bulk', 'live', 'interactive'] as const;
    const sent: Record<string, string[]> = { dashboard: [], conversation: [], shell: [] };
    let seed = 7;
    const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let i = 0; i < 300; i++) {
      const stream = streams[Math.floor(rand() * 3)];
      const lane = lanes[Math.floor(rand() * 3)];
      const line = `${stream}#${i}${lane === 'bulk' ? ':' + 'y'.repeat(40_000) : ''}`;
      sent[stream].push(`${stream}#${i}`);
      t.put(line, { lane, stream });
      if (i % 20 === 0) await vi.advanceTimersByTimeAsync(40);
    }
    await vi.advanceTimersByTimeAsync(ACK_MS * 400);
    const got = t.lines().map((l) => l.split(':')[0]);
    expect(got).toHaveLength(300);
    expect(new Set(got).size).toBe(300);
    for (const s of streams) expect(got.filter((l) => l.startsWith(`${s}#`))).toEqual(sent[s]);
    expect(t.socket.bufferedAmount).toBe(0);
  });

  it('is first in line for the open, and last for a close that drains everything', async () => {
    const t = rig();
    t.put('b1', { lane: 'bulk', stream: 'conversation' });
    t.put('b2', { lane: 'bulk', stream: 'conversation' });
    t.socket.sendFirst({ k: 'open', build: 'x', protocol: 1 });
    t.socket.close(1001, 'bye');
    await vi.advanceTimersByTimeAsync(ACK_MS * 6);
    expect(t.lines()).toEqual(['<open>', 'b1', 'b2', '<close>']);
    expect(t.isEnded()).toBe(true);
  });
});

describe('fairness and bounds', () => {
  it('does not starve bulk while interactive traffic keeps coming', async () => {
    const t = rig({ batchMs: 1 });
    t.put('BULK', { lane: 'bulk', stream: 'dashboard' });
    // A reply every 50 ms for a minute: each wants a batch of its own.
    for (let i = 0; i < 1200; i++) {
      t.put(`reply${i}`, { lane: 'interactive', stream: 'shell' });
      await vi.advanceTimersByTimeAsync(50);
      if (t.lines().includes('BULK')) break;
    }
    expect(t.lines()).toContain('BULK');
    const before = t.lines().indexOf('BULK');
    // Within a bounded number of batches: not after the whole minute of replies.
    expect(t.log.findIndex((b) => b.lines.includes('BULK'))).toBeLessThanOrEqual(10);
    expect(before).toBeGreaterThanOrEqual(0);
  });

  it('counts what is queued and in flight, so the backpressure ceiling still sees it', async () => {
    const t = rig();
    for (let i = 0; i < 20; i++) t.put(`${BULK_LINE}:${i}`, { lane: 'bulk', stream: 'conversation' });
    expect(t.socket.bufferedAmount).toBeGreaterThan(20 * 100 * 1024 - 1);
    await vi.advanceTimersByTimeAsync(ACK_MS * 3 + 10);
    expect(t.socket.bufferedAmount).toBeLessThan(20 * 100 * 1024);
    expect(t.socket.bufferedAmount).toBeGreaterThan(10 * 100 * 1024);
    await vi.advanceTimersByTimeAsync(ACK_MS * 30);
    expect(t.socket.bufferedAmount).toBe(0);
  });

  it('ends the tab when a send fails, and sends nothing more', async () => {
    const t = rig({ failAt: 2 });
    for (let i = 0; i < 5; i++) t.put(`${BULK_LINE}:${i}`, { lane: 'bulk', stream: 'conversation' });
    await vi.advanceTimersByTimeAsync(ACK_MS * 10);
    expect(t.isEnded()).toBe(true);
    expect(t.log.length).toBeLessThanOrEqual(3);
  });
});
