/**
 * Spike #120: the workbench, served to an ordinary browser on this Mac.
 *
 * Off unless the app is started with `AW_WEB_PROTOTYPE=<port>`. It answers on
 * 127.0.0.1 only, and every request needs the token written to
 * `run/web.token` (once, as `?token=`, which becomes an HttpOnly cookie).
 * Findings and the plan it informs are in `docs/plans/browser-workbench.md`.
 *
 * What it proves: the existing pane bundles run unchanged in a browser once a
 * script supplies `agentWranglerHost` (`src/webview/webshim`), and the existing
 * `DashboardHost`/`ConversationHost` run unchanged per browser over a WebSocket
 * `EnvelopeTransport` — one pair per connection, all over the one app.
 *
 * Each browser is a client of its own (#126): confirmations, pickers, toasts
 * and navigation its own clicks cause come back to it over the `shell`
 * channel (`src/core/web/shellChannel.ts`), answered for now with the
 * browser's `confirm()`/`prompt()`. What it does not do, and the plan says who
 * does: in-page modals (#133), TLS, LAN, pairing.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import type { AgentWranglerApp } from '../app/createApp';
import { Emitter, type Disposable } from '../core/events';
import { ownerContext } from '../core/access';
import type { HostServices } from '../host/hostServices';
import type { ConversationHostUi } from '../ui/conversation/conversationHost';
import type { ClientRegistry } from '../core/clients';
import { createShellChannel } from '../core/web/shellChannel';
import { SHELL_PANE } from '../shared/shellProtocol';
import { renderWebviewHtml } from '../ui/html';
import type { EnvelopeTransport } from '../ui/paneChannel';
import {
  acceptKey,
  encodeClose,
  encodePong,
  encodeText,
  isLoopbackHost,
  isSameOrigin,
  readCookie,
  tokenMatches,
  WsDecoder,
} from '../core/web/wsFrames';
import { createWorkbenchHosts } from './workbenchWindow';

const COOKIE = 'aw_web';
/** A browser that stops reading is dropped rather than buffered without end. */
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export interface WebPrototypeOptions {
  app: AgentWranglerApp;
  host: HostServices;
  ui: ConversationHostUi;
  /** Each browser registers as a client, so what it causes comes back to it (#126). */
  clients: ClientRegistry;
  distDir: string;
  runDir: string;
  port: number;
  log: (line: string) => void;
}

/** The port to serve on, or undefined when the prototype is off. */
export function webPrototypePort(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const port = Number(env.AW_WEB_PROTOTYPE);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : undefined;
}

