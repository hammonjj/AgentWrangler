/**
 * The web workbench's HTTP side (#127, plan §8 and §10): the page, its
 * assets, the login link and the device cookie, and the gate in front of the
 * WebSocket. What happens on the socket once it is open is the caller's
 * (`onClient`), so the window's main process today and the daemon later can
 * both run this unchanged. No Electron here.
 *
 * Every request, in order:
 * 1. `Host` must be this listener by a loopback name, or **421**. A page that
 *    rebinds its own DNS name to 127.0.0.1 still sends its own name.
 * 2. Anything but GET/HEAD, and every WebSocket upgrade, must carry an
 *    `Origin` equal to this server, or **403**. No endpoint takes a POST yet,
 *    so one that passes is 405.
 * 3. `/login?code=…` exchanges a single-use code from `aw web open` for a
 *    device cookie. Everything else needs that cookie, or **401**.
 *
 * Only `dist/webview` is served (`AssetManifest`); data files will come
 * through their own allowlist later (§6).
 */
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import type { Disposable } from '../events';
import { ownerContext, type AccessGate, type RequestContext } from '../access';
import { AssetManifest } from './assets';
import { DEVICE_TTL_MS, WEB_DEVICES_FILE, WebDeviceStore, summarizeUserAgent, type WebDevice } from './devices';
import { LoginCodes } from './loginLinks';
import { acceptKey, isLoopbackHost, readCookie } from './wsFrames';

export const WEB_DEFAULT_PORT = 7391;
/** The loopback device cookie. A LAN one (later) gets its own name. */
export const DEVICE_COOKIE = 'aw_device';
const COOKIE_MAX_AGE_S = Math.floor(DEVICE_TTL_MS / 1000);

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

const IMMUTABLE = 'public, max-age=31536000, immutable';

export interface WebPageInput {
  /** An asset's URL by its plain name (`workbench.js`), hashed. */
  asset: (name: string) => string;
  nonce: string;
  connectSrc: string;
}

export interface WebServerOptions {
  /** 0 picks a free port (tests). */
  port: number;
  /** `dist/webview`: the only directory served. */
  webviewDir: string;
  /** Where `web-devices.json` lives. */
  dataDir: string;
  gate: AccessGate;
  log: (line: string) => void;
  /** The workbench document. Kept out of core so it carries no UI code. */
  page: (input: WebPageInput) => string;
  /**
   * An upgraded, authenticated WebSocket. `context` is the device's: owner
   * principal, `via: 'browser'`, its `deviceId`. The callee adds a connection
   * id and owns the socket from here.
   */
  onClient: (socket: Duplex, context: RequestContext) => void;
  now?: () => number;
}

export class WebServer implements Disposable {
  private readonly server: http.Server;
  private readonly assets: AssetManifest;
  private readonly devices: WebDeviceStore;
  private readonly codes: LoginCodes;
  private readonly sockets = new Set<Duplex>();
  private boundPort: number | undefined;
  private failedLogins = 0;

  constructor(private readonly opts: WebServerOptions) {
    const now = opts.now ?? (() => Date.now());
    this.assets = new AssetManifest(opts.webviewDir);
    this.devices = new WebDeviceStore(path.join(opts.dataDir, WEB_DEVICES_FILE), now, opts.log);
    this.codes = new LoginCodes(now);
    this.server = http.createServer((req, res) => this.request(req, res));
    this.server.on('upgrade', (req: http.IncomingMessage, socket: Duplex) => this.upgrade(req, socket));
  }

