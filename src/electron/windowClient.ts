/**
 * The window as a client of the core daemon (#131, plan §11 step 1).
 *
 * With `experimental.coreDaemon` on, this process runs no core: no
 * `createApp`, no IPC bridge, no preload, no `aw://` documents, no tray. It
 * is a browser window on the daemon's web workbench, the same page a browser
 * tab gets, so the window and every tab are clients of one core and show the
 * same state.
 *
 * 1. `coreElsewhere.ts` has made sure the daemon is running.
 * 2. A single-use login link comes over the control socket (`web.link`, as
 *    `aw web open` asks): this is the same user on the same Mac, which is
 *    what the socket's token already proves.
 * 3. The window loads it. `/login` sets the loopback device cookie and
 *    redirects to `/`. The default session is persistent, so the cookie, and
 *    with it the device, survives a restart; each launch signs in with a fresh
 *    link anyway and the server keeps the device it already has.
 *
 * The page is someone else's transcripts rendered as HTML, so the window is
 * locked down like any other: context isolation, the sandbox, no Node, and
 * navigation only within the loopback origin. Web links go to the real
 * browser (`windowClientPolicy.ts`).
 *
 * Quitting it (⌘Q, closing the window) ends only this process: the daemon,
 * session hosts and agents keep running.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { app, BrowserWindow, dialog, Menu, session, shell, type MenuItemConstructorOptions } from 'electron';
import { ControlClient } from '../cli/client';
import type { ControlWebLinkResult } from '../core/control/protocol';
import { CORE_DAEMON_SETTING } from '../core/daemon/coreDaemon';
import { BUILD_ID } from '../core/session/sessionHostRuntime';
import { shouldReloadRenderer } from './rendererRecovery';
import { loopbackOrigin, navigationVerdict, preferencesUrl, shouldSignInAgain, waitForLoginLink } from './windowClientPolicy';

export interface WindowClientOptions {
  userDataDir: string;
  appRoot: string;
  log: (message: string) => void;
}

/** How long to wait for the daemon's web server to be listening. */
const LINK_TIMEOUT_MS = 20_000;
const LINK_INTERVAL_MS = 250;
/** A 401 is answered with a new link at most this often, so a broken device store cannot loop. */
const SIGN_IN_AGAIN_MIN_MS = 10_000;

