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
/** The daemon's lobby self-check (#186): a random nonce, nothing else. */
export const RELAY_EVENT_PROBE = 'probe';

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
  | { k: 'open'; build: string; protocol: number; vapid?: string }
  /** The device's Web Push subscription (#177), or null to stop. The daemon checks its shape. */
  | { k: 'push'; sub: unknown }
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
        out.push({ k: 'open', build: i.build, protocol: i.protocol, ...(typeof i.vapid === 'string' ? { vapid: i.vapid } : {}) });
        break;
      case 'push':
        out.push({ k: 'push', sub: i.sub ?? null });
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

// ---- password sign-in and enrollment (#187; plan §3.1) ----

/** A device asking, on the lobby, to be enrolled with the remote password. */
export const RELAY_EVENT_ENROLL = 'enroll';
/** The daemon's answer, on the reply topic the device named. */
export const RELAY_EVENT_ENROLLED = 'enrolled';
export const RELAY_PASSWORD_MIN = 12;
export const RELAY_PBKDF2_ITERATIONS = 600_000;

/** What a remote password turns into. Neither is the password, and only `authValue` leaves the device. */
export interface RelayPasswordValues {
  /** The Supabase password, hex. */
  authValue: string;
  /** The enrollment key, base64url (32 bytes). Never sent anywhere. */
  enrollKey: string;
}

/**
 * The two values a remote password stands for: PBKDF2 over the password, salted with the
 * account's email, then HKDF to two independent keys. Both ends run this.
 */
export async function deriveRelayPassword(email: string, password: string, iterations = RELAY_PBKDF2_ITERATIONS): Promise<RelayPasswordValues> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(password) as BufferSource, 'PBKDF2', false, ['deriveBits']);
  const master = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(`aw-v1|${email.trim().toLowerCase()}`) as BufferSource, iterations },
    base,
    512,
  );
  const hkdf = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
  const expand = async (info: string) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(info) as BufferSource }, hkdf, 256));
  const auth = await expand('aw auth');
  return { authValue: [...auth].map((b) => b.toString(16).padStart(2, '0')).join(''), enrollKey: toBase64Url(await expand('aw enroll')) };
}

/** A device asking to be enrolled. `c` seals `{ts, pub, label}` under the enrollment key. */
export interface EnrollRequest {
  v: number;
  /** The reply topic's id: the device has joined `connectionTopic(uid, t)` and waits there. */
  t: string;
  n: string;
  c: string;
}

/** The daemon's answer: its ECDH public key in clear, and the device's id and key sealed. */
export interface EnrollReply {
  v: number;
  p: string;
  n: string;
  c: string;
}

export function parseEnrollRequest(value: unknown): EnrollRequest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Record<string, unknown>;
  if (typeof r.v !== 'number' || !isRelayId(r.t) || typeof r.n !== 'string' || typeof r.c !== 'string' || r.c.length > 4096) return undefined;
  return { v: r.v, t: r.t, n: r.n, c: r.c };
}

export function parseEnrollReply(value: unknown): EnrollReply | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Record<string, unknown>;
  if (typeof r.v !== 'number' || typeof r.p !== 'string' || r.p.length > 200 || typeof r.n !== 'string' || typeof r.c !== 'string' || r.c.length > 4096) return undefined;
  return { v: r.v, p: r.p, n: r.n, c: r.c };
}

function enrollKeyOf(enrollKey: string): Promise<CryptoKey> {
  return importRelayKey(enrollKey);
}

/** An ephemeral ECDH key pair, and its public half as base64 (raw point). */
export async function newEnrollKeyPair(): Promise<{ pair: CryptoKeyPair; pub: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])) as CryptoKeyPair;
  const pub = toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  return { pair, pub };
}

/**
 * The key the device's id and key travel under: HKDF over the ECDH secret, salted with the
 * enrollment key. A recorded exchange stays closed to someone who learns the password later
 * (no ECDH secret), and neither end can be impersonated without the enrollment key.
 */
