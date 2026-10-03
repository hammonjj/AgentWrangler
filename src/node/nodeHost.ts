/**
 * `HostServices` for plain Node: the daemon's host (#125, epic #121).
 *
 * `createApp` takes nothing but a `HostServices`, so the core runs without
 * Electron once something implements it without Electron. Most of it is what
 * `electronHost.ts` already did over plain files:
 *
 * - **Settings and state**: the same four JSON documents in the same data
 *   directory (`settings.json`, `state.json`, `surface.json`, `sessions.json`),
 *   so the daemon and the app read one set of preferences.
 * - **Log**: `<dataDir>/agent-wrangler.log`, the app's log file.
 * - **Secrets**: the login Keychain (`KeychainSecrets`, #124). No migration
 *   here: the old `safeStorage` file only Electron can read is moved by the
 *   Electron build, which ships first.
 * - **Session hosts and the remote daemon**: taken as options. Where they come
 *   from (which bundle, which runtime) is the daemon's decision (#130); a
 *   runtime is built with `createSessionHostRuntime` from
 *   `src/core/session/sessionHostRuntime.ts`, which has no Electron either.
 *
 * What differs is everything that needs a person. The daemon has no window,
 * so dialogs, the shell, the clipboard and notifications go to a
 * `ClientBroker` (`clientBroker.ts`), looked up on every call so the real one
 * (#126) can be attached once the app exists. Until then the default answers
 * every question with "cancel".
 *
 * Nothing under `src/node/` may import `electron`; a test checks.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../core/events';
import { startFileLog } from '../core/fileLog';
import { JsonSettings, JsonStore } from '../core/jsonStore';
import { KeychainSecrets, systemSecurityRunner, type SecurityRunner } from '../core/keychainSecrets';
import { toolPath } from '../core/toolPath';
import type { HostDialogs, HostServices, HostShell } from '../host/hostServices';
import { createDefaultClientBroker, type ClientBroker } from './clientBroker';

export interface NodeHostOptions {
  /**
   * The app's data directory: settings, state, the log, `run/`, `runtimes/`.
   * The Electron app's `userData` (`~/Library/Application Support/Agent
   * Wrangler`) when the daemon replaces it; a temp dir in tests.
   */
  dataDir: string;
  /** Where session hosts live and run from. Required (#122). */
  sessionHosts: HostServices['sessionHosts'];
  /** The remote daemon's controls; absent, remote control is unavailable. */
  remoteDaemon?: HostServices['remoteDaemon'];
  /** Remote control in this process (the core daemon, #138). */
  remoteInProcess?: HostServices['remoteInProcess'];
  /** Default: append to `<dataDir>/agent-wrangler.log` and echo to stdout. */
  log?: (message: string) => void;
  /** How `security` is run for the Keychain. Default: `/usr/bin/security`. */
  securityRunner?: SecurityRunner;
  /** Who answers dialogs and the like. Default: the non-interactive broker. */
  broker?: ClientBroker;
  /**
   * Add Homebrew's directories to `process.env.PATH`, as the Electron main
   * process does: launchd, like Finder, starts processes without them, and
   * git invokes git-lfs through PATH. Default true.
   */
  fixToolPath?: boolean;
}

export interface NodeHost extends HostServices {
  /** The settings document, for whatever edits settings outside the panes. */
  readonly settingsStore: JsonSettings;
  /** Replace the broker; `undefined` goes back to the non-interactive default. */
  useBroker(broker: ClientBroker | undefined): void;
  /** Dispose everything subscribed, then close the log. Safe to call twice. */
  disposeAll(): void;
}

export function createNodeHost(opts: NodeHostOptions): NodeHost {
  const { dataDir } = opts;
  if (opts.fixToolPath !== false) process.env.PATH = toolPath(process.env.PATH);

  const storageDir = path.join(dataDir, 'cache');
  fs.mkdirSync(storageDir, { recursive: true });

  const fileLog = opts.log ? undefined : startFileLog(dataDir);
  const log = opts.log ?? fileLog!;

  const fallback = createDefaultClientBroker({ log });
  let broker: ClientBroker = opts.broker ?? fallback;

  const settings = new JsonSettings(path.join(dataDir, 'settings.json'));
  const disposables: Disposable[] = [];

  // Looked up per call, never captured: the broker can change under a caller
  // that holds `host.dialogs`, as every service `createApp` builds does.
  const dialogs: HostDialogs = {
    info: (message, ...items) => broker.dialogs.info(message, ...items),
    warn: (message, options, ...items) => broker.dialogs.warn(message, options, ...items),
    error: (message) => broker.dialogs.error(message),
    flash: (message, timeoutMs) => broker.dialogs.flash(message, timeoutMs),
    input: (options) => broker.dialogs.input(options),
    pick: (items, options) => broker.dialogs.pick(items, options),
    pickFolder: (options) => broker.dialogs.pickFolder(options),
  };
  const shell: HostShell = {
    openExternal: (url) => broker.shell.openExternal(url),
    revealInFileManager: (target) => broker.shell.revealInFileManager(target),
    openFile: (target) => broker.shell.openFile(target),
    // Optional members stay optional: present only while the broker has one,
    // so a caller's `if (host.shell.runInTerminal)` keeps meaning "can it".
    get runInTerminal() {
      const run = broker.shell.runInTerminal;
      return run ? (command: string, o: { cwd: string; name: string }) => run.call(broker.shell, command, o) : undefined;
    },
  };

  let disposed = false;
  return {
    appName: 'Agent Wrangler',
    log,
    settings,
    settingsStore: settings,
    globalState: new JsonStore(path.join(dataDir, 'state.json')),
    workspaceState: new JsonStore(path.join(dataDir, 'surface.json')),
    sessionState: new JsonStore(path.join(dataDir, 'sessions.json')),
    sessionHosts: opts.sessionHosts,
    remoteDaemon: opts.remoteDaemon,
    remoteInProcess: opts.remoteInProcess,
    storageDir,
    dataDir,
    dialogs,
    shell,
    clipboard: { writeText: (text) => broker.clipboard.writeText(text) },
    get notify() {
      const notify = broker.notify;
      return notify ? (notice: Parameters<NonNullable<HostServices['notify']>>[0]) => notify(notice) : undefined;
    },
    secrets: new KeychainSecrets(opts.securityRunner ?? systemSecurityRunner(), log),
    workspaceFolders: () => [],
    subscribe: (disposable) => {
      disposables.push(disposable);
    },
    useBroker: (next) => {
      broker = next ?? fallback;
    },
    disposeAll: () => {
      // Copied and cleared first, as in electronHost.ts: a disposer may subscribe.
      const pending = disposables.splice(0, disposables.length);
      for (const d of pending) {
        try {
          d.dispose();
        } catch (error) {
          log(`dispose failed: ${String(error)}`);
        }
      }
      if (!disposed) {
        disposed = true;
        fileLog?.close();
      }
    },
  };
}
