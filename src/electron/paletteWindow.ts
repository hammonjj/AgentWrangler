/**
 * `showQuickPick` and `showInputBox`, as a window.
 *
 * These are the two `HostDialogs` methods Electron has no native answer for,
 * and until now they declined out loud — which cost the app renaming a
 * conversation, every menu item that has to ask *which session*, and the folder
 * list behind *New Conversation*. This is the replacement.
 *
 * Two rules it follows, both of which are about not lying to the caller:
 *
 * - **A row is answered by index.** The objects the host is choosing between
 *   carry fields the renderer has no business with — a session key, a folder
 *   path — so only labels cross the wire and the host maps the answer back. See
 *   `src/shared/palette.ts`.
 * - **Every path resolves exactly once.** Escape, a click, Enter, closing the
 *   window, or a second request arriving while this one is up: all of them land
 *   on `settle`, because a `showQuickPick` that never returns is a command that
 *   hangs forever with nothing on screen to cancel.
 */

import * as path from 'node:path';
import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import type { Disposable } from '../core/events';
import type { InputOptions, PickItem, PickOptions } from '../host/hostServices';
import type { HostToPalette, PaletteRequest, PaletteToHost } from '../shared/palette';
import { documentUrl } from './bundleProtocol';
import { TO_HOST, TO_WEBVIEW } from './channels';

export interface PaletteWindowOptions {
  log(message: string): void;
  /** Where `dist/` is, for the preload. */
  appRoot: string;
  /** Centred over the workbench when there is one. */
  parentWindow(): BrowserWindow | undefined;
}

/**
 * How tall the window is, per shape. A list wants room to show a dozen rows; a
 * field and its prompt want about a fifth of that, and a mostly-empty 440px
 * box asking for one line reads as something having gone wrong.
 */
const HEIGHT = { pick: 440, input: 190 } as const;
const WIDTH = 620;

/** What is waiting on the window right now. */
interface Pending {
  request: PaletteRequest;
  resolve(answer: { index: number } | { value: string } | undefined): void;
  /** Only for an input that asked to be checked as it is typed. */
  validate?(value: string): string | undefined;
}

export class PaletteWindow implements Disposable {
  private window?: BrowserWindow;
  private pending?: Pending;
  /** The renderer has loaded and asked for its request. */
  private ready = false;
  private readonly subs: Disposable[] = [];

  constructor(private opts: PaletteWindowOptions) {
    const onMessage = (event: IpcMainEvent, raw: unknown) => {
      if (event.sender.id !== this.window?.webContents.id) return;
      this.onMessage(raw as PaletteToHost);
    };
    ipcMain.on(TO_HOST, onMessage);
    this.subs.push({ dispose: () => ipcMain.removeListener(TO_HOST, onMessage) });
  }

  /** The list. Resolves the chosen row's index, or `undefined` if cancelled. */
  async pick<T extends PickItem>(items: T[], options?: PickOptions): Promise<T | undefined> {
    const answer = await this.ask({
      kind: 'pick',
      placeholder: options?.placeHolder,
      matchOnDescription: options?.matchOnDescription,
      matchOnDetail: options?.matchOnDetail,
      rows: items.map((i) => ({ label: i.label, description: i.description, detail: i.detail })),
    });
    if (!answer || !('index' in answer)) return undefined;
    // The index came from a renderer. Bounds-checked rather than trusted.
    return items[answer.index];
  }

  /** The text field. Resolves the value, or `undefined` if cancelled. */
  async input(options: InputOptions): Promise<string | undefined> {
    const answer = await this.ask(
      {
        kind: 'input',
        title: options.title,
        prompt: options.prompt,
        value: options.value,
        placeholder: options.placeHolder,
        validates: typeof options.validateInput === 'function',
      },
      options.validateInput,
    );
    if (!answer || !('value' in answer)) return undefined;
    // The window refuses to submit while a complaint is showing, but the rule
    // lives here and this is the last place it can be applied.
    if (options.validateInput?.(answer.value)) return undefined;
    return answer.value;
  }

