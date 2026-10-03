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
import type { BoundAccess } from '../core/access';
import type { Disposable } from '../core/events';
import { PreferencesHost, type PreferencesBackend } from '../ui/preferencesHost';
import type { PaneChannel } from '../ui/paneChannel';
import { documentUrl } from './bundleProtocol';
import { TO_HOST, TO_WEBVIEW } from './channels';

export interface PreferencesWindowOptions {
  /**
   * What the window reads and calls, shared with every browser's Preferences
   * route (`createPreferencesBackend`, #135): the rules live in `PreferencesHost`.
   */
  backend: PreferencesBackend;
  /** Who the window acts as, and the gate its messages pass (#123). */
  access: BoundAccess;
  log(message: string): void;
  /** Where `dist/` is, for the preload. */
  appRoot: string;
  /** Centred over the workbench when there is one. */
  parentWindow(): BrowserWindow | undefined;
  /** Told when the window is created and when it has closed, for the Dock icon. */
  onDidChangeOpen?(open: boolean): void;
}

export class PreferencesWindow implements Disposable {
  private window?: BrowserWindow;
  private host?: PreferencesHost;

  constructor(private opts: PreferencesWindowOptions) {}

  /** Open it, or bring the open one forward. */
  open(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      return;
    }

    const parent = this.opts.parentWindow();
    const win = new BrowserWindow({
      width: 880,
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

    // One host per open window: it reads the settings and the orchestration
    // view live and pushes what changes while the window is up.
    const channel: PaneChannel = {
      postMessage: async (body) => {
        if (win.isDestroyed()) return false;
        win.webContents.send(TO_WEBVIEW, body);
        return true;
      },
      onDidReceiveMessage: (listener) => {
        const onMessage = (event: IpcMainEvent, raw: unknown) => {
          if (event.sender.id !== win.webContents.id) return;
          listener(raw);
        };
        ipcMain.on(TO_HOST, onMessage);
        return { dispose: () => ipcMain.removeListener(TO_HOST, onMessage) };
      },
    };
    this.host = new PreferencesHost(channel, this.opts.backend, this.opts.access, { onClose: () => this.close() });

    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('console-message', (details) => {
      if (details.level !== 'warning' && details.level !== 'error') return;
      this.opts.log(`preferences ${details.level}: ${details.message} (${details.sourceId}:${details.lineNumber})`);
    });

    win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
      this.host?.dispose();
      this.host = undefined;
      this.window = undefined;
      this.opts.onDidChangeOpen?.(false);
    });
    this.opts.onDidChangeOpen?.(true);

    void win.loadURL(documentUrl('preferences'));
  }

  get isOpen(): boolean {
    return this.window !== undefined && !this.window.isDestroyed();
  }

  close(): void {
    this.window?.close();
  }

  dispose(): void {
    this.host?.dispose();
    this.host = undefined;
    this.window?.destroy();
    this.window = undefined;
  }
}
