/**
 * The remote-control relay's wire format (#112, #173, #174;
 * `docs/plans/remote-control-supabase.md` §1–§3).
 *
 * The relay carries the workbench's own envelopes between a remote tab and the core daemon
 * through Supabase Realtime Broadcast. Supabase only ever sees what is defined here: topic
 * names, a device id, sequence numbers and ciphertext.
 *
 * - **Topics.** `aw:<uid>:lobby`, where a device asks to connect, and `aw:<uid>:c:<id>`, one per
 *   tab. RLS lets a user join only topics carrying their own uid (`supabase/migrations`).
 * - **Encryption.** AES-256-GCM under the device's key, which pairing put on the device and
 *   which never leaves it or the Mac. A random 96-bit nonce per sealed part, and additional
 *   data binding direction, device, topic and sequence number, so a part cannot be replayed,
 *   reordered or moved to another channel or direction.
 * - **Batching and compression.** Everything one side has to say in a short window goes as one
 *   batch: a JSON list of items, deflated, then sealed. A batch too big for one Broadcast is
 *   sealed in parts (`m: 1` on all but the last), each part under its own sequence number.
 *
 * Shared by the daemon and the browser loader: WebCrypto (`crypto.subtle`) and
 * `CompressionStream` are globals in both, so nothing is imported.
 */

export const RELAY_PROTOCOL = 1;

/** Broadcast events. */
export const RELAY_EVENT_CONNECT = 'connect';
export const RELAY_EVENT_FRAME = 'f';

/** Under Supabase's 256 KB Broadcast payload limit on the free plan, with room for the envelope. */
export const RELAY_MAX_PART_BYTES = 150 * 1024;
/** How long a side waits to batch what it has to say. */
export const RELAY_BATCH_MS = 250;
/** A `connect` older than this, or from further in the future, is refused. */
export const RELAY_CONNECT_WINDOW_MS = 2 * 60 * 1000;
/** A batch, reassembled, may not inflate past this: a bound on what a peer can make us hold. */
export const RELAY_MAX_BATCH_BYTES = 16 * 1024 * 1024;

export function lobbyTopic(uid: string): string {
  return `aw:${uid}:lobby`;
}

export function connectionTopic(uid: string, connectionId: string): string {
  return `aw:${uid}:c:${connectionId}`;
}

/** A connection id: random, url-safe, and short enough for a topic name. */
export function isRelayId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

export type RelayDirection = 'd2b' | 'b2d';

// ---- items: what a batch carries ----

/**
 * One thing one side says to the other.
 * - `open`: the daemon accepted the connection. Its build, and what the relay cannot do.
 * - `data`: one workbench envelope, as the JSON text a WebSocket would have carried.
 * - `ping` / `pong`: liveness, which a WebSocket gets from its control frames.
 * - `close`: this side is done; the other should leave the channel too.
 * - `assets`: the loader asks for the workbench's files for `build`; `asset` is one of them.
 */
export type RelayItem =
  | { k: 'open'; build: string; protocol: number }
  | { k: 'data'; line: string }
  | { k: 'ping' }
  | { k: 'pong' }
  | { k: 'close'; code?: number; reason?: string }
  | { k: 'assets'; build: string }
  | { k: 'asset'; build: string; name: string; type: string; text: string; last?: boolean };

export function parseRelayItems(value: unknown): RelayItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: RelayItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return undefined;
    const i = raw as Record<string, unknown>;
    switch (i.k) {
      case 'open':
        if (typeof i.build !== 'string' || typeof i.protocol !== 'number') return undefined;
        out.push({ k: 'open', build: i.build, protocol: i.protocol });
        break;
      case 'data':
        if (typeof i.line !== 'string') return undefined;
        out.push({ k: 'data', line: i.line });
        break;
      case 'ping':
      case 'pong':
        out.push({ k: i.k });
        break;
      case 'close':
        out.push({
          k: 'close',
          ...(typeof i.code === 'number' ? { code: i.code } : {}),
          ...(typeof i.reason === 'string' ? { reason: i.reason.slice(0, 120) } : {}),
        });
        break;
      case 'assets':
        if (typeof i.build !== 'string') return undefined;
        out.push({ k: 'assets', build: i.build });
        break;
      case 'asset':
        if (typeof i.build !== 'string' || typeof i.name !== 'string' || typeof i.type !== 'string' || typeof i.text !== 'string') return undefined;
        out.push({ k: 'asset', build: i.build, name: i.name, type: i.type, text: i.text, ...(i.last === true ? { last: true } : {}) });
        break;
      default:
        return undefined;
    }
  }
  return out;
}

