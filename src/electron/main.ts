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
import { createElectronHost } from './electronHost';
import { installApplicationMenu } from './menu';
import { JsonStore } from './jsonStore';
import { PreferencesWindow } from './preferencesWindow';
import { WorkbenchWindow } from './workbenchWindow';

// Before anything reads `getPath('userData')` — which is derived from it — and
// before the menu is built, since macOS takes the first menu's title from here.
// Without it the app is "Electron" and its preferences live in Electron's own
// directory, shared with every other unpackaged Electron app on the machine.
app.setName('Agent Wrangler');

// Before `whenReady`: a scheme cannot be privileged once a renderer exists.
registerBundleScheme();

if (!app.requestSingleInstanceLock()) {
  // The running copy gets a `second-instance` event and raises its window.
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
  const userDataDir = app.getPath('userData');
  const log = startLog(userDataDir);
  log(`Agent Wrangler starting — Electron ${process.versions.electron}, userData ${userDataDir}`);

  serveBundles(path.join(APP_ROOT, 'dist'));

  let window: WorkbenchWindow | undefined;
  const host = createElectronHost({
    userDataDir,
    log,
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

  // ⌘, — the app's answer to VSCode's settings UI. It renders
  // `src/shared/settings.ts`, which is also what `package.json`'s
  // `contributes.configuration` is tested against, so both front ends offer
  // the same settings and a new one is declared once.
  const preferences = new PreferencesWindow({
    settings: host.settingsStore,
    log,
    appRoot: APP_ROOT,
    parentWindow: () => window?.browserWindow,
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
