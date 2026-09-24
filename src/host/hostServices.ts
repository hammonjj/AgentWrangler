/**
 * Everything the application needs from whatever is hosting it.
 *
 * Agent Wrangler is a VSCode extension and, on this branch, also an Electron
 * app. The two share all of `src/claude`, `src/codex`, `src/core` and the
 * webview bundles — roughly eight hundred of the thousand lines that used to be
 * `activate()` are about sessions, not about VSCode. What differs is the outer
 * edge: where settings live, where preferences are persisted, what a modal
 * looks like, and what a window is.
 *
 * That edge is this interface. `src/app/createApp.ts` is written against it and
 * knows nothing else; `src/host/vscode/*` and `src/electron/*` each implement
 * it. Nothing here may import `vscode` or `electron` — that is the whole point
 * — and nothing here is allowed to be VSCode-shaped for its own sake: a method
 * that only VSCode could implement is a method `createApp` should not be
 * calling.
 *
 * Three surfaces are deliberately *not* here:
 *
 * - **The webview.** `PaneChannel` (`src/ui/paneChannel.ts`) already is that
 *   seam, and `createWebviewBridge` is its renderer-side mirror. A host builds
 *   its own window and hands the two hosts a channel each.
 * - **Commands.** The fifteen `agentWrangler.*` commands are a VSCode concept.
 *   Both hosts call the same methods on the object `createApp` returns; VSCode
 *   registers commands that call them and Electron puts them in a menu.
 * - **Anything with no honest desktop equivalent** — the diff editor, the
 *   status bar item, the integrated terminal. Those are capabilities, so they
 *   are optional (`undefined` means "this host cannot") rather than stubs that
 *   silently do nothing.
 */

import type { Disposable } from '../core/events';
import type { SessionHandle } from '../core/session/sessionHandle';

/**
 * Persisted key/value, the same structural shape `ArchiveService` and
 * `RunnerRegistry` already took instead of `vscode.Memento`. VSCode supplies
 * `globalState`/`workspaceState`; Electron supplies a JSON file.
 */
export interface HostStorage {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): unknown;
}

/**
 * Settings, keyed without the `agentWrangler.` prefix — `runner.model`,
 * `showUsage`, `autoPause.percent` — exactly as
 * `workspace.getConfiguration('agentWrangler').get(...)` takes them, so the
 * call sites did not have to change when they moved here.
 */
export interface HostSettings {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Promise<void>;
  /**
   * Fired when any setting changes. `affects('showUsage')` answers whether a
   * particular one did, which is what the callers actually want and what
   * VSCode's own event gives; a host with no finer information may answer
   * `true` for everything.
   */
  onDidChange(listener: (affects: (key: string) => boolean) => void): Disposable;
}

export interface MessageOptions {
  /** Block the window until answered. Used where the answer destroys work. */
  modal?: boolean;
  /** The second paragraph: what this will cost, in full sentences. */
  detail?: string;
}

export interface InputOptions {
  title?: string;
  prompt?: string;
  value?: string;
  placeHolder?: string;
  /** Mask what is typed. For credentials, which must not be left on screen. */
  password?: boolean;
  /** Returns a complaint to show, or undefined while the value is acceptable. */
  validateInput?(value: string): string | undefined;
}

export interface PickItem {
  label: string;
  description?: string;
  detail?: string;
}

export interface PickOptions {
  placeHolder?: string;
  matchOnDescription?: boolean;
  matchOnDetail?: boolean;
}

/**
 * Asking the user something.
 *
 * `info`/`warn` return the button that was pressed, or `undefined` for
 * dismissed — never assume dismissal means the first button. Callers compare
 * against the exact label they passed.
 */
