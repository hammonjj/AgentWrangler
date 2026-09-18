/**
 * The Preferences window — ⌘, — and the app's answer to VSCode's settings UI.
 *
 * It renders `src/shared/settings.ts`, the same declaration `package.json`'s
 * `contributes.configuration` is checked against, so the app offers exactly the
 * settings the extension does and a new one appears in both by being declared
 * once.
 *
 * Writes go straight to `HostSettings.update`, which is the JSON file plus the
 * change event the usage pollers and the dashboard already listen to. There is
 * no apply step: every setting is read live at the point it is used, so a value
 * is in effect the moment it lands.
 *
 * It shares the workbench's preload — three methods, sandboxed, context
 * isolated — and not its envelope: there is one thing in this window, so there
 * is nothing to address a message to.
 */

import * as path from 'node:path';
import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import type { Disposable } from '../core/events';
import type { HostSettings } from '../host/hostServices';
import { settingUpdate, type HostToPreferences, type PreferencesToHost } from '../shared/preferences';
import { SETTINGS, settingsFor } from '../shared/settings';
import { documentUrl } from './bundleProtocol';
import { TO_HOST, TO_WEBVIEW } from './channels';

export interface PreferencesWindowOptions {
  settings: HostSettings;
  log(message: string): void;
  /** Where `dist/` is, for the preload. */
  appRoot: string;
  /** Centred over the workbench when there is one. */
  parentWindow(): BrowserWindow | undefined;
}

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

export class PreferencesWindow implements Disposable {
  private window?: BrowserWindow;
  private readonly subs: Disposable[] = [];

  constructor(private opts: PreferencesWindowOptions) {
    const onMessage = (event: IpcMainEvent, raw: unknown) => {
      if (event.sender.id !== this.window?.webContents.id) return;
      this.onMessage(raw as PreferencesToHost);
    };
    ipcMain.on(TO_HOST, onMessage);
    this.subs.push({ dispose: () => ipcMain.removeListener(TO_HOST, onMessage) });

    // A setting changed elsewhere — the dashboard's Codex-subagents checkbox is
    // the one that does today — has to reach an open window, or it shows a
    // value that is no longer true and writing anything else puts the stale one
    // back.
    this.subs.push(opts.settings.onDidChange(() => this.push()));
  }

  /** Open it, or bring the open one forward. */
  open(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      return;
    }

    const parent = this.opts.parentWindow();
    const win = new BrowserWindow({
      width: 720,
      height: 760,
      minWidth: 520,
      minHeight: 420,
      title: 'Preferences',
      show: false,
      backgroundColor: '#1f1f1f',
      parent,
      // Not `modal`. Several of these are worth changing while watching what
      // they do — the poll interval, the stuck threshold, the usage cards — and
      // a modal blocks the window you would be watching.
      resizable: true,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: path.join(this.opts.appRoot, 'dist', 'electron', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window = win;

    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('console-message', (details) => {
      if (details.level !== 'warning' && details.level !== 'error') return;
      this.opts.log(`preferences ${details.level}: ${details.message} (${details.sourceId}:${details.lineNumber})`);
    });

    win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
      this.window = undefined;
    });

    void win.loadURL(documentUrl('preferences'));
  }

  close(): void {
    this.window?.close();
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.window?.destroy();
    this.window = undefined;
  }

  private onMessage(message: PreferencesToHost): void {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      this.push();
      return;
    }
    if (message.type === 'close') {
      this.close();
      return;
    }

    // The rules live in `settingUpdate`, in shared, where they can be tested
    // without a window: only a declared key, only its declared type, and reset
    // removes rather than overwrites. Anything else is not a person changing a
    // setting and does not get to write.
    const update = settingUpdate(message, (key) => BY_KEY.get(key));
    if (!update) {
      this.opts.log(`preferences: refused ${String((message as { key?: unknown }).key)}`);
      return;
    }
    void this.opts.settings.update(update.key, update.value);
  }

  private push(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const values: Record<string, string | boolean | number> = {};
    for (const spec of settingsFor('app')) values[spec.key] = this.opts.settings.get(spec.key, spec.default);
    const message: HostToPreferences = { type: 'values', values };
    this.window.webContents.send(TO_WEBVIEW, message);
  }
}
