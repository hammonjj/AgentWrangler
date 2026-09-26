/**
 * The remote daemon (#74): the one process that talks to Discord.
 *
 * It holds the gateway connection and the reconciler (`RemoteControlService`),
 * and keeps both running whether the app is open, quit, crashed or halfway
 * through a reinstall. The app is a client: it hands over the settings and the
 * bot token, feeds its session list while it runs, and applies the presses
 * only it can. When it goes, the daemon follows its own feed (`LocalFeed`).
 * See `protocol.ts` for the wire and `sources.ts` for the switch.
 *
 * The token is held in memory only: it stays in the app's `safeStorage`, and a
 * daemon that restarts without the app (a crash, a reboot) waits, connected to
 * nothing, until the app is opened and hands it over again.
 */
import { timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CONFIG, type WranglerConfig } from '../../core/config';
import { Emitter, type Disposable } from '../../core/events';
import { NdjsonPeer, type IncomingRequest } from '../../core/rpc/ndjsonPeer';
import { ensurePrivateDir, writeControlToken } from '../../core/control/server';
import { writeJsonAtomic } from '../../core/session/manifestFile';
import type { SessionDTO } from '../../shared/model';
import type { RemoteNotice } from '../../shared/remote';
import type { PermissionDecisionOutcome } from '../../ui/actions';
import { FileAuditLog, type AuditLog } from '../audit';
import { DiscordTransport } from '../discord/transport';
import { MirrorStore } from '../mirrorStore';
import { auditFile, mirrorFile } from '../paths';
import { RemoteControlService, type RemoteConfig } from '../service';
import type { RemoteTransport } from '../transport';
import { LocalFeed, type LocalFeedOptions } from './localFeed';
import {
  REMOTE_DAEMON_PROTOCOL,
  RPC_PROTOCOL_MISMATCH,
  RPC_UNAUTHORIZED,
  type ConfigureParams,
  type DaemonStatus,
  type HelloParams,
  type HelloResult,
  type SessionsParams,
} from './protocol';
import { SourceSwitch, type FeedSource } from './sources';

/** What the daemon needs of its own feed; `LocalFeed` in production. */
export interface OwnFeed extends FeedSource, Disposable {
  start(): Promise<void>;
  redecorate(): void;
  readonly hostCount: number;
}

export interface RemoteDaemonOptions {
  socketPath: string;
  tokenPath: string;
  manifestPath: string;
  runDir: string;
  build: string;
  /** The runtime clone this daemon runs from, recorded so the app's GC keeps it. */
  runtimeDir?: string;
  log: (message: string) => void;
  /** Tests: fakes for Discord and the local feed, and private file locations. */
  makeTransport?: (token: string, cfg: RemoteConfig) => RemoteTransport;
  makeOwnFeed?: (opts: LocalFeedOptions) => OwnFeed;
  mirrorFile?: string;
  audit?: AuditLog;
}

/** A press the app is asked to apply gets this long before it counts as not applied. */
const APP_PRESS_TIMEOUT_MS = 30_000;
const MAX_LINE_BYTES = 32 * 1024 * 1024;

interface Conn {
  socket: net.Socket;
  peer: NdjsonPeer;
  authed: boolean;
}

/** The app's session list, as pushed over its connection. */
class AppFeed implements FeedSource, Disposable {
  sessions: SessionDTO[] = [];
  ready = false;
  private emitter = new Emitter<void>();
  readonly onDidUpdate = (listener: () => void): Disposable => this.emitter.event(listener);

  constructor(
    private peer: NdjsonPeer,
    private log: (message: string) => void,
  ) {}

  push(sessions: SessionDTO[], ready: boolean): void {
    this.sessions = sessions;
    this.ready = ready;
    this.emitter.fire();
  }

  decidePermission(key: string, behavior: 'allow' | 'deny' | 'always', opts?: { expectedRequestId?: string }) {
    return this.ask('decidePermission', { key, behavior, expectedRequestId: opts?.expectedRequestId });
  }

