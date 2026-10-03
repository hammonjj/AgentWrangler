/**
 * The web workbench's HTTP side (#127, plan §8 and §10): the page, its
 * assets, the login link and the device cookie, and the gate in front of the
 * WebSocket. What happens on the socket once it is open is the caller's
 * (`onClient`), so the window's main process today and the daemon later can
 * both run this unchanged. No Electron here.
 *
 * It runs one or more listeners (#136), each with a scope:
 * - **loopback**: plain http on 127.0.0.1, always (while `web.enabled`).
 * - **lan**: https on each of the Mac's private IPv4 addresses, only while
 *   `web.lan.enabled` (`setLan`, driven by `lan.ts`). Its credentials are
 *   `scope: 'lan'` and live in their own cookie; a loopback credential is not
 *   one here, and the other way round.
 *
 * Every request, in order:
 * 1. `Host` must name this listener, or **421**: a loopback name on loopback,
 *    `<host>.local` or a bound address on the LAN, with the listener's port. A
 *    page that rebinds its own DNS name to us still sends its own name.
 * 2. Anything but GET/HEAD, and every WebSocket upgrade, must carry an
 *    `Origin` equal to this server (`https://…` on the LAN), or **403**. No
 *    endpoint takes a POST yet, so one that passes is 405.
 * 3. `/login?code=…` exchanges a single-use code for a device cookie of the
 *    listener's scope: from `aw web open` on loopback, from pairing (#137) on
 *    the LAN. Everything else needs that cookie, or **401**.
 *
 * Only `dist/webview` is served (`AssetManifest`), plus, on loopback, the
 * local CA for a device to install (`/ca.pem`, `/ca.mobileconfig`); data files
 * will come through their own allowlist later (§6).
 */
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Disposable } from '../events';
import { ownerContext, type AccessGate, type RequestContext } from '../access';
import { AssetManifest } from './assets';
import { DEVICE_TTL_MS, WEB_DEVICES_FILE, WebDeviceStore, summarizeUserAgent, type DeviceScope, type WebDevice } from './devices';
import { LoginCodes } from './loginLinks';
import { caMobileconfig, MOBILECONFIG_CONTENT_TYPE } from './mobileconfig';
import { isLoopbackHost, readCookie } from './wsFrames';

export const WEB_DEFAULT_PORT = 7391;
/** The loopback device cookie. */
export const DEVICE_COOKIE = 'aw_device';
/**
 * The LAN device cookie (#136). `__Host-`: the browser only accepts it with
 * `Secure`, `Path=/` and no `Domain`, so nothing on another name or over http
 * can plant or widen it.
 */
export const LAN_DEVICE_COOKIE = '__Host-aw_lan_device';
const COOKIE_MAX_AGE_S = Math.floor(DEVICE_TTL_MS / 1000);

/** What the LAN listeners should be (#136). `lan.ts` works it out; the server only binds it. */
export interface LanConfig {
  /** Private IPv4 addresses to bind, one listener each. */
  addresses: string[];
  /** Every name a LAN request may use in `Host`: `<host>.local` and the addresses. */
  names: string[];
  /** 0 picks a free port per address (tests). */
  port: number;
  cert: string;
  key: string;
}

/** One LAN listener, for Preferences. */
export interface LanListenerStatus {
  address: string;
  port?: number;
  error?: string;
}

interface Listener {
  scope: DeviceScope;
  server: http.Server | https.Server;
  address: string;
  /** The port actually bound, once listening. */
  port?: number;
  error?: string;
  /** Upgraded WebSockets, which the http server no longer tracks: closing the listener ends them. */
  sockets: Set<WebSocket>;
}

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
  /** The build the page's assets are (`WebServer.build`); the shim compares it with the server's `hello`. */
  build: string;
}

/** The files the browser workbench is made of: its build is their hashes. */
const PAGE_ASSETS = ['webshim.js', 'workbench.js', 'workbench.css', 'theme.css'];

/**
 * A message from a browser is a pane message, an image or two at most:
 * anything bigger is refused (1009) rather than allocated.
 */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/**
 * permessage-deflate (#128): the table snapshot is repetitive JSON. Context
 * takeover is kept both ways, which is what makes the second snapshot cheap;
 * it costs a zlib window per connection, and there are a handful.
 */
const DEFLATE = {
  threshold: 256,
  zlibDeflateOptions: { level: 6, memLevel: 8 },
  serverNoContextTakeover: false,
  clientNoContextTakeover: false,
} as const;

