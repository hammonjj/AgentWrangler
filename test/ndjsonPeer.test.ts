import { describe, expect, it } from 'vitest';
import { NdjsonPeer, type IncomingNotification } from '../src/core/rpc/ndjsonPeer';

function peer(maxLineBytes?: number) {
  const got: IncomingNotification[] = [];
  let oversize = 0;
  const p = new NdjsonPeer({ write: () => undefined, maxLineBytes, onOversize: () => oversize++ });
  p.onNotification((n) => got.push(n));
  return { p, got, oversize: () => oversize };
}

const line = (method: string, params?: unknown) => `${JSON.stringify({ method, params })}\n`;

describe('NdjsonPeer framing', () => {
  it('joins a line split across many chunks, and dispatches several lines from one chunk', () => {
    const { p, got } = peer();
    const big = line('big', { text: 'x'.repeat(200_000) });
    for (let i = 0; i < big.length; i += 1000) p.feed(big.slice(i, i + 1000));
    p.feed(`${line('a')}${line('b')}${line('c').slice(0, 5)}`);
    p.feed(line('c').slice(5));
    expect(got.map((n) => n.method)).toEqual(['big', 'a', 'b', 'c']);
    expect((got[0].params as { text: string }).text).toHaveLength(200_000);
  });

  it('keeps multi-byte characters split across chunks intact', () => {
    const { p, got } = peer();
    const bytes = Buffer.from(line('u', { text: 'héllo ✓' }), 'utf8');
    const cut = bytes.indexOf(0xe2) + 1; // inside the three-byte check mark
    p.feed(bytes.subarray(0, cut));
    p.feed(bytes.subarray(cut));
    expect(got[0].params).toEqual({ text: 'héllo ✓' });
  });

  it('rejects an over-long line whole, including the part that arrives after the limit, and carries on', () => {
    const { p, got, oversize } = peer(1000);
    const long = line('long', { text: 'y'.repeat(5000) });
    for (let i = 0; i < long.length; i += 700) p.feed(long.slice(i, i + 700));
    p.feed(line('after'));
    expect(oversize()).toBe(1);
    expect(got.map((n) => n.method)).toEqual(['after']);
  });

  it('rejects an over-long line that arrives in one chunk', () => {
    const { p, got, oversize } = peer(100);
    p.feed(`${line('long', { text: 'z'.repeat(500) })}${line('ok')}`);
    expect(oversize()).toBe(1);
    expect(got.map((n) => n.method)).toEqual(['ok']);
  });

  it('has no limit when told so', () => {
    const { p, got, oversize } = peer(Number.POSITIVE_INFINITY);
    p.feed(line('huge', { text: 'w'.repeat(100_000) }));
    expect(oversize()).toBe(0);
    expect(got).toHaveLength(1);
  });
});