// ---- the wire ----

/** One sealed part, as a Broadcast payload. */
export interface SealedPart {
  /** Sequence number, per direction per channel, from 1. */
  s: number;
  /** Nonce, base64. */
  n: string;
  /** Ciphertext with its tag, base64. */
  c: string;
  /** More parts of this batch follow. */
  m?: 1;
}

/** A device asking, on the lobby, for a channel. `c` seals `{ts, t}` so only the key holder can ask. */
export interface ConnectRequest {
  v: number;
  /** The device id: in clear, so the daemon knows which key to try. */
  d: string;
  /** The connection id the device chose; the channel is `connectionTopic(uid, t)`. */
  t: string;
  n: string;
  c: string;
}

export function parseSealedPart(value: unknown): SealedPart | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const p = value as Record<string, unknown>;
  if (!Number.isSafeInteger(p.s) || (p.s as number) < 1) return undefined;
  if (typeof p.n !== 'string' || typeof p.c !== 'string' || p.c.length > RELAY_MAX_PART_BYTES * 2) return undefined;
  return { s: p.s as number, n: p.n, c: p.c, ...(p.m === 1 ? { m: 1 as const } : {}) };
}

export function parseConnectRequest(value: unknown): ConnectRequest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Record<string, unknown>;
  if (typeof r.v !== 'number' || typeof r.d !== 'string' || r.d.length === 0 || r.d.length > 64) return undefined;
  if (!isRelayId(r.t) || typeof r.n !== 'string' || typeof r.c !== 'string' || r.c.length > 4096) return undefined;
  return { v: r.v, d: r.d, t: r.t, n: r.n, c: r.c };
}

// ---- bytes ----

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(bytes as BufferSource).then(() => writer.close()).catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error('relay: batch too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new CompressionStream('deflate-raw'));
}

export function inflate(bytes: Uint8Array, limit = RELAY_MAX_BATCH_BYTES): Promise<Uint8Array> {
  return pipe(bytes, new DecompressionStream('deflate-raw'), limit);
}

// ---- keys ----

/** A new device key: 32 random bytes, base64url, as it goes in the pairing link. */
export function newRelayKey(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** A new connection id. */
export function newRelayId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(18)));
}

/** A device key for AES-GCM. Non-extractable: once imported, script cannot read it back. */
export function importRelayKey(key: string): Promise<CryptoKey> {
  const raw = fromBase64Url(key);
  if (raw.length !== 32) throw new Error('relay: a device key is 32 bytes');
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function aad(parts: (string | number)[]): Uint8Array {
  return encoder.encode(parts.join('|'));
}

async function seal(key: CryptoKey, plain: Uint8Array, additional: Uint8Array): Promise<{ n: string; c: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additional as BufferSource }, key, plain as BufferSource));
  return { n: toBase64(iv), c: toBase64(ct) };
}

/** Undefined when it does not authenticate: a wrong key, a changed byte or the wrong additional data. */
async function open(key: CryptoKey, n: string, c: string, additional: Uint8Array): Promise<Uint8Array | undefined> {
  try {
    const iv = fromBase64(n);
    if (iv.length !== 12) return undefined;
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: additional as BufferSource }, key, fromBase64(c) as BufferSource));
  } catch {
    return undefined;
  }
}

// ---- connect ----

export async function sealConnect(key: CryptoKey, deviceId: string, uid: string, connectionId: string, nowMs: number): Promise<ConnectRequest> {
  const plain = encoder.encode(JSON.stringify({ ts: nowMs, t: connectionId }));
  const { n, c } = await seal(key, plain, aad(['connect', deviceId, lobbyTopic(uid), connectionId]));
  return { v: RELAY_PROTOCOL, d: deviceId, t: connectionId, n, c };
}