  answerQuestion(key: string, requestId: string, answers: Record<string, string>) {
    return this.ask('answerQuestion', { key, requestId, answers });
  }

  decidePlan(key: string, requestId: string, approve: boolean, feedback?: string) {
    return this.ask('decidePlan', { key, requestId, approve, feedback });
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private async ask(method: string, params: unknown): Promise<PermissionDecisionOutcome> {
    try {
      const r = await this.peer.request<{ outcome: PermissionDecisionOutcome }>(method, params, { timeoutMs: APP_PRESS_TIMEOUT_MS });
      return r.outcome;
    } catch (err) {
      this.log(`the app could not apply ${method}: ${String(err)}`);
      return 'gone';
    }
  }
}

export class RemoteDaemon implements Disposable {
  private readonly startedAt = Date.now();
  private token = Buffer.alloc(0);
  private server?: net.Server;
  private conns = new Set<Conn>();
  private app?: { conn: Conn; feed: AppFeed };
  private sources: SourceSwitch;
  private service: RemoteControlService;
  private own?: OwnFeed;

  private config: WranglerConfig = DEFAULT_CONFIG;
  private homeDir = os.homedir();
  private botToken?: string;
  private archived = new Set<string>();
  private nicknames = new Map<string, string>();

  private transport?: RemoteTransport;
  /** What the transport was built for; a change means reconnecting. */
  private transportFor?: string;
  private syncing: Promise<void> = Promise.resolve();
  private sleepTimer?: ReturnType<typeof setInterval>;

  constructor(private opts: RemoteDaemonOptions) {
    const log = (m: string) => opts.log(m);
    this.sources = new SourceSwitch(log);
    this.service = new RemoteControlService(
      this.sources,
      this.sources,
      new MirrorStore(opts.mirrorFile ?? mirrorFile()),
      () => this.remoteConfig(),
      opts.audit ?? new FileAuditLog(auditFile()),
      log,
    );
  }

  async start(): Promise<void> {
    this.token = Buffer.from(writeControlToken(this.opts.tokenPath), 'utf8');
    ensurePrivateDir(path.dirname(this.opts.socketPath));
    await this.listen();
    writeJsonAtomic(this.opts.manifestPath, {
      pid: process.pid,
      build: this.opts.build,
      startedAt: this.startedAt,
      socketPath: this.opts.socketPath,
      ...(this.opts.runtimeDir ? { runtimeDir: this.opts.runtimeDir } : {}),
    });
    this.opts.log(`remote daemon ${this.opts.build} listening (pid ${process.pid}); waiting for the app to hand over the settings`);
    this.watchForSleep();
  }

  /**
   * The machine slept: a timer that fires far later than it was due. There is
   * no `powerMonitor` outside Electron, and a gateway connection that went
   * stale across a sleep otherwise takes a missed heartbeat or two to notice.
   */
  private watchForSleep(): void {
    const everyMs = 5000;
    let last = Date.now();
    this.sleepTimer = setInterval(() => {
      const now = Date.now();
      if (now - last > everyMs + 30_000) {
        this.opts.log('woke from sleep: rechecking the Discord connection and the hosts');
        this.transport?.wake?.();
      }
      last = now;
    }, everyMs);
    this.sleepTimer.unref?.();
  }

  status(): DaemonStatus {
    return {
      build: this.opts.build,
      pid: process.pid,
      startedAt: this.startedAt,
      hasToken: this.botToken !== undefined,
      connected: this.service.connected,
      source: this.sources.source,
      mirrored: this.service.mirroredCount,
      hosts: this.own?.hostCount ?? 0,
    };
  }

  /** For tests: resolves once queued reconciles and notices have run. */
  async whenIdle(): Promise<void> {
    await this.syncing;
    await this.service.whenIdle();
  }