/** What a route is handed: a request from a signed-in device, on a listener of `scope`. */
export interface WebRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  scope: DeviceScope;
  deviceId: string;
}

/**
 * A route another module adds (#140's file view; downloads and uploads).
 * Reached only after the host, origin and device checks, GET and HEAD only.
 */
export interface WebRoute {
  match(pathname: string): boolean;
  handle(ctx: WebRouteContext): Promise<void> | void;
}

export interface WebServerOptions {
  /** Routes beyond the page, assets and login (#140). First match wins. */
  routes?: WebRoute[];
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
   * An upgraded, authenticated WebSocket (`ws`, permessage-deflate on).
   * `context` is the device's: owner principal, `via: 'browser'`, its
   * `deviceId`. The callee adds a connection id and owns the socket from here.
   */
  onClient: (socket: WebSocket, context: RequestContext) => void;
  /**
   * The local CA certificate (PEM) for `/ca.pem` and `/ca.mobileconfig` on
   * loopback (#136). `undefined`: there is none to offer (a user-supplied
   * certificate is in use). Absent: those routes are 404.
   */
  caCertificate?: () => Promise<string | undefined>;
  now?: () => number;
}

export class WebServer implements Disposable {
  private readonly loopback: Listener;
  private lan: Listener[] = [];
  private lanConfig: LanConfig | undefined;
  private readonly assets: AssetManifest;
  private readonly devices: WebDeviceStore;
  private readonly codes: Record<DeviceScope, LoginCodes>;
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: DEFLATE, maxPayload: MAX_MESSAGE_BYTES });
  private failedLogins = 0;
  private disposed = false;

  constructor(private readonly opts: WebServerOptions) {
    const now = opts.now ?? (() => Date.now());
    this.assets = new AssetManifest(opts.webviewDir);
    this.devices = new WebDeviceStore(path.join(opts.dataDir, WEB_DEVICES_FILE), now, opts.log);
    this.codes = { loopback: new LoginCodes(now), lan: new LoginCodes(now) };
    this.loopback = { scope: 'loopback', address: '127.0.0.1', server: http.createServer(), sockets: new Set() };
    this.wire(this.loopback);
  }

  /**
   * Which build the page and its assets are: a hash of their hashed names.
   * A tab loaded before a rebuild has another one, and reloads when the
   * server's `hello` says so (#128). Recomputed on each call, so a rebuild is
   * noticed without a restart, as the assets themselves are.
   */
  build(): string {
    const urls = PAGE_ASSETS.map((name) => {
      try {
        return this.assets.url(name);
      } catch {
        return `${name}:missing`;
      }
    });
    return crypto.createHash('sha256').update(urls.join('\n')).digest('hex').slice(0, 16);
  }

  /** Listen on 127.0.0.1. Resolves with the port; rejects if it cannot (in use). */
  async listen(): Promise<number> {
    this.loopback.port = await bind(this.loopback.server, this.opts.port, '127.0.0.1', this.opts.log);
    return this.loopback.port;
  }

  get port(): number | undefined {
    return this.loopback.port;
  }

  /**
   * Bring the LAN listeners in line with `config` (#136); `undefined` closes
   * them all. Addresses that stay keep their listener and connections; a new
   * certificate is swapped in without re-binding; a new port re-binds. An
   * address that failed to bind is tried again on the next call.
   */
  async setLan(config: LanConfig | undefined): Promise<LanListenerStatus[]> {
    if (this.disposed) return [];
    const prev = this.lanConfig;
    this.lanConfig = config;
    const keep = (l: Listener): boolean =>
      !!config && !l.error && l.port !== undefined && prev?.port === config.port && config.addresses.includes(l.address);
    for (const l of this.lan) if (!keep(l)) closeListener(l);
    this.lan = this.lan.filter(keep);
    if (!config) return [];
    if (prev && (prev.cert !== config.cert || prev.key !== config.key)) {
      for (const l of this.lan) (l.server as https.Server).setSecureContext({ cert: config.cert, key: config.key });
    }
    const missing = config.addresses.filter((a) => !this.lan.some((l) => l.address === a));
    await Promise.all(
      missing.map(async (address) => {
        const server = https.createServer({ cert: config.cert, key: config.key, minVersion: 'TLSv1.2' });
        const l: Listener = { scope: 'lan', address, server, sockets: new Set() };
        this.wire(l);
        this.lan.push(l);
        try {
          l.port = await bind(server, config.port, address, this.opts.log);
          // Disposed while binding: what was just opened goes too.
          if (this.disposed) closeListener(l);
        } catch (err) {
          l.error = (err as NodeJS.ErrnoException).code ?? String(err);
          closeListener(l);
        }
      }),
    );
    return this.lanStatus();
  }

  /** The LAN listeners, bound or not. Empty when LAN access is off. */
  lanStatus(): LanListenerStatus[] {
    return this.lan.map((l) => ({ address: l.address, ...(l.port !== undefined ? { port: l.port } : {}), ...(l.error ? { error: l.error } : {}) }));
  }

  /**
   * A single-use login link, good for two minutes. Loopback: for `aw web
   * open`. LAN: for pairing (#137), which is what will call it; it signs in a
   * `scope: 'lan'` device on the LAN listener and nowhere else.
   */
  loginLink(scope: DeviceScope = 'loopback'): { url: string; expiresAt: number } {
    if (scope === 'loopback') {
      if (this.loopback.port === undefined) throw new Error('the browser workbench is not listening');
      const { code, expiresAt } = this.codes.loopback.mint();
      return { url: `http://127.0.0.1:${this.loopback.port}/login?code=${code}`, expiresAt };
    }
    const listener = this.lan.find((l) => l.port !== undefined && !l.error);
    if (!listener || !this.lanConfig) throw new Error('LAN access is not listening');
    const { code, expiresAt } = this.codes.lan.mint();
    return { url: `https://${this.lanConfig.names[0]}:${listener.port}/login?code=${code}`, expiresAt };
  }

  dispose(): void {
    this.disposed = true;
    closeListener(this.loopback);
    for (const l of this.lan) closeListener(l);
    this.lan = [];
    this.wss.close();
  }

  private wire(listener: Listener): void {
    listener.server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => this.request(listener, req, res));
    listener.server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(listener, req, socket, head));
  }

  // ---- HTTP ----

  private request(listener: Listener, req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.hostAllowed(listener, req.headers.host)) {
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
      this.login(listener, req, res, url);
      return;
    }
    const cookie = readCookie(req.headers.cookie, cookieName(listener.scope));
    const device = this.devices.verify(cookie, listener.scope);
    if (!device || !cookie) {
      text(
        res,
        401,
        listener.scope === 'lan'
          ? 'Not signed in. This device has not been paired with Agent Wrangler on the Mac yet.'
          : 'Not signed in. Run `aw web open` in a terminal on this Mac to open Agent Wrangler here.',
      );
      return;
    }
    if (url.pathname === '/') {
      this.page(listener, req, res, cookie);
      return;
    }
    // Routes other modules add (#140): reached only by a signed-in device.
    const route = (this.opts.routes ?? []).find((r) => r.match(url.pathname));
    if (route) {
      void Promise.resolve()
        .then(() => route.handle({ req, res, url, scope: listener.scope, deviceId: device.id }))
        .catch((err) => {
          this.opts.log(`web: route ${url.pathname} failed: ${String(err)}`);
          if (!res.headersSent) text(res, 500, 'Something went wrong.');
          else res.destroy();
        });
      return;
    }
    // The CA, for a device to install, from the Mac only (#136).
    if (listener.scope === 'loopback' && (url.pathname === '/ca.pem' || url.pathname === '/ca.mobileconfig')) {
      void this.caDownload(url.pathname, res);
      return;
    }
    this.asset(url.pathname, res);
  }

  private login(listener: Listener, req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const scope = listener.scope;
    const outcome = this.codes[scope].redeem(url.searchParams.get('code'));
    if (outcome !== 'ok') {
      this.failedLogins++;
      this.opts.gate.loginFailed('browser', outcome);
      this.opts.log(`web: refused a ${scope} login link (${outcome}; ${this.failedLogins} since start)`);
      text(
        res,
        401,
        scope === 'lan'
          ? 'This pairing link has expired or has already been used. Pair this device again from the Mac.'
          : 'This sign-in link has expired or has already been used. Run `aw web open` again.',
      );
      return;
    }
    // A browser that is already a device keeps its device; anything else
    // becomes a new one, of this listener's scope.
    let cookie = readCookie(req.headers.cookie, cookieName(scope));
    let device: WebDevice | undefined = this.devices.verify(cookie, scope);
    if (!device) {
      const id = crypto.randomUUID();
      if (!this.opts.gate.admit(ownerContext('browser', { deviceId: id }), 'web.device.add', { kind: 'device', id })) {
        text(res, 403, 'Not permitted.');
        return;
      }
      const issued = this.devices.issue(summarizeUserAgent(req.headers['user-agent']), id, scope);
      device = issued.device;
      cookie = issued.credential;
      this.opts.log(`web: new ${scope} device ${device.id}`);
    }
    if (!cookie || !this.opts.gate.admit(ownerContext('browser', { deviceId: device.id }), 'web.login', { kind: 'device', id: device.id })) {
      text(res, 403, 'Not permitted.');
      return;
    }
    res.writeHead(303, { ...SECURITY_HEADERS, 'set-cookie': this.cookie(listener, req, cookie), location: '/' });
    res.end();
  }

  private async caDownload(pathname: string, res: http.ServerResponse): Promise<void> {
    let pem: string | undefined;
    try {
      pem = this.opts.caCertificate ? await this.opts.caCertificate() : undefined;
    } catch (err) {
      this.opts.log(`web: cannot make the local CA: ${String(err)}`);
      text(res, 500, 'Could not make the local certificate authority. See the Agent Wrangler log.');
      return;
    }
    if (!pem) {
      text(res, 404, 'There is no local certificate authority to install: LAN access uses your own certificate (web.lan.certFile).');
      return;
    }
    const mobileconfig = pathname === '/ca.mobileconfig';
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': mobileconfig ? MOBILECONFIG_CONTENT_TYPE : 'application/x-pem-file',
      'content-disposition': `attachment; filename="${mobileconfig ? 'agent-wrangler-ca.mobileconfig' : 'agent-wrangler-ca.pem'}"`,
    });
    res.end(mobileconfig ? caMobileconfig(pem) : pem);
  }

  private page(listener: Listener, req: http.IncomingMessage, res: http.ServerResponse, cookie: string): void {
    const nonce = crypto.randomBytes(16).toString('base64');
    // Explicit as well as 'self': older Safari does not count ws: as 'self'.
    const connectSrc = `'self' ${this.secure(req) ? 'wss' : 'ws'}://${req.headers.host}`;
    let html: string;
    try {
      html = this.opts.page({ asset: (name) => this.assets.url(name), nonce, connectSrc, build: this.build() });
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
      'set-cookie': this.cookie(listener, req, cookie),
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

  /**
   * The gate, then `ws` (`noServer`): it checks the handshake itself (version,
   * key; 400 otherwise), negotiates permessage-deflate and frames from there.
   */
  private upgrade(listener: Listener, req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: string): void => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    socket.on('error', () => socket.destroy());
    if (!this.hostAllowed(listener, req.headers.host)) return refuse('421 Misdirected Request');
    if (!this.sameOrigin(req)) return refuse('403 Forbidden');
    const device = this.devices.verify(readCookie(req.headers.cookie, cookieName(listener.scope)), listener.scope);
    if (!device) return refuse('401 Unauthorized');
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return refuse('400 Bad Request');
    }
    if (pathname !== '/ws') return refuse('400 Bad Request');
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      listener.sockets.add(ws);
      ws.on('close', () => listener.sockets.delete(ws));
      this.opts.onClient(ws, ownerContext('browser', { deviceId: device.id, deviceScope: listener.scope }));
    });
  }

  // ---- helpers ----

  /**
   * `Host` names this listener: a loopback name on loopback; on the LAN,
   * `<host>.local` or a bound address. Always with the listener's own port.
   */
  private hostAllowed(listener: Listener, hostHeader: string | undefined): boolean {
    const port = listener.port ?? this.opts.port;
    if (listener.scope === 'loopback') return isLoopbackHost(hostHeader, port);
    return isLanHost(hostHeader, port, this.lanConfig?.names ?? []);
  }

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
  private cookie(listener: Listener, req: http.IncomingMessage, value: string): string {
    return `${cookieName(listener.scope)}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}${this.secure(req) ? '; Secure' : ''}`;
  }
}

function cookieName(scope: DeviceScope): string {
  return scope === 'lan' ? LAN_DEVICE_COOKIE : DEVICE_COOKIE;
}

/** The LAN Host allowlist (#136): one of `names`, exactly, with this port. */
export function isLanHost(hostHeader: string | undefined, port: number, names: readonly string[]): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase();
  return names.some((n) => `${n.toLowerCase()}:${port}` === host);
}

/** Listen on `address`; the bound port. Errors after that are logged, not thrown. */
function bind(server: http.Server | https.Server, port: number, address: string, log: (line: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, address, () => {
      server.off('error', reject);
      server.on('error', (err) => log(`web: ${address}: ${String(err)}`));
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}

function closeListener(l: Listener): void {
  for (const s of l.sockets) s.terminate();
  l.sockets.clear();
  l.server.close();
  l.server.closeAllConnections();
}

function text(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${body}\n`);
}
