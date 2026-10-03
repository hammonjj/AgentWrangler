import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccessGate, type AccessAuditRecord, type RequestContext } from '../src/core/access';
import { AssetManifest, isInside } from '../src/core/web/assets';
import { DEVICE_TTL_MS, summarizeUserAgent, WebDeviceStore } from '../src/core/web/devices';
import { LOGIN_CODE_TTL_MS, LoginCodes } from '../src/core/web/loginLinks';
import { DEVICE_COOKIE, WebServer } from '../src/core/web/server';
import { parseArgs } from '../src/cli/args';
import { createControlBackend } from '../src/app/controlBackend';
import { ControlError } from '../src/core/control/server';
import { RPC_UNSUPPORTED } from '../src/core/control/protocol';
import type { AgentWranglerApp } from '../src/app/createApp';
import { renderBrowserWorkbenchHtml } from '../src/ui/html';

const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let dir: string;
let webviewDir: string;
let server: WebServer;
let port: number;
let host: string;
let audit: AccessAuditRecord[];
let clients: { socket: WebSocket; context: RequestContext }[];
let clock: number;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-web-'));
  webviewDir = path.join(dir, 'dist', 'webview');
  fs.mkdirSync(webviewDir, { recursive: true });
  for (const name of ['workbench.js', 'workbench.css', 'theme.css', 'webshim.js']) fs.writeFileSync(path.join(webviewDir, name), `/* ${name} */\n`);
  fs.writeFileSync(path.join(webviewDir, 'workbench.js.map'), '{}');
  // Outside the served directory: must never be reachable.
  fs.writeFileSync(path.join(dir, 'dist', 'secret.js'), 'secret');
  fs.writeFileSync(path.join(dir, 'secret.js'), 'secret');
  audit = [];
  clients = [];
  clock = Date.UTC(2026, 0, 1);
  server = new WebServer({
    port: 0,
    webviewDir,
    dataDir: path.join(dir, 'data'),
    gate: createAccessGate({ audit: { write: (r) => audit.push(r) } }),
    log: () => undefined,
    page: renderBrowserWorkbenchHtml,
    onClient: (socket, context) => {
      clients.push({ socket, context });
      socket.close();
    },
    now: () => clock,
  });
  port = await server.listen();
  host = `127.0.0.1:${port}`;
});

