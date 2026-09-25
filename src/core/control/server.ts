/**
 * The control socket's server, in the app (playbook §9.10, Stage 8, #21).
 *
 * It holds no policy of its own. It authenticates a client by the per-launch
 * token, checks the protocol version, and hands each method to a
 * `ControlBackend`, which `createControlBackend` builds over the app's own
 * services. Transport-level concerns only: framing, one subscription per
 * connection, and a bound on how far a slow reader may fall behind.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { Disposable } from '../events';
import { NdjsonPeer, type IncomingRequest } from '../rpc/ndjsonPeer';
import type { SessionViewEvent } from '../session/sessionHandle';
import {
  CONTROL_PROTOCOL_VERSION,
  DEFAULT_SUBSCRIBE_BLOCKS,
  MAX_CONTROL_LINE_BYTES,
  MAX_SUBSCRIBE_BLOCKS,
  RPC_UNSUPPORTED,
  MUTATING_CONTROL_METHODS,
  RPC_INTERNAL,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  RPC_PROTOCOL_MISMATCH,
  RPC_UNAUTHORIZED,
  type ControlHelloParams,
  type ControlHelloResult,
  type ControlMethod,
  type ControlProject,
  type ControlSendResult,
  type ControlSession,
  type ControlSessionClosed,
  type ControlSessionResult,
  type ControlStatusResult,
  type ControlSubscribeResult,
  type StopOutcome,
} from './protocol';

/** A method failed in a way the client should be told about by code. */
export class ControlError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface ControlSubscription extends Disposable {
  result: ControlSubscribeResult;
}

/** What the socket can ask the app. Every method may throw `ControlError`. */
export interface ControlBackend {
  describe(): Omit<ControlHelloResult, 'protocol' | 'capabilities'>;
  status(): ControlStatusResult;
  sessions(opts: { all: boolean }): ControlSession[];
  session(ref: string): ControlSessionResult;
  subscribe(
    ref: string,
    maxBlocks: number,
    onEvent: (event: SessionViewEvent) => void,
    onClosed: (reason: ControlSessionClosed['reason']) => void,
  ): ControlSubscription;
  send(ref: string, text: string): Promise<ControlSendResult>;
  stop(ref: string, force: boolean): Promise<StopOutcome>;
  projects(): ControlProject[];
}

export interface ControlServerOptions {
  backend: ControlBackend;
  token: string;
  log: (message: string) => void;
  /** Bytes a subscriber may leave unread before its subscription is dropped. Default 8 MiB. */
  maxBufferedBytes?: number;
}

interface Conn {
  socket: net.Socket;
  peer: NdjsonPeer;
  authed: boolean;
  /** Who it said it was at `hello`, for the audit log. Self-reported. */
  client?: string;
  subscription?: ControlSubscription;
}

const DEFAULT_MAX_BUFFERED = 8 * 1024 * 1024;

export class ControlServer implements Disposable {
  private server?: net.Server;
  private socketPath?: string;
  private readonly conns = new Set<Conn>();
  private readonly token: Buffer;
  /** Set once the app starts quitting: reads still work, changes do not. */
  private mutationsStopped = false;

  constructor(private readonly opts: ControlServerOptions) {
    this.token = Buffer.from(opts.token, 'utf8');
  }

  /**
   * The app is quitting: refuse `send` and `stop` from now on, so a command
   * cannot race the quit's own ending of sessions.
   */
  stopMutations(): void {
    this.mutationsStopped = true;
  }

