/**
 * The outbound WebSocket that makes this whole feature possible without a port.
 *
 * Discord delivers interactions one of two mutually exclusive ways: to an
 * Interactions Endpoint URL over HTTPS, or down a gateway socket the bot opened
 * itself. With no endpoint URL configured it is the second — verified against a
 * real bot, see the plan's §0.1 — so a laptop behind NAT needs no tunnel, no
 * public URL and no hosted relay.
 *
 * It identifies with **`intents: 0`**: interactions are not gated by intents, so
 * the bot subscribes to nothing, receives no message content, and needs no
 * privileged intent toggled in the developer portal.
 *
 * The socket is injected so the lifecycle — heartbeat, resume, invalid session,
 * the close codes that must not be retried — is testable against a scripted
 * fake rather than against Discord.
 *
 * **Exactly one socket at a time, and every reconnect goes through one chain.**
 * A gateway that can hold two live sockets is not twice as reliable, it is
 * broken: both receive every interaction, both race to acknowledge it, the loser
 * gets "Unknown interaction" and the card in Discord says the application did
 * not respond in time. Worse, the two multiply — each socket that dies asks for
 * a replacement — until the bot is opening hundreds of connections a minute and
 * Discord stops answering at all. So connection state that used to live on the
 * instance (the socket, its heartbeat timer, whether the last beat was acked)
 * lives on a `Connection` instead, and every callback checks that its own
 * connection is still the current one before touching anything. A superseded
 * connection is inert: its close event asks for nothing, its heartbeat sends
 * nothing.
 */
import { Emitter, type Disposable } from '../../core/events';

/** The little of `WebSocket` this needs; the global one satisfies it. */
export interface GatewaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (event: { code: number; reason?: string }) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  /** Optional: lets a torn-down socket be released rather than merely ignored. */
  removeEventListener?(type: string, listener: (event: never) => void): void;
}

export type SocketFactory = (url: string) => GatewaySocket;

export interface GatewayDispatch {
  t: string;
  d: Record<string, unknown>;
}

export interface GatewayDeps {
  token: () => string;
  /** Where to connect. Normally `GET /gateway/bot`'s `url`. */
  gatewayUrl: () => Promise<string>;
  socketFactory?: SocketFactory;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
  /** Deterministic jitter in tests. */
  random?: () => number;
  /**
   * The heartbeat timer. Injected so the zombie-connection path — an open
   * socket that has stopped acknowledging — can be exercised under test
   * without waiting 41 seconds for a real interval.
   */
  setIntervalImpl?: (fn: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
}

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/**
 * Close codes Discord documents as permanent. Retrying these is a loop that
 * cannot succeed, and 4004 in particular means the token is wrong — the one
 * failure a human must be told about rather than have papered over.
 */
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

const MAX_BACKOFF_MS = 60_000;

/**
 * One attempt at a socket, and everything that belongs to it alone.
 *
 * `acked` and the heartbeat timer are per-connection because they used to be
 * shared: two sockets beating against one `acked` flag made each other look
 * dead, and every false death spawned another socket.
 */
interface Connection {
  socket: GatewaySocket;
  /** Cleared the moment this connection stops being the current one. */
  alive: boolean;
  acked: boolean;
  heartbeatTimer?: unknown;
  /** Kept so the listeners can be detached, where the socket supports it. */
  listeners: { type: string; listener: (event: never) => void }[];
}

export class DiscordGateway implements Disposable {
  private conn?: Connection;
  private sequence: number | null = null;
  private sessionId?: string;
  private resumeUrl?: string;
  private attempt = 0;
  private wantOpen = false;
  private disposed = false;
  private ready = false;
  private fatal?: string;
  /**
   * One reconnect in flight at a time. Without this, a socket that closes while
   * a reconnect is already sleeping adds a second chain, and from then on the
   * number of chains only ever grows.
   */
  private reconnecting = false;
  /**
   * Bumped by connect/disconnect/dispose. A reconnect that was sleeping across
   * one of those wakes into a world that no longer wants it, and stops.
   */
  private epoch = 0;