export interface HostDialogs {
  info(message: string, ...items: string[]): Promise<string | undefined>;
  warn(message: string, options: MessageOptions, ...items: string[]): Promise<string | undefined>;
  /** No buttons and no answer: something went wrong and there is nothing to decide. */
  error(message: string): void;
  /**
   * One line of transient feedback — "Copied session id …", "paused 4 agents".
   * The status bar in VSCode; a toast that fades in the app. Never used to
   * report something the user has to act on.
   */
  flash(message: string, timeoutMs?: number): void;
  input(options: InputOptions): Promise<string | undefined>;
  pick<T extends PickItem>(items: T[], options?: PickOptions): Promise<T | undefined>;
  /** One existing folder, or undefined if cancelled. */
  pickFolder(options?: { openLabel?: string }): Promise<string | undefined>;
}

/** Handing something to the rest of the machine. */
export interface HostShell {
  /** http/https only; the caller has already checked the scheme. */
  openExternal(url: string): void;
  /** Show the file in Finder/Explorer, selected. */
  revealInFileManager(path: string): void;
  /** Open a file for reading. An editor in VSCode; the default app otherwise. */
  openFile(path: string): void;
  /**
   * Run a command in a terminal the user can see and keep typing into.
   *
   * Optional because there is no honest `sendText` outside VSCode: an Electron
   * build needs `node-pty` and xterm.js, or a shell-out to Terminal.app.
   * Undefined means *Release* and the dictation install helper are not offered,
   * which is better than a button that appears to work.
   */
  runInTerminal?(command: string, options: { cwd: string; name: string }): void;
}

/**
 * The window the panes live in, from the application's point of view.
 *
 * Every method is "put this in front of the user"; none of them say how. In
 * VSCode that is one editor tab, in Electron one `BrowserWindow`. `openInTab`
 * is the one place the two genuinely differ in kind — a second tab beside your
 * code, versus a second window — which is why it is named for the intent
 * ("give this conversation a surface of its own") rather than for the tab.
 */
export interface WorkbenchSurface {
  readonly isOpen: boolean;
  open(options?: { preserveFocus?: boolean }): void;
  /** Show an existing session in the conversation half. */
  show(key: string, options?: { preserveFocus?: boolean }): void;
  /** A session running here (Claude or Codex), which may have no id or store entry yet. */
  showSession(handle: SessionHandle, options?: { preserveFocus?: boolean }): void;
  /** Give this conversation a surface of its own, which row clicks never swap away. */
  openInTab(key: string): void;
}

/**
 * Somewhere to put a credential that is not a setting.
 *
 * Deliberately tiny and string-shaped: this feature needs one bot token, and an
 * interface that could hold a credential store would invite one.
 */
export interface HostSecrets {
  /** False when the OS declines to encrypt; nothing should be stored then. */
  readonly available: boolean;
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface HostServices {
  /** The name shown in dialogs and window titles. Always 'Agent Wrangler' today. */
  readonly appName: string;
  log(message: string): void;
  settings: HostSettings;
  /** Preferences about sessions: archive, sections, nicknames, columns, turn stats. */
  globalState: HostStorage;
  /**
   * Preferences about *this* surface. In VSCode, per window — which is what
   * keeps two windows from both resuming one session id and corrupting its
   * transcript. In a single-window app it is the same store as `globalState`,
   * and the same rule is enforced by there only being one of them.
   */
  workspaceState: HostStorage;
  /** Directory for caches this host owns, e.g. the shared usage read. Must exist. */
  storageDir: string;
  dialogs: HostDialogs;
  shell: HostShell;
  clipboard: { writeText(text: string): Promise<void> };
  /**
   * Credentials, kept out of the settings file.
   *
   * Settings are plain JSON a user may open, copy, or paste into an issue; a
   * bot token in there is a token in a screenshot. This goes to the OS instead,
   * and a host that cannot encrypt must say so rather than quietly writing
   * plaintext — hence `available`, which the caller checks before offering to
   * store anything.
   */
  secrets: HostSecrets;
  /**
   * Folders the launcher should offer beyond Claude Code's own history. A
   * workspace in VSCode; empty in an app that is machine-wide by design.
   */
  workspaceFolders(): string[];
  /** Registered for disposal when the host shuts down. */
  subscribe(disposable: Disposable): void;
}
