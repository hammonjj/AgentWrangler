/**
 * The workbench in a browser, as a service of whichever process runs the core
 * (#127, #128, #136; moved out of `src/electron/` for the daemon in #131).
 *
 * The HTTP side — page, assets, login link, device cookie and the request
 * guards — is `core/web/server.ts`. The connection itself — handshake, acks
 * and exactly-once, backpressure, snapshot coalescing — is
 * `core/web/browserConnections.ts`. This ties them to one app: each browser
 * gets its own `DashboardHost`/`ConversationHost` pair
 * (`createWorkbenchHosts`), all over the one app, and registers with the
 * app's `ClientRegistry` (#126) so what it causes comes back to it. The bridge
 * on the page is `src/webview/webshim`.
 *
 * It follows the settings live:
 * - `web.enabled` (default on) and `web.port`: the loopback listener,
 *   127.0.0.1 only, sign-in by `aw web open` (`loginLink`);
 * - `web.lan.*` (default off): home-network access over https with the local
 *   CA in `web-tls/` or the user's own certificate (`LanAccess`).
 *
 * Run by the Electron main process while it owns the core, and by the core
 * daemon (`src/daemon/startCore.ts`) when it does. No Electron here.
 */
import * as path from 'node:path';
import type { WebSocket } from 'ws';
import type { AgentWranglerApp } from './createApp';
import { createWorkbenchHosts } from './workbenchHosts';
import type { RequestContext } from '../core/access';
import type { ClientRegistry } from '../core/clients';
import type { ControlWebLinkResult } from '../core/control/protocol';
import { Emitter, type Disposable } from '../core/events';
import { createBrowserConnections } from '../core/web/browserConnections';
import { LAN_DEFAULT_PORT, LanAccess, localHostName, type LanStatus } from '../core/web/lan';
import { WEB_DEFAULT_PORT, WebServer } from '../core/web/server';
import { LocalCertificates, WEB_TLS_DIR } from '../core/web/tls';
import type { HostServices } from '../host/hostServices';
import type { ConversationHostUi } from '../ui/conversation/conversationHost';
import { renderBrowserWorkbenchHtml } from '../ui/html';
import { isMutatingPaneMessage } from '../ui/paneMutations';

export interface BrowserClientsOptions {
  app: AgentWranglerApp;
  host: HostServices;
  ui: ConversationHostUi;
  /** Each browser registers as a client, so what it causes comes back to it (#126). */
  clients: ClientRegistry;
  log: (line: string) => void;
  /** The build the served page is (`WebServer.build`). */
  build: () => string;
}

export interface BrowserClients extends Disposable {
  /** An upgraded socket from an authenticated device. Owned from here on. */
  attach(socket: WebSocket, device: RequestContext): void;
}

export function createBrowserClients(opts: BrowserClientsOptions): BrowserClients {
  const { app, host, ui, clients, log } = opts;
  return createBrowserConnections({
    clients,
    log,
    build: opts.build,
    isMutating: isMutatingPaneMessage,
    createPanes: (transport, context) => createWorkbenchHosts(app, host, ui, transport, context),
  });
}

/** The settings this follows; a change to any of them re-syncs. */
export const WEB_SETTING_KEYS = ['web.enabled', 'web.port', 'web.lan.enabled', 'web.lan.port', 'web.lan.certFile', 'web.lan.keyFile'] as const;

const LAN_OFF: LanStatus = { state: 'off', lines: ['Off. Nothing listens beyond this Mac.'] };

export interface WebWorkbenchOptions {
  app: AgentWranglerApp;
  host: HostServices;
  ui: ConversationHostUi;
  clients: ClientRegistry;
  /** `dist/webview`: the only directory served. In a packaged build, the unpacked copy (plain Node cannot read app.asar). */
  webviewDir: string;
  log: (line: string) => void;
}

export interface WebWorkbench extends Disposable {
  /** A single-use loopback sign-in link, or undefined while nothing listens (`aw web open`, `web.link`). */
  loginLink(): ControlWebLinkResult | undefined;
  /** The loopback port, once listening. */
  readonly port: number | undefined;
  /** LAN access's state, for Preferences. */
  readonly lanStatus: LanStatus;
  readonly onDidChangeLanStatus: (listener: () => void) => Disposable;
  /** Re-read the network now: addresses change across sleep. */
  refresh(): void;
}

