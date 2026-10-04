/**
 * The web workbench's HTTP side (#127, plan §8 and §10): the page, its
 * assets, the login link and the device cookie, and the gate in front of the
 * WebSocket. What happens on the socket once it is open is the caller's
 * (`onClient`). Run by the core daemon.
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
 *    `Origin` equal to this server (`https://…` on the LAN), or **403**. A
 *    POST is `/upload` (#139, `files.ts`), a registered route (`routes` with
 *    `methods`, #141: the device cookie, then the route's own checks) or a
 *    pairing form below;
 *    any other that passes is 405.
 * 3. `/login?code=…` exchanges a single-use code for a device cookie of the
 *    listener's scope (`aw web open`, on loopback). Everything else needs that
 *    cookie, or **401**, except pairing on the LAN.
 *
 * Pairing (#137, `pairing.ts`, `pairPages.ts`):
 * - `/pair/new` on loopback, signed in: GET shows a button, POST starts an
 *   offer and shows its QR code. `aw web pair` starts one too (`pairingOffer`).
 * - `/pair` on the LAN, not signed in: GET is the form (the code from the QR
 *   code's link filled in), POST exchanges the code for a `scope: 'lan'`
 *   device and its cookie, then redirects to `/`. Guesses are limited per
 *   address and overall, and a locked-out address is refused before its form
 *   is read.
 * - Both POSTs need this server's `Origin` (step 2) and a form token equal to
 *   a `SameSite=Strict` cookie set with the form, and take at most
 *   `MAX_FORM_BYTES` of `application/x-www-form-urlencoded`. The one other
 *   upload route, `/upload` (#139), has its own caps in `files.ts`.
 *
 * Revoking a device (`WebDeviceStore.revoke`) closes its open WebSockets at
 * once (`onDidRevoke`), and its cookie is refused from then on.
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
import { DEVICE_TTL_MS, WEB_DEVICES_FILE, WebDeviceStore, cleanDeviceName, summarizeUserAgent, type DeviceScope, type WebDevice } from './devices';
import type { WebFileRoutes } from './files';
import { DIRS_PATH, FILES_PATH, UPLOAD_PATH } from '../../shared/files';
import { LoginCodes } from './loginLinks';
import { caMobileconfig, MOBILECONFIG_CONTENT_TYPE } from './mobileconfig';
import { PAIRING_LOCKOUT_MS, PairingOffers } from './pairing';
import { PAIR_CSS, PAIR_CSS_PATH, PAIR_PAGE_CSP, pairFormPage, pairMessagePage, pairOfferPage, pairStartPage, setupPage } from './pairPages';
import { encodeQr, qrToSvg } from './qr';
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
/** The pairing forms' token cookie (#137), per scope like the device cookies. */
export const PAIR_FORM_COOKIE = 'aw_pair_form';
export const LAN_PAIR_FORM_COOKIE = '__Host-aw_pair_form';
const PAIR_FORM_MAX_AGE_S = 15 * 60;
/** The most a pairing form may send. A code and a name are well under 200 bytes. */
export const MAX_FORM_BYTES = 4 * 1024;

/** A pairing offer, for `aw web pair` and the loopback page (#137). */
export interface PairingOfferView {
  /** `https://<host>.local:<port>/pair?code=…`: what the QR code says. */
  url: string;
  /**
   * `http://<address>:<setup port>/setup?code=…`: what the QR code carries, so
   * a device that does not trust the certificate yet can still open it. Absent
   * when the setup listener could not bind.
   */
  setupUrl?: string;
  code: string;
  expiresAt: number;
}

/** One plain-HTTP setup listener (`setupRequest`): the certificate before the device trusts it. */
interface SetupListener {
  address: string;
  server: http.Server;
  port?: number;
}

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
  /**
   * Upgraded WebSockets, which the http server no longer tracks, and the
   * device each belongs to: closing the listener ends them, and revoking a
   * device ends its own (#137).
   */
  sockets: Map<WebSocket, string>;
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  // Not `no-referrer`: Chrome then sends `Origin: null` on a same-origin form POST, which `sameOrigin` refuses (the pairing buttons got a 403).
  'referrer-policy': 'same-origin',
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
  /** The device's request context (owner, `via: 'browser'`), for the access gate (#141). */
  context: RequestContext;
  gate: AccessGate;
}

