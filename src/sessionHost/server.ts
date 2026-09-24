/**
 * The session host's server: protocol v1 (`src/shared/sessionProtocol.ts`)
 * over a Unix socket, in front of one `ClaudeSdkSession`.
 *
 * It holds no policy. It authenticates clients by token, forwards their calls
 * to the session, and streams the session's events to every subscribed client
 * through a byte-bounded queue each, so a slow client costs itself a `resync`
 * and never costs the agent anything (playbook §9).
 */
import { timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { UnknownControlOp, type ClaudeSdkSession } from '../claude/runner/claudeSdkSession';
import type { Disposable } from '../core/events';
import { NdjsonPeer, type IncomingRequest } from '../core/rpc/ndjsonPeer';
import { ResyncNeeded } from '../core/session/seqLog';
import {
  CONTROL_OPS,
  HOST_PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  MAX_PAGE_BYTES,
  RPC_FORBIDDEN,
  RPC_INTERNAL,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  RPC_PROTOCOL_MISMATCH,
  RPC_RESYNC,
  RPC_UNAUTHORIZED,
  type ClientRole,
  type ControlRequest,
  type EventsResult,
  type HelloParams,
  type HelloResult,
  type HostEvent,
  type RawPermissionResult,
} from '../shared/sessionProtocol';
import { DEFAULT_QUEUE_BYTES, OutQueue } from './outQueue';
import { slimForWire } from './wire';

export interface HostServerOptions {
  session: ClaudeSdkSession;
  token: string;
  /** Everything in `hello`'s answer the server cannot know itself. */
  describe: () => Omit<HelloResult, 'protocol' | 'sessionId' | 'state' | 'seq' | 'epoch'>;
  log: (msg: string) => void;
  queueBytes?: number;
}

class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

interface Conn {
  socket: net.Socket;
  peer: NdjsonPeer;
  queue: OutQueue;
  role?: ClientRole;
  events?: Disposable;
  /** The last event seq this client was handed, for the drain check. */
  lastSent: number;
  /** Inside `subscribe`'s backlog replay: an overflow fails the call rather than sending `resync`. */
  subscribing?: boolean;
}

/** A line this close to the frame limit is replaced by a stub rather than sent (or never delivered). */
const FRAME_HEADROOM = 4096;

const MUTATING = new Set(['send', 'respondAsk', 'control', 'end']);

export class HostServer {
  private server?: net.Server;
  private conns = new Set<Conn>();
  private readonly token: Buffer;

  constructor(private opts: HostServerOptions) {
    this.token = Buffer.from(opts.token, 'utf8');
  }

  /** Listen on `socketPath` (0600). A stale socket file from a dead host is replaced. */
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
        try {
          fs.chmodSync(socketPath, 0o600);
        } catch (err) {
          this.opts.log(`could not restrict the socket: ${String(err)}`);
        }
        this.server = server;
        resolve();
      });
    });
  }

  /** Connected clients that are subscribed to events. */
  get subscribers(): number {
    return [...this.conns].filter((c) => c.events).length;
  }

  /**
   * Whether some subscribed client has been handed everything up to `seq` and
   * its queue is empty: the exit record has reached someone who can act on it.
   */
  delivered(seq: number): boolean {
    return [...this.conns].some((c) => c.events && c.lastSent >= seq && c.queue.idle);
  }

  /**
   * Stop listening and let every connection go. Each socket is ended, not
   * destroyed, so whatever is still in its write buffer (the exit event, the
   * reply to `end`) reaches the client; one that has not closed within
   * `graceMs` is destroyed.
   */
  async close(graceMs = 500): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const c of this.conns) {
      c.events?.dispose();
      c.peer.close();
      closing.push(
        new Promise<void>((resolve) => {
          if (c.socket.destroyed) return resolve();
          const timer = setTimeout(() => {
            c.socket.destroy();
            resolve();
          }, graceMs);
          c.socket.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
          c.socket.end();
        }),
      );
    }
    this.conns.clear();
    const server = this.server;
    this.server = undefined;
    await Promise.all([...closing, new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))]);
  }

  // ---- connections ----

  private accept(socket: net.Socket): void {
    const conn: Conn = {
      socket,
      lastSent: 0,
      queue: new OutQueue(socket, this.opts.queueBytes ?? DEFAULT_QUEUE_BYTES, () => this.overflow(conn)),
      peer: new NdjsonPeer({
        jsonrpc: true,
        maxLineBytes: MAX_FRAME_BYTES,
        write: (line) => conn.queue.push(line, false),
        log: (m) => this.opts.log(`client sent ${m}`),
        onOversize: () => socket.destroy(),
      }),
    };
    this.conns.add(conn);
    socket.on('data', (chunk: Buffer) => conn.peer.feed(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      conn.events?.dispose();
      conn.peer.close();
      this.conns.delete(conn);
    });
    conn.peer.onRequest((req) => void this.dispatch(conn, req));
  }

  /** Its queue overflowed: stop streaming to it and tell it to catch up from a snapshot. */
  private overflow(conn: Conn): void {
    conn.events?.dispose();
    conn.events = undefined;
    // Inside `subscribe`, the call itself fails with RPC_RESYNC instead (see there).
    if (conn.subscribing) return;
    this.opts.log(`a client fell behind; asked it to resync (overflow ${conn.queue.overflows})`);
    conn.queue.push(`${JSON.stringify({ jsonrpc: '2.0', method: 'resync', params: {} })}\n`, false);
  }

  private async dispatch(conn: Conn, req: IncomingRequest): Promise<void> {
    try {
      const result = await this.handle(conn, req);
      conn.peer.respond(req.id, result);
    } catch (err) {
      const failure =
        err instanceof RpcFailure
          ? err
          : err instanceof UnknownControlOp
            ? new RpcFailure(RPC_METHOD_NOT_FOUND, err.message)
            : new RpcFailure(RPC_INTERNAL, err instanceof Error ? err.message : String(err));
      conn.peer.respondError(req.id, {
        code: failure.code,
        message: failure.message,
        ...(failure.data === undefined ? {} : { data: failure.data }),
      });
    }
  }

  private async handle(conn: Conn, req: IncomingRequest): Promise<unknown> {
    const p = (req.params ?? {}) as Record<string, unknown>;
    if (req.method === 'hello') return this.hello(conn, p as unknown as HelloParams);
    if (!conn.role) throw new RpcFailure(RPC_UNAUTHORIZED, 'hello first, with the token');
    if (MUTATING.has(req.method) && conn.role !== 'core') throw new RpcFailure(RPC_FORBIDDEN, `${conn.role} may not ${req.method}`);
    const session = this.opts.session;
    switch (req.method) {
      case 'snapshot':
        return session.snapshot();
      case 'subscribe':
        this.checkEpoch(p.epoch);
        return this.subscribe(conn, num(p.fromSeq, 'fromSeq'));
      case 'events':
        this.checkEpoch(p.epoch);
        return this.events(num(p.fromSeq, 'fromSeq'), typeof p.maxBytes === 'number' ? p.maxBytes : MAX_PAGE_BYTES);
      case 'send':
        if (!p.message || typeof p.message !== 'object') throw new RpcFailure(RPC_INVALID_PARAMS, 'message is required');
        this.audit('send', (p.message as { uuid?: unknown }).uuid);
        return session.send(p.message as never);
      case 'respondAsk': {
        if (typeof p.requestId !== 'string' || !p.result || typeof p.result !== 'object') {
          throw new RpcFailure(RPC_INVALID_PARAMS, 'requestId and result are required');
        }
        this.audit('respondAsk', p.requestId);
        return { outcome: session.respondAsk(p.requestId, p.result as RawPermissionResult) };
      }
      case 'control': {
        if (!(CONTROL_OPS as readonly unknown[]).includes(p.op)) throw new RpcFailure(RPC_METHOD_NOT_FOUND, `no control op ${String(p.op)}`);
        this.audit('control', p.op);
        return { result: await session.control(p as unknown as ControlRequest) };
      }
      case 'end':
        this.audit('end');
        await session.end(typeof p.graceMs === 'number' ? { graceMs: p.graceMs } : {});
        return { ok: true };
      case 'ping':
        return { seq: session.snapshot().seq, now: Date.now() };
      default:
        throw new RpcFailure(RPC_METHOD_NOT_FOUND, `no method ${req.method}`);
    }
  }

  /** The audit trail §12 asks for: what was done and to which id, never the content. */
  private audit(method: string, detail?: unknown): void {
    this.opts.log(`audit: ${method}${detail === undefined ? '' : ` ${String(detail).slice(0, 80)}`}`);
  }

  /** Seqs from another host instance mean nothing here. */
  private checkEpoch(epoch: unknown): void {
    if (epoch !== undefined && epoch !== this.opts.session.snapshot().epoch) {
      throw new RpcFailure(RPC_RESYNC, 'that seq belongs to another host instance');
    }
  }

  private hello(conn: Conn, p: HelloParams): HelloResult {
    const offered = typeof p?.token === 'string' ? Buffer.from(p.token, 'utf8') : Buffer.alloc(0);
    if (offered.length !== this.token.length || !timingSafeEqual(offered, this.token)) {
      this.opts.log('refused a client with the wrong token');
      throw new RpcFailure(RPC_UNAUTHORIZED, 'bad token');
    }
    const min = p.protocol?.min ?? 1;
    const max = p.protocol?.max ?? 1;
    if (HOST_PROTOCOL_VERSION < min || HOST_PROTOCOL_VERSION > max) {
      throw new RpcFailure(RPC_PROTOCOL_MISMATCH, `this host speaks protocol ${HOST_PROTOCOL_VERSION}`, {
        min: HOST_PROTOCOL_VERSION,
        max: HOST_PROTOCOL_VERSION,
      });
    }
    // Only a client that says it is the core may command; anything else watches.
    conn.role = p.client?.role === 'core' ? 'core' : 'observer';
    const snap = this.opts.session.snapshot();
    return {
      ...this.opts.describe(),
      protocol: HOST_PROTOCOL_VERSION,
      sessionId: snap.sessionId,
      state: snap.state,
      seq: snap.seq,
      epoch: snap.epoch,
    };
  }

  /**
   * Replay the held events after `fromSeq`, then follow. The replayed events
   * go out before this call's answer. If they overflow the client's queue, the
   * answer is RPC_RESYNC and nothing streams (no silent gap): the client pages
   * with `events` and subscribes again from nearer the head.
   */
  private subscribe(conn: Conn, fromSeq: number): { ok: true } {
    conn.events?.dispose();
    conn.events = undefined;
    const overflowsBefore = conn.queue.overflows;
    conn.subscribing = true;
    try {
      const sub = this.opts.session.subscribe(fromSeq, (event) => this.sendEvent(conn, event));
      if (conn.queue.overflows !== overflowsBefore) {
        sub.dispose();
        throw new RpcFailure(RPC_RESYNC, 'the gap is too large to replay in one go; page it with `events`');
      }
      conn.events = sub;
    } catch (err) {
      if (err instanceof ResyncNeeded) throw new RpcFailure(RPC_RESYNC, err.message);
      throw err;
    } finally {
      conn.subscribing = false;
    }
    return { ok: true };
  }

  private sendEvent(conn: Conn, event: HostEvent): void {
    if (!conn.events && !conn.subscribing) return; // unsubscribed by an overflow; nothing until a new subscribe
    conn.lastSent = event.seq;
    conn.queue.push(encodeEvent(event), true);
  }

  /** One page of held events after `fromSeq`, cut at `maxBytes` (never above the page cap). */
  private events(fromSeq: number, maxBytes: number): EventsResult {
    const budget = Math.max(1, Math.min(maxBytes, MAX_PAGE_BYTES));
    let events: HostEvent[];
    try {
      events = this.opts.session.eventsSince(fromSeq);
    } catch (err) {
      if (err instanceof ResyncNeeded) throw new RpcFailure(RPC_RESYNC, err.message);
      throw err;
    }
    const page: HostEvent[] = [];
    let bytes = 0;
    for (const event of events) {
      const wire = wireEvent(event);
      const size = JSON.stringify(wire).length;
      // Always at least one, so a single event bigger than the budget still moves the cursor.
      if (page.length > 0 && bytes + size > budget) break;
      page.push(wire);
      bytes += size;
    }
    const nextSeq = page.length > 0 ? page[page.length - 1].seq : fromSeq;
    return { events: page, nextSeq, done: page.length === events.length };
  }
}