async function enrollWrapKey(own: CryptoKey, theirPub: string, enrollKey: string, t: string): Promise<CryptoKey> {
  const pub = await crypto.subtle.importKey('raw', fromBase64(theirPub) as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, own, 256);
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: fromBase64Url(enrollKey) as BufferSource, info: encoder.encode(`aw enroll reply|${t}`) as BufferSource },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sealEnroll(enrollKey: string, uid: string, t: string, pub: string, label: string, nowMs: number): Promise<EnrollRequest> {
  const plain = encoder.encode(JSON.stringify({ ts: nowMs, pub, label: label.slice(0, 80) }));
  const { n, c } = await seal(await enrollKeyOf(enrollKey), plain, aad(['enroll', lobbyTopic(uid), t]));
  return { v: RELAY_PROTOCOL, t, n, c };
}

/** The device's ECDH key and label when `req` was sealed with `enrollKey`, for this lobby, recently. */
export async function openEnroll(enrollKey: string, req: EnrollRequest, uid: string, nowMs: number): Promise<{ pub: string; label: string } | undefined> {
  if (req.v !== RELAY_PROTOCOL) return undefined;
  const plain = await open(await enrollKeyOf(enrollKey), req.n, req.c, aad(['enroll', lobbyTopic(uid), req.t]));
  if (!plain) return undefined;
  try {
    const body = JSON.parse(decoder.decode(plain)) as { ts?: unknown; pub?: unknown; label?: unknown };
    if (typeof body.ts !== 'number' || Math.abs(nowMs - body.ts) > RELAY_CONNECT_WINDOW_MS) return undefined;
    if (typeof body.pub !== 'string' || body.pub.length > 200) return undefined;
    return { pub: body.pub, label: typeof body.label === 'string' ? body.label.slice(0, 80) : 'Remote device' };
  } catch {
    return undefined;
  }
}

/** The daemon's answer to an enrollment it accepted: the new device's id and key. */
export async function sealEnrollReply(enrollKey: string, uid: string, t: string, devicePub: string, deviceId: string, key: string): Promise<EnrollReply> {
  const own = await newEnrollKeyPair();
  const wrap = await enrollWrapKey(own.pair.privateKey, devicePub, enrollKey, t);
  const { n, c } = await seal(wrap, encoder.encode(JSON.stringify({ d: deviceId, k: key })), aad(['enrolled', uid, t, devicePub, own.pub]));
  return { v: RELAY_PROTOCOL, p: own.pub, n, c };
}

/** The device's id and key from the daemon's answer, or undefined when it does not authenticate. */
export async function openEnrollReply(
  enrollKey: string,
  uid: string,
  t: string,
  own: { pair: CryptoKeyPair; pub: string },
  reply: EnrollReply,
): Promise<{ deviceId: string; key: string } | undefined> {
  if (reply.v !== RELAY_PROTOCOL) return undefined;
  try {
    const wrap = await enrollWrapKey(own.pair.privateKey, reply.p, enrollKey, t);
    const plain = await open(wrap, reply.n, reply.c, aad(['enrolled', uid, t, own.pub, reply.p]));
    if (!plain) return undefined;
    const body = JSON.parse(decoder.decode(plain)) as { d?: unknown; k?: unknown };
    if (typeof body.d !== 'string' || body.d.length === 0 || body.d.length > 64 || typeof body.k !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.k)) return undefined;
    return { deviceId: body.d, key: body.k };
  } catch {
    return undefined;
  }
}

/** Which Supabase project a device talks through. Both public values; the link carries them so the site needs no configuration. */
export interface RelayProject {
  url: string;
  anonKey: string;
}

export interface RelayPairing {
  deviceId: string;
  key: string;
  project: RelayProject;
}

/**
 * The link a device is paired with: the loader's origin, then in the fragment (which a browser
 * never sends to the site) the device id, its key, and the project.
 */
export function relayPairingLink(origin: string, deviceId: string, key: string, project: RelayProject): string {
  const p = new URLSearchParams({ pair: `${deviceId}.${key}`, u: project.url, a: project.anonKey });
  return `${origin.replace(/\/+$/, '')}/#${p.toString()}`;
}

/** What a pairing fragment holds, or undefined when it is not one. */
export function parsePairingFragment(hash: string): RelayPairing | undefined {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const m = /^([^.]{1,64})\.([A-Za-z0-9_-]{43})$/.exec(p.get('pair') ?? '');
  const url = p.get('u') ?? '';
  const anonKey = p.get('a') ?? '';
  if (!m || !/^https?:\/\/[^\s/]+$/.test(url) || !/^[A-Za-z0-9._-]{20,1024}$/.test(anonKey)) return undefined;
  return { deviceId: m[1], key: m[2], project: { url, anonKey } };
}
