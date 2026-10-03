/**
 * The Electron front end.
 *
 * The mirror of `src/extension.ts`, and deliberately the same four steps:
 * build a `HostServices`, build the application on it, give it a surface to
 * draw in, and register the things that invoke it. Everything about sessions
 * is in `src/app/createApp.ts` and is shared verbatim with the extension.
 *
 * **One instance.** A second copy of the app would be a second session
 * registry and therefore a second process willing to resume the same
 * session id — two processes on one id is the thing that corrupts a
 * transcript. The lock is taken before anything else and a second launch
 * simply raises the window that already exists.
 *
 * The app and the *extension* can still both be running, and there is no lease
 * between them yet; that gap is recorded in `docs/plans/electron-app-migration.md`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app, Notification, powerMonitor, powerSaveBlocker } from 'electron';
import { createApp } from '../app/createApp';
import { createControlBackend } from '../app/controlBackend';
import { controlSocketPath, controlTokenPath } from '../core/control/paths';
import { ControlServer, ensurePrivateDir, writeControlToken } from '../core/control/server';
import { DictationSetupError, defaultModelPath } from '../core/dictation';
import { shouldPreventAppSuspension } from '../core/menuBar';
import { agentCount, quitIntentSource, quitPolicy, type QuitSource } from '../core/session/quitPolicy';
import { sourceStatus } from '../shared/orchestration/sourceHealth';
import { parseRoutingSettings, ROUTING_KEY } from '../shared/orchestration/executionPolicy';
import type { ConversationHostUi } from '../ui/conversation/conversationHost';
import { registerBundleScheme, serveBundles } from './bundleProtocol';
import { installContextMenuEverywhere } from './contextMenu';
import { startFileLog } from '../core/fileLog';
import { JsonStore } from '../core/jsonStore';
import { BUILD_ID, createSessionHostRuntime } from '../core/session/sessionHostRuntime';
import { toolPath } from '../core/toolPath';
import { createElectronHost } from './electronHost';
import { installApplicationMenu } from './menu';
import { PaletteWindow } from './paletteWindow';
import { PreferencesWindow } from './preferencesWindow';
import { createRemoteDaemonAgent } from '../node/remoteDaemonAgent';
import { coreRunsElsewhere } from './coreElsewhere';
import { socketAnswers } from '../core/control/probe';
import { coreDaemonPaths, findCoreHolder } from '../core/daemon/coreDaemon';
import { MenuBar, menuBarSessions } from './tray';
import { WINDOW_CONNECTION_ID, WINDOW_CONTEXT, WorkbenchWindow, windowClientChannel } from './workbenchWindow';
import { createBrowserClients, type BrowserClients } from './webPrototype';
import { WEB_DEFAULT_PORT, WebServer } from '../core/web/server';
import { renderBrowserWorkbenchHtml } from '../ui/html';
import { ClientRegistry } from '../core/clients';
import { runInRequest } from '../core/requestScope';
import type { HostDialogs } from '../host/hostServices';

// Git invokes git-lfs through PATH while checking out task worktrees. Finder's
// environment lacks Homebrew's bin directory even when git-lfs is installed.
process.env.PATH = toolPath(process.env.PATH);

// Before anything reads `getPath('userData')` — which is derived from it — and
// before the menu is built, since macOS takes the first menu's title from here.
// Without it the app is "Electron" and its preferences live in Electron's own
// directory, shared with every other unpackaged Electron app on the machine.
app.setName('Agent Wrangler');

// Before `whenReady`: a scheme cannot be privileged once a renderer exists.
registerBundleScheme();

// Before any window is built, so no renderer can be created without it. An
// Electron app has no right-click menu at all unless it makes one, and a text
// field with no Cut/Copy/Paste reads as broken.
installContextMenuEverywhere();

/**
 * Whether this process is the one. The running copy gets a `second-instance`
 * event and raises its window, which is the right answer to a double-click.
 *
 * `app.quit()` is not enough on its own: it is asynchronous, so everything
 * below would still run — a second `whenReady`, a second set of providers, a
 * second process writing the same JSON files — for however long the quit takes.
 * Hence the guard around the whole of startup rather than an early `return`,
 * which a module cannot do.
 *
 * The line on stderr is for a terminal. Launched from the Dock the handoff is
 * visible (a window comes forward); launched from a shell, a silent exit 0
 * looks exactly like a crash, and it cost an afternoon once.
 */
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  // eslint-disable-next-line no-console
  console.error('Agent Wrangler is already running; raising that window instead.');
  app.quit();
}

