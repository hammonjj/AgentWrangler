/**
 * One side of an NDJSON JSON-RPC conversation: one JSON object per line,
 * requests with an `id`, notifications without.
 *
 * Transport-free on purpose. The owner feeds it whatever bytes arrive
 * (`feed`) and gives it a way to write one line (`write`), so the same codec
 * serves a Unix socket (a session host and the core's client for it) and a
 * test's in-memory pipe. Written for Stage 3 of the session-lifecycle plan;
 * Codex's client has its own message transports (`CodexAppServer`).
 *
 * Framing: a line longer than `maxLineBytes` is rejected whole and reported,
 * never partially applied (§9.2). A line that is not JSON is logged and dropped.
 */
import { Emitter, type Disposable } from '../events';

export const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** A request the other side answered with an error. */
export class RpcRemoteError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface IncomingRequest {
  id: number | string;
  method: string;
  params?: any;
}

export interface IncomingNotification {
  method: string;
  params?: any;
}

export interface NdjsonPeerOptions {
  /** Write one complete line, newline included. May throw if the transport is gone. */
  write: (line: string) => void;
  log?: (message: string) => void;
  /** Default 16 MiB. `Number.POSITIVE_INFINITY` for no limit (a trusted child's stdio). */
  maxLineBytes?: number;
  /** A line over the limit arrived. The owner usually drops the connection. */
  onOversize?: () => void;
  /** Stamp outgoing messages with `"jsonrpc": "2.0"`. Codex's app-server does not use it. */
  jsonrpc?: boolean;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

export class NdjsonPeer implements Disposable {
  private nextId = 1;
  private pending = new Map<string, Pending>();
  /** The pieces of a line still waiting for its newline. */
  private parts: Buffer[] = [];
  private partLen = 0;
  /** Inside a line already rejected as too long, until its newline. */
  private discarding = false;
  private closed?: Error;
  private readonly maxLineBytes: number;
  private readonly requests = new Emitter<IncomingRequest>();
  private readonly notifications = new Emitter<IncomingNotification>();

  constructor(private opts: NdjsonPeerOptions) {
    this.maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  readonly onRequest = (listener: (req: IncomingRequest) => void): Disposable => this.requests.event(listener);
  readonly onNotification = (listener: (n: IncomingNotification) => void): Disposable =>
    this.notifications.event(listener);

  /**
   * Hand the peer bytes as they arrive. Complete lines are dispatched; a
   * partial one waits. Only the new chunk is searched for a newline, and a
   * partial line's pieces are joined once, when it completes: a 16 MiB frame
   * arriving in 64 KiB chunks costs one copy, not hundreds.
   */
  feed(chunk: Buffer | string): void {
    const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    let start = 0;
    for (;;) {
      const nl = data.indexOf(0x0a, start);
      if (nl === -1) {
        const rest = data.subarray(start);
        if (this.discarding || rest.length === 0) return;
        if (this.partLen + rest.length > this.maxLineBytes) {
          // Too long already: drop what is held, and the rest of the line when it comes.
          this.parts = [];
          this.partLen = 0;
          this.discarding = true;
          this.oversize();
          return;
        }
        this.parts.push(rest);
        this.partLen += rest.length;
        return;
      }
      const piece = data.subarray(start, nl);
      start = nl + 1;
      if (this.discarding) {
        this.discarding = false;
        continue;
      }
      const len = this.partLen + piece.length;
      let line = piece;
      if (this.parts.length > 0) {
        this.parts.push(piece);
        line = Buffer.concat(this.parts, len);
        this.parts = [];
        this.partLen = 0;
      }
      if (len > this.maxLineBytes) {
        this.oversize();
        continue;
      }
      if (len === 0) continue;
      this.receive(line.toString('utf8'));
    }
  }

  /** Send a request and wait for its answer. Rejects if the peer closes first, or after `timeoutMs`. */
  request<T = unknown>(method: string, params?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (v: unknown) => void, reject };
      if (opts.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          if (!this.pending.delete(String(id))) return;
          reject(new Error(`${method} timed out after ${opts.timeoutMs} ms`));
        }, opts.timeoutMs);
      }
      this.pending.set(String(id), entry);
      try {
        this.send({ method, id, ...(params === undefined ? {} : { params }) });
      } catch (err) {
        this.pending.delete(String(id));
        if (entry.timer) clearTimeout(entry.timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.send({ method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: number | string, result?: unknown): void {
    if (this.closed) return;
    this.send({ id, result: result ?? {} });
  }

  respondError(id: number | string, error: RpcErrorObject): void {
    if (this.closed) return;
    this.send({ id, error });
  }

  /** Stop: every pending request is rejected with `reason`, and nothing more is sent. */
  close(reason: Error = new Error('connection closed')): void {
    if (this.closed) return;
    this.closed = reason;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
  }

  get isClosed(): boolean {
    return this.closed !== undefined;
  }

  dispose(): void {
    this.close(new Error('disposed'));
    this.requests.dispose();
    this.notifications.dispose();
  }

  private send(message: Record<string, unknown>): void {
    const body = this.opts.jsonrpc ? { jsonrpc: '2.0', ...message } : message;
    this.opts.write(`${JSON.stringify(body)}\n`);
  }

  private oversize(): void {
    this.opts.log?.(`rejected a line over ${this.maxLineBytes} bytes`);
    this.opts.onOversize?.();
  }

  private receive(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      this.opts.log?.(`invalid JSON: ${line.slice(0, 200)}`);
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.id !== undefined && message.id !== null && typeof message.method === 'string') {
      this.requests.fire({ id: message.id, method: message.method, params: message.params });
      return;
    }
    if (message.id !== undefined && message.id !== null) {
      const key = String(message.id);
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) {
        const e = message.error as Partial<RpcErrorObject>;
        pending.reject(new RpcRemoteError(typeof e.code === 'number' ? e.code : -32603, e.message ?? 'request failed', e.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === 'string') this.notifications.fire({ method: message.method, params: message.params });
  }
}
