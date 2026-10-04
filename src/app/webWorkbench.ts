/**
 * The workbench in a browser, as a service of the core daemon (#127, #128,
 * #131, #136).
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
 * Run by the core daemon (`src/daemon/startCore.ts`, through `clients.ts`).
 */
import * as path from 'node:path';
import type { WebSocket } from 'ws';
import type { AgentWranglerApp } from './createApp';
import { createPreferencesBackend } from './preferencesBackend';
import { createWorkbenchHosts } from './workbenchHosts';
import type { PreferencesBackend } from '../ui/preferencesHost';
import type { RequestContext } from '../core/access';
import type { ClientRegistry } from '../core/clients';
import type { ControlWebLinkResult } from '../core/control/protocol';
import { Emitter, type Disposable } from '../core/events';
import { createBrowserConnections } from '../core/web/browserConnections';
import { LAN_DEFAULT_PORT, LanAccess, localHostName, type LanStatus } from '../core/web/lan';
import { WEB_DEFAULT_PORT, WebServer } from '../core/web/server';
import { LocalCertificates, WEB_TLS_DIR } from '../core/web/tls';
import { WEB_DEVICES_FILE, WebDeviceStore } from '../core/web/devices';
import { createDictationRoute } from '../core/web/dictationRoute';
import type { WebFiles } from '../core/web/files';
import { createFileViewRoute } from '../core/web/fileView';
import type { WebRoute } from '../core/web/server';
import type { HostServices, HostShell } from '../host/hostServices';
import { createWebFiles } from './webFiles';
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
  /** Whether a folder a browser chose may be used as a host path (`WebFiles.folderAllowed`, #139). */
  folderAllowed: (dir: string) => Promise<boolean>;
  /** The Mac's own shell: what a loopback browser's "Open on this Mac" does (#140). */
  hostShell?: HostShell;
  /** What each browser's `#/preferences` route is served from (#135). Absent: no `preferences` pane. */
  preferences?: PreferencesBackend;
}

export interface BrowserClients extends Disposable {
  /** An upgraded socket from an authenticated device. Owned from here on. */
  attach(socket: WebSocket, device: RequestContext): void;
  /** A revoked device's connections, closed now (#137). */
  closeDevice(deviceId: string): number;
}

export function createBrowserClients(opts: BrowserClientsOptions): BrowserClients {
  const { app, host, ui, clients, log } = opts;
  return createBrowserConnections({
    clients,
    log,
    build: opts.build,
    folderAllowed: opts.folderAllowed,
    ...(opts.hostShell ? { hostShell: opts.hostShell } : {}),
    isMutating: isMutatingPaneMessage,
    appAction: (action, context) => {
      // The same gate every mutating action passes (#123); a refusal is audited and does nothing.
      const name = action === 'restartCodex' ? 'codex.restart' : 'hooks.remove';
      if (!app.access.admit(context, name)) return;
      const run = action === 'restartCodex' ? app.restartCodexServer() : app.uninstallHooks();
      run.catch((e) => log(`web: ${action} failed: ${e instanceof Error ? e.message : String(e)}`));
    },
    createPanes: (transport, context) => createWorkbenchHosts(app, host, ui, transport, context, opts.preferences),
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
  /** The Mac's own shell, for a loopback browser's "Open on this Mac" (#140). */
  hostShell?: HostShell;
  /** The process's device store, when something else (Preferences) shares it. Default: its own, in the data dir. */
  devices?: WebDeviceStore;
  /**
   * More of what a server and its clients are made of, for features that add
   * routes or hooks (pairing, notifications). Called once per server built,
   * with the pieces it shares.
   */
  extend?: (parts: { files: WebFiles }) => { routes?: WebRoute[] };
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
  /** Paired devices (#137): `aw web devices` and Preferences read and revoke through it. */
  readonly devices: WebDeviceStore;
  /** A pairing offer for `aw web pair`; undefined while LAN access is not listening. */
  pairingOffer(): ReturnType<WebServer['pairingOffer']>;
}

interface Running {
  server: WebServer;
  files: WebFiles;
  browsers: BrowserClients;
  lan: LanAccess;
  port: number;
  listening: boolean;
}

export function startWebWorkbench(opts: WebWorkbenchOptions): WebWorkbench {
  const { app, host, ui, clients, log } = opts;
  const devices = opts.devices ?? new WebDeviceStore(path.join(host.dataDir, WEB_DEVICES_FILE), () => Date.now(), log);
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
  // Preferences in every browser (#135): one backend for all of them.
  const preferences = createPreferencesBackend({ app, host, devices, lan: { status: () => lanStatus, onDidChange: statusChanged.event } });

  const stop = () => {
    web?.lan.dispose();
    web?.server.dispose();
    web?.browsers.dispose();
    web?.files.dispose();
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
    // Uploads, downloads and the folder browser for remote browsers (#139).
    const files = createWebFiles(app, { dataDir: host.dataDir, log });
    files.start();
    const extra = opts.extend?.({ files });
    const browsers = createBrowserClients({
      app,
      host,
      ui: { ...ui, allowRemotePath: (p) => files.isStaged(p) },
      clients,
      log,
      hostShell: opts.hostShell,
      preferences,
      build: () => server.build(),
      folderAllowed: (dir) => files.folderAllowed(dir),
    });
    const server = new WebServer({
      files,
      // The read-only file and diff view that stands in for "open in the editor" (#140), on the shared allowlist.
      routes: [
        createFileViewRoute({ allowlist: files.allowlist, log }),
        // Browser dictation (#141): audio recorded in the page, transcribed by the core.
        createDictationRoute({ transcribe: (audio, ext) => app.dictation.transcribeAudio(audio, ext), log }),
        ...(extra?.routes ?? []),
      ],
      // One store for the process, shared with `aw web devices` and Preferences (#137).
      devices,
      onDeviceRevoked: (id) => browsers.closeDevice(id),
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
    const entry: Running = { server, files, browsers, lan, port, listening: false };
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
    devices,
    pairingOffer: () => web?.server.pairingOffer(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      settingsSub.dispose();
      web?.lan.dispose();
      web?.server.dispose();
      web?.browsers.dispose();
      web?.files.dispose();
      web = undefined;
      statusChanged.dispose();
    },
  };
}
