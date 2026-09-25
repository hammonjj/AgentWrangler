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
import type { ConversationHostUi } from '../ui/conversation/conversationHost';
import { registerBundleScheme, serveBundles } from './bundleProtocol';
import { installContextMenuEverywhere } from './contextMenu';
import { createElectronHost } from './electronHost';
import { installApplicationMenu } from './menu';
import { JsonStore } from './jsonStore';
import { PaletteWindow } from './paletteWindow';
import { PreferencesWindow } from './preferencesWindow';
import { BUILD_ID, createSessionHostRuntime } from './sessionHostRuntime';
import { MenuBar, menuBarSessions } from './tray';
import { WorkbenchWindow } from './workbenchWindow';

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

function startLog(userDataDir: string): (message: string) => void {
  const file = path.join(userDataDir, 'agent-wrangler.log');
  fs.mkdirSync(userDataDir, { recursive: true });
  // Appended, never rotated by us: it is a developer log for a dev build, and
  // a rotation scheme is a thing to get wrong before there is a reason for one.
  const stream = fs.createWriteStream(file, { flags: 'a' });
  return (message: string) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    stream.write(`${line}\n`);
    // eslint-disable-next-line no-console
    console.log(line);
  };
}

void app.whenReady().then(() => {
  if (!isPrimaryInstance) return; // see the lock above: quit() has not landed yet

  const userDataDir = app.getPath('userData');
  const log = startLog(userDataDir);
  log(`Agent Wrangler starting — Electron ${process.versions.electron}, userData ${userDataDir}`);

  serveBundles(path.join(APP_ROOT, 'dist'));

  let window: WorkbenchWindow | undefined;
  // Built after the host, because it needs nothing from it — but the host needs
  // *it*, for `pick` and `input`. The indirection is the same one `parentWindow`
  // uses and for the same reason: a `let` the closures read when called.
  let palette: PaletteWindow | undefined;
  const host = createElectronHost({
    userDataDir,
    log,
    sessionHosts: {
      runtime: createSessionHostRuntime({ userDataDir, appRoot: APP_ROOT, isPackaged: app.isPackaged, execPath: process.execPath, log }),
      runDir: path.join(userDataDir, 'run'),
      fallbackRunDir: path.join(os.homedir(), '.agentwrangler', 'run'),
      logDir: path.join(userDataDir, 'logs'),
    },
    palette: {
      pick: (items, options) => palette?.pick(items, options) ?? Promise.resolve(undefined),
      input: (options) => palette?.input(options) ?? Promise.resolve(undefined),
    },
    // Looked up rather than captured: the window can be closed and reopened
    // while the app keeps running, and a modal on a destroyed parent throws.
    // Also why this is a closure over a `let` — the host is built before the
    // window, because the window needs the app, which needs the host.
    parentWindow: () => window?.browserWindow,
  });

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
  });
  wrangler.attachSurface(window);

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
    runAction: (id) => wrangler.runSettingAction(id),
    onDidChangeOpen: () => syncDock(),
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
      }),
    });
    control.listen(socketPath).then(
      () => log(`control socket: listening on ${socketPath}`),
      (err) => log(`control socket: not serving: ${String(err)}`),
    );
  } catch (err) {
    log(`control socket: not serving: ${String(err)}`);
  }

  const teardown = () => {
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
      log(`Agent Wrangler quitting (${source}); ${counts.local} in-process and ${counts.hosted} hosted session(s)`);
      if (decision.confirm) {
        const keeps =
          counts.hosted > 0 ? `\n\n${agentCount(counts.hosted)} running in session hosts keep running.` : '';
        const choice = await host.dialogs.warn(
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
