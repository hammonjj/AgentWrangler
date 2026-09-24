/**
 * `HostServices` over Electron.
 *
 * The only implementation, now that the extension is gone, and the rule it was
 * written under still holds: it translates, it does not decide. The notes below
 * record where the editor used to give something away for free, because those
 * are the places this file had to grow something of its own.
 *
 * - **Settings and state** were `workspace.getConfiguration` and two `Memento`s;
 *   they are three JSON files in `userData` now. The services behind them never
 *   knew the difference — they always took a structural `{get, update}`.
 * - **`flash`** was the status bar. There is no status bar, so the shell grew a
 *   toast: this sends the line, the preload builds the node.
 * - **`input` and `pick`** were `showInputBox` and `showQuickPick`, and Electron
 *   has neither, so they go to `PaletteWindow` — a small frameless child window
 *   that is the app's version of both.
 * - **`runInTerminal`** shells out to Terminal.app through AppleScript. There is
 *   no in-window terminal to send text to, and *Release* and *Resume in
 *   terminal* both need one, so the platform's own terminal stands in.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type BrowserWindow, clipboard, dialog, Notification, shell } from 'electron';
import type { Disposable } from '../core/events';
import type { HostDialogs, HostServices, HostShell, InputOptions, PickItem, PickOptions } from '../host/hostServices';
import { JsonSettings, JsonStore } from './jsonStore';
import { ElectronSecrets } from './secrets';
import { TOAST } from './channels';

export interface ElectronHostOptions {
  /** `app.getPath('userData')`. Settings, state and the usage cache live here. */
  userDataDir: string;
  log(message: string): void;
  /**
   * The window dialogs are parented to, looked up when one is shown rather than
   * held: the window can be closed and reopened while the app keeps running,
   * and a stale reference would put a modal on a destroyed parent.
   */
  parentWindow(): BrowserWindow | undefined;
  /**
   * The list-and-field window behind `pick` and `input`. Supplied rather than
   * constructed here because it needs `appRoot` for the preload, and because a
   * host that has no palette should decline rather than fail — see the two
   * methods below.
   */
  palette?: {
    pick<T extends PickItem>(items: T[], options?: PickOptions): Promise<T | undefined>;
    input(options: InputOptions): Promise<string | undefined>;
  };
  /** Where session hosts live and run from. Built by `main.ts`, which knows the bundle. */
  sessionHosts?: HostServices['sessionHosts'];
}

/**
 * `showMessageBox` returns an index; the interface returns the label. Mapping
 * back here keeps every caller comparing against the string it passed, which is
 * what makes the same `createApp` code work against both hosts.
 */
async function messageBox(
  parent: BrowserWindow | undefined,
  type: 'info' | 'warning' | 'error',
  message: string,
  options: { detail?: string; modal?: boolean },
  items: string[],
): Promise<string | undefined> {
  // A dialog with no buttons of its own still needs a way out, and the caller
  // is not offered it: it compares the result against labels it passed, and
  // 'OK' is not one of them, so dismissing reads as dismissed.
  const buttons = items.length > 0 ? [...items, 'Cancel'] : ['OK'];
  const cancelId = buttons.length - 1;
  const args = {
    type,
    message,
    detail: options.detail,
    buttons,
    defaultId: 0,
    cancelId,
    noLink: true,
  } as const;

  const result =
    options.modal && parent
      ? await dialog.showMessageBox(parent, args)
      : await dialog.showMessageBox(args);
  if (items.length === 0 || result.response === cancelId) return undefined;
  return items[result.response];
}

function dialogsFor(opts: ElectronHostOptions): HostDialogs {
  const toast = (text: string) => {
    opts.parentWindow()?.webContents.send(TOAST, text);
    opts.log(`flash: ${text}`);
  };

  return {
    info: (message, ...items) => messageBox(opts.parentWindow(), 'info', message, {}, items),
    warn: (message, options, ...items) =>
      messageBox(opts.parentWindow(), 'warning', message, options, items),
    error: (message) => {
      void messageBox(opts.parentWindow(), 'error', message, {}, []);
      opts.log(`error: ${message}`);
    },
    flash: (message) => toast(message),
    input: async (options) => {
      if (!opts.palette) {
        toast(`${options.title ?? 'That'} is unavailable: no palette window.`);
        return undefined;
      }
      return opts.palette.input(options);
    },
    pick: async (items, options) => {
      if (!opts.palette) {
        toast(`${options?.placeHolder ?? 'Choosing from a list'} is unavailable: no palette window.`);
        return undefined;
      }
      return opts.palette.pick(items, options);
    },
    pickFolder: async (options) => {
      const parent = opts.parentWindow();
      const args = {
        properties: ['openDirectory' as const, 'createDirectory' as const],
        buttonLabel: options?.openLabel,
      };
      const chosen = parent ? await dialog.showOpenDialog(parent, args) : await dialog.showOpenDialog(args);
      return chosen.canceled ? undefined : chosen.filePaths[0];
    },
  };
}