  /** Listen on 127.0.0.1. Resolves with the port; rejects if it cannot (in use). */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.port, '127.0.0.1', () => {
        this.server.off('error', reject);
        this.server.on('error', (err) => this.opts.log(`web: ${String(err)}`));
        const addr = this.server.address();
        this.boundPort = typeof addr === 'object' && addr ? addr.port : this.opts.port;
        resolve(this.boundPort);
      });
    });
  }

  get port(): number | undefined {
    return this.boundPort;
  }

  /** A single-use login link, good for two minutes. For `aw web open`. */
  loginLink(): { url: string; expiresAt: number } {
    if (this.boundPort === undefined) throw new Error('the browser workbench is not listening');
    const { code, expiresAt } = this.codes.mint();
    return { url: `http://127.0.0.1:${this.boundPort}/login?code=${code}`, expiresAt };
  }

  dispose(): void {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.server.close();
    this.server.closeAllConnections();
  }

  // ---- HTTP ----

  private request(req: http.IncomingMessage, res: http.ServerResponse): void {
    const port = this.boundPort ?? this.opts.port;
    if (!isLoopbackHost(req.headers.host, port)) {
      res.writeHead(421, SECURITY_HEADERS).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!this.sameOrigin(req)) {
        res.writeHead(403, SECURITY_HEADERS).end();
        return;
      }
      res.writeHead(405, { ...SECURITY_HEADERS, allow: 'GET, HEAD' }).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      res.writeHead(400, SECURITY_HEADERS).end();
      return;
    }
    if (url.pathname === '/login') {
      // A HEAD (a link preview, a prefetch) must not spend the code.
      if (req.method !== 'GET') {
        res.writeHead(405, { ...SECURITY_HEADERS, allow: 'GET' }).end();
        return;
      }
      this.login(req, res, url);
      return;
    }
    const cookie = readCookie(req.headers.cookie, DEVICE_COOKIE);
    const device = this.devices.verify(cookie);
    if (!device || !cookie) {
      text(res, 401, 'Not signed in. Run `aw web open` in a terminal on this Mac to open Agent Wrangler here.');
      return;
    }
    if (url.pathname === '/') {
      this.page(req, res, cookie);
      return;
    }
    this.asset(url.pathname, res);
  }

  private login(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const outcome = this.codes.redeem(url.searchParams.get('code'));
    if (outcome !== 'ok') {
      this.failedLogins++;
      this.opts.gate.loginFailed('browser', outcome);
      this.opts.log(`web: refused a login link (${outcome}; ${this.failedLogins} since start)`);
      text(res, 401, 'This sign-in link has expired or has already been used. Run `aw web open` again.');
      return;
    }
    // A browser that is already a device keeps its device; anything else
    // becomes a new one.
    let cookie = readCookie(req.headers.cookie, DEVICE_COOKIE);
    let device: WebDevice | undefined = this.devices.verify(cookie);
    if (!device) {
      const id = crypto.randomUUID();
      if (!this.opts.gate.admit(ownerContext('browser', { deviceId: id }), 'web.device.add', { kind: 'device', id })) {
        text(res, 403, 'Not permitted.');
        return;
      }
      const issued = this.devices.issue(summarizeUserAgent(req.headers['user-agent']), id);
      device = issued.device;
      cookie = issued.credential;
      this.opts.log(`web: new device ${device.id}`);
    }
    if (!cookie || !this.opts.gate.admit(ownerContext('browser', { deviceId: device.id }), 'web.login', { kind: 'device', id: device.id })) {
      text(res, 403, 'Not permitted.');
      return;
    }
    res.writeHead(303, { ...SECURITY_HEADERS, 'set-cookie': this.cookie(req, cookie), location: '/' });
    res.end();
  }

  private page(req: http.IncomingMessage, res: http.ServerResponse, cookie: string): void {
    const nonce = crypto.randomBytes(16).toString('base64');
    // Explicit as well as 'self': older Safari does not count ws: as 'self'.
    const connectSrc = `'self' ${this.secure(req) ? 'wss' : 'ws'}://${req.headers.host}`;
    let html: string;
    try {
      html = this.opts.page({ asset: (name) => this.assets.url(name), nonce, connectSrc });
    } catch (err) {
      this.opts.log(`web: cannot render the page: ${String(err)}`);
      text(res, 500, 'The web workbench is not built. Run npm run build.');
      return;
    }
    const csp =
      `default-src 'none'; style-src 'self'; script-src 'nonce-${nonce}'; img-src 'self' data:; ` +
      `connect-src ${connectSrc}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': csp,
      // Sliding expiry: every page load starts the 30 days again.
      'set-cookie': this.cookie(req, cookie),
    });
    res.end(html);
  }

  private asset(urlPath: string, res: http.ServerResponse): void {
    const found = this.assets.resolve(urlPath);
    if (!found) {
      res.writeHead(404, SECURITY_HEADERS).end();
      return;
    }
    fs.readFile(found.file, (err, body) => {
      if (err) {
        res.writeHead(404, SECURITY_HEADERS).end();
        return;
      }
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': found.contentType,
        'cache-control': found.immutable ? IMMUTABLE : 'no-cache',
      });
      res.end(body);
    });
  }

  // ---- WebSocket ----

  private upgrade(req: http.IncomingMessage, socket: Duplex): void {
    const refuse = (status: string): void => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    socket.on('error', () => socket.destroy());
    if (!isLoopbackHost(req.headers.host, this.boundPort ?? this.opts.port)) return refuse('421 Misdirected Request');
    if (!this.sameOrigin(req)) return refuse('403 Forbidden');
    const device = this.devices.verify(readCookie(req.headers.cookie, DEVICE_COOKIE));
    if (!device) return refuse('401 Unauthorized');
    const key = req.headers['sec-websocket-key'];
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return refuse('400 Bad Request');
    }
    if (pathname !== '/ws' || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string') return refuse('400 Bad Request');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    this.opts.onClient(socket, ownerContext('browser', { deviceId: device.id }));
  }

  // ---- helpers ----

  private secure(req: http.IncomingMessage): boolean {
    return (req.socket as TLSSocket).encrypted === true;
  }

  /** `Origin` is exactly this server, by the name the request used. */
  private sameOrigin(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!origin || !host) return false;
    return origin.toLowerCase() === `${this.secure(req) ? 'https' : 'http'}://${host.toLowerCase()}`;
  }

  /** `Secure` only over https: a plain-http loopback browser would drop it. */
  private cookie(req: http.IncomingMessage, value: string): string {
    return `${DEVICE_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}${this.secure(req) ? '; Secure' : ''}`;
  }
}

function text(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${body}\n`);
}