export function startWebPrototype(opts: WebPrototypeOptions): Disposable {
  const { app, host, ui, clients, port, log } = opts;
  const root = path.resolve(opts.distDir, 'webview');
  const token = crypto.randomBytes(32).toString('hex');
  const tokenFile = path.join(opts.runDir, 'web.token');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });

  const connections = new Set<Duplex>();

  const securityHeaders = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  };

  const server = http.createServer((req, res) => {
    if (!isLoopbackHost(req.headers.host, port)) {
      res.writeHead(421, securityHeaders).end();
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (req.method !== 'GET') {
      res.writeHead(405, securityHeaders).end();
      return;
    }

    // The link carries the token once; from then on it is a cookie the page's
    // scripts cannot read, and the token is out of the address bar and history.
    if (url.pathname === '/' && url.searchParams.has('token')) {
      if (!tokenMatches(token, url.searchParams.get('token'))) {
        res.writeHead(403, securityHeaders).end('Wrong token.');
        return;
      }
      res.writeHead(303, {
        ...securityHeaders,
        'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        location: '/',
      });
      res.end();
      return;
    }
    if (!tokenMatches(token, readCookie(req.headers.cookie, COOKIE))) {
      res.writeHead(401, { ...securityHeaders, 'content-type': 'text/plain; charset=utf-8' });
      res.end('Open the link with ?token= from run/web.token.');
      return;
    }

    if (url.pathname === '/') {
      const html = renderWebviewHtml({
        bundleName: 'workbench',
        title: 'Agent Wrangler',
        cssHref: '/workbench.css',
        jsSrc: '/workbench.js',
        cspSource: "'self'",
        extraStylesheets: ['/theme.css'],
        bodyClass: 'aw-shell',
        preScripts: ['/webshim.js'],
        // Explicit as well as 'self': older Safari does not count ws: as 'self'.
        connectSrc: `'self' ws://${req.headers.host}`,
      });
      res.writeHead(200, { ...securityHeaders, 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    const name = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep) || !TYPES[path.extname(file)]) {
      res.writeHead(404, securityHeaders).end();
      return;
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404, securityHeaders).end();
        return;
      }
      res.writeHead(200, { ...securityHeaders, 'content-type': TYPES[path.extname(file)] });
      res.end(body);
    });
  });

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex) => {
    const refuse = (status: string) => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    };
    const key = req.headers['sec-websocket-key'];
    if (
      new URL(req.url ?? '/', 'http://x').pathname !== '/ws' ||
      !isLoopbackHost(req.headers.host, port) ||
      !isSameOrigin(req.headers.origin, req.headers.host) ||
      !tokenMatches(token, readCookie(req.headers.cookie, COOKIE)) ||
      req.headers['sec-websocket-version'] !== '13' ||
      typeof key !== 'string'
    ) {
      refuse('403 Forbidden');
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    attach(socket);
  });

  let connectionSeq = 0;
  function attach(socket: Duplex): void {
    connections.add(socket);
    const incoming = new Emitter<unknown>();
    const decoder = new WsDecoder();
    let open = true;

    const transport: EnvelopeTransport = {
      postMessage: async (msg) => {
        if (!open) return false;
        if (socket.writableLength > MAX_BUFFERED_BYTES) {
          log('web prototype: dropping a browser that stopped reading');
          close(1008);
          return false;
        }
        socket.write(encodeText(JSON.stringify(msg)));
        return true;
      },
      onDidReceiveMessage: (listener) => incoming.event(listener),
    };

    // The cookie is the owner's, so the owner it is; the connection id is for
    // the audit and for sending this browser's prompts, toasts and navigation
    // back to it (#126), never identity (#123).
    const connectionId = `web-${++connectionSeq}`;
    let panes: ReturnType<typeof createWorkbenchHosts> | undefined = createWorkbenchHosts(
      app,
      host,
      ui,
      transport,
      ownerContext('browser', { connectionId }),
    );
    const shell = createShellChannel({
      connectionId,
      post: (envelope) => void transport.postMessage(envelope),
      conversation: () => panes?.conversation,
    });
    const shellIn = incoming.event((raw) => {
      const m = raw as { pane?: unknown; body?: unknown } | undefined;
      if (m && typeof m === 'object' && m.pane === SHELL_PANE) shell.receive(m.body);
    });
    const registration = clients.register(shell.channel);
    log(`web prototype: browser connected (${connections.size} open)`);

    const close = (code?: number) => {
      if (!open) return;
      open = false;
      if (code !== undefined && !socket.destroyed) socket.end(encodeClose(code));
      else socket.destroy();
      // Before the panes: whatever this browser was being asked resolves as cancelled.
      registration.dispose();
      shell.dispose();
      shellIn.dispose();
      panes?.dashboard.dispose();
      panes?.conversation.dispose();
      panes = undefined;
      connections.delete(socket);
      log(`web prototype: browser disconnected (${connections.size} open)`);
    };

    socket.on('data', (chunk: Buffer) => {
      for (const ev of decoder.push(chunk)) {
        if (ev.kind === 'text') {
          try {
            incoming.fire(JSON.parse(ev.text));
          } catch {
            close(1007);
            return;
          }
        } else if (ev.kind === 'ping') {
          socket.write(encodePong(ev.payload));
        } else if (ev.kind === 'close') {
          close(1000);
          return;
        } else {
          close(ev.code);
          return;
        }
      }
    });
    socket.on('close', () => close());
    socket.on('error', () => close());
  }

  server.on('error', (err) => log(`web prototype: not serving: ${String(err)}`));
  server.listen(port, '127.0.0.1', () => log(`web prototype: http://127.0.0.1:${port}/?token=<run/web.token>`));

  return {
    dispose: () => {
      for (const s of connections) s.destroy();
      server.close();
      fs.rmSync(tokenFile, { force: true });
    },
  };
}
