/**
 * The Electron front end.
 *
 * The mirror of `src/extension.ts`, and deliberately the same four steps:
 * build a `HostServices`, build the application on it, give it a surface to
 * draw in, and register the things that invoke it. Everything about sessions
 * is in `src/app/createApp.ts` and is shared verbatim with the extension.
 *
 * **One instance.** A second copy of the app would be a second
 * `RunnerRegistry` and therefore a second process willing to resume the same
 * session id — two processes on one id is the thing that corrupts a
 * transcript. The lock is taken before anything else and a second launch
 * simply raises the window that already exists.
 *
 * The app and the *extension* can still both be running, and there is no lease
 * between them yet; that gap is recorded in `docs/plans/electron-app-migration.md`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import { createApp } from '../app/createApp';
import { DictationSetupError, defaultModelPath } from '../core/dictation';
import type { ConversationHostUi } from '../ui/conversation/conversationHost';
import { registerBundleScheme, serveBundles } from './bundleProtocol';
import { installContextMenuEverywhere } from './contextMenu';
import { createElectronHost } from './electronHost';
import { installApplicationMenu } from './menu';
import { JsonStore } from './jsonStore';
import { PaletteWindow } from './paletteWindow';
import { PreferencesWindow } from './preferencesWindow';
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
  });
  installApplicationMenu(wrangler, window, () => preferences.open());

  app.on('second-instance', () => window?.open());
  // macOS: the dock icon after every window has been closed. The backend is
  // still running and still watching sessions, so this is a show, not a start.
  app.on('activate', () => window?.open());

  window.open();
  wrangler.start();

  app.on('before-quit', () => {
    log('Agent Wrangler quitting');
    preferences.dispose();
    palette?.dispose();
    window?.dispose();
    wrangler.dispose();
    host.disposeAll();
  });
});

/**
 * Closing the window does not quit, even on Windows and Linux.
 *
 * The usual rule is the other way round, and it is wrong for this: the app is
 * running conversations. Quitting ends every runner it owns, and the point of
 * closing a window is usually to get it off the screen. The tray item that
 * makes this obvious is a later feature; until then, quit from the menu.
 */
app.on('window-all-closed', () => {
  // Deliberately empty. See above.
});