/**
 * A route another module adds (#140's file view; downloads and uploads).
 * Reached only after the host, origin and device checks, GET and HEAD only.
 */
export interface WebRoute {
  match(pathname: string): boolean;
  /** The methods it answers; GET and HEAD when absent. A POST route (#141) says `['POST']`. */
  methods?: readonly string[];
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
  /**
   * The process's device store (#137), shared with the control socket and
   * Preferences so a revocation from either reaches this server. Absent: the
   * server keeps its own, in `dataDir` (tests).
   */
  devices?: WebDeviceStore;
  /**
   * A device was revoked and its sockets here terminated. Called so the
   * connection layer can drop its pane hosts and client registration in the
   * same tick, rather than when the sockets' `close` events arrive.
   */
  onDeviceRevoked?: (deviceId: string) => void;
  /**
   * Upload, download and the folder browser (#139; `WebFiles`). Absent: those
   * routes do not exist. They sit behind the same Host, Origin and device
   * cookie checks as everything else here.
   */
  files?: WebFileRoutes;
  now?: () => number;
}

export class WebServer implements Disposable {
  private readonly loopback: Listener;
  private lan: Listener[] = [];
  private setup: SetupListener[] = [];
  private lanConfig: LanConfig | undefined;
  private readonly assets: AssetManifest;
  /** Where devices and their credential hashes are kept. */
  readonly devices: WebDeviceStore;
  private readonly codes: Record<DeviceScope, LoginCodes>;
  private readonly pairing: PairingOffers;
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: DEFLATE, maxPayload: MAX_MESSAGE_BYTES });
  private readonly revocations: Disposable;
  private failedLogins = 0;
  private disposed = false;

  constructor(private readonly opts: WebServerOptions) {
    const now = opts.now ?? (() => Date.now());
    this.assets = new AssetManifest(opts.webviewDir);
    this.devices = opts.devices ?? new WebDeviceStore(path.join(opts.dataDir, WEB_DEVICES_FILE), now, opts.log);
    this.codes = { loopback: new LoginCodes(now), lan: new LoginCodes(now) };
    this.pairing = new PairingOffers(now);
    this.loopback = { scope: 'loopback', address: '127.0.0.1', server: http.createServer(), sockets: new Map() };
    this.wire(this.loopback);
    this.revocations = this.devices.onDidRevoke((id) => this.disconnectDevice(id));
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
    await this.setSetup(config);
    if (!config) {
      // Nothing to redeem it on any more; a new one is started when LAN access is back.
      this.pairing.cancel();
      return [];
    }
    if (prev && (prev.cert !== config.cert || prev.key !== config.key)) {
      for (const l of this.lan) (l.server as https.Server).setSecureContext({ cert: config.cert, key: config.key });
    }
    const missing = config.addresses.filter((a) => !this.lan.some((l) => l.address === a));
    await Promise.all(
      missing.map(async (address) => {
        const server = https.createServer({ cert: config.cert, key: config.key, minVersion: 'TLSv1.2' });
        const l: Listener = { scope: 'lan', address, server, sockets: new Map() };
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

  /**
   * The plain-HTTP setup listeners, one per LAN address, on the port after the
   * HTTPS one. A phone cannot open the HTTPS pairing page before it trusts the
   * certificate, so the QR code leads here first. They answer 404 to everything
   * unless a pairing offer is live and the request carries its code, and serve
   * only the public CA certificate and a link on to `/pair`: never a session, a
   * device credential or any Agent Wrangler data.
   */
  private async setSetup(config: LanConfig | undefined): Promise<void> {
    const port = config ? (config.port === 0 ? 0 : config.port + 1) : undefined;
    const keep = (l: SetupListener): boolean => !!config && l.port !== undefined && config.addresses.includes(l.address) && (port === 0 || l.port === port);
    for (const l of this.setup) if (!keep(l)) closeSetup(l);
    this.setup = this.setup.filter(keep);
    if (!config || port === undefined) return;
    const missing = config.addresses.filter((a) => !this.setup.some((l) => l.address === a));
    await Promise.all(
      missing.map(async (address) => {
        const server = http.createServer();
        const l: SetupListener = { address, server };
        server.on('request', (req, res) => this.setupRequest(l, req, res));
        try {
          l.port = await bind(server, port, address, this.opts.log);
          if (this.disposed) closeSetup(l);
          else this.setup.push(l);
        } catch (err) {
          this.opts.log(`web: setup listener on ${address}:${port}: ${(err as NodeJS.ErrnoException).code ?? String(err)}; the QR code will lead to the pairing page directly`);
          closeSetup(l);
        }
      }),
    );
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

  /**
   * Start pairing a device (#137): a new single-use code for five minutes,
   * replacing any other, and the `/pair` link on the LAN listener that the QR
   * code carries. Undefined while LAN access is not listening, since there is
   * nowhere to redeem it. The caller has already passed `web.pair.start`.
   */
  pairingOffer(): PairingOfferView | undefined {
    const listener = this.lan.find((l) => l.port !== undefined && !l.error);
    if (!listener || !this.lanConfig || this.disposed) return undefined;
    const { code, expiresAt } = this.pairing.start();
    // By address, not `<host>.local`: it needs no name lookup on the device.
    const setup = this.setup.find((l) => l.address === listener.address);
    return {
      url: `https://${this.lanConfig.names[0]}:${listener.port}/pair?code=${code}`,
      ...(setup?.port !== undefined ? { setupUrl: `http://${setup.address}:${setup.port}/setup?code=${code}` } : {}),
      code,
      expiresAt,
    };
  }

  /**
   * The setup listener's requests. Unauthenticated by design, so: a `Host`
   * that is one of ours, GET/HEAD only, a live offer, and its code (counted
   * against the same guessing limits as `/pair`); anything else is a 404 that
   * does not say which of those was missing.
   */
  private setupRequest(listener: SetupListener, req: http.IncomingMessage, res: http.ServerResponse): void {
    const config = this.lanConfig;
    if (!config || listener.port === undefined || !isLanHost(req.headers.host, listener.port, config.names)) {
      res.writeHead(421, SECURITY_HEADERS).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
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
    if (url.pathname === PAIR_CSS_PATH) {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/css; charset=utf-8' });
      res.end(PAIR_CSS);
      return;
    }
    const files = ['/setup', '/setup/ca.mobileconfig', '/setup/ca.pem'];
    if (!files.includes(url.pathname)) {
      this.html(res, 404, pairMessagePage('Not found', 'There is nothing here.'));
      return;
    }
    const code = url.searchParams.get('code');
    const outcome = this.pairing.verify(code, remoteAddress(req));
    if (!outcome.ok) {
      if (outcome.reason === 'locked' || outcome.lockedOut) {
        this.pairLocked(res);
        return;
      }
      this.opts.gate.loginFailed('browser', outcome.reason, 'web.pair.redeem');
      this.html(res, 404, pairMessagePage('Not found', 'This link is not valid, or has expired. Start pairing again on the Mac and scan the new QR code.'));
      return;
    }
    if (url.pathname !== '/setup') {
      void this.caDownload(url.pathname.replace('/setup', ''), res);
      return;
    }
    const host = String(req.headers.host).replace(/:\d+$/, '');
    const lanPort = this.lan.find((l) => l.port !== undefined && !l.error)?.port;
    if (lanPort === undefined) {
      this.html(res, 503, pairMessagePage('Not available', 'Home-network access is not listening. Check Agent Wrangler on the Mac.'));
      return;
    }
    const q = `code=${encodeURIComponent(String(code))}`;
    this.html(
      res,
      200,
      setupPage({
        mobileconfigHref: `/setup/ca.mobileconfig?${q}`,
        pemHref: `/setup/ca.pem?${q}`,
        pairUrl: `https://${host}:${lanPort}/pair?${q}`,
        userAgent: String(req.headers['user-agent'] ?? ''),
      }),
    );
  }

  /** Open WebSockets per device id (diagnostics, tests). */
  connectionsOf(deviceId: string): number {
    let n = 0;
    for (const l of [this.loopback, ...this.lan]) for (const id of l.sockets.values()) if (id === deviceId) n++;
    return n;
  }

  /** End every WebSocket of a revoked device, now (#137). */
  private disconnectDevice(deviceId: string): void {
    let closed = 0;
    for (const l of [this.loopback, ...this.lan]) {
      for (const [ws, id] of [...l.sockets]) {
        if (id !== deviceId) continue;
        l.sockets.delete(ws);
        ws.terminate();
        closed++;
      }
    }
    this.opts.onDeviceRevoked?.(deviceId);
    this.opts.log(`web: device ${deviceId} revoked; closed ${closed} connection${closed === 1 ? '' : 's'}`);
  }

  dispose(): void {
    this.disposed = true;
    this.revocations.dispose();
    this.pairing.cancel();
    closeListener(this.loopback);
    for (const l of this.lan) closeListener(l);
    this.lan = [];
    for (const l of this.setup) closeSetup(l);
    this.setup = [];
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
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      res.writeHead(400, SECURITY_HEADERS).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!this.sameOrigin(req)) {
        res.writeHead(403, SECURITY_HEADERS).end();
        return;
      }
      // A POST route (#141): the device cookie first, then the route's own checks.
      const route = this.postRouteFor(req);
      if (route) {
        const device = this.devices.verify(readCookie(req.headers.cookie, cookieName(listener.scope)), listener.scope);
        if (!device) text(res, 401, 'Not signed in.');
        else this.runRoute(listener, route.route, req, res, route.url, device.id);
        return;
      }
      // A file for the host (#139), from a signed-in device.
      if (req.method === 'POST' && this.opts.files && url.pathname === UPLOAD_PATH) {
        const device = this.devices.verify(readCookie(req.headers.cookie, cookieName(listener.scope)), listener.scope);
        if (!device) {
          text(res, 401, 'Not signed in.');
          return;
        }
        this.routed(res, this.opts.files.upload(ownerContext('browser', { deviceId: device.id }), req, res));
        return;
      }
      if (req.method === 'POST' && listener.scope === 'lan' && url.pathname === '/pair') {
        void this.pairRedeem(listener, req, res);
        return;
      }
      if (req.method === 'POST' && listener.scope === 'loopback' && url.pathname === '/pair/new') {
        void this.pairStart(listener, req, res);
        return;
      }
      res.writeHead(405, { ...SECURITY_HEADERS, allow: 'GET, HEAD' }).end();
      return;
    }
    if (url.pathname === PAIR_CSS_PATH) {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/css; charset=utf-8' });
      res.end(PAIR_CSS);
      return;
    }
    if (listener.scope === 'lan' && url.pathname === '/pair') {
      this.pairForm(listener, req, res, url.searchParams.get('code') ?? '');
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
          ? 'Not signed in. This device has not been paired with Agent Wrangler on the Mac, or was unpaired. To pair it, run `aw web pair` on the Mac and scan the QR code.'
          : 'Not signed in. Run `aw web open` in a terminal on this Mac to open Agent Wrangler here.',
      );
      return;
    }
    if (url.pathname === '/') {
      this.page(listener, req, res, cookie);
      return;
    }
    if (listener.scope === 'loopback' && url.pathname === '/pair/new') {
      this.html(res, 200, pairStartPage({ token: this.formToken(listener, req, res), lanReady: this.lanListening() }));
      return;
    }
    // Files for a remote browser (#139): downloads from an allowlist, and the folder browser.
    if (this.opts.files && (url.pathname === FILES_PATH || url.pathname === DIRS_PATH)) {
      if (req.method !== 'GET') {
        res.writeHead(405, { ...SECURITY_HEADERS, allow: 'GET' }).end();
        return;
      }
      const ctx = ownerContext('browser', { deviceId: device.id });
      this.routed(res, url.pathname === FILES_PATH ? this.opts.files.download(ctx, req, res, url) : this.opts.files.dirs(ctx, req, res, url));
      return;
    }
    // Routes other modules add (#140): reached only by a signed-in device.
    const route = (this.opts.routes ?? []).find((r) => !r.methods && r.match(url.pathname));
    if (route) {
      this.runRoute(listener, route, req, res, url, device.id);
      return;
    }
    // The CA, for a device to install, from the Mac only (#136).
    if (listener.scope === 'loopback' && (url.pathname === '/ca.pem' || url.pathname === '/ca.mobileconfig')) {
      void this.caDownload(url.pathname, res);
      return;
    }
    this.asset(url.pathname, res);
  }

  /** The route that answers this non-GET request, by path and method. */
  private postRouteFor(req: http.IncomingMessage): { route: WebRoute; url: URL } | undefined {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return undefined;
    }
    const route = this.opts.routes?.find((r) => r.methods?.includes(req.method ?? '') && r.match(url.pathname));
    return route ? { route, url } : undefined;
  }

  private runRoute(listener: Listener, route: WebRoute, req: http.IncomingMessage, res: http.ServerResponse, url: URL, deviceId: string): void {
    const context = ownerContext('browser', { deviceId, deviceScope: listener.scope });
    void Promise.resolve()
      .then(() => route.handle({ req, res, url, scope: listener.scope, deviceId, context, gate: this.opts.gate }))
      .catch((err) => {
        this.opts.log(`web: route ${url.pathname} failed: ${String(err)}`);
        if (!res.headersSent) text(res, 500, 'Something went wrong.');
        else res.destroy();
      });
  }

  /** An async route that fails is a 500, never an unhandled rejection or a hung request. */
  private routed(res: http.ServerResponse, done: Promise<void>): void {
    done.catch((err: unknown) => {
      this.opts.log(`web: ${String(err)}`);
      if (!res.headersSent) text(res, 500, 'Something went wrong.');
      else res.destroy();
    });
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

  // ---- pairing (#137) ----

  /** LAN `GET /pair`: the form, with the code from the QR code's link. */
  private pairForm(listener: Listener, req: http.IncomingMessage, res: http.ServerResponse, code: string): void {
    if (this.pairing.locked(remoteAddress(req))) {
      this.pairLocked(res);
      return;
    }
    const token = this.formToken(listener, req, res);
    this.html(res, 200, pairFormPage({ code: code.slice(0, 16), name: summarizeUserAgent(req.headers['user-agent']), token }));
  }

  /**
   * LAN `POST /pair`: the code for a device. Origin has been checked. Locked
   * out first, before the form is read; then the form token; then the code.
   */
  private async pairRedeem(listener: Listener, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const ip = remoteAddress(req);
    if (this.pairing.locked(ip)) {
      req.resume();
      this.pairLocked(res);
      return;
    }
    const form = await readForm(req);
    if (typeof form === 'number') {
      this.html(res, form, pairMessagePage('Not accepted', form === 413 ? 'That form was too large.' : 'That was not a pairing form.'));
      return;
    }
    if (!this.formTokenMatches(listener, req, form.get('token'))) {
      this.html(res, 403, pairMessagePage('This form has expired', 'Open the pairing link again (scan the QR code on the Mac) and try once more.'));
      return;
    }
    const fallbackName = summarizeUserAgent(req.headers['user-agent']);
    const outcome = this.pairing.redeem(form.get('code'), ip);
    if (!outcome.ok) {
      this.opts.gate.loginFailed('browser', outcome.reason, 'web.pair.redeem');
      if (outcome.lockedOut) {
        this.opts.gate.loginFailed('browser', `locked-out-${outcome.lockedOut}`, 'web.pair.redeem');
        this.opts.log(`web: pairing locked out ${outcome.lockedOut === 'global' ? 'for every address' : `for ${ip}`} after repeated wrong codes`);
      }
      if (outcome.offerWithdrawn) this.opts.log('web: pairing code withdrawn after repeated wrong codes; start pairing again');
      if (outcome.reason === 'locked' || outcome.lockedOut) {
        this.pairLocked(res);
        return;
      }
      const error =
        outcome.reason === 'expired'
          ? 'That code has expired. Start pairing again on the Mac for a new one.'
          : 'That code is not right, or has already been used or replaced. Check it against the Mac, or start pairing again there.';
      this.html(res, 401, pairFormPage({ code: '', name: cleanDeviceName(form.get('name'), fallbackName), token: form.get('token') ?? '', error }));
      return;
    }
    const id = crypto.randomUUID();
    if (!this.opts.gate.admit(ownerContext('browser', { deviceId: id }), 'web.pair.redeem', { kind: 'device', id })) {
      this.html(res, 403, pairMessagePage('Not permitted', 'Agent Wrangler refused to pair this device.'));
      return;
    }
    const { device, credential } = this.devices.issue(cleanDeviceName(form.get('name'), fallbackName), id, 'lan');
    this.opts.log(`web: paired lan device ${device.id}`);
    res.writeHead(303, {
      ...SECURITY_HEADERS,
      'set-cookie': [this.cookie(listener, req, credential), this.clearFormCookie(listener, req)],
      location: '/',
    });
    res.end();
  }

  /** Loopback `POST /pair/new`, signed in: start an offer and show its QR code. */
  private async pairStart(listener: Listener, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const device = this.devices.verify(readCookie(req.headers.cookie, cookieName(listener.scope)), listener.scope);
    if (!device) {
      req.resume();
      text(res, 401, 'Not signed in. Run `aw web open` in a terminal on this Mac first.');
      return;
    }
    const form = await readForm(req);
    if (typeof form === 'number') {
      this.html(res, form, pairMessagePage('Not accepted', 'That was not a pairing form.'));
      return;
    }
    if (!this.formTokenMatches(listener, req, form.get('token'))) {
      this.html(res, 403, pairMessagePage('This form has expired', 'Reload the Pair a device page and try again.'));
      return;
    }
    const token = form.get('token') ?? '';
    if (!this.lanListening()) {
      this.html(res, 409, pairStartPage({ token, lanReady: false }));
      return;
    }
    if (!this.opts.gate.admit(ownerContext('browser', { deviceId: device.id }), 'web.pair.start')) {
      text(res, 403, 'Not permitted.');
      return;
    }
    const offer = this.pairingOffer();
    if (!offer) {
      this.html(res, 409, pairStartPage({ token, lanReady: false }));
      return;
    }
    this.opts.log('web: pairing started from a browser on this Mac');
    const svg = qrToSvg(encodeQr(offer.setupUrl ?? offer.url, 'M'), { title: 'Pairing QR code' });
    this.html(res, 200, pairOfferPage({ svg, code: offer.code, url: offer.url, ...(offer.setupUrl ? { setupUrl: offer.setupUrl } : {}), expiresAt: offer.expiresAt, token }));
  }

  private pairLocked(res: http.ServerResponse): void {
    res.setHeader('retry-after', String(Math.ceil(PAIRING_LOCKOUT_MS / 1000)));
    this.html(res, 429, pairMessagePage('Too many attempts', 'Pairing is locked for 15 minutes after too many wrong codes. Wait, then start pairing again on the Mac.'));
  }

  private lanListening(): boolean {
    return !!this.lanConfig && this.lan.some((l) => l.port !== undefined && !l.error);
  }

  /** A fresh form token, set as this listener's form cookie; returned for the form's hidden field. */
  private formToken(listener: Listener, req: http.IncomingMessage, res: http.ServerResponse): string {
    const token = crypto.randomBytes(32).toString('base64url');
    const name = listener.scope === 'lan' ? LAN_PAIR_FORM_COOKIE : PAIR_FORM_COOKIE;
    res.setHeader('set-cookie', `${name}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${PAIR_FORM_MAX_AGE_S}${this.secure(req) ? '; Secure' : ''}`);
    return token;
  }

  private clearFormCookie(listener: Listener, req: http.IncomingMessage): string {
    const name = listener.scope === 'lan' ? LAN_PAIR_FORM_COOKIE : PAIR_FORM_COOKIE;
    return `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${this.secure(req) ? '; Secure' : ''}`;
  }

  /** The form's token equals its cookie, in constant time. */
  private formTokenMatches(listener: Listener, req: http.IncomingMessage, token: string | null): boolean {
    const cookie = readCookie(req.headers.cookie, listener.scope === 'lan' ? LAN_PAIR_FORM_COOKIE : PAIR_FORM_COOKIE);
    if (!cookie || !token || cookie.length !== token.length || token.length > 128) return false;
    return crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(token));
  }

  private html(res: http.ServerResponse, status: number, body: string): void {
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAIR_PAGE_CSP });
    res.end(body);
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
      // Revoked while the handshake was in flight: it does not get in.
      if (!this.devices.has(device.id)) {
        ws.terminate();
        return;
      }
      listener.sockets.set(ws, device.id);
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

/** The peer's address, for pairing's per-address limits. */
function remoteAddress(req: http.IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * A small urlencoded form, or the status to refuse it with: 415 for another
 * type, 413 past `MAX_FORM_BYTES` (by `Content-Length`, or as it streams in).
 */
function readForm(req: http.IncomingMessage): Promise<URLSearchParams | number> {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') {
    req.resume();
    return Promise.resolve(415);
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) {
    req.resume();
    return Promise.resolve(413);
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_FORM_BYTES) {
        done = true;
        resolve(413);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', () => {
      if (done) return;
      done = true;
      resolve(400);
    });
  });
}

function closeSetup(l: SetupListener): void {
  l.server.close();
  l.server.closeAllConnections();
}

function closeListener(l: Listener): void {
  for (const s of l.sockets.keys()) s.terminate();
  l.sockets.clear();
  l.server.close();
  l.server.closeAllConnections();
}

function text(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${body}\n`);
}