  async dispose(): Promise<void> {
    clearInterval(this.sleepTimer);
    for (const c of this.conns) c.socket.destroy();
    this.conns.clear();
    this.server?.close();
    try {
      fs.rmSync(this.opts.socketPath, { force: true });
    } catch {
      // gone
    }
    await this.disconnectTransport();
    this.service.dispose();
    this.sources.dispose();
    this.own?.dispose();
  }

  // ---- settings ----

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

  /**
   * New settings, and the token (or its absence). Resolves once they have
   * taken effect: the surface reconciled first (so switching off closes the
   * cards while there is still a connection to close them with), then the
   * connection made, remade or dropped.
   */
  private async configure(p: ConfigureParams): Promise<void> {
    if (p.config && typeof p.config === 'object') this.config = { ...DEFAULT_CONFIG, ...p.config };
    if (typeof p.homeDir === 'string' && p.homeDir) this.homeDir = p.homeDir;
    this.botToken = typeof p.botToken === 'string' && p.botToken ? p.botToken : undefined;
    if (this.config.remoteEnabled && this.botToken) this.ensureOwnFeed();
    else this.dropOwnFeed();
    // The toolbar button changes what may be published, not the connection.
    await this.service.reconcile();
    await this.syncTransport();
  }

  private ensureOwnFeed(): void {
    if (this.own) return;
    const make = this.opts.makeOwnFeed ?? ((o: LocalFeedOptions) => new LocalFeed(o));
    const own = make({
      getConfig: () => this.config,
      runDir: this.opts.runDir,
      build: this.opts.build,
      log: (m) => this.opts.log(m),
      isArchived: (key) => this.archived.has(key),
      nickname: (key) => this.nicknames.get(key),
      isActive: () => this.sources.source === 'daemon',
      onNotice: (notice) => void this.service.notify(notice),
    });
    this.own = own;
    this.sources.set('daemon', own);
    void own.start().catch((err) => this.opts.log(`own feed failed to start: ${String(err)}`));
  }

  /** Switched off, or no token: nothing to follow the machine for. */
  private dropOwnFeed(): void {
    if (!this.own) return;
    this.sources.set('daemon', undefined);
    this.own.dispose();
    this.own = undefined;
  }

  // ---- Discord ----

  private disconnectTransport = async (): Promise<void> => {
    if (!this.transport) return;
    this.service.setTransport(undefined);
    const going = this.transport;
    this.transport = undefined;
    this.transportFor = undefined;
    await going.disconnect();
    going.dispose();
  };

  /** Connect, reconnect or disconnect, whichever the settings and the token now say. */
  private syncTransport(): Promise<void> {
    this.syncing = this.syncing.then(async () => {
      const cfg = this.remoteConfig();
      const token = this.botToken;
      const wanted = cfg.enabled && !!token && !!cfg.guildId && !!cfg.channelId;
      const key = wanted ? `${token}\u0000${cfg.guildId}\u0000${cfg.channelId}` : undefined;
      if (key === this.transportFor && (wanted ? !!this.transport : !this.transport)) return;
      if (this.transport) this.opts.log('disconnecting from Discord');
      await this.disconnectTransport();
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

  // ---- the socket ----

  private listen(): Promise<void> {
    try {
      fs.rmSync(this.opts.socketPath, { force: true });
    } catch {
      // nothing there
    }
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.accept(socket));
      server.once('error', reject);
      server.listen(this.opts.socketPath, () => {
        server.off('error', reject);
        server.on('error', (err) => this.opts.log(`socket: ${String(err)}`));
        try {
          fs.chmodSync(this.opts.socketPath, 0o600);
        } catch (err) {
          this.opts.log(`socket: could not restrict ${this.opts.socketPath}: ${String(err)}`);
        }
        this.server = server;
        resolve();
      });
    });
  }

