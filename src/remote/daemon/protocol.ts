/**
 * The remote daemon's socket (#74): how the app and the daemon talk.
 *
 * The daemon owns the Discord connection and the reconciler, and outlives the
 * app. The app is its best source of truth while it runs, so it connects and:
 *
 * - `configure`s it: the settings. The bot token is not sent (#138): it is in
 *   the login Keychain (#124), which the daemon reads itself at start and on
 *   every `configure`, so it connects after a reboot without the app;
 * - streams its decorated session list (`sessions`), and says once the list
 *   is complete (`ready`), so a half-scanned list never closes cards;
 * - forwards notices (`notify`), and asks how things stand (`status`).
 *
 * The daemon, in turn, sends the app the presses it should apply
 * (`decidePermission`, `answerQuestion`, `decidePlan`), since while the app
 * runs, only it can answer a question an in-process runner or Codex holds.
 *
 * NDJSON JSON-RPC over a Unix socket, like `core.sock`.
 *
 *   app → daemon
 *     hello        HelloParams                 → HelloResult
 *     configure    ConfigureParams             → {ok: true}
 *     notify       {notice: RemoteNotice}      → {ok: true}
 *     status       {}                          → DaemonStatus
 *     sessions     SessionsParams              (notification)
 *   daemon → app
 *     decidePermission {key, behavior, expectedRequestId?} → {outcome}
 *     answerQuestion   {key, requestId, answers}           → {outcome}
 *     decidePlan       {key, requestId, approve, feedback?} → {outcome}
 *
 * No Node imports: the app and the daemon both bundle this.
 */
import type { WranglerConfig } from '../../core/config';
import type { SessionDTO } from '../../shared/model';
import type { RemoteNotice } from '../../shared/remote';

export const REMOTE_DAEMON_PROTOCOL = 1;

export const REMOTE_SOCKET_NAME = 'remote.sock';
export const REMOTE_TOKEN_NAME = 'remote.token';
/** `{pid, build, startedAt, runtimeDir?}`, written by the daemon at start. */
export const REMOTE_MANIFEST_NAME = 'remote-daemon.json';

/** The LaunchAgent's label, from the app id. */
export const REMOTE_DAEMON_LABEL = 'com.hammonjj.agentwrangler.remote';

export interface HelloParams {
  token: string;
  protocol: number;
  build: string;
}

export interface HelloResult {
  protocol: number;
  build: string;
  pid: number;
  startedAt: number;
}

export interface ConfigureParams {
  config: WranglerConfig;
  /** Folded to `~` in anything published. */
  homeDir: string;
  /**
   * Not sent since #138: the daemon reads the token from the Keychain itself,
   * at start and on every `configure`. A non-empty one (an app from before
   * #138) is still used as it is.
   */
  botToken?: string | null;
}

export interface SessionsParams {
  sessions: SessionDTO[];
  /** The list is complete: its first scan is in, and its hosts have caught up. */
  ready: boolean;
  /** Archived session keys, for the daemon's own feed once the app has gone. */
  archived: string[];
  /** The names the user gave sessions, by key, for the same reason. */
  nicknames: Record<string, string>;
}

export interface DaemonStatus {
  build: string;
  pid: number;
  startedAt: number;
  /** Holding a bot token (read from the Keychain, or handed over by an older app). */
  hasToken: boolean;
  /** Connected to the Discord gateway. */
  connected: boolean;
  /** Whose session list the reconciler is following. */
  source: 'app' | 'daemon' | 'none';
  mirrored: number;
  /** Hosts the daemon's own feed follows. */
  hosts: number;
}

export interface MethodParams {
  decidePermission: { key: string; behavior: 'allow' | 'deny' | 'always'; expectedRequestId?: string };
  answerQuestion: { key: string; requestId: string; answers: Record<string, string> };
  decidePlan: { key: string; requestId: string; approve: boolean; feedback?: string };
  notify: { notice: RemoteNotice };
}

export const RPC_UNAUTHORIZED = -32001;
export const RPC_PROTOCOL_MISMATCH = -32002;
