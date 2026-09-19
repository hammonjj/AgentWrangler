/**
 * `HostServices` over Electron.
 *
 * The mirror of `src/host/vscode/vscodeHost.ts`, and the same rule applies: it
 * translates, it does not decide. Where it differs from that file is where the
 * editor was genuinely giving something away for free.
 *
 * - **Settings and state** were `workspace.getConfiguration` and two `Memento`s;
 *   they are three JSON files in `userData` now. The services behind them never
 *   knew the difference — they always took a structural `{get, update}`.
 * - **`flash`** was the status bar. There is no status bar, so the shell grew a
 *   toast: this sends the line, the preload builds the node.
 * - **`input` and `pick`** were `showInputBox` and `showQuickPick`, and Electron
 *   has neither, so they go to `PaletteWindow` — a small frameless child window
 *   that is the app's version of both.
 * - **`runInTerminal`** is absent, which is a fact about the platform and not an
 *   oversight: there is no `sendText` outside VSCode. `HostShell` makes it
 *   optional, so *Release* is simply not offered.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type BrowserWindow, clipboard, dialog, shell } from 'electron';
import type { Disposable } from '../core/events';
import type { HostDialogs, HostServices, HostShell, InputOptions, PickItem, PickOptions } from '../host/hostServices';
import { JsonSettings, JsonStore } from './jsonStore';
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
        toast(`${options.title ?? 'That'} needs VSCode for now.`);
        return undefined;
      }
      return opts.palette.input(options);
    },
    pick: async (items, options) => {
      if (!opts.palette) {
        toast(`${options?.placeHolder ?? 'Choosing from a list'} needs VSCode for now.`);
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
    // runInTerminal is deliberately absent. See the header.
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
    storageDir,
    dialogs: dialogsFor(opts),
    shell: shellFor(opts),
    clipboard: { writeText: async (text) => clipboard.writeText(text) },
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