/**
 * An event as it goes on the wire: large images dropped (see `wire.ts`), and
 * anything still too big for a frame replaced by a stub that says so, rather
 * than a line the client must reject (and would then reconnect over forever).
 */
function wireEvent(event: HostEvent): HostEvent {
  if (event.type !== 'message') return event;
  const slim = { ...event, msg: slimForWire(event.msg) };
  const size = JSON.stringify(slim).length;
  return size <= MAX_FRAME_BYTES - FRAME_HEADROOM ? slim : stub(event, size);
}

/** The `event` notification line for one event, serialized once. */
function encodeEvent(event: HostEvent): string {
  const wire = event.type === 'message' ? { ...event, msg: slimForWire(event.msg) } : event;
  const line = `${JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { event: wire } })}\n`;
  if (line.length <= MAX_FRAME_BYTES - FRAME_HEADROOM) return line;
  return `${JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { event: stub(event, line.length) } })}\n`;
}

function stub(event: HostEvent, bytes: number): HostEvent {
  if (event.type !== 'message') return event;
  const m = event.msg as { type?: unknown; subtype?: unknown; uuid?: unknown };
  return { ...event, msg: { type: m.type, subtype: m.subtype, uuid: m.uuid, omitted: true, bytes } };
}

function num(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new RpcFailure(RPC_INVALID_PARAMS, `${name} must be a non-negative number`);
  return v;
}