/** True when `req` was sealed by the holder of `key`, for this lobby, recently. */
export async function openConnect(key: CryptoKey, req: ConnectRequest, uid: string, nowMs: number): Promise<boolean> {
  if (req.v !== RELAY_PROTOCOL) return false;
  const plain = await open(key, req.n, req.c, aad(['connect', req.d, lobbyTopic(uid), req.t]));
  if (!plain) return false;
  try {
    const body = JSON.parse(decoder.decode(plain)) as { ts?: unknown; t?: unknown };
    return typeof body.ts === 'number' && body.t === req.t && Math.abs(nowMs - body.ts) <= RELAY_CONNECT_WINDOW_MS;
  } catch {
    return false;
  }
}

// ---- a channel's codec ----

/**
 * One side of one channel: seals what it sends, opens what it receives, and refuses anything
 * out of sequence. `direction` is the way this side sends.
 */
export class RelayCodec {
  private sendSeq = 0;
  private recvSeq = 0;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;

  constructor(
    private readonly key: CryptoKey,
    private readonly deviceId: string,
    private readonly topic: string,
    private readonly direction: RelayDirection,
  ) {}

  private additional(dir: RelayDirection, seq: number): Uint8Array {
    return aad([dir, this.deviceId, this.topic, seq]);
  }

  /** The parts to broadcast, in order, for one batch. */
  async seal(items: RelayItem[]): Promise<SealedPart[]> {
    const packed = await deflate(encoder.encode(JSON.stringify(items)));
    const parts: SealedPart[] = [];
    for (let at = 0; at < packed.length || parts.length === 0; at += RELAY_MAX_PART_BYTES) {
      const chunk = packed.subarray(at, at + RELAY_MAX_PART_BYTES);
      const s = ++this.sendSeq;
      const { n, c } = await seal(this.key, chunk, this.additional(this.direction, s));
      const more = at + RELAY_MAX_PART_BYTES < packed.length;
      parts.push({ s, n, c, ...(more ? { m: 1 as const } : {}) });
    }
    return parts;
  }

  /**
   * One received part. The batch's items once its last part arrives; `[]` while more are
   * owed; undefined when the part is refused (out of sequence, forged, or garbled), after
   * which the channel should be dropped: a relay does not lose or reorder messages.
   */
  async open(part: SealedPart): Promise<RelayItem[] | undefined> {
    if (part.s !== this.recvSeq + 1) return undefined;
    const theirs: RelayDirection = this.direction === 'd2b' ? 'b2d' : 'd2b';
    const plain = await open(this.key, part.n, part.c, this.additional(theirs, part.s));
    if (!plain) return undefined;
    this.recvSeq = part.s;
    this.pending.push(plain);
    this.pendingBytes += plain.length;
    if (this.pendingBytes > RELAY_MAX_BATCH_BYTES) return undefined;
    if (part.m === 1) return [];
    const whole = new Uint8Array(this.pendingBytes);
    let at = 0;
    for (const p of this.pending) {
      whole.set(p, at);
      at += p.length;
    }
    this.pending = [];
    this.pendingBytes = 0;
    try {
      return parseRelayItems(JSON.parse(decoder.decode(await inflate(whole))));
    } catch {
      return undefined;
    }
  }
}

/** The link a device is paired with: the loader's origin, the device id and its key in the fragment. */
export function relayPairingLink(origin: string, deviceId: string, key: string): string {
  return `${origin.replace(/\/+$/, '')}/#pair=${encodeURIComponent(deviceId)}.${key}`;
}

/** The device id and key from a pairing fragment (`#pair=<id>.<key>`), or undefined. */
export function parsePairingFragment(hash: string): { deviceId: string; key: string } | undefined {
  const m = /^#?pair=([^.]{1,64})\.([A-Za-z0-9_-]{43})$/.exec(hash);
  if (!m) return undefined;
  return { deviceId: decodeURIComponent(m[1]), key: m[2] };
}
