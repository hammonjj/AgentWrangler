/**
 * The workbench, as a window.
 *
 * `WorkbenchPanelManager` does this for an editor tab, and the two are the same
 * shape on purpose: own the document, hand each host a `PaneChannel` that
 * addresses its messages, and otherwise leave `DashboardHost` and
 * `ConversationHost` exactly as they are. Neither of them knows which of these
 * it is inside.
 *
 * What is a tab there is a window here, and the difference is smaller than it
 * sounds because the prerequisite work already removed the only thing that
 * cared: nothing reveals a window or jumps between them any more. The pane is
 * where a conversation happens either way.
 *
 * `openInTab` is the one genuine gap. In VSCode it gives a conversation an
 * editor tab of its own beside your code; here it would be a second window,
 * which is a different product decision and not a porting task, so for now it
 * shows the session in the one window and says so.
 */

import * as path from 'node:path';
import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import type { SessionHandle } from '../core/session/sessionHandle';
import { Emitter, type Disposable } from '../core/events';
import type { AgentWranglerApp } from '../app/createApp';
import type { HostServices, WorkbenchSurface } from '../host/hostServices';
import { ConversationHost, type ConversationHostUi } from '../ui/conversation/conversationHost';
import { DashboardHost } from '../ui/dashboardHost';
import { paneChannel, type EnvelopeTransport } from '../ui/paneChannel';
import { documentUrl } from './bundleProtocol';
import { STATE_GET, STATE_SET, TO_HOST, TO_WEBVIEW } from './channels';
import { shouldReloadRenderer } from './rendererRecovery';

/** What the renderer saves, so a restart comes back on the same conversation. */
interface WorkbenchState {
  conversation?: { key?: string };
}

export interface WorkbenchWindowOptions {
  app: AgentWranglerApp;
  host: HostServices;
  ui: ConversationHostUi;
  /** Where `dist/` is, for the preload script and the window icon. */
  appRoot: string;
  /**
   * The renderer's `setState` document, persisted so a restart reopens on the
   * conversation that was showing. `SessionRegistry` is *not* this: that is the
   * host's `workspaceState`, and it records what was running rather than what
   * was on screen.
   */
  state: { get(): unknown; set(value: unknown): void };
}

export class WorkbenchWindow implements WorkbenchSurface, Disposable {
  private window?: BrowserWindow;
  private dashboard?: DashboardHost;
  private conversation?: ConversationHost;
  /** When the renderer was last reloaded after a crash; bounds automatic reloads. */
  private rendererReloads: number[] = [];
  /** Torn down with the window; the IPC listeners outlive a single document. */
  private windowSubs: Disposable[] = [];
  private readonly ipcSubs: Disposable[] = [];
  private readonly incoming = new Emitter<unknown>();
  private readonly openChanged = new Emitter<boolean>();
  /** True when the window is created, false once it has closed. The Dock icon follows it. */
  readonly onDidChangeOpen = this.openChanged.event;

  constructor(private opts: WorkbenchWindowOptions) {
    const onToHost = (event: IpcMainEvent, message: unknown) => {
      // Only our own window's renderer. A second `BrowserWindow` — a dev-tools
      // extension, an about box — must not be able to drive the session hosts.
      if (event.sender.id !== this.window?.webContents.id) return;
      this.incoming.fire(message);
    };
    ipcMain.on(TO_HOST, onToHost);
    this.ipcSubs.push({ dispose: () => ipcMain.removeListener(TO_HOST, onToHost) });

    // Synchronous, because `paneApi` reads state while the bundle is still
    // evaluating. See the preload for why that round trip exists.
    const onStateGet = (event: IpcMainEvent) => {
      event.returnValue = this.opts.state.get() ?? null;
    };
    ipcMain.on(STATE_GET, onStateGet);
    this.ipcSubs.push({ dispose: () => ipcMain.removeListener(STATE_GET, onStateGet) });

    const onStateSet = (event: IpcMainEvent, value: unknown) => {
      if (event.sender.id !== this.window?.webContents.id) return;
      this.opts.state.set(value);
    };
    ipcMain.on(STATE_SET, onStateSet);
    this.ipcSubs.push({ dispose: () => ipcMain.removeListener(STATE_SET, onStateSet) });
  }

  get isOpen(): boolean {
    return this.window !== undefined && !this.window.isDestroyed();
  }

  /**
   * The window a modal should be parented to, or `undefined` while there is
   * none. Read at the moment a dialog opens rather than captured, because the
   * window can be closed and reopened while the app keeps running and a modal
   * on a destroyed parent throws.
   */
  get browserWindow(): BrowserWindow | undefined {
    return this.isOpen ? this.window : undefined;
  }

  open(options?: { preserveFocus?: boolean }): void {
    if (this.isOpen) {
      const win = this.window!;
      if (win.isMinimized()) win.restore();
      if (options?.preserveFocus) win.showInactive();
      else win.show();
      return;
    }
    this.create(options?.preserveFocus ?? false);
  }

  show(key: string, options?: { preserveFocus?: boolean }): void {
    // A row click should fill the pane beside it, not pull the window forward.
    this.open({ preserveFocus: options?.preserveFocus ?? true });
    this.conversation?.show(key);
  }

  showSession(handle: SessionHandle, options?: { preserveFocus?: boolean }): void {
    this.open({ preserveFocus: options?.preserveFocus ?? false });
    this.conversation?.showSession(handle);
  }

  openInTab(key: string): void {
    // One window for now. Showing it rather than doing nothing is the honest
    // half of the request; the toast is the other half.
    this.show(key, { preserveFocus: false });
    this.opts.host.dialogs.flash('A conversation of its own needs VSCode for now.');
  }

