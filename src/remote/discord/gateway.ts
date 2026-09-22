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

export class DiscordGateway implements Disposable {
  private socket?: GatewaySocket;
  private heartbeatTimer?: unknown;
  private sequence: number | null = null;
  private sessionId?: string;
  private resumeUrl?: string;
  private acked = true;
  private attempt = 0;
  private wantOpen = false;
  private disposed = false;
  private ready = false;
  private fatal?: string;

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
    this.wantOpen = true;
    this.fatal = undefined;
    await this.open();
  }

  async disconnect(): Promise<void> {
    this.wantOpen = false;
    this.teardown();
    this.setReady(false);
  }

  dispose(): void {
    this.disposed = true;
    this.wantOpen = false;
    this.teardown();
    this.dispatchEmitter.dispose();
    this.stateEmitter.dispose();
  }

  // ---- internals ----

  private async open(): Promise<void> {
    if (!this.wantOpen || this.disposed) return;
    let url: string;
    try {
      // Resume goes back to the host READY named, not the one we first dialled.
      url = this.sessionId && this.resumeUrl ? this.resumeUrl : await this.deps.gatewayUrl();
    } catch (err) {
      this.log(`cannot resolve the gateway url: ${String(err)}`);
      return void this.scheduleReconnect();
    }

    try {
      this.socket = this.socketFactory(`${url}/?v=10&encoding=json`);
    } catch (err) {
      this.log(`cannot open the gateway socket: ${String(err)}`);
      return void this.scheduleReconnect();
    }

    this.socket.addEventListener('message', (event) => this.onMessage(event.data));
    this.socket.addEventListener('close', (event) => this.onClose(event.code, event.reason));
    this.socket.addEventListener('error', () => {
      // The close event follows and carries the code; nothing to do here but
      // avoid an unhandled 'error'.
    });
  }

  private onMessage(raw: unknown): void {
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
        this.startHeartbeat(interval);
        if (this.sessionId && this.sequence !== null) this.sendResume();
        else this.sendIdentify();
        return;
      }
      case OP.HEARTBEAT:
        // Discord can ask for one out of band.
        this.send(OP.HEARTBEAT, this.sequence);
        return;
      case OP.HEARTBEAT_ACK:
        this.acked = true;
        return;
      case OP.RECONNECT:
        this.log('gateway asked us to reconnect');
        this.reopen(4000);
        return;
      case OP.INVALID_SESSION: {
        // `d: true` means the session can still be resumed; false means start over.
        const resumable = payload.d === true;
        if (!resumable) this.forgetSession();
        this.log(`gateway invalidated the session (resumable: ${resumable})`);
        void this.sleep(1000 + this.random() * 4000).then(() => this.reopen(4000));
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

  private onClose(code: number, reason?: string): void {
    this.stopHeartbeat();
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
    if (!this.wantOpen || this.disposed) return;
    this.attempt++;
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.attempt - 1));
    const jittered = base * (0.8 + this.random() * 0.4);
    this.log(`reconnecting in ${Math.round(jittered)}ms (attempt ${this.attempt})`);
    await this.sleep(jittered);
    await this.open();
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.acked = true;
    // The first beat is jittered, so a fleet reconnecting together does not
    // arrive in lockstep. Discord asks for this explicitly.
    void this.sleep(intervalMs * this.random()).then(() => {
      if (!this.socket) return;
      this.beat();
      this.heartbeatTimer = this.setIntervalImpl(() => this.beat(), intervalMs);
    });
  }

  private beat(): void {
    if (!this.acked) {
      // A missed ACK means a zombie connection: the socket is open but nothing
      // is coming back. Reconnecting and resuming is the documented cure.
      this.log('no heartbeat ack; the connection is a zombie, reconnecting');
      this.reopen(4000);
      return;
    }
    this.acked = false;
    this.send(OP.HEARTBEAT, this.sequence);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) this.clearIntervalImpl(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private sendIdentify(): void {
    this.send(OP.IDENTIFY, {
      token: this.deps.token(),
      // Nothing. Interactions arrive regardless, and subscribing to guild or
      // message events would mean reading traffic this feature has no use for.
      intents: 0,
      properties: { os: process.platform, browser: 'agent-wrangler', device: 'agent-wrangler' },
    });
  }

  private sendResume(): void {
    this.send(OP.RESUME, { token: this.deps.token(), session_id: this.sessionId, seq: this.sequence });
  }

  private send(op: number, d: unknown): void {
    try {
      this.socket?.send(JSON.stringify({ op, d }));
    } catch (err) {
      this.log(`gateway send failed: ${String(err)}`);
    }
  }

  private reopen(code: number): void {
    this.teardown(code);
    void this.scheduleReconnect();
  }

  private teardown(code = 1000): void {
    this.stopHeartbeat();
    try {
      this.socket?.close(code);
    } catch {
      // already gone
    }
    this.socket = undefined;
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