  private dispatchEmitter = new Emitter<GatewayDispatch>();
  private stateEmitter = new Emitter<void>();

  private socketFactory: SocketFactory;
  private sleep: (ms: number) => Promise<void>;
  private log: (message: string) => void;
  private random: () => number;
  private setIntervalImpl: (fn: () => void, ms: number) => unknown;
  private clearIntervalImpl: (handle: unknown) => void;

  constructor(private deps: GatewayDeps) {
    this.socketFactory = deps.socketFactory ?? ((url) => new WebSocket(url) as unknown as GatewaySocket);
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = deps.log ?? (() => undefined);
    this.random = deps.random ?? Math.random;
    this.setIntervalImpl = deps.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalImpl = deps.clearIntervalImpl ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  }

  readonly onDispatch = (listener: (d: GatewayDispatch) => void): Disposable => this.dispatchEmitter.event(listener);
  readonly onDidChangeState = (listener: () => void): Disposable => this.stateEmitter.event(listener);

  get connected(): boolean {
    return this.ready;
  }

  /** Set when the connection failed in a way retrying cannot fix. */
  get fatalError(): string | undefined {
    return this.fatal;
  }

  async connect(): Promise<void> {
    if (this.disposed || this.wantOpen) return;
    this.epoch++;
    this.wantOpen = true;
    this.fatal = undefined;
    await this.open();
  }

  async disconnect(): Promise<void> {
    this.epoch++;
    this.wantOpen = false;
    this.teardown();
    this.setReady(false);
  }

  /**
   * The machine woke from sleep (`powerMonitor` `resume`). The socket is
   * almost certainly dead and would only be found so at the next heartbeat,
   * ~41 s away (§8 "Machine sleeps"). Drop it and dial again at once,
   * resuming the session so no event is lost. A reconnect already sleeping on
   * its backoff is superseded, not doubled.
   */
  wake(): void {
    if (!this.wantOpen || this.disposed) return;
    this.log('woke from sleep; reconnecting now');
    this.epoch++; // a backoff sleeping across the wake is stale
    this.reconnecting = false;
    this.attempt = 0;
    // 4000: not a normal closure, so the session stays resumable.
    this.teardown(4000);
    this.setReady(false);
    void this.open();
  }

  dispose(): void {
    this.epoch++;
    this.disposed = true;
    this.wantOpen = false;
    this.teardown();
    this.dispatchEmitter.dispose();
    this.stateEmitter.dispose();
  }

  // ---- internals ----

  /**
   * True only for the connection this gateway is currently living on. Every
   * callback asks first: a socket that has been superseded still delivers
   * events, and acting on them is what produced the storm.
   */
  private isCurrent(conn: Connection): boolean {
    return conn.alive && this.conn === conn && !this.disposed;
  }

  private async open(): Promise<void> {
    if (!this.wantOpen || this.disposed) return;
    // Nothing should still be open here, but if it is, it is not ours to keep:
    // two sockets is the failure this class exists to prevent.
    this.teardown();

    let url: string;
    try {
      // Resume goes back to the host READY named, not the one we first dialled.
      url = this.sessionId && this.resumeUrl ? this.resumeUrl : await this.deps.gatewayUrl();
    } catch (err) {
      this.log(`cannot resolve the gateway url: ${String(err)}`);
      return void this.scheduleReconnect();
    }
    // Awaiting the url gave disconnect() a chance to run.
    if (!this.wantOpen || this.disposed) return;

    let socket: GatewaySocket;
    try {
      socket = this.socketFactory(`${url}/?v=10&encoding=json`);
    } catch (err) {
      this.log(`cannot open the gateway socket: ${String(err)}`);
      return void this.scheduleReconnect();
    }

    const conn: Connection = { socket, alive: true, acked: true, listeners: [] };
    this.conn = conn;

    const on = (type: 'message' | 'close' | 'error', listener: (event: never) => void) => {
      conn.listeners.push({ type, listener });
      (socket.addEventListener as (t: string, l: (event: never) => void) => void)(type, listener);
    };
    on('message', (event: { data: unknown }) => this.onMessage(conn, event.data));
    on('close', (event: { code: number; reason?: string }) => this.onClose(conn, event.code, event.reason));
    on('error', () => {
      // The close event follows and carries the code; nothing to do here but
      // avoid an unhandled 'error'.
    });
  }

