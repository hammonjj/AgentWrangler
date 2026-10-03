/**
 * Everything the application needs from whatever is hosting it.
 *
 * Agent Wrangler began as a VSCode extension, became an Electron app, and is
 * now a daemon on plain Node that browsers connect to (#142). Through all of
 * it `src/claude`, `src/codex`, `src/core` and the webview bundles stayed
 * the same; what differed was the outer edge: where settings live, where
 * preferences are persisted, what a modal looks like, and what a window is.
 *
 * That edge is this interface. `src/app/createApp.ts` is written against it and
 * knows nothing else; `src/node/nodeHost.ts` implements it. Nothing here may
 * import `vscode` or `electron`, and nothing here is allowed to be shaped by
 * one host for its own sake: a method only one host could implement is a
 * method `createApp` should not be calling.
 *
 * Three surfaces are deliberately *not* here:
 *
 * - **The webview.** `PaneChannel` (`src/ui/paneChannel.ts`) already is that
 *   seam, and `createWebviewBridge` is its renderer-side mirror. Each browser
 *   connection hands the two pane hosts a channel each.
 * - **Commands.** The browser workbench, `aw` and Discord call the same
 *   methods on the object `createApp` returns.
 * - **Anything with no honest desktop equivalent** — the diff editor, the
 *   status bar item, the integrated terminal. Those are capabilities, so they
 *   are optional (`undefined` means "this host cannot") rather than stubs that
 *   silently do nothing.
 */

import type { Disposable } from '../core/events';
import type { SessionHandle } from '../core/session/sessionHandle';
import type { SessionHostRuntime } from '../core/session/hostSupervisor';
import type { RemoteConfig } from '../remote/service';
import type { RemoteTransport } from '../remote/transport';
import type { AnalyticsDetail } from '../shared/orchestration/analyticsView';

/**
 * Persisted key/value, the same structural shape `ArchiveService` and
 * the runner registry took instead of `vscode.Memento`. The node host
 * supplies a JSON file.
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
  /**
   * Make Cancel the default button, so Return backs out instead of acting.
   * For actions a stray click or keypress should not be able to confirm.
   */
  defaultToCancel?: boolean;
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
   * Optional because there is no honest `sendText` outside VSCode: anything
   * else needs `node-pty` and xterm.js, or a shell-out to Terminal.app.
   * Undefined means *Release* and the dictation install helper are not offered,
   * which is better than a button that appears to work.
   */
  runInTerminal?(command: string, options: { cwd: string; name: string }): void;
}

/**
 * The window the panes live in, from the application's point of view.
 *
 * Every method is "put this in front of the user"; none of them say how. For
 * the daemon it is the conversation pane of the browser that asked
 * (`ClientRegistry.surface`). `openInTab` is named for the intent ("give this
 * conversation a surface of its own") rather than for a tab.
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
  /** Show something that is not a session in the conversation half: an analytics item's detail (#49). */
  showDetail(detail: AnalyticsDetail): void;
}

/**
 * Somewhere to put a credential that is not a setting.
 *
 * Deliberately tiny and string-shaped: this feature needs one bot token, and an
 * interface that could hold a credential store would invite one.
 */
export interface HostSecrets {
  /** False when the OS store (the macOS Keychain) cannot be used; nothing should be stored then. */
  readonly available: boolean;
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * A "needs you" notice. `sessionKey` and `tag` are for the browser clients
 * (#141): where tapping the notification goes, and one tag per ask so the
 * same ask collapses. The host's own notification ignores both.
 */
export interface HostNotice {
  title: string;
  body: string;
  onClick?: () => void;
  sessionKey?: string;
  tag?: string;
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
  /** The session registry's document (`sessions.json`): every session AW runs and what became of it. */
  sessionState: HostStorage;
  /**
   * Where session hosts live and run from (playbook §5, Stage 3). Required:
   * every Claude conversation runs in one, never in the app's process (#122).
   */
  sessionHosts: {
    runtime: SessionHostRuntime;
    /** `run/`: manifests, tokens, sockets. 0700. */
    runDir: string;
    /** For sockets when `runDir`'s path is too long for macOS (`~/.agentwrangler/run`). */
    fallbackRunDir: string;
    logDir: string;
  };
  /**
   * Remote control (#138): Discord in the core daemon, fed the core's own
   * list, presses going through its own actions. Absent means remote control
   * is not available here.
   */
  remoteInProcess?: {
    /**
     * Stop the old remote daemon an Electron-era build may have left (#74) and
     * remove its LaunchAgent, resolving once it has exited. Awaited before
     * this process builds its connector, every start: the two share the
     * mirror map, and only one may run.
     */
    retireDaemon(): Promise<void>;
    /** Tests: a fake Discord, and a private mirror map. */
    makeTransport?: (token: string, cfg: RemoteConfig) => RemoteTransport;
    mirrorFile?: string;
  };
  /** Directory for caches this host owns, e.g. the shared usage read. Must exist. */
  storageDir: string;
  /**
   * The app's own data directory (the parent of `storageDir`): `run/` for
   * manifests and sockets of processes that outlive the app, `runtimes/` for
   * the binaries they run from. Not a cache: deleting it orphans them.
   */
  dataDir: string;
  dialogs: HostDialogs;
  shell: HostShell;
  clipboard: { writeText(text: string): Promise<void> };
  /**
   * An OS notification, which takes neither focus nor the window. `onClick`
   * runs when it is clicked. Absent means this host has none, and the caller
   * falls back to `dialogs.info`.
   */
  notify?(notice: HostNotice): void;
  /**
   * Credentials, kept out of the settings file.
   *
   * Settings are plain JSON a user may open, copy, or paste into an issue; a
   * bot token in there is a token in a screenshot. This goes to the login
   * Keychain instead (`src/core/keychainSecrets.ts`), and a host that cannot
   * reach it must say so rather than quietly writing
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