/** Repo root in development (`dist/electron/main.js` → two levels up). */
const APP_ROOT = path.resolve(__dirname, '..', '..');

void app.whenReady().then(async () => {
  if (!isPrimaryInstance) return; // see the lock above: quit() has not landed yet

  const userDataDir = app.getPath('userData');
  const log = startFileLog(userDataDir);
  log(`Agent Wrangler starting — Electron ${process.versions.electron}, userData ${userDataDir}`);

  // The core runs elsewhere (#130): `experimental.coreDaemon` hands it to the
  // LaunchAgent daemon, or a daemon already holds `run/core.sock`. Never two
  // cores at once; `coreElsewhere.ts` says so and quits.
  if (await coreRunsElsewhere({ userDataDir, appRoot: APP_ROOT, log })) return;

  serveBundles(path.join(APP_ROOT, 'dist'));

  let window: WorkbenchWindow | undefined;
  // Built after the host, because it needs nothing from it — but the host needs
  // *it*, for `pick` and `input`. The indirection is the same one `parentWindow`
  // uses and for the same reason: a `let` the closures read when called.
  let palette: PaletteWindow | undefined;
  // One runtime for both: the remote daemon runs from the session hosts' clone.
  const runtime = createSessionHostRuntime({ userDataDir, appRoot: APP_ROOT, isPackaged: app.isPackaged, execPath: process.execPath, log });
  const hostDirs = {
    runDir: path.join(userDataDir, 'run'),
    fallbackRunDir: path.join(os.homedir(), '.agentwrangler', 'run'),
    logDir: path.join(userDataDir, 'logs'),
  };
  // Every client the app has: the window, and each browser of the web
  // prototype. The app is given the registry's dialogs and surface, which
  // reach whichever client a request came from (#126); the native dialogs are
  // the window client's own.
  const clients = new ClientRegistry({ log, navigationFallback: WINDOW_CONNECTION_ID });
  let nativeDialogs: HostDialogs | undefined;
  /** As the user at this Mac: the window client. For the menu, tray, Preferences and notifications. */
  const asLocalUser = <T,>(fn: () => T): T => runInRequest(WINDOW_CONTEXT, fn);
  const host = createElectronHost({
    userDataDir,
    log,
    sessionHosts: { runtime, ...hostDirs },
    remoteDaemon: createRemoteDaemonAgent({
      runDirs: hostDirs,
      logDir: hostDirs.logDir,
      runtime,
      isPackaged: app.isPackaged,
      log,
      // Never beside a core daemon, which runs Discord itself (#138).
      coreDaemonHolds: async () => {
        const paths = coreDaemonPaths(userDataDir, hostDirs.fallbackRunDir);
        return (await findCoreHolder({ socketPath: paths.socketPath, manifestPath: paths.manifestPath, probe: socketAnswers })).kind === 'daemon';
      },
    }),
    palette: {
      pick: (items, options) => palette?.pick(items, options) ?? Promise.resolve(undefined),
      input: (options) => palette?.input(options) ?? Promise.resolve(undefined),
    },
    // Looked up rather than captured: the window can be closed and reopened
    // while the app keeps running, and a modal on a destroyed parent throws.
    // Also why this is a closure over a `let` — the host is built before the
    // window, because the window needs the app, which needs the host.
    parentWindow: () => window?.browserWindow,
    scopeDialogs: (native) => {
      nativeDialogs = native;
      return clients.dialogs;
    },
    asLocalUser,
  });
  const windowDialogs = nativeDialogs!;

  const wrangler = createApp(host);

  /**
   * What to do when dictation is asked for and a piece of it is missing.
   *
   * The VSCode version offers to run the Homebrew command in a terminal. There
   * is no terminal here, so it names the command and puts it on the clipboard —
   * installing software on someone's behalf is not a thing this should do
   * either way, and the editor version does not do it silently either.
   */
  const offerDictationSetup = async (err: DictationSetupError): Promise<void> => {
    const command =
      err.remedy === 'download-model'
        ? `curl -L --create-dirs -o ${defaultModelPath()} https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`
        : `brew install ${err.remedy === 'install-whisper' ? 'whisper-cpp' : 'ffmpeg'}`;
    const choice = await host.dialogs.warn(
      `Agent Wrangler: ${err.message}`,
      { detail: `Run this in a terminal, then try dictating again:\n\n${command}` },
      'Copy command',
    );
    if (choice === 'Copy command') await host.clipboard.writeText(command);
  };

  const ui: ConversationHostUi = { dialogs: host.dialogs, offerDictationSetup };

  // What the renderer's `setState` holds — which conversation was showing, and
  // where the divider was. Separate from `workspaceState`, which records what
  // was *running*; those come back by different routes and one is not the other.
  const paneState = new JsonStore(path.join(userDataDir, 'window.json'));

  window = new WorkbenchWindow({
    app: wrangler,
    host,
    ui,
    appRoot: APP_ROOT,
    state: {
      get: () => paneState.get<unknown>('workbench', undefined),
      set: (value) => paneState.update('workbench', value),
    },
    dialogs: windowDialogs,
  });
  // The window is a client for the app's whole life, open or not: the menu and
  // tray act as it, native dialogs need no window, and navigating to it opens it.
  host.subscribe(clients.register(windowClientChannel(window, windowDialogs)));
  wrangler.attachSurface(clients.surface);

  // `showQuickPick` and `showInputBox`, which Electron has neither of: renaming
  // a conversation, the session picker behind the menu items that ask *which*,
  // and the folder list behind New Conversation all come through here.
  palette = new PaletteWindow({
    log,
    appRoot: APP_ROOT,
    parentWindow: () => window?.browserWindow,
  });

  // ⌘, — the app's answer to VSCode's settings UI. It renders
  // `src/shared/settings.ts`, which is also what `package.json`'s
  // `contributes.configuration` is tested against, so both front ends offer
  // the same settings and a new one is declared once.
  const preferences = new PreferencesWindow({
    settings: host.settingsStore,
    log,
    appRoot: APP_ROOT,
    parentWindow: () => window?.browserWindow,
    runAction: (id) => asLocalUser(() => wrangler.runSettingAction(id)),
    onDidChangeOpen: () => syncDock(),
    // Orchestration → tier map (#29): the catalog, and each source's health
    // from the same usage reads the dashboard cards use.
    orchestration: {
      view: () => {
        const routing = parseRoutingSettings(host.settingsStore.get<unknown>(ROUTING_KEY, undefined));
        return {
          catalog: wrangler.models.catalog,
          sources: [
            sourceStatus('anthropic', wrangler.usage.usage, Date.now()),
            sourceStatus('openai', wrangler.codexUsage.usage, Date.now()),
            ...Object.values(wrangler.localEndpoints.statuses()),
          ],
          // Local endpoints (#51): the registry, and what each model has done (§19.4).
          local: {
            endpoints: wrangler.localEndpoints.view(wrangler.models.catalog),
            summaries: wrangler.localMetrics.summaries(),
            secretsAvailable: host.secrets.available,
          },
          // The global scope of pins and caps (#40), with anything in settings.json that was ignored.
          // With automatic routing's gate and the shadow comparison report (#42).
          routing: {
            mode: routing.mode,
            policy: routing.policy,
            ignored: routing.errors.map((e) => `${e.path}: ${e.message}`),
            ...(routing.autoOverride ? { autoOverride: routing.autoOverride } : {}),
            ...wrangler.autoRouting(),
          },
        };
      },
      onDidChange: (listener) => {
        const subs = [
          wrangler.models.onDidChange(listener),
          wrangler.usage.onDidChange(listener),
          wrangler.codexUsage.onDidChange(listener),
          wrangler.localEndpoints.onDidChange(listener),
          wrangler.localMetrics.onDidChange(listener),
          wrangler.onDidChangeRoutingEvidence(listener),
        ];
        return { dispose: () => subs.forEach((s) => s.dispose()) };
      },
      setPolicy: (change) => wrangler.models.setPolicy(change),
      // Can ask for an endpoint's key: as the window, so the question appears there.
      localEndpoint: (change) => asLocalUser(() => wrangler.localEndpoints.apply(change)),
      // Frozen into each mission recorded after this; a started mission keeps what it had (§10.2).
      setRouting: (value) => host.settingsStore.update(ROUTING_KEY, value),
    },
  });

  // ---- Windowless (playbook Stage 6) ----
  //
  // With no window open the app is a menu-bar app: the Dock icon goes, the
  // menu-bar item stays. It comes back when a window opens. `dock.show()` does
  // not activate the app, so reopening from the menu bar or a notification is
  // the only thing that brings it forward — and that is the user's click.
  const syncDock = () => {
    if (!app.dock) return;
    const visible = window?.isOpen || preferences?.isOpen;
    if (visible && !app.dock.isVisible()) void app.dock.show();
    else if (!visible && app.dock.isVisible()) app.dock.hide();
  };
  window.onDidChangeOpen(() => syncDock());
  // ---- Quitting (playbook §7.2, §11.10) ----
  //
  // Electron gives `before-quit` no reason, so the sources the app owns label
  // themselves: the menu's own Quit item, the SIGTERM handler below, and
  // `install-app.sh` through a `run/quit-intent` file. Anything unlabelled is
  // external (an `osascript` quit, Dock → Quit, logout) and never gets a dialog.
  let quitSource: QuitSource | undefined;
  let quitInProgress = false;
  const requestQuit = (source: QuitSource) => {
    quitSource = source;
    app.quit();
  };
  const quitIntentFile = path.join(userDataDir, 'run', 'quit-intent');
  const readQuitIntent = (): QuitSource | undefined => {
    try {
      const content = fs.readFileSync(quitIntentFile, 'utf8');
      const age = Date.now() - fs.statSync(quitIntentFile).mtimeMs;
      fs.rmSync(quitIntentFile, { force: true });
      return quitIntentSource(content, age);
    } catch {
      return undefined; // no marker: not an announced quit
    }
  };

  installApplicationMenu(wrangler, window, () => preferences.open(), {
    quit: () => requestQuit('menu'),
    quitAndStopAll: () => requestQuit('menuStopAll'),
  });

  // Registered here, inside `whenReady`: one registered at module load is
  // replaced by Electron's own SIGTERM handler and never runs (spike S2).
  // Electron already turns SIGTERM into a graceful quit; this only labels it.
  process.on('SIGTERM', () => {
    log('SIGTERM received');
    requestQuit('signal');
  });

  app.on('second-instance', () => window?.open());
  // macOS: the dock icon after every window has been closed. The backend is
  // still running and still watching sessions, so this is a show, not a start.
  app.on('activate', () => window?.open());

  // ---- Sleep (playbook §8 "Machine sleeps") ----
  //
  // On wake, links and the Discord gateway are rechecked at once rather than
  // at their next heartbeat (spike M2: a sleep leaves no timer gap to detect
  // it by). Idle sleep while agents work is the power block below.
  powerMonitor.on('resume', () => wrangler.onSystemResume());

  const menuBar = new MenuBar({
    app: wrangler,
    surface: window,
    openPreferences: () => preferences.open(),
    quit: () => requestQuit('menu'),
    quitAndStopAll: () => requestQuit('menuStopAll'),
  });

  // Open at login: opt-in, and a login item only — nothing relaunches the app
  // after a quit or a crash. Packaged builds only: in development it would
  // register the bare Electron binary.
  const syncLoginItem = () => {
    if (!app.isPackaged) return;
    const wanted = host.settings.get<boolean>('openAtLogin', false);
    if (app.getLoginItemSettings().openAtLogin === wanted) return;
    app.setLoginItemSettings({ openAtLogin: wanted });
    log(`open at login ${wanted ? 'on' : 'off'}`);
  };
  syncLoginItem();
  host.subscribe(host.settings.onDidChange((affects) => {
    if (affects('openAtLogin')) syncLoginItem();
  }));

  // App Nap (spike S2, playbook §11.10): held only while an agent this app
  // runs is working or holding a permission ask, because the same assertion
  // also stops idle system sleep.
  let powerBlockId: number | undefined;
  const syncPowerBlock = () => {
    const wanted = shouldPreventAppSuspension(menuBarSessions(wrangler));
    if (wanted && powerBlockId === undefined) {
      powerBlockId = powerSaveBlocker.start('prevent-app-suspension');
    } else if (!wanted && powerBlockId !== undefined) {
      powerSaveBlocker.stop(powerBlockId);
      powerBlockId = undefined;
    }
  };
  host.subscribe(wrangler.store.onDidUpdate(() => syncPowerBlock()));

  // Launched as a login item: start in the menu bar, not in your face.
  const atLogin = app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin;
  if (atLogin) {
    log('opened at login; starting in the menu bar');
    syncDock();
  } else {
    window.open();
  }
  wrangler.start();

  // The `aw` command-line client's way in (#21). Nothing depends on it, so a
  // failure to serve it is logged and the app carries on.
  const runDirs = { runDir: path.join(userDataDir, 'run'), fallbackRunDir: path.join(os.homedir(), '.agentwrangler', 'run') };
  // The browser workbench (#127), started below; `aw web open` asks it for a link.
  let web: { server: WebServer; clients: BrowserClients; port: number; listening: boolean } | undefined;
  let control: ControlServer | undefined;
  try {
    const socketPath = controlSocketPath(runDirs);
    ensurePrivateDir(path.dirname(socketPath));
    control = new ControlServer({
      token: writeControlToken(controlTokenPath(runDirs)),
      log,
      backend: createControlBackend(wrangler, {
        build: BUILD_ID,
        appPid: process.pid,
        startedAt: Date.now(),
        flash: (message) => host.dialogs.flash(message, 4000),
        gate: wrangler.access,
        webLink: () => (web?.listening ? web.server.loginLink() : undefined),
      }),
    });
    control.listen(socketPath).then(
      () => log(`control socket: listening on ${socketPath}`),
      (err) => log(`control socket: not serving: ${String(err)}`),
    );
  } catch (err) {
    log(`control socket: not serving: ${String(err)}`);
  }

  // The workbench in a browser on this Mac (#127): 127.0.0.1 only, sign-in by
  // `aw web open`. On by default; follows `web.enabled` and `web.port` live.
  const stopWeb = () => {
    web?.server.dispose();
    web?.clients.dispose();
    web = undefined;
  };
  const syncWeb = () => {
    const enabled = host.settings.get<boolean>('web.enabled', true);
    const wanted = Number(host.settings.get<number>('web.port', WEB_DEFAULT_PORT));
    const port = Number.isInteger(wanted) && wanted >= 1024 && wanted <= 65535 ? wanted : WEB_DEFAULT_PORT;
    if (!enabled) {
      if (web) log('web: off');
      stopWeb();
      return;
    }
    if (web && web.port === port) return;
    stopWeb();
    // Each browser registers with the app's client registry, so what it causes comes back to it (#126).
    const browsers = createBrowserClients({ app: wrangler, host, ui, clients, log });
    const server = new WebServer({
      port,
      webviewDir: path.join(APP_ROOT, 'dist', 'webview'),
      dataDir: host.dataDir,
      gate: wrangler.access,
      log,
      page: renderBrowserWorkbenchHtml,
      onClient: (socket, context) => browsers.attach(socket, context),
    });
    const entry = { server, clients: browsers, port, listening: false };
    web = entry;
    server.listen().then(
      (bound) => {
        entry.listening = true;
        log(`web: http://127.0.0.1:${bound}/ (sign in with aw web open)`);
      },
      (err) => {
        log(`web: not serving on port ${port}: ${String(err)}`);
        if (web === entry) stopWeb();
      },
    );
  };
  syncWeb();
  host.subscribe(host.settings.onDidChange((affects) => {
    if (affects('web.enabled') || affects('web.port')) syncWeb();
  }));

  const teardown = () => {
    stopWeb();
    control?.dispose();
    menuBar.dispose();
    if (powerBlockId !== undefined) powerSaveBlocker.stop(powerBlockId);
    preferences.dispose();
    palette?.dispose();
    window?.dispose();
    wrangler.dispose();
    host.disposeAll();
  };

  app.on('before-quit', (event) => {
    // Held until the agents have been ended, then `app.exit` (which does not
    // come back through here) finishes the job.
    event.preventDefault();
    if (quitInProgress) return;
    quitInProgress = true;
    const source = quitSource ?? readQuitIntent() ?? 'external';
    quitSource = undefined;
    void (async () => {
      const counts = wrangler.sessionCounts();
      const decision = quitPolicy({ source, ...counts });
      log(`Agent Wrangler quitting (${source}); ${counts.hosted} hosted and ${counts.local} in-app Codex session(s)`);
      if (decision.confirm) {
        const keeps =
          counts.hosted > 0 ? `\n\n${agentCount(counts.hosted)} running in session hosts keep running.` : '';
        // Only a menu quit asks, and the menu is this Mac's: ask natively,
        // never through whichever client happens to be scoped (#126).
        const choice = await windowDialogs.warn(
          `Quit and stop ${agentCount(counts.local)}?`,
          {
            modal: true,
            detail:
              'Agent Wrangler runs these sessions itself, so quitting ends them. Nothing is lost: each ' +
              'conversation is kept in its transcript, and comes back as an Interrupted row you can resume.' +
              keeps,
          },
          'Quit and Stop',
        );
        if (choice !== 'Quit and Stop') {
          log('quit cancelled');
          quitInProgress = false;
          return;
        }
      }
      // Committed to quitting: `aw send`/`aw stop` must not race the ending below.
      control?.stopMutations();
      try {
        await wrangler.stopAllForQuit(decision.stopWithinMs, { includeHosted: decision.stopHosted });
      } catch (err) {
        log(`ending sessions at quit failed: ${String(err)}`);
      }
      if (decision.announceRunning > 0 && Notification.isSupported()) {
        new Notification({
          title: `${agentCount(decision.announceRunning)} keep running`,
          // The accepted risk of §8.1: nothing enforces the usage cap while the app is shut.
          body:
            'Agent Wrangler reconnects when you open it again. ⌥⌘Q quits and stops them.' +
            (wrangler.getConfig().autoPauseEnabled ? ' Auto-pause is off until then.' : ''),
          silent: true,
        }).show();
        // A moment for the notification to be handed to the system before the process goes.
        await new Promise((r) => setTimeout(r, 300));
      }
      teardown();
      app.exit(0);
    })();
  });
});

/**
 * Closing the window does not quit, even on Windows and Linux.
 *
 * The usual rule is the other way round, and it is wrong for this: the app is
 * running conversations. Quitting ends every runner it owns, and the point of
 * closing a window is usually to get it off the screen. The menu-bar item
 * (`tray.ts`) is what shows it is still running, and where it quits from.
 */
app.on('window-all-closed', () => {
  // Deliberately empty. See above.
});