  private onMessage(conn: Connection, raw: unknown): void {
    if (!this.isCurrent(conn)) return;
    let payload: { op?: number; t?: string; s?: number | null; d?: unknown };
    try {
      payload = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return; // not ours to make sense of
    }
    if (typeof payload.s === 'number') this.sequence = payload.s;

    switch (payload.op) {
      case OP.HELLO: {
        const interval = (payload.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 41_250;
        this.startHeartbeat(conn, interval);
        if (this.sessionId && this.sequence !== null) this.sendResume(conn);
        else this.sendIdentify(conn);
        return;
      }
      case OP.HEARTBEAT:
        // Discord can ask for one out of band.
        this.send(conn, OP.HEARTBEAT, this.sequence);
        return;
      case OP.HEARTBEAT_ACK:
        conn.acked = true;
        return;
      case OP.RECONNECT:
        this.log('gateway asked us to reconnect');
        this.reopen(conn, 4000);
        return;
      case OP.INVALID_SESSION: {
        // `d: true` means the session can still be resumed; false means start over.
        const resumable = payload.d === true;
        if (!resumable) this.forgetSession();
        this.log(`gateway invalidated the session (resumable: ${resumable})`);
        void this.sleep(1000 + this.random() * 4000).then(() => this.reopen(conn, 4000));
        return;
      }
      case OP.DISPATCH: {
        const t = payload.t;
        if (typeof t !== 'string') return;
        if (t === 'READY') {
          const d = payload.d as { session_id?: string; resume_gateway_url?: string; user?: { username?: string } };
          this.sessionId = d?.session_id;
          this.resumeUrl = d?.resume_gateway_url;
          this.attempt = 0; // a good connection resets the backoff
          this.log(`gateway ready as ${d?.user?.username ?? 'unknown'}`);
          this.setReady(true);
          return;
        }
        if (t === 'RESUMED') {
          this.attempt = 0;
          this.log('gateway resumed');
          this.setReady(true);
          return;
        }
        this.dispatchEmitter.fire({ t, d: (payload.d ?? {}) as Record<string, unknown> });
        return;
      }
      default:
        return;
    }
  }

  private onClose(conn: Connection, code: number, reason?: string): void {
    // A connection we already replaced closing is expected — it is us that
    // closed it. It must not ask for a replacement of its own.
    if (!this.isCurrent(conn)) return;
    this.retire(conn);
    this.conn = undefined;
    this.setReady(false);
    if (FATAL_CLOSE.has(code)) {
      // 4004 is a bad token. Retrying would hammer Discord with a credential
      // that will never work, so stop and surface it.
      this.wantOpen = false;
      this.fatal =
        code === 4004
          ? 'Discord rejected the bot token.'
          : `Discord closed the connection permanently (${code}${reason ? `: ${reason}` : ''}).`;
      this.log(this.fatal);
      this.stateEmitter.fire();
      return;
    }
    // Codes outside the resumable range mean the session is finished.
    if (code === 4007 || code === 4009 || code === 1000 || code === 1001) this.forgetSession();
    if (this.wantOpen) void this.scheduleReconnect();
  }

  private async scheduleReconnect(): Promise<void> {
    if (!this.wantOpen || this.disposed || this.reconnecting) return;
    this.reconnecting = true;
    const epoch = this.epoch;
    this.attempt++;
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.attempt - 1));
    const jittered = base * (0.8 + this.random() * 0.4);
    this.log(`reconnecting in ${Math.round(jittered)}ms (attempt ${this.attempt})`);
    try {
      await this.sleep(jittered);
    } finally {
      this.reconnecting = false;
    }
    // connect/disconnect/dispose while we slept means this chain is stale.
    if (epoch !== this.epoch || !this.wantOpen || this.disposed) return;
    await this.open();
  }

