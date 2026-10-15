/**
 * Remote control inside the process that holds the core (#138): the core
 * daemon.
 *
 * Electron-era builds ran Discord in a separate remote daemon (#74), because
 * the app came and went. The core daemon does not, so its
 * `RemoteControlService` is fed the core's own decorated session list and
 * applies presses through the core's own `SessionActions`, with no socket in
 * between and one LaunchAgent.
 *
 * The settings are the core's (`getConfig`); the token is read from the login
 * Keychain (#124) on every `sync`, so it is there at login with no window or
 * browser ever opened.
 *
 * Built only once the remote daemon has been retired (`retireRemoteDaemon`):
 * the two share the mirror map, and a connector built while the other still
 * runs would post a second card for an ask (see `connector.ts`).
 */
import * as os from 'node:os';
import { ownerContext, type AccessGate } from '../core/access';
import type { WranglerConfig } from '../core/config';
import type { Disposable } from '../core/events';
import type { SessionDTO } from '../shared/model';
import type { RemoteNotice } from '../shared/remote';
import type { SessionActions } from '../ui/actions';
import { guardSessionActions } from '../ui/guardedActions';
import type { AuditLog } from './audit';
import { RemoteConnector } from './connector';
import { DISCORD_BOT_TOKEN_KEY } from './paths';
import type { RemoteConfig } from './service';
import type { RemoteTransport } from './transport';

export interface InProcessRemoteOptions {
  /** The core's decorated list: archive, pause and runner asks applied. */
  sessions: { readonly sessions: SessionDTO[]; onDidUpdate(listener: () => void): Disposable };
  /** The list is complete (first scan in, hosts caught up). Until then nothing is closed. */
  ready: () => boolean;
  /** The core's own actions. Guarded here, as Discord, through `gate`. */
  actions: SessionActions;
  gate: AccessGate;
  getConfig: () => WranglerConfig;
  /** The Keychain. */
  secrets: { get(key: string): Promise<string | undefined> };
  log: (message: string) => void;
  homeDir?: string;
  /** Tests: a fake Discord, a private mirror map and audit log. */
  makeTransport?: (token: string, cfg: RemoteConfig) => RemoteTransport;
  mirrorFile?: string;
  audit?: AuditLog;
}

export interface InProcessRemoteControl {
  /** Re-read the settings and the token, and connect, reconnect or hang up to match. */
  sync(): Promise<void>;
  /** The list may have become complete, or changed in a way no store update says. */
  reconcile(): Promise<void>;
  notify(notice: RemoteNotice): Promise<void>;
  /** The machine woke. */
  wake(): void;
  status(): { pid: number; hasToken: boolean; connected: boolean; mirrored: number };
  whenIdle(): Promise<void>;
  /** Hang up, leaving open cards in the mirror map for the next connector. */
  dispose(): Promise<void>;
}

export function createInProcessRemoteControl(opts: InProcessRemoteOptions): InProcessRemoteControl {
  const connector = new RemoteConnector({
    sessions: {
      get sessions() {
        return opts.sessions.sessions;
      },
      get ready() {
        return opts.ready();
      },
      onDidUpdate: (listener) => opts.sessions.onDidUpdate(listener),
    },
    // The service authorises a press as Discord (#123) and runs it inside a
    // request with that context (#126); the gate checks it again where the
    // action runs, as the app's end of the remote daemon link does.
    actions: guardSessionActions(opts.actions, { context: ownerContext('discord'), gate: opts.gate }),
    log: opts.log,
    makeTransport: opts.makeTransport,
    mirrorFile: opts.mirrorFile,
    audit: opts.audit,
  });

  let syncing: Promise<void> = Promise.resolve();
  const readToken = async (): Promise<string | undefined> => {
    try {
      return await opts.secrets.get(DISCORD_BOT_TOKEN_KEY);
    } catch (err) {
      opts.log(`could not read the bot token from the Keychain: ${String(err)}`);
      return undefined;
    }
  };

  return {
    sync() {
      const run = syncing.then(async () => {
        const config = opts.getConfig();
        const botToken = config.remoteEnabled ? await readToken() : undefined;
        if (config.remoteEnabled && !botToken) opts.log('Discord integration is on, but there is no bot token in the Keychain');
        await connector.apply({ config, homeDir: opts.homeDir ?? os.homedir(), botToken });
      });
      syncing = run.catch(() => undefined);
      return run;
    },
    reconcile: () => connector.reconcile(),
    notify: (notice) => connector.notify(notice),
    wake: () => connector.wake(),
    status: () => ({ pid: process.pid, hasToken: connector.hasToken, connected: connector.connected, mirrored: connector.mirroredCount }),
    async whenIdle() {
      await syncing;
      await connector.whenIdle();
    },
    async dispose() {
      await syncing;
      await connector.dispose();
    },
  };
}