  dispose(): void {
    for (const s of this.ipcSubs) s.dispose();
    this.window?.destroy();
    this.window = undefined;
  }

  private create(preserveFocus: boolean): void {
    const { app, host, ui, appRoot } = this.opts;

    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 560,
      minHeight: 420,
      title: host.appName,
      show: false,
      backgroundColor: '#1f1f1f',
      icon: path.join(appRoot, 'build', 'icon.png'),
      // No title bar on macOS: it said "Agent Wrangler" over a window whose
      // first pane already says which project and which session, and it cost
      // the panes 28px to do it. The strip the traffic lights float over is
      // handled by the shell — `aw-frameless` keeps the panes clear of it and
      // the preload puts a drag handle under it. Elsewhere, an ordinary bar.
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      // Centred in the 30px the shell reserves, rather than the default 12,
      // which assumes the taller bar `hiddenInset` is usually paired with.
      trafficLightPosition: process.platform === 'darwin' ? { x: 13, y: 9 } : undefined,
      webPreferences: {
        preload: path.join(appRoot, 'dist', 'electron', 'preload.js'),
        // The renderer displays other people's transcripts. It gets the three
        // methods in the preload and nothing else.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // A pane that is not visible must keep running: a conversation is
        // streaming into it and a throttled timer loses the stream's pacing.
        backgroundThrottling: false,
      },
    });
    this.window = win;

    // Nothing in this window may navigate anywhere, and nothing may open a
    // second one. Every external link goes through `HostShell.openExternal`,
    // which hands it to the real browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
      host.shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event) => event.preventDefault());

    // A pane that throws while rendering leaves a blank window and no trace:
    // there is no output channel to look in and no editor to open the dev tools
    // from. Warnings and errors go to the app log; `info` and `debug` do not,
    // because the panes log per-message noise at those levels and the log would
    // fill with somebody's conversation.
    win.webContents.on('console-message', (details) => {
      if (details.level !== 'warning' && details.level !== 'error') return;
      host.log(`renderer ${details.level}: ${details.message} (${details.sourceId}:${details.lineNumber})`);
    });

    // A crashed renderer used to leave a blank window. Everything it showed
    // lives here in the main process, and the panes re-initialise from it on
    // `ready`, so a reload brings the same view back. Bounded, so a renderer
    // that crashes on load does not reload forever.
    win.webContents.on('render-process-gone', (_event, details) => {
      host.log(`renderer gone: ${details.reason} (exit code ${details.exitCode})`);
      const decision = shouldReloadRenderer(details.reason, this.rendererReloads, Date.now());
      this.rendererReloads = decision.history;
      if (decision.reload && !win.isDestroyed()) {
        win.webContents.reload();
      } else if (!decision.reload && details.reason !== 'clean-exit') {
        host.dialogs.error('Agent Wrangler: the window keeps crashing, so it was not reloaded again. Close it and reopen it from the Dock.');
      }
    });

    const transport: EnvelopeTransport = {
      postMessage: async (msg) => {
        if (!this.isOpen) return false;
        win.webContents.send(TO_WEBVIEW, msg);
        return true;
      },
      onDidReceiveMessage: (listener) => this.incoming.event(listener),
    };

    // Renderer → main is the half that fails silently: the table fills from
    // store pushes whether or not anything is coming back, so a broken preload
    // looks like a working window until the first click does nothing. One line
    // saying a pane spoke is the difference between diagnosing that in a minute
    // and in an afternoon. Only the first from each pane; after that it is traffic.
    const greeted = new Set<string>();
    this.windowSubs.push(
      this.incoming.event((raw) => {
        const pane = (raw as { pane?: string } | undefined)?.pane ?? 'unknown';
        if (greeted.has(pane)) return;
        greeted.add(pane);
        host.log(`renderer connected: ${pane} pane is sending`);
      }),
    );

    this.dashboard = new DashboardHost(
      paneChannel(transport, 'dashboard'),
      app.store,
      app.archive,
      app.actions,
      app.provider,
      app.usage,
      app.codexUsage,
      app.columns,
      app.runnerOwnership,
      app.projects,
      app.launcher,
      app.pause,
      app.pins,
      host.settings,
      host.dialogs,
      app.models,
    );
    this.conversation = new ConversationHost(
      paneChannel(transport, 'conversation'),
      app.store,
      app.provider,
      app.codexProvider,
      app.sessions,
      app.runners,
      app.actions,
      app.dictation,
      app.files,
      // The window is the whole workbench, not one conversation, so its title
      // does not follow the session — the pane shows the name in its header.
      () => undefined,
      ui,
    );
    this.windowSubs.push(this.dashboard, this.conversation);

    win.once('ready-to-show', () => {
      if (preserveFocus) win.showInactive();
      else win.show();
    });

    win.on('closed', () => {
      for (const s of this.windowSubs) s.dispose();
      this.windowSubs = [];
      this.dashboard = undefined;
      this.conversation = undefined;
      this.window = undefined;
      this.openChanged.fire(false);
    });
    this.openChanged.fire(true);

    void win.loadURL(documentUrl('workbench'));

    // The store is very likely empty here — the first provider scan has not
    // landed — so the key is handed over and the host binds it when the session
    // turns up. Same handover `WorkbenchPanelManager.restore` does.
    const key = (this.opts.state.get() as WorkbenchState | undefined)?.conversation?.key;
    if (key) this.conversation.show(key);
  }
}
