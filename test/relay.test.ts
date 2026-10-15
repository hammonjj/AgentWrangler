import { describe, expect, it } from 'vitest';
import {
  RELAY_CONNECT_WINDOW_MS,
  RELAY_MAX_PART_BYTES,
  RelayCodec,
  connectionTopic,
  fromBase64Url,
  importRelayKey,
  newRelayId,
  newRelayKey,
  openConnect,
  parseConnectRequest,
  parsePairingFragment,
  parseRelayItems,
  parseSealedPart,
  relayPairingLink,
  sealConnect,
  type RelayItem,
} from '../src/shared/relay';

const UID = '00000000-0000-4000-8000-000000000001';

async function pair(): Promise<{ daemon: RelayCodec; browser: RelayCodec; topic: string }> {
  const key = await importRelayKey(newRelayKey());
  const topic = connectionTopic(UID, newRelayId());
  return { daemon: new RelayCodec(key, 'dev1', topic, 'd2b'), browser: new RelayCodec(key, 'dev1', topic, 'b2d'), topic };
}

describe('relay keys and ids', () => {
  it('makes 32-byte keys and topic-safe ids', () => {
    expect(fromBase64Url(newRelayKey())).toHaveLength(32);
    expect(newRelayId()).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });

  it('round-trips a pairing link through its fragment', () => {
    const key = newRelayKey();
    const project = { url: 'https://abcd1234.supabase.co', anonKey: 'sb_publishable_ABCDEFGHIJKLMNOPQRSTUV' };
    const link = relayPairingLink('https://agentwrangler.netlify.app/', 'abc-123', key, project);
    expect(link.startsWith('https://agentwrangler.netlify.app/#pair=abc-123.')).toBe(true);
    expect(parsePairingFragment(new URL(link).hash)).toEqual({ deviceId: 'abc-123', key, project });
    expect(parsePairingFragment('#pair=abc.short')).toBeUndefined();
    // A project URL with a path, or a key with odd characters, is not one a link carries.
    expect(parsePairingFragment(new URL(relayPairingLink('https://x', 'a', key, { ...project, url: 'https://evil.example/x' })).hash)).toBeUndefined();
  });
});

describe('relay codec', () => {
  it('carries a batch from the daemon to the browser and back', async () => {
    const { daemon, browser } = await pair();
    const items: RelayItem[] = [{ k: 'open', build: 'b1', protocol: 1 }, { k: 'data', line: '{"pane":"dashboard"}' }];
    const parts = await daemon.seal(items);
    expect(parts).toHaveLength(1);
    expect(await browser.open(parts[0])).toEqual(items);
    const back = await browser.seal([{ k: 'pong' }]);
    expect(await daemon.open(back[0])).toEqual([{ k: 'pong' }]);
  });

  it('splits a batch too big for one broadcast into parts and reassembles it', async () => {
    const { daemon, browser } = await pair();
    // Random text barely compresses, so this needs several parts.
    let noise = '';
    while (noise.length < RELAY_MAX_PART_BYTES * 3) noise += Array.from(crypto.getRandomValues(new Uint8Array(65_536)), (b) => b.toString(36)).join('');
    const parts = await daemon.seal([{ k: 'data', line: noise }]);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.slice(0, -1).every((p) => p.m === 1)).toBe(true);
    expect(parts.at(-1)?.m).toBeUndefined();
    for (const p of parts) expect(JSON.stringify(p).length).toBeLessThan(256 * 1024);
    let got: RelayItem[] | undefined;
    for (const p of parts) got = await browser.open(p);
    expect(got).toEqual([{ k: 'data', line: noise }]);
  });

  it('refuses a replayed, reordered or reflected part', async () => {
    const a = await pair();
    const [p1] = await a.daemon.seal([{ k: 'ping' }]);
    const [p2] = await a.daemon.seal([{ k: 'ping' }]);
    expect(await a.browser.open(p2)).toBeUndefined(); // out of order

    const b = await pair();
    const [q1] = await b.daemon.seal([{ k: 'ping' }]);
    expect(await b.browser.open(q1)).toEqual([{ k: 'ping' }]);
    expect(await b.browser.open(q1)).toBeUndefined(); // replayed

    const c = await pair();
    const [r1] = await c.daemon.seal([{ k: 'ping' }]);
    expect(await c.daemon.open(r1)).toBeUndefined(); // sent back to its sender
    void p1;
  });

  it('refuses a part moved to another channel or sealed under another key', async () => {
    const key = await importRelayKey(newRelayKey());
    const here = new RelayCodec(key, 'dev1', connectionTopic(UID, 'aaaaaaaaaaaaaaaaaaaaaaaa'), 'd2b');
    const there = new RelayCodec(key, 'dev1', connectionTopic(UID, 'bbbbbbbbbbbbbbbbbbbbbbbb'), 'b2d');
    const [part] = await here.seal([{ k: 'ping' }]);
    expect(await there.open(part)).toBeUndefined();

    const other = new RelayCodec(await importRelayKey(newRelayKey()), 'dev1', connectionTopic(UID, 'aaaaaaaaaaaaaaaaaaaaaaaa'), 'b2d');
    expect(await other.open(part)).toBeUndefined();
  });

  it('refuses a tampered ciphertext', async () => {
    const { daemon, browser } = await pair();
    const [part] = await daemon.seal([{ k: 'data', line: 'x' }]);
    const flipped = part.c.startsWith('A') ? `B${part.c.slice(1)}` : `A${part.c.slice(1)}`;
    expect(await browser.open({ ...part, c: flipped })).toBeUndefined();
  });
});

describe('relay connect', () => {
  it('accepts a recent request sealed by the key holder', async () => {
    const key = await importRelayKey(newRelayKey());
    const req = await sealConnect(key, 'dev1', UID, newRelayId(), 1_000_000);
    expect(parseConnectRequest(JSON.parse(JSON.stringify(req)))).toEqual(req);
    expect(await openConnect(key, req, UID, 1_000_000 + 5_000)).toBe(true);
  });

  it('refuses a stale one, another user\'s lobby, or another key', async () => {
    const key = await importRelayKey(newRelayKey());
    const req = await sealConnect(key, 'dev1', UID, newRelayId(), 1_000_000);
    expect(await openConnect(key, req, UID, 1_000_000 + RELAY_CONNECT_WINDOW_MS + 1)).toBe(false);
    expect(await openConnect(key, req, '00000000-0000-4000-8000-000000000002', 1_000_000)).toBe(false);
    expect(await openConnect(await importRelayKey(newRelayKey()), req, UID, 1_000_000)).toBe(false);
    // The connection id is bound in: a request cannot be pointed at another channel.
    expect(await openConnect(key, { ...req, t: newRelayId() }, UID, 1_000_000)).toBe(false);
  });
});

describe('relay parsing', () => {
  it('refuses shapes no peer sends', () => {
    expect(parseRelayItems([{ k: 'data' }])).toBeUndefined();
    expect(parseRelayItems([{ k: 'nope' }])).toBeUndefined();
    expect(parseRelayItems({})).toBeUndefined();
    expect(parseSealedPart({ s: 0, n: '', c: '' })).toBeUndefined();
    expect(parseConnectRequest({ v: 1, d: 'x', t: 'short', n: '', c: '' })).toBeUndefined();
  });
});