afterEach(() => {
  server.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

function request(pathname: string, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: opts.method ?? 'GET', headers: { host, ...opts.headers }, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** The status line of a raw upgrade request. */
function upgrade(headers: Record<string, string>, target = '/ws'): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let got = '';
    socket.on('data', (c: Buffer) => {
      got += c.toString('latin1');
      if (got.includes('\r\n')) {
        resolve(got.split('\r\n')[0]);
        socket.destroy();
      }
    });
    socket.on('error', reject);
    const all = {
      Host: host,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
      ...headers,
    };
    const lines = Object.entries(all)
      .filter(([, v]) => v !== '')
      .map(([k, v]) => `${k}: ${v}`);
    socket.write(`GET ${target} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
  });
}

function codeOf(url: string): string {
  return new URL(url).searchParams.get('code') ?? '';
}

/** Sign in through a fresh link; the cookie's value. */
async function signIn(): Promise<string> {
  const r = await request(`/login?code=${codeOf(server.loginLink().url)}`, { headers: { 'user-agent': CHROME_MAC } });
  expect(r.status).toBe(303);
  const cookie = String(r.headers['set-cookie']?.[0] ?? '');
  return cookie.split(';')[0].split('=')[1];
}

describe('web server: request guards', () => {
  it('a foreign Host gets 421, for pages, assets, login and upgrades', async () => {
    for (const p of ['/', '/workbench.js', '/login?code=x']) {
      expect((await request(p, { headers: { host: `evil.example:${port}` } })).status).toBe(421);
    }
    expect((await request('/', { headers: { host: '127.0.0.1:1' } })).status).toBe(421);
    expect(await upgrade({ Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` })).toContain('421');
  });

  it('accepts the loopback names', async () => {
    for (const name of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      expect((await request('/', { headers: { host: name } })).status).toBe(401);
    }
  });

  it('a non-GET needs this Origin: 403 without or foreign, 405 when it matches', async () => {
    expect((await request('/', { method: 'POST' })).status).toBe(403);
    expect((await request('/', { method: 'POST', headers: { origin: 'http://evil.example' } })).status).toBe(403);
    expect((await request('/', { method: 'DELETE', headers: { origin: `http://localhost:${port}` } })).status).toBe(403);
    const same = await request('/', { method: 'POST', headers: { origin: `http://${host}` } });
    expect(same.status).toBe(405);
    expect(same.headers.allow).toBe('GET, HEAD');
  });

  it('no credential, or a wrong one, gets 401 everywhere but /login', async () => {
    expect((await request('/')).status).toBe(401);
    expect((await request('/', { headers: { cookie: `${DEVICE_COOKIE}=nope` } })).status).toBe(401);
    expect((await request(new AssetManifest(webviewDir).url('workbench.js'))).status).toBe(401);
  });

  it('upgrades: foreign Origin 403, no credential 401, a signed-in device 101 with its context', async () => {
    const cred = await signIn();
    const cookie = `${DEVICE_COOKIE}=${cred}`;
    expect(await upgrade({ Origin: 'http://evil.example', Cookie: cookie })).toContain('403');
    expect(await upgrade({ Origin: '', Cookie: cookie })).toContain('403');
    expect(await upgrade({ Origin: `http://${host}` })).toContain('401');
    expect(await upgrade({ Origin: `http://${host}`, Cookie: `${DEVICE_COOKIE}=nope` })).toContain('401');
    expect(await upgrade({ Origin: `http://${host}`, Cookie: cookie }, '/other')).toContain('400');
    expect(clients).toHaveLength(0);
    expect(await upgrade({ Origin: `http://${host}`, Cookie: cookie })).toBe('HTTP/1.1 101 Switching Protocols');
    expect(clients).toHaveLength(1);
    const device = audit.find((r) => r.action === 'web.device.add')?.deviceId;
    expect(clients[0].context).toMatchObject({ principal: { id: 'local-owner' }, via: 'browser', deviceId: device });
  });
});