  private accept(socket: net.Socket): void {
    const conn: Conn = {
      socket,
      authed: false,
      peer: new NdjsonPeer({
        write: (line) => {
          if (!socket.destroyed) socket.write(line);
        },
        jsonrpc: true,
        maxLineBytes: MAX_LINE_BYTES,
        onOversize: () => socket.destroy(),
        log: (m) => this.opts.log(m),
      }),
    };
    this.conns.add(conn);
    socket.on('data', (chunk: Buffer) => conn.peer.feed(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      conn.peer.dispose();
      this.conns.delete(conn);
      if (this.app?.conn === conn) {
        this.opts.log('the app disconnected');
        this.app.feed.dispose();
        this.app = undefined;
        this.sources.set('app', undefined);
      }
    });
    conn.peer.onRequest((req) => void this.dispatch(conn, req));
    conn.peer.onNotification((n) => {
      if (!conn.authed || n.method !== 'sessions') return;
      this.onSessions(conn, n.params as SessionsParams);
    });
  }

  private async dispatch(conn: Conn, req: IncomingRequest): Promise<void> {
    try {
      conn.peer.respond(req.id, await this.handle(conn, req));
    } catch (err) {
      const e = err as { code?: number; message?: string };
      conn.peer.respondError(req.id, { code: typeof e.code === 'number' ? e.code : -32603, message: e.message ?? String(err) });
    }
  }

  private async handle(conn: Conn, req: IncomingRequest): Promise<unknown> {
    const p = (req.params && typeof req.params === 'object' ? req.params : {}) as Record<string, unknown>;
    if (req.method === 'hello') return this.hello(conn, p as unknown as HelloParams);
    if (!conn.authed) throw Object.assign(new Error('hello first, with the token'), { code: RPC_UNAUTHORIZED });
    switch (req.method) {
      case 'configure':
        this.claimApp(conn);
        await this.configure(p as unknown as ConfigureParams);
        return { ok: true };
      case 'notify':
        await this.service.notify((p as { notice: RemoteNotice }).notice);
        return { ok: true };
      case 'status':
        return this.status();
      default:
        throw Object.assign(new Error(`no method ${req.method}`), { code: -32601 });
    }
  }

  private hello(conn: Conn, p: HelloParams): HelloResult {
    const offered = typeof p?.token === 'string' ? Buffer.from(p.token, 'utf8') : Buffer.alloc(0);
    if (offered.length !== this.token.length || !timingSafeEqual(offered, this.token)) {
      throw Object.assign(new Error('bad token'), { code: RPC_UNAUTHORIZED });
    }
    if (p.protocol !== REMOTE_DAEMON_PROTOCOL) {
      throw Object.assign(new Error(`this daemon speaks protocol ${REMOTE_DAEMON_PROTOCOL}`), { code: RPC_PROTOCOL_MISMATCH });
    }
    conn.authed = true;
    return { protocol: REMOTE_DAEMON_PROTOCOL, build: this.opts.build, pid: process.pid, startedAt: this.startedAt };
  }

  /** The connection that configures the daemon is the app. The newest one wins. */
  private claimApp(conn: Conn): void {
    if (this.app?.conn === conn) return;
    if (this.app) {
      this.opts.log('a new app connection replaces the previous one');
      this.app.feed.dispose();
      this.app.conn.socket.destroy();
    }
    const feed = new AppFeed(conn.peer, (m) => this.opts.log(m));
    this.app = { conn, feed };
    this.sources.set('app', feed);
    this.opts.log('the app connected');
  }

  private onSessions(conn: Conn, p: SessionsParams): void {
    this.claimApp(conn);
    if (!Array.isArray(p?.sessions)) return;
    const archived = new Set(Array.isArray(p.archived) ? p.archived : []);
    const nicknames = new Map(Object.entries(p.nicknames ?? {}));
    const changed = !sameSet(archived, this.archived) || !sameMap(nicknames, this.nicknames);
    this.archived = archived;
    this.nicknames = nicknames;
    if (changed) this.own?.redecorate();
    this.app!.feed.push(p.sessions, p.ready === true);
  }
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function sameMap(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