function shellFor(opts: ElectronHostOptions): HostShell {
  return {
    openExternal: (url) => {
      void shell.openExternal(url);
    },
    revealInFileManager: (target) => shell.showItemInFolder(target),
    openFile: (target) => {
      void shell.openPath(target).then((err) => {
        if (err) opts.log(`openPath ${target}: ${err}`);
      });
    },
    /**
     * Hand a command to Terminal.app.
     *
     * This was the one capability only VSCode had, and *Release*, *Resume in
     * terminal* and the dictation `brew install` helper all sat behind it. With
     * the extension gone they would simply have stopped working, so rather than
     * lose three features it shells out to the terminal the platform already
     * has.
     *
     * AppleScript rather than `open -a Terminal <script>`: `do script` takes a
     * command directly, so nothing has to be written to disk, and the window it
     * opens is a normal interactive shell the user can keep typing into — which
     * is the whole point for *Release*, where the session carries on there.
     *
     * The command is composed by `resumeCommand`, but it still ends up inside
     * an AppleScript string literal, so both escapes are applied: `\\` and `"`
     * for AppleScript, and the `cd` is quoted for the shell.
     */
    runInTerminal: (command, { cwd }) => {
      const script = `cd ${shellQuote(cwd)} && ${command}`;
      const applescript = `tell application "Terminal"\nactivate\ndo script ${appleScriptString(script)}\nend tell`;
      execFile('osascript', ['-e', applescript], (err) => {
        if (err) opts.log(`runInTerminal failed: ${String(err)}`);
      });
    },
  };
}

/** Single-quote for `sh`, closing and reopening around any embedded quote. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A double-quoted AppleScript literal. Backslash first, or it doubles the escapes. */
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * `Notification`, kept alive until it is dismissed or clicked: one that is only
 * referenced by a local is collected, and its click handler with it, while the
 * banner is still in Notification Centre.
 */
function notifierFor(opts: ElectronHostOptions): HostServices['notify'] {
  if (!Notification.isSupported()) return undefined;
  const live = new Set<Notification>();
  return ({ title, body, onClick }) => {
    const n = new Notification({ title, body });
    live.add(n);
    const drop = () => live.delete(n);
    n.on('click', () => {
      drop();
      onClick?.();
    });
    n.on('close', drop);
    n.on('failed', (_event, error) => {
      drop();
      opts.log(`notification failed: ${error}`);
    });
    n.show();
    // Unclicked banners are not closed on macOS until the user clears them;
    // bound the set so a week of them does not accumulate.
    if (live.size > 50) live.delete(live.values().next().value as Notification);
  };
}

export interface ElectronHost extends HostServices {
  /** The settings document, so the menu can toggle things the panes cannot. */
  readonly settingsStore: JsonSettings;
  /** What `context.subscriptions` did on quit. Safe to call twice. */
  disposeAll(): void;
}

export function createElectronHost(opts: ElectronHostOptions): ElectronHost {
  const { userDataDir } = opts;
  const storageDir = path.join(userDataDir, 'cache');
  fs.mkdirSync(storageDir, { recursive: true });

  const settings = new JsonSettings(path.join(userDataDir, 'settings.json'));
  const disposables: Disposable[] = [];

  return {
    appName: 'Agent Wrangler',
    log: opts.log,
    settings,
    settingsStore: settings,
    globalState: new JsonStore(path.join(userDataDir, 'state.json')),
    // One process, one window, so "this surface's state" and "the machine's
    // state" are two files rather than two scopes. Keeping them apart anyway is
    // what stops a future second window inheriting the first one's runner
    // records and resuming a session that is already running.
    workspaceState: new JsonStore(path.join(userDataDir, 'surface.json')),
    sessionState: new JsonStore(path.join(userDataDir, 'sessions.json')),
    sessionHosts: opts.sessionHosts,
    storageDir,
    dataDir: userDataDir,
    dialogs: dialogsFor(opts),
    shell: shellFor(opts),
    clipboard: { writeText: async (text) => clipboard.writeText(text) },
    notify: notifierFor(opts),
    // Beside the other state, but a file of its own: see `secrets.ts` for why
    // a credential must not live in `settings.json`.
    secrets: new ElectronSecrets(path.join(userDataDir, 'secrets.json'), opts.log),
    // Machine-wide by design: there is no workspace, and the launcher already
    // merges Claude Code's own history with everything currently running.
    workspaceFolders: () => [],
    subscribe: (disposable) => {
      disposables.push(disposable);
    },
    disposeAll: () => {
      // Copied and cleared first: a disposer that registers something else on
      // the way out would otherwise grow the array we are walking.
      const pending = disposables.splice(0, disposables.length);
      for (const d of pending) {
        try {
          d.dispose();
        } catch (error) {
          opts.log(`dispose failed: ${String(error)}`);
        }
      }
    },
  };
}