export async function runWindowClient(opts: WindowClientOptions): Promise<void> {
  const { userDataDir, appRoot, log } = opts;
  const runDirs = { runDir: path.join(userDataDir, 'run'), fallbackRunDir: path.join(os.homedir(), '.agentwrangler', 'run') };
  const settingsFile = path.join(userDataDir, 'settings.json');

  /** One `web.link` over the control socket; undefined while nothing answers. */
  const askForLink = async (): Promise<{ url: string } | undefined> => {
    const client = await ControlClient.connect(runDirs, { build: BUILD_ID, name: 'window' });
    if (!client) return undefined;
    try {
      return await client.request<ControlWebLinkResult>('web.link');
    } finally {
      client.close();
    }
  };
  const loginLink = () => waitForLoginLink(askForLink, { timeoutMs: LINK_TIMEOUT_MS, intervalMs: LINK_INTERVAL_MS });

  let window: BrowserWindow | undefined;
  let origin: string | undefined;
  let lastSignIn = 0;
  let rendererReloads: number[] = [];

  const failed = async (err: unknown): Promise<void> => {
    const message = err instanceof Error ? err.message : String(err);
    log(`window client: no sign-in link: ${message}`);
    await dialog.showMessageBox({
      type: 'error',
      message: 'Agent Wrangler could not open its window',
      detail:
        `${message}\n\nThe background service is still running, and so are your agents. ` +
        '"aw daemon status" says how it is; "aw web open" opens it in a browser. ' +
        `To run Agent Wrangler in this window again, turn off ${CORE_DAEMON_SETTING} in settings.json, ` +
        'run "aw daemon stop", and open Agent Wrangler again.',
      buttons: ['Quit'],
    });
    app.quit();
  };

  /** A fresh link into the window (and nothing else): first load, a 401, or Reload. */
  const signIn = async (): Promise<void> => {
    let url: string;
    try {
      url = await loginLink();
    } catch (err) {
      if (!window || window.isDestroyed()) return failed(err);
      log(`window client: could not sign in again: ${String(err)}`);
      return;
    }
    origin = loopbackOrigin(url);
    lastSignIn = Date.now();
    // Not logged: the link is a credential until it is used.
    log(`window client: signing in to ${origin}`);
    if (!window || window.isDestroyed()) window = createWindow();
    await window.loadURL(url).catch((err: unknown) => log(`window client: load failed: ${String(err)}`));
  };

  const openExternal = (url: string) => {
    void shell.openExternal(url).catch((err: unknown) => log(`window client: could not open a link: ${String(err)}`));
  };

  const createWindow = (): BrowserWindow => {
    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 560,
      minHeight: 420,
      title: app.name,
      show: false,
      backgroundColor: '#1f1f1f',
      icon: path.join(appRoot, 'build', 'icon.png'),
      webPreferences: {
        // No preload: the page talks to the daemon over its WebSocket, like any tab.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // A conversation streaming into a hidden window must keep its pacing.
        backgroundThrottling: false,
      },
    });

    const guard = (event: { preventDefault(): void }, url: string) => {
      const verdict = origin ? navigationVerdict(url, origin) : 'deny';
      if (verdict === 'allow') return;
      event.preventDefault();
      if (verdict === 'external') openExternal(url);
      else log(`window client: blocked a navigation to a ${safeScheme(url)} URL`);
    };
    win.webContents.on('will-navigate', (event, url) => guard(event, url));
    win.webContents.on('will-redirect', (event, url) => guard(event, url));
    // Nothing opens a second window; web links go to the real browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (origin && navigationVerdict(url, origin) !== 'deny') openExternal(url);
      return { action: 'deny' };
    });

    // A revoked or expired device: sign in again rather than show "run aw web open".
    win.webContents.on('did-navigate', (_event, url, code) => {
      if (!origin || !shouldSignInAgain(code, url, origin)) return;
      if (Date.now() - lastSignIn < SIGN_IN_AGAIN_MIN_MS) return;
      log('window client: signed out; signing in again');
      void signIn();
    });

    win.webContents.on('console-message', (details) => {
      if (details.level !== 'warning' && details.level !== 'error') return;
      log(`renderer ${details.level}: ${details.message} (${details.sourceId}:${details.lineNumber})`);
    });

    // The page holds nothing the daemon does not, so a crashed renderer just reloads (bounded).
    win.webContents.on('render-process-gone', (_event, details) => {
      log(`renderer gone: ${details.reason} (exit code ${details.exitCode})`);
      const decision = shouldReloadRenderer(details.reason, rendererReloads, Date.now());
      rendererReloads = decision.history;
      if (decision.reload && !win.isDestroyed()) win.webContents.reload();
    });

    win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
      if (window === win) window = undefined;
    });
    return win;
  };

  // Only the workbench's own origin may ask for anything (the microphone, notifications).
  session.defaultSession.setPermissionRequestHandler((contents, _permission, callback, details) => {
    const from = details.requestingUrl || contents.getURL();
    callback(origin !== undefined && navigationVerdict(from, origin) === 'allow');
  });
  session.defaultSession.setPermissionCheckHandler((_contents, _permission, requestingOrigin) =>
    origin !== undefined && requestingOrigin === origin,
  );

  /** Preferences is a route of the workbench the window shows: go there, in this window (#135). */
  const openPreferences = async (): Promise<void> => {
    if (!window || window.isDestroyed() || !origin) await signIn();
    if (!window || window.isDestroyed() || !origin) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    await window.loadURL(preferencesUrl(origin)).catch((err: unknown) => log(`window client: could not open Preferences: ${String(err)}`));
  };

  installClientMenu({
    settingsFile,
    logFile: path.join(userDataDir, 'agent-wrangler.log'),
    openPreferences: () => void openPreferences(),
    reload: () => void signIn(),
    openInBrowser: () => {
      void loginLink().then(openExternal, (err: unknown) => {
        void dialog.showMessageBox({ type: 'error', message: 'Could not open Agent Wrangler in a browser', detail: String(err instanceof Error ? err.message : err) });
      });
    },
  });

  // The window is the whole of this process: closing it quits, and quitting
  // leaves the daemon and its agents running.
  app.on('window-all-closed', () => app.quit());
  app.on('second-instance', () => {
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show();
    } else void signIn();
  });
  app.on('activate', () => {
    if (!window || window.isDestroyed()) void signIn();
  });
  // The device cookie is written to disk lazily; make sure it is there before the process goes.
  let flushed = false;
  app.on('before-quit', (event) => {
    if (flushed) return;
    event.preventDefault();
    flushed = true;
    void session.defaultSession.cookies
      .flushStore()
      .catch(() => undefined)
      .finally(() => app.quit());
  });

  await signIn();
}

/** For the log: the scheme only, never the whole URL. */
function safeScheme(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  return m ? m[1].toLowerCase() : 'malformed';
}

/**
 * The menu while the window is a client. The workbench's own commands (new
 * conversation, pause all, refresh) are in the page, which is where every
 * client has them; what is left needs no core, or goes through the control
 * socket as `aw` does. Settings… (⌘,) is the workbench's `#/preferences`
 * route, shown in this window (#135); `settings.json` stays one item away.
 */
function installClientMenu(actions: {
  settingsFile: string;
  logFile: string;
  openPreferences: () => void;
  reload: () => void;
  openInBrowser: () => void;
}): void {
  const mac = process.platform === 'darwin';
  const openFile = (file: string) => void shell.openPath(file);
  const settingsItems: MenuItemConstructorOptions[] = [
    { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: actions.openPreferences },
    { label: 'Open Settings File', click: () => openFile(actions.settingsFile) },
    { label: 'Open in Browser', click: actions.openInBrowser },
    { label: 'Show Log', click: () => openFile(actions.logFile) },
  ];
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              ...settingsItems,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              // Ends this window only; the background service and agents keep running.
              { role: 'quit' },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: mac ? [{ role: 'close' }] : [...settingsItems, { type: 'separator' }, { role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        // A fresh sign-in, not just a reload: it also finds the daemon on a new port.
        { label: 'Reload', accelerator: 'CmdOrCtrl+Shift+R', click: actions.reload },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(mac ? ([{ type: 'separator' }, { role: 'front' }] as MenuItemConstructorOptions[]) : [])],
    },
    {
      role: 'help',
      submenu: [{ label: 'Agent Wrangler on GitHub', click: () => void shell.openExternal('https://github.com/hammonjj/AgentWrangler') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