  /**
   * Listen on `socketPath` (0600). A socket file already there is a previous
   * run's: the app holds a single-instance lock, so no live server owns it.
   */
  listen(socketPath: string): Promise<void> {
    try {
      fs.rmSync(socketPath, { force: true });
    } catch {
      // nothing there
    }
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.accept(socket));
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        // Accept failures (EMFILE, …) arrive here; unheard, they would be an
        // uncaught exception in the app's main process.
        server.on('error', (err) => this.opts.log(`control socket: ${String(err)}`));
        try {
          fs.chmodSync(socketPath, 0o600);
        } catch (err) {
          this.opts.log(`control socket: could not restrict ${socketPath}: ${String(err)}`);
        }
        this.server = server;
        this.socketPath = socketPath;
        resolve();
      });
    });
  }

  dispose(): void {
    for (const conn of this.conns) {
      conn.subscription?.dispose();
      conn.peer.dispose();
      conn.socket.destroy();
    }
    this.conns.clear();
    this.server?.close();
    this.server = undefined;
    if (this.socketPath) {
      try {
        fs.rmSync(this.socketPath, { force: true });
      } catch {
        // gone
      }
    }
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
        maxLineBytes: MAX_CONTROL_LINE_BYTES,
        onOversize: () => socket.destroy(),
      }),
    };
    this.conns.add(conn);
    socket.on('data', (chunk: Buffer) => conn.peer.feed(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      conn.subscription?.dispose();
      conn.peer.dispose();
      this.conns.delete(conn);
    });
    conn.peer.onRequest((req) => void this.dispatch(conn, req));
  }

  private async dispatch(conn: Conn, req: IncomingRequest): Promise<void> {
    try {
      conn.peer.respond(req.id, await this.handle(conn, req));
    } catch (err) {
      const failure = err instanceof ControlError ? err : new ControlError(RPC_INTERNAL, err instanceof Error ? err.message : String(err));
      conn.peer.respondError(req.id, {
        code: failure.code,
        message: failure.message,
        ...(failure.data === undefined ? {} : { data: failure.data }),
      });
    }
  }

  private async handle(conn: Conn, req: IncomingRequest): Promise<unknown> {
    const p = (req.params && typeof req.params === 'object' ? req.params : {}) as Record<string, unknown>;
    const method = req.method as ControlMethod;
    if (method === 'hello') return this.hello(conn, p as unknown as ControlHelloParams);
    if (!conn.authed) throw new ControlError(RPC_UNAUTHORIZED, 'hello first, with the token');
    const backend = this.opts.backend;
    const mutating = MUTATING_CONTROL_METHODS.includes(method);
    if (mutating || method === 'subscribe') {
      this.opts.log(`control socket: ${method} ${String(p.ref).slice(0, 80)} by ${conn.client ?? '?'}`);
    }
    if (mutating && this.mutationsStopped) throw new ControlError(RPC_UNSUPPORTED, 'Agent Wrangler is quitting');
    switch (method) {
      case 'status':
        return backend.status();
      case 'sessions':
        return { sessions: backend.sessions({ all: p.all === true }) };
      case 'session':
        return backend.session(ref(p));
      case 'subscribe': {
        const wanted = typeof p.maxBlocks === 'number' && Number.isFinite(p.maxBlocks) ? Math.floor(p.maxBlocks) : DEFAULT_SUBSCRIBE_BLOCKS;
        return this.subscribe(conn, ref(p), Math.max(0, Math.min(MAX_SUBSCRIBE_BLOCKS, wanted)));
      }
      case 'send': {
        if (typeof p.text !== 'string' || p.text.trim().length === 0) throw new ControlError(RPC_INVALID_PARAMS, 'text is required');
        return (await backend.send(ref(p), p.text)) satisfies ControlSendResult;
      }
      case 'stop':
        return { outcome: await backend.stop(ref(p), p.force === true) };
      case 'projects':
        return { projects: backend.projects() };
      default:
        throw new ControlError(RPC_METHOD_NOT_FOUND, `no method ${req.method}`);
    }
  }

  private hello(conn: Conn, p: ControlHelloParams): ControlHelloResult {
    // A later hello replaces the first: it has to pass on its own.
    conn.authed = false;
    const offered = typeof p?.token === 'string' ? Buffer.from(p.token, 'utf8') : Buffer.alloc(0);
    if (offered.length !== this.token.length || !timingSafeEqual(offered, this.token)) {
      this.opts.log('control socket: refused a client with the wrong token');
      throw new ControlError(RPC_UNAUTHORIZED, 'bad token');
    }
    const min = typeof p.protocol?.min === 'number' ? p.protocol.min : 1;
    const max = typeof p.protocol?.max === 'number' ? p.protocol.max : 1;
    if (CONTROL_PROTOCOL_VERSION < min || CONTROL_PROTOCOL_VERSION > max) {
      throw new ControlError(RPC_PROTOCOL_MISMATCH, `this app speaks control protocol ${CONTROL_PROTOCOL_VERSION}`, {
        min: CONTROL_PROTOCOL_VERSION,
        max: CONTROL_PROTOCOL_VERSION,
      });
    }
    conn.authed = true;
    const name = typeof p.client?.name === 'string' ? p.client.name.slice(0, 40) : '?';
    conn.client = `${name} pid ${typeof p.client?.pid === 'number' ? p.client.pid : '?'}`;
    return { ...this.opts.backend.describe(), protocol: CONTROL_PROTOCOL_VERSION, capabilities: [] };
  }

  /**
   * Replace any subscription this connection had. Events are written as they
   * come; a client that stops reading is cut off once `maxBufferedBytes` sit
   * unread, with `session.closed {reason: 'overflow'}`, rather than letting
   * the app's heap grow for it.
   */
  private subscribe(conn: Conn, sessionRef: string, maxBlocks: number): ControlSubscribeResult {
    conn.subscription?.dispose();
    conn.subscription = undefined;
    const limit = this.opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED;
    let closed = false;
    // The ref until the backend has resolved it to a key.
    let key = sessionRef;
    const close = (reason: ControlSessionClosed['reason']) => {
      if (closed) return;
      closed = true;
      sub?.dispose();
      if (conn.subscription === sub) conn.subscription = undefined;
      conn.peer.notify('session.closed', { key, reason } satisfies ControlSessionClosed);
    };
    let sub: ControlSubscription | undefined;
    sub = this.opts.backend.subscribe(
      sessionRef,
      maxBlocks,
      (event) => {
        if (closed) return;
        if (conn.socket.writableLength > limit) {
          close('overflow');
          return;
        }
        conn.peer.notify('session.event', { key, event });
      },
      (reason) => close(reason),
    );
    key = sub.result.key;
    if (closed) {
      sub.dispose();
    } else {
      conn.subscription = sub;
    }
    return sub.result;
  }
}

/** 0700 and ours, or refuse: a directory anyone else can reach is not a private channel (§12). */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.statSync(dir);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`${dir} belongs to another user; not serving the control socket there`);
  }
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

function ref(p: Record<string, unknown>): string {
  if (typeof p.ref !== 'string' || p.ref.trim().length === 0) throw new ControlError(RPC_INVALID_PARAMS, 'ref is required');
  return p.ref;
}

/**
 * Create the run directory if needed (0700, ours), and write a fresh token
 * (0600). A new token every launch: a client that read the last one has to
 * read it again, and a token copied somewhere stops working at the next start.
 */
export function writeControlToken(tokenPath: string): string {
  ensurePrivateDir(path.dirname(tokenPath));
  const token = randomBytes(32).toString('base64url');
  const tmp = `${tokenPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token, { mode: 0o600 });
  fs.renameSync(tmp, tokenPath);
  return token;
}
