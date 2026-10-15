import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encryptPayload, isPushEndpoint, loadOrCreateVapid, parsePushSubscription, sendPush, vapidAuthorization } from '../src/remote/relay/webPush';

/** The browser's half of RFC 8291: decrypt what `encryptPayload` made. */
function decrypt(body: Buffer, ua: crypto.ECDH, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  expect(plain.at(-1)).toBe(2); // last-record delimiter
  return plain.subarray(0, -1);
}

function browserSubscription() {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ua, auth, sub: { endpoint: 'https://web.push.apple.com/abc', p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}

describe('web push (#177)', () => {
  it('encrypts a payload the subscribing browser can decrypt (RFC 8291)', () => {
    const { ua, auth, sub } = browserSubscription();
    const body = encryptPayload(sub, Buffer.from('{"title":"x"}'));
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(decrypt(body, ua, auth).toString()).toBe('{"title":"x"}');
  });

  it('signs a VAPID token the push service can verify (RFC 8292)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-vapid-'));
    const keys = loadOrCreateVapid(dir);
    expect(loadOrCreateVapid(dir)).toEqual(keys); // kept, not remade
    expect(fs.statSync(path.join(dir, 'relay-vapid.json')).mode & 0o777).toBe(0o600);
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/x', keys, 'https://agentwrangler.netlify.app', 1_000_000_000);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    expect(JSON.parse(Buffer.from(m[2], 'base64url').toString())).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'https://agentwrangler.netlify.app' });
    const raw = Buffer.from(m[4], 'base64url');
    const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('posts only to real push services', () => {
    expect(isPushEndpoint('https://web.push.apple.com/x')).toBe(true);
    expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/x')).toBe(true);
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isPushEndpoint('http://web.push.apple.com/x')).toBe(false);
    expect(isPushEndpoint('https://127.0.0.1/x')).toBe(false);
    expect(isPushEndpoint('https://evil.example/web.push.apple.com')).toBe(false);
    expect(parsePushSubscription({ endpoint: 'https://evil.example/', p256dh: 'x', auth: 'y' })).toBeUndefined();
    expect(parsePushSubscription(browserSubscription().sub)).toBeDefined();
  });

  it('reports a lapsed subscription as gone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-vapid-'));
    const keys = loadOrCreateVapid(dir);
    const { sub } = browserSubscription();
    const calls: RequestInit[] = [];
    const post = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(null, { status: 410 });
    }) as unknown as typeof fetch;
    expect(await sendPush(sub, { title: 't', body: 'b', tag: 'ask:1' }, keys, 'https://x', post)).toBe('gone');
    expect((calls[0].headers as Record<string, string>)['content-encoding']).toBe('aes128gcm');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