interface Running {
  server: WebServer;
  browsers: BrowserClients;
  lan: LanAccess;
  port: number;
  listening: boolean;
}

export function startWebWorkbench(opts: WebWorkbenchOptions): WebWorkbench {
  const { app, host, ui, clients, log } = opts;
  const certs = new LocalCertificates({ dir: path.join(host.dataDir, WEB_TLS_DIR), log });
  let hostName: Promise<string> | undefined;
  const macName = () => (hostName ??= localHostName());
  const lanSettings = () => ({
    enabled: host.settings.get<boolean>('web.lan.enabled', false) === true,
    port: Number(host.settings.get<number>('web.lan.port', LAN_DEFAULT_PORT)),
    certFile: String(host.settings.get<string>('web.lan.certFile', '') ?? '').trim(),
    keyFile: String(host.settings.get<string>('web.lan.keyFile', '') ?? '').trim(),
  });

  let web: Running | undefined;
  let disposed = false;
  let lanStatus: LanStatus = LAN_OFF;
  const statusChanged = new Emitter<void>();
  const setLanStatus = (status: LanStatus) => {
    lanStatus = status;
    statusChanged.fire();
  };

  const stop = () => {
    web?.lan.dispose();
    web?.server.dispose();
    web?.browsers.dispose();
    web = undefined;
    setLanStatus(
      lanSettings().enabled ? { state: 'error', lines: ['Not listening: turn on "Open in a browser" above first.'] } : LAN_OFF,
    );
  };

  const sync = () => {
    if (disposed) return;
    const enabled = host.settings.get<boolean>('web.enabled', true);
    const wanted = Number(host.settings.get<number>('web.port', WEB_DEFAULT_PORT));
    const port = Number.isInteger(wanted) && wanted >= 1024 && wanted <= 65535 ? wanted : WEB_DEFAULT_PORT;
    if (!enabled) {
      if (web) log('web: off');
      stop();
      return;
    }
    if (web && web.port === port) {
      void web.lan.refresh();
      return;
    }
    stop();
    // Each browser registers with the app's client registry, so what it causes comes back to it (#126).
    const browsers = createBrowserClients({ app, host, ui, clients, log, build: () => server.build() });
    const server = new WebServer({
      port,
      webviewDir: opts.webviewDir,
      dataDir: host.dataDir,
      gate: app.access,
      log,
      page: renderBrowserWorkbenchHtml,
      onClient: (socket, context) => browsers.attach(socket, context),
      // `/ca.mobileconfig` on loopback. Made on first request, so a device can
      // be set up before LAN access is switched on. None with the user's own cert.
      caCertificate: async () => {
        const s = lanSettings();
        if (s.certFile && s.keyFile) return undefined;
        return certs.caCertificate(await macName());
      },
    });
    const lan = new LanAccess({ server, certs, settings: lanSettings, log, hostName: macName, onStatus: setLanStatus });
    const entry: Running = { server, browsers, lan, port, listening: false };
    web = entry;
    server.listen().then(
      (bound) => {
        entry.listening = true;
        log(`web: http://127.0.0.1:${bound}/ (sign in with aw web open)`);
        if (web === entry) void lan.refresh();
      },
      (err) => {
        log(`web: not serving on port ${port}: ${String(err)}`);
        if (web === entry) stop();
      },
    );
  };

  sync();
  const settingsSub = host.settings.onDidChange((affects) => {
    if (WEB_SETTING_KEYS.some(affects)) sync();
  });

  return {
    loginLink: () => (web?.listening ? web.server.loginLink() : undefined),
    get port() {
      return web?.listening ? web.server.port : undefined;
    },
    get lanStatus() {
      return lanStatus;
    },
    onDidChangeLanStatus: (listener) => statusChanged.event(listener),
    refresh: () => void web?.lan.refresh(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      settingsSub.dispose();
      web?.lan.dispose();
      web?.server.dispose();
      web?.browsers.dispose();
      web = undefined;
      statusChanged.dispose();
    },
  };
}