  private startHeartbeat(conn: Connection, intervalMs: number): void {
    this.stopHeartbeat(conn);
    conn.acked = true;
    // The first beat is jittered, so a fleet reconnecting together does not
    // arrive in lockstep. Discord asks for this explicitly. The sleep cannot be
    // cancelled, so the connection is re-checked on the other side of it —
    // otherwise a reconnect during the jitter leaves an interval running
    // against a socket nobody owns any more.
    void this.sleep(intervalMs * this.random()).then(() => {
      if (!this.isCurrent(conn)) return;
      this.beat(conn);
      if (!this.isCurrent(conn)) return; // the beat itself may have reopened
      conn.heartbeatTimer = this.setIntervalImpl(() => this.beat(conn), intervalMs);
    });
  }

  private beat(conn: Connection): void {
    if (!this.isCurrent(conn)) return;
    if (!conn.acked) {
      // A missed ACK means a zombie connection: the socket is open but nothing
      // is coming back. Reconnecting and resuming is the documented cure.
      this.log('no heartbeat ack; the connection is a zombie, reconnecting');
      this.reopen(conn, 4000);
      return;
    }
    conn.acked = false;
    this.send(conn, OP.HEARTBEAT, this.sequence);
  }

  private stopHeartbeat(conn: Connection): void {
    if (conn.heartbeatTimer !== undefined) this.clearIntervalImpl(conn.heartbeatTimer);
    conn.heartbeatTimer = undefined;
  }

  private sendIdentify(conn: Connection): void {
    this.send(conn, OP.IDENTIFY, {
      token: this.deps.token(),
      // Nothing. Interactions arrive regardless, and subscribing to guild or
      // message events would mean reading traffic this feature has no use for.
      intents: 0,
      properties: { os: process.platform, browser: 'agent-wrangler', device: 'agent-wrangler' },
    });
  }

  private sendResume(conn: Connection): void {
    this.send(conn, OP.RESUME, { token: this.deps.token(), session_id: this.sessionId, seq: this.sequence });
  }

  private send(conn: Connection, op: number, d: unknown): void {
    if (!conn.alive) return;
    try {
      conn.socket.send(JSON.stringify({ op, d }));
    } catch (err) {
      this.log(`gateway send failed: ${String(err)}`);
    }
  }

  /** Close this connection and ask for one more — but only if it is still ours. */
  private reopen(conn: Connection, code: number): void {
    if (!this.isCurrent(conn)) return;
    this.teardown(code);
    void this.scheduleReconnect();
  }

  private teardown(code = 1000): void {
    const conn = this.conn;
    this.conn = undefined;
    if (!conn) return;
    this.retire(conn);
    try {
      conn.socket.close(code);
    } catch {
      // already gone
    }
  }

  /**
   * Make a connection inert: stop its heartbeat and detach its listeners. The
   * close event it is about to fire will find `alive` false and do nothing.
   */
  private retire(conn: Connection): void {
    this.stopHeartbeat(conn);
    conn.alive = false;
    const remove = conn.socket.removeEventListener?.bind(conn.socket);
    if (remove) for (const { type, listener } of conn.listeners) remove(type, listener);
    conn.listeners = [];
  }

  private forgetSession(): void {
    this.sessionId = undefined;
    this.resumeUrl = undefined;
    this.sequence = null;
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    this.stateEmitter.fire();
  }
}
