/**
 * The app's end of the remote daemon (#74).
 *
 * Starts the daemon if it is not running (`ensure`: the LaunchAgent, in the
 * packaged app), connects, hands over the settings and the bot token, streams
 * the app's decorated session list, and applies the presses the daemon sends
 * back through the same `SessionActions` the dashboard's buttons use. It
 * reconnects for as long as remote control is on; the daemon carries on
 * without it in between.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import type { Disposable } from '../../core/events';
import { NdjsonPeer, type IncomingRequest } from '../../core/rpc/ndjsonPeer';
import type { SessionDTO } from '../../shared/model';
import type { RemoteNotice } from '../../shared/remote';
import type { PermissionActions } from '../service';
import type { RemoteDaemonPaths } from './paths';
import {
  REMOTE_DAEMON_PROTOCOL,
  type ConfigureParams,
  type DaemonStatus,
  type HelloResult,
  type MethodParams,
  type SessionsParams,
} from './protocol';

export type EnsureReason = 'start' | 'unreachable' | 'outdated';

export interface RemoteDaemonLinkOptions {
  paths: RemoteDaemonPaths;
  build: string;
  log: (message: string) => void;
  /** Start the daemon, or bring it up to this build. Idempotent. */
  ensure: (why: EnsureReason) => Promise<void>;
  /** A daemon of another build is replaced (the packaged app); unpackaged, it is used as it is. */
  replaceOutdated: boolean;
  configure: () => Promise<ConfigureParams>;
  sessions: { readonly sessions: SessionDTO[]; onDidUpdate(listener: () => void): Disposable };
  /** The list is complete. Checked on every push. */
  ready: () => boolean;
  extras: () => Pick<SessionsParams, 'archived' | 'nicknames'>;
  actions: PermissionActions;
}

const PUSH_DEBOUNCE_MS = 100;
/**
 * `configure` answers once it has taken effect, and switching off means
 * editing every open card first, at Discord's rate limit. Generous, so the
 * caller does not stop the daemon halfway through.
 */
const CONFIGURE_TIMEOUT_MS = 120_000;
const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 15_000;
/** Ask `ensure` again after this many failed connects in a row: launchd may have given up on it. */
const ENSURE_EVERY = 5;

export class RemoteDaemonLink implements Disposable {
  private peer?: NdjsonPeer;
  private socket?: net.Socket;
  private stopped = true;
  private loop?: Promise<void>;
  private pushTimer?: ReturnType<typeof setTimeout>;
  private sessionsSub?: Disposable;
  private replacedOutdated = false;
  private wake?: () => void;
  private hello?: HelloResult;

  constructor(private opts: RemoteDaemonLinkOptions) {}

  get connected(): boolean {
    return this.peer !== undefined && !this.peer.isClosed;
  }

  /** The daemon's build and pid, once connected. */
  get daemon(): HelloResult | undefined {
    return this.connected ? this.hello : undefined;
  }

  /** Begin (or carry on) connecting. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.sessionsSub ??= this.opts.sessions.onDidUpdate(() => this.pushSoon());
    this.loop = this.run();
  }

  /** Stop following. The daemon carries on (or is removed by the caller). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.sessionsSub?.dispose();
    this.sessionsSub = undefined;
    clearTimeout(this.pushTimer);
    this.socket?.destroy();
    this.wake?.();
    await this.loop;
  }

  dispose(): void {
    void this.stop();
  }

  /** The settings or the token changed. */
  async reconfigure(): Promise<void> {
    const peer = this.peer;
    if (!peer || peer.isClosed) return;
    try {
      await peer.request('configure', await this.opts.configure(), { timeoutMs: CONFIGURE_TIMEOUT_MS });
    } catch (err) {
      this.opts.log(`remote daemon: configure failed: ${String(err)}`);
    }
  }

