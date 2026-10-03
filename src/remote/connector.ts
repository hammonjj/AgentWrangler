/**
 * One Discord connection and the reconciler behind it, for the core daemon
 * (#130, #138), which runs it in-process (`inProcess.ts`): a
 * `RemoteControlService` fed by the core's session list, and a transport that
 * is made, remade or dropped as the settings and the bot token say.
 *
 * **One connector at a time.** Every process that builds one shares the mirror
 * map (`~/.cache/agent-wrangler/remote/mirrors.json`), and the map is read
 * once, on the first pass. So a process must not build its connector while
 * another one still runs: it would read a map the other is still writing, and
 * post its own card for an ask the other already posted. Only one core daemon
 * runs at a time, and it retires the old remote daemon (#74) of Electron-era
 * builds first (`retireRemoteDaemon`).
 */
import * as os from 'node:os';
import { DEFAULT_CONFIG, type WranglerConfig } from '../core/config';
import type { Authorizer } from '../core/access';
import { FileAuditLog, type AuditLog } from './audit';
import { DiscordTransport } from './discord/transport';
import { MirrorStore } from './mirrorStore';
import { auditFile, mirrorFile } from './paths';
import { RemoteControlService, type PermissionActions, type RemoteConfig, type SessionSnapshot } from './service';
import type { RemoteTransport } from './transport';
import type { RemoteNotice } from '../shared/remote';

export interface RemoteConnectorOptions {
  sessions: SessionSnapshot;
  actions: PermissionActions;
  log: (message: string) => void;
  /** Tests: a fake Discord, a private mirror map and audit log, a refusing policy. */
  makeTransport?: (token: string, cfg: RemoteConfig) => RemoteTransport;
  mirrorFile?: string;
  audit?: AuditLog;
  authorize?: Authorizer;
}

/** What the connection follows: the settings, the home to fold, and the token (absent: none). */
export interface RemoteSettings {
  config: WranglerConfig;
  homeDir?: string;
  botToken?: string;
}

export class RemoteConnector {
  readonly service: RemoteControlService;
  private config: WranglerConfig = DEFAULT_CONFIG;
  private homeDir = os.homedir();
  private botToken?: string;
  private transport?: RemoteTransport;
  /** What the transport was built for; a change means reconnecting. */
  private transportFor?: string;
  private syncing: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private opts: RemoteConnectorOptions) {
    this.service = new RemoteControlService(
      opts.sessions,
      opts.actions,
      new MirrorStore(opts.mirrorFile ?? mirrorFile()),
      () => this.remoteConfig(),
      opts.audit ?? new FileAuditLog(auditFile()),
      opts.log,
      opts.authorize,
    );
  }

  /** The settings in effect: the app's own, or what the daemon read at start. */
  get settings(): WranglerConfig {
    return this.config;
  }

  get hasToken(): boolean {
    return this.botToken !== undefined;
  }

  get connected(): boolean {
    return this.service.connected;
  }

  get mirroredCount(): number {
    return this.service.mirroredCount;
  }

  /**
   * New settings and token. Resolves once they have taken effect: the surface
   * reconciled first (so switching off closes the cards while there is still a
   * connection to close them with), then the connection made, remade or
   * dropped.
   */
  async apply(s: RemoteSettings): Promise<void> {
    if (this.disposed) return;
    this.config = { ...DEFAULT_CONFIG, ...s.config };
    if (s.homeDir) this.homeDir = s.homeDir;
    this.botToken = s.botToken ? s.botToken : undefined;
    // The toolbar button changes what may be published, not the connection.
    await this.service.reconcile();
    await this.syncTransport();
  }

  reconcile(): Promise<void> {
    return this.service.reconcile();
  }

  notify(notice: RemoteNotice): Promise<void> {
    return this.service.notify(notice);
  }

  /** The machine woke: recheck the gateway now rather than at its next missed heartbeat. */
  wake(): void {
    this.transport?.wake?.();
  }

  /** Resolves once queued connects, reconciles and notices have run. */
  async whenIdle(): Promise<void> {
    await this.syncing;
    await this.service.whenIdle();
  }

  /**
   * Hang up and stop. Open cards stay open and stay in the mirror map, so the
   * next connector (this process restarted, or the other mode) adopts them
   * rather than posting them again. Waits for queued writes to the map first.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.whenIdle().catch(() => undefined);
    this.disposed = true;
    await this.disconnect();
    this.service.dispose();
  }

  private remoteConfig(): RemoteConfig {
    const cfg = this.config;
    return {
      enabled: cfg.remoteEnabled,
      notificationsEnabled: cfg.remoteNotificationsEnabled,
      guildId: cfg.remoteGuildId,
      channelId: cfg.remoteChannelId,
      authorizedUserIds: cfg.remoteAuthorizedUserIds,
      homeDir: this.homeDir,
    };
  }

  private async disconnect(): Promise<void> {
    if (!this.transport) return;
    this.service.setTransport(undefined);
    const going = this.transport;
    this.transport = undefined;
    this.transportFor = undefined;
    await going.disconnect();
    going.dispose();
  }

  /** Connect, reconnect or disconnect, whichever the settings and the token now say. */
  private syncTransport(): Promise<void> {
    this.syncing = this.syncing.then(async () => {
      if (this.disposed) return;
      const cfg = this.remoteConfig();
      const token = this.botToken;
      const wanted = cfg.enabled && !!token && !!cfg.guildId && !!cfg.channelId;
      const key = wanted ? `${token}\u0000${cfg.guildId}\u0000${cfg.channelId}` : undefined;
      if (key === this.transportFor && (wanted ? !!this.transport : !this.transport)) return;
      if (this.transport) this.opts.log('disconnecting from Discord');
      await this.disconnect();
      if (!wanted) return;
      const make =
        this.opts.makeTransport ??
        ((t: string, c: RemoteConfig) =>
          new DiscordTransport({
            config: () => ({ guildId: c.guildId, channelId: c.channelId }),
            restDeps: { token: () => t, log: (m) => this.opts.log(m) },
            gatewayDeps: { token: () => t, log: (m) => this.opts.log(m) },
            log: (m) => this.opts.log(m),
          }));
      const next = make(token!, cfg);
      this.transport = next;
      this.transportFor = key;
      this.service.setTransport(next);
      try {
        await next.connect();
        this.opts.log('connecting to Discord');
      } catch (err) {
        this.opts.log(`could not connect to Discord: ${String(err)}`);
      }
    });
    return this.syncing;
  }
}