describe('web server: login link and device cookie', () => {
  it('exchanges a link for an HttpOnly, SameSite=Strict, Path=/ cookie with a 30-day expiry, then redirects to /', async () => {
    const link = server.loginLink();
    expect(link.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/login\\?code=[A-Za-z0-9_-]{43}$`));
    expect(link.expiresAt).toBe(clock + LOGIN_CODE_TTL_MS);
    const r = await request(`/login?code=${codeOf(link.url)}`, { headers: { 'user-agent': CHROME_MAC } });
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe('/');
    const cookie = String(r.headers['set-cookie']?.[0]);
    expect(cookie).toMatch(new RegExp(`^${DEVICE_COOKIE}=[A-Za-z0-9_-]{43}; `));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
    // Plain http on loopback: a Secure cookie would be dropped.
    expect(cookie).not.toContain('Secure');
  });

  it('a used link cannot be used again, and a HEAD does not use it', async () => {
    const code = codeOf(server.loginLink().url);
    expect((await request(`/login?code=${code}`, { method: 'HEAD' })).status).toBe(405);
    expect((await request(`/login?code=${code}`)).status).toBe(303);
    const again = await request(`/login?code=${code}`);
    expect(again.status).toBe(401);
    expect(again.headers['set-cookie']).toBeUndefined();
  });

  it('a link older than two minutes is refused, and audited as a failed login', async () => {
    const code = codeOf(server.loginLink().url);
    clock += LOGIN_CODE_TTL_MS + 1;
    expect((await request(`/login?code=${code}`)).status).toBe(401);
    expect((await request('/login?code=made-up')).status).toBe(401);
    expect((await request('/login')).status).toBe(401);
    expect(audit.filter((r) => r.event === 'login-failed').map((r) => r.outcome)).toEqual(['expired', 'invalid', 'invalid']);
    // Ids only: no code, no principal.
    for (const r of audit) expect(JSON.stringify(r)).not.toContain(code);
    expect(audit[0].principal).toBeUndefined();
  });

  it('a signed-in device gets the page, the cookie slides, and a new device and the login are audited', async () => {
    const cred = await signIn();
    const page = await request('/', { headers: { cookie: `${DEVICE_COOKIE}=${cred}` } });
    expect(page.status).toBe(200);
    expect(String(page.headers['set-cookie']?.[0])).toContain(`${DEVICE_COOKIE}=${cred}; HttpOnly; SameSite=Strict; Path=/; Max-Age=`);
    expect(audit.map((r) => [r.event, r.action, r.resource?.kind, r.via])).toEqual([
      ['authorized', 'web.device.add', 'device', 'browser'],
      ['authorized', 'web.login', 'device', 'browser'],
    ]);
    expect(audit[0].deviceId).toBe(audit[1].deviceId);
    expect(audit[0].principal).toBe('local-owner');
  });

  it('signing in again from a device keeps that device', async () => {
    const cred = await signIn();
    const r = await request(`/login?code=${codeOf(server.loginLink().url)}`, { headers: { cookie: `${DEVICE_COOKIE}=${cred}` } });
    expect(r.status).toBe(303);
    expect(audit.filter((a) => a.action === 'web.device.add')).toHaveLength(1);
    expect(audit.filter((a) => a.action === 'web.login')).toHaveLength(2);
  });

  it('stores only the credential hash, 0600, bound to the owner on loopback', async () => {
    const cred = await signIn();
    const file = path.join(dir, 'data', 'web-devices.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain(cred);
    const stored = JSON.parse(raw).devices[0];
    expect(stored).toMatchObject({
      name: 'Chrome on macOS',
      principal: 'local-owner',
      scope: 'loopback',
      createdAt: clock,
      lastSeen: clock,
      credentialHash: crypto.createHash('sha256').update(cred).digest('hex'),
    });
    expect(typeof stored.id).toBe('string');
  });

  it('a device unseen for 30 days is signed out', async () => {
    const cred = await signIn();
    clock += DEVICE_TTL_MS + 1;
    expect((await request('/', { headers: { cookie: `${DEVICE_COOKIE}=${cred}` } })).status).toBe(401);
  });
});

describe('web server: page and assets', () => {
  it('the page is no-store, with a fresh nonce per request and the CSP as a header', async () => {
    const cookie = `${DEVICE_COOKIE}=${await signIn()}`;
    const a = await request('/', { headers: { cookie } });
    const b = await request('/', { headers: { cookie } });
    expect(a.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(a.headers['cache-control']).toBe('no-store');
    expect(a.headers['x-content-type-options']).toBe('nosniff');
    expect(a.headers['referrer-policy']).toBe('no-referrer');
    expect(a.headers['x-frame-options']).toBe('DENY');
    const csp = String(a.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`connect-src 'self' ws://${host}`);
    expect(csp).toContain("frame-ancestors 'none'");
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(a.body).toContain(`nonce="${nonce}"`);
    expect(String(b.headers['content-security-policy'])).not.toContain(nonce!);
    // Hashed names only.
    const manifest = new AssetManifest(webviewDir);
    for (const name of ['workbench.js', 'workbench.css', 'theme.css', 'webshim.js']) {
      const url = manifest.url(name);
      expect(url).toMatch(/^\/[a-z]+\.[0-9a-f]{16}\.(js|css)$/);
      expect(a.body).toContain(`"${url}"`);
    }
    expect(a.body).not.toContain('"/workbench.js"');
  });

  it('a hashed asset is immutable; a plain or stale name is not served', async () => {
    const cookie = `${DEVICE_COOKIE}=${await signIn()}`;
    const url = new AssetManifest(webviewDir).url('workbench.js');
    const r = await request(url, { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.body).toBe('/* workbench.js */\n');
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(r.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect((await request('/workbench.js', { headers: { cookie } })).status).toBe(404);
    expect((await request('/workbench.0000000000000000.js', { headers: { cookie } })).status).toBe(404);
    const map = await request('/workbench.js.map', { headers: { cookie } });
    expect(map.status).toBe(200);
    expect(map.headers['cache-control']).toBe('no-cache');
  });

  it('a rebuild changes the hash, and the old name stops resolving', async () => {
    const manifest = new AssetManifest(webviewDir);
    const before = manifest.url('workbench.js');
    const file = path.join(webviewDir, 'workbench.js');
    fs.writeFileSync(file, '/* rebuilt, and longer */\n');
    const after = manifest.url('workbench.js');
    expect(after).not.toBe(before);
    expect(manifest.resolve(before)).toBeUndefined();
    expect(manifest.resolve(after)?.file).toBe(file);
  });

  it('nothing outside dist/webview is reachable', async () => {
    const cookie = `${DEVICE_COOKIE}=${await signIn()}`;
    for (const p of [
      '/../secret.js',
      '/..%2fsecret.js',
      '/%2e%2e/secret.js',
      '/%2e%2e%2fsecret.js',
      '/..%2f..%2fsecret.js',
      '/webview/../secret.js',
      '/%2fetc%2fpasswd',
      '/secret.js',
      '/sub/workbench.js',
      '/%E0%A4%A',
    ]) {
      expect((await request(p, { headers: { cookie } })).status, p).toBe(404);
    }
    const manifest = new AssetManifest(webviewDir);
    expect(manifest.resolve('/..%2fsecret.js')).toBeUndefined();
    expect(manifest.resolve('/../secret.js.map')).toBeUndefined();
    expect(() => manifest.url('../secret.js')).toThrow();
    expect(isInside(webviewDir, path.join(webviewDir, 'a.js'))).toBe(true);
    expect(isInside(webviewDir, path.join(webviewDir, '..', 'secret.js'))).toBe(false);
    expect(isInside(webviewDir, `${webviewDir}-evil/a.js`)).toBe(false);
    expect(isInside(webviewDir, webviewDir)).toBe(false);
  });
});

describe('login codes and devices', () => {
  it('a code is good once, and only until it expires', () => {
    let now = 1000;
    const codes = new LoginCodes(() => now);
    const a = codes.mint();
    const b = codes.mint();
    expect(codes.redeem(a.code)).toBe('ok');
    expect(codes.redeem(a.code)).toBe('invalid');
    now += LOGIN_CODE_TTL_MS;
    expect(codes.redeem(b.code)).toBe('expired');
    expect(codes.redeem(b.code)).toBe('invalid');
    expect(codes.redeem(undefined)).toBe('invalid');
    expect(codes.redeem('')).toBe('invalid');
  });

  it('expiry slides with use', () => {
    let now = 0;
    const file = path.join(dir, 'devices.json');
    const store = new WebDeviceStore(file, () => now);
    const { device, credential } = store.issue('Safari on iOS');
    now += DEVICE_TTL_MS - 1000;
    expect(store.verify(credential)?.id).toBe(device.id);
    now += DEVICE_TTL_MS - 1000;
    expect(store.verify(credential)?.id).toBe(device.id);
    // And it survives a restart.
    expect(new WebDeviceStore(file, () => now).verify(credential)?.id).toBe(device.id);
    expect(store.verify('x'.repeat(43))).toBeUndefined();
  });

  it('summarises a user agent without keeping it', () => {
    expect(summarizeUserAgent(CHROME_MAC)).toBe('Chrome on macOS');
    expect(summarizeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iOS');
    expect(summarizeUserAgent(undefined)).toBe('Unknown browser');
  });
});

describe('aw web', () => {
  it('parses open and url', () => {
    expect(parseArgs(['web', 'open'])).toEqual({ kind: 'web', action: 'open' });
    expect(parseArgs(['web', 'url'])).toEqual({ kind: 'web', action: 'url' });
    expect(parseArgs(['web'])).toHaveProperty('error');
    expect(parseArgs(['web', 'open', 'extra'])).toHaveProperty('error');
    expect(parseArgs(['web', 'url', '--json'])).toHaveProperty('error');
  });

  it('the control backend mints a link, or says the workbench is off', () => {
    const gate = createAccessGate();
    const app = {} as AgentWranglerApp;
    const on = createControlBackend(app, { build: 't', appPid: 1, startedAt: 0, gate, webLink: () => server.loginLink() });
    expect(on.webLink().url).toContain(`http://127.0.0.1:${port}/login?code=`);
    const off = createControlBackend(app, { build: 't', appPid: 1, startedAt: 0, gate, webLink: () => undefined });
    expect(() => off.webLink()).toThrow(ControlError);
    try {
      off.webLink();
    } catch (err) {
      expect((err as ControlError).code).toBe(RPC_UNSUPPORTED);
    }
  });
});