  dispose(): void {
    this.settle(undefined);
    for (const s of this.subs) s.dispose();
    this.window?.destroy();
    this.window = undefined;
  }

  private ask(
    request: PaletteRequest,
    validate?: (value: string) => string | undefined,
  ): Promise<{ index: number } | { value: string } | undefined> {
    // A second request while one is up — a menu item invoked twice — replaces
    // it. The first resolves as cancelled rather than being left waiting on a
    // window that now belongs to somebody else.
    this.settle(undefined);

    return new Promise((resolve) => {
      this.pending = { request, resolve, validate };
      this.open();
      if (this.ready) this.send({ type: 'show', request });
    });
  }

  private settle(answer: { index: number } | { value: string } | undefined): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve(answer);
  }

  private send(message: HostToPalette): void {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send(TO_WEBVIEW, message);
  }

  private onMessage(message: PaletteToHost): void {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'ready':
        this.ready = true;
        if (this.pending) this.send({ type: 'show', request: this.pending.request });
        return;
      case 'validate':
        this.send({ type: 'validation', message: this.pending?.validate?.(message.value) });
        return;
      case 'picked':
        this.settle({ index: message.index });
        this.close();
        return;
      case 'submitted':
        this.settle({ value: message.value });
        this.close();
        return;
      case 'cancelled':
        this.settle(undefined);
        this.close();
        return;
    }
  }

  private close(): void {
    this.window?.hide();
  }

  /**
   * Built once and hidden between uses rather than created per request: a
   * window costs a renderer process and a document load, and a palette that
   * takes half a second to appear is one nobody reaches for.
   */
  private open(): void {
    const parent = this.opts.parentWindow();
    if (this.window && !this.window.isDestroyed()) {
      if (parent) this.centreOver(parent);
      this.window.show();
      this.window.focus();
      return;
    }

    this.ready = false;
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT.pick,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      backgroundColor: '#1f1f1f',
      parent,
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
      this.opts.log(`palette ${details.level}: ${details.message} (${details.sourceId}:${details.lineNumber})`);
    });

    /**
     * Clicking away dismisses it, which is how a palette behaves everywhere and
     * the only way out when there is no frame to put a close button on.
     *
     * Deferred, and re-checked. Two requests in a row — picking a session and
     * then being asked what to rename it to — hide the window and immediately
     * show it again, and the blur from that hide arrives *after* the new
     * request is already up. Taken at face value it cancels the question the
     * user is looking at, which is what made Rename do nothing at all. By the
     * next tick the window has focus again, so asking whether it really lost it
     * tells the two apart.
     */
    win.on('blur', () => {
      setTimeout(() => {
        if (win.isDestroyed() || !win.isVisible() || win.isFocused()) return;
        this.settle(undefined);
        this.close();
      }, 0);
    });
    win.on('closed', () => {
      this.settle(undefined);
      this.window = undefined;
      this.ready = false;
    });

    win.once('ready-to-show', () => {
      if (parent) this.centreOver(parent);
      win.show();
      win.focus();
    });

    void win.loadURL(documentUrl('palette'));
  }

  /**
   * Near the top of the parent, where a palette belongs — not dead centre — and
   * sized for the shape being asked for. Both in one call because they are one
   * `setBounds`, and setting them separately makes the window jump.
   */
  private centreOver(parent: BrowserWindow): void {
    if (!this.window || this.window.isDestroyed()) return;
    const p = parent.getBounds();
    const height = HEIGHT[this.pending?.request.kind ?? 'pick'];
    this.window.setBounds({
      x: Math.round(p.x + (p.width - WIDTH) / 2),
      y: Math.round(p.y + Math.min(120, p.height * 0.15)),
      width: WIDTH,
      height,
    });
  }
}
