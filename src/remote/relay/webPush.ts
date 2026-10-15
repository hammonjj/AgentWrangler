/**
 * Web Push from the core daemon (#177): a "needs you" notice to a paired device's phone while
 * no page is open. An outbound HTTPS POST to the browser's own push service (Apple, Google,
 * Mozilla, Microsoft); no Supabase hop and nothing listening here.
 *
 * - **VAPID** (RFC 8292): an ES256 JWT names this daemon to the push service. The key pair is
 *   made once and kept in the data dir (0600), like the TLS keys.
 * - **Payload encryption** (RFC 8291, `aes128gcm`): the notice is encrypted to the browser's
 *   own subscription key, so the push service carries ciphertext it cannot read.
 *
 * Written against `node:crypto` rather than adding a dependency: it is two HKDFs, one ECDH and
 * one AES-GCM.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const VAPID_FILE = 'relay-vapid.json';

/** What a browser's `PushSubscription` gives us: where to post, and the keys to encrypt to. */
export interface PushSubscriptionInfo {
  endpoint: string;
  /** The browser's P-256 public key, base64url (65 bytes uncompressed). */
  p256dh: string;
  /** The browser's auth secret, base64url (16 bytes). */
  auth: string;
}

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url: the `applicationServerKey` a page subscribes with. */
  publicKey: string;
  privateKeyPem: string;
}

/** The push services browsers use. A subscription naming anywhere else is not posted to. */
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /^android\.googleapis\.com$/];

export function isPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export function parsePushSubscription(value: unknown): PushSubscriptionInfo | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const s = value as Record<string, unknown>;
  if (typeof s.endpoint !== 'string' || s.endpoint.length > 1024 || !isPushEndpoint(s.endpoint)) return undefined;
  if (typeof s.p256dh !== 'string' || !/^[A-Za-z0-9_-]{86,88}$/.test(s.p256dh)) return undefined;
  if (typeof s.auth !== 'string' || !/^[A-Za-z0-9_-]{21,24}$/.test(s.auth)) return undefined;
  return { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth };
}

function rawPublicKey(key: crypto.KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
}

/** This daemon's VAPID keys: read from `dataDir`, or made and kept there. */
export function loadOrCreateVapid(dataDir: string): VapidKeys {
  const file = path.join(dataDir, VAPID_FILE);
  try {
    const k = JSON.parse(fs.readFileSync(file, 'utf8')) as VapidKeys;
    if (typeof k.publicKey === 'string' && typeof k.privateKeyPem === 'string') return k;
  } catch {
    // None yet, or unreadable: make a new pair (subscriptions made with the old one lapse).
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keys: VapidKeys = {
    publicKey: rawPublicKey(publicKey).toString('base64url'),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

/** The `Authorization` header for `endpoint` (RFC 8292). */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowMs = Date.now()): string {
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject })).toString('base64url');
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: keys.privateKeyPem, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${signature.toString('base64url')}, k=${keys.publicKey}`;
}

/**
 * Encrypt `plaintext` to a subscription (RFC 8291 §3–4, one `aes128gcm` record). `ephemeral`
 * and `salt` are for tests; normally both are fresh per message.
 */
export function encryptPayload(
  sub: Pick<PushSubscriptionInfo, 'p256dh' | 'auth'>,
  plaintext: Buffer,
  opts: { ephemeral?: crypto.ECDH; salt?: Buffer } = {},
): Buffer {
  const uaPublic = Buffer.from(sub.p256dh, 'base64url');
  const authSecret = Buffer.from(sub.auth, 'base64url');
  const ecdh = opts.ephemeral ?? crypto.createECDH('prime256v1');
  if (!opts.ephemeral) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = opts.salt ?? crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // One record, so it is the last: padding delimiter 0x02.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** The notice a device's service worker shows. Ids and short text only. */
export interface PushNotice {
  title: string;
  body: string;
  tag?: string;
  /** The conversation tapping it opens. */
  key?: string;
}

export type PushOutcome = 'sent' | 'gone' | 'failed';

/** Post one notice. `gone`: the subscription has lapsed and should be forgotten. */
export async function sendPush(
  sub: PushSubscriptionInfo,
  notice: PushNotice,
  keys: VapidKeys,
  subject: string,
  post: typeof fetch = fetch,
): Promise<PushOutcome> {
  if (!isPushEndpoint(sub.endpoint)) return 'gone';
  const payload = encryptPayload(sub, Buffer.from(JSON.stringify(notice)));
  try {
    const res = await post(sub.endpoint, {
      method: 'POST',
      headers: {
        authorization: vapidAuthorization(sub.endpoint, keys, subject),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: '3600',
        urgency: 'high',
        ...(notice.tag ? { topic: notice.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
      },
      body: new Uint8Array(payload),
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}