  /** The list may have become complete without changing: push now. */
  pushSoon(): void {
    if (!this.connected) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.push(), PUSH_DEBOUNCE_MS);
  }

  async notify(notice: RemoteNotice): Promise<void> {
    const peer = this.peer;
    if (!peer || peer.isClosed) {
      this.opts.log(`remote daemon: not connected, notice dropped: ${notice.title}`);
      return;
    }
    try {
      await peer.request('notify', { notice } satisfies MethodParams['notify'], { timeoutMs: 15_000 });
    } catch (err) {
      this.opts.log(`remote daemon: notice failed: ${String(err)}`);
    }
  }

  async status(): Promise<DaemonStatus | undefined> {
    const peer = this.peer;
    if (!peer || peer.isClosed) return undefined;
    try {
      return await peer.request<DaemonStatus>('status', {}, { timeoutMs: 5000 });
    } catch {
      return undefined;
    }
  }

  // ---- internals ----

  private async run(): Promise<void> {
    try {
      await this.opts.ensure('start');
    } catch (err) {
      this.opts.log(`remote daemon: could not start it: ${String(err)}`);
    }
    let failures = 0;
    let delay = RETRY_FIRST_MS;
    while (!this.stopped) {
      try {
        const closed = await this.connect();
        failures = 0;
        delay = RETRY_FIRST_MS;
        await closed;
        if (!this.stopped) this.opts.log('remote daemon: connection lost; reconnecting');
      } catch (err) {
        failures++;
        if (failures === 1 || failures % ENSURE_EVERY === 0) {
          this.opts.log(`remote daemon: not reachable (${String(err)})`);
          try {
            await this.opts.ensure('unreachable');
          } catch (e) {
            this.opts.log(`remote daemon: could not start it: ${String(e)}`);
          }
        }
      }
      if (this.stopped) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delay);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.wake = undefined;
      delay = Math.min(delay * 2, RETRY_MAX_MS);
    }
  }

  /** Connect and hand everything over. Resolves with a promise that settles when the link closes. */
  private async connect(): Promise<Promise<void>> {
    const token = fs.readFileSync(this.opts.paths.tokenPath, 'utf8').trim();
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(this.opts.paths.socketPath);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    // Held at once, so a `stop()` that lands mid-handshake can close it.
    this.socket = socket;
    if (this.stopped) {
      socket.destroy();
      throw new Error('stopped');
    }
    const peer = new NdjsonPeer({
      write: (line) => {
        if (!socket.destroyed) socket.write(line);
      },
      jsonrpc: true,
      log: (m) => this.opts.log(`remote daemon: ${m}`),
    });
    const closed = new Promise<void>((resolve) => {
      socket.on('close', () => {
        peer.dispose();
        if (this.peer === peer) this.peer = undefined;
        resolve();
      });
    });
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => peer.feed(chunk));
    peer.onRequest((req) => void this.onRequest(peer, req));
    try {
      this.hello = await peer.request<HelloResult>(
        'hello',
        { token, protocol: REMOTE_DAEMON_PROTOCOL, build: this.opts.build },
        { timeoutMs: 5000 },
      );
    } catch (err) {
      socket.destroy();
      throw err;
    }
    if (this.hello.build !== this.opts.build && this.opts.replaceOutdated && !this.replacedOutdated) {
      this.replacedOutdated = true;
      this.opts.log(`remote daemon: it runs build ${this.hello.build}, not ${this.opts.build}; replacing it`);
      socket.destroy();
      await this.opts.ensure('outdated');
      throw new Error('replaced an outdated daemon');
    }
    try {
      if (this.stopped) throw new Error('stopped');
      await peer.request('configure', await this.opts.configure(), { timeoutMs: CONFIGURE_TIMEOUT_MS });
    } catch (err) {
      socket.destroy();
      throw err;
    }
    this.peer = peer;
    this.opts.log(`remote daemon: connected (build ${this.hello.build}, pid ${this.hello.pid})`);
    this.push();
    return closed;
  }

  private push(): void {
    const peer = this.peer;
    if (!peer || peer.isClosed) return;
    const params: SessionsParams = { sessions: this.opts.sessions.sessions, ready: this.opts.ready(), ...this.opts.extras() };
    peer.notify('sessions', params);
  }

  private async onRequest(peer: NdjsonPeer, req: IncomingRequest): Promise<void> {
    const a = this.opts.actions;
    try {
      let outcome;
      if (req.method === 'decidePermission') {
        const p = req.params as MethodParams['decidePermission'];
        outcome = await a.decidePermission(p.key, p.behavior, { expectedRequestId: p.expectedRequestId });
      } else if (req.method === 'answerQuestion') {
        const p = req.params as MethodParams['answerQuestion'];
        outcome = await a.answerQuestion(p.key, p.requestId, p.answers);
      } else if (req.method === 'decidePlan') {
        const p = req.params as MethodParams['decidePlan'];
        outcome = await a.decidePlan(p.key, p.requestId, p.approve, p.feedback);
      } else {
        peer.respondError(req.id, { code: -32601, message: `no method ${req.method}` });
        return;
      }
      peer.respond(req.id, { outcome });
    } catch (err) {
      peer.respondError(req.id, { code: -32603, message: err instanceof Error ? err.message : String(err) });
    }
  }
}
