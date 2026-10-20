/**
 * One remote tab, as a socket `browserConnections` can attach (#173).
 *
 * `browserConnections` does the hard parts of a browser connection: handshake, acks,
 * exactly-once mutations, snapshot coalescing, backpressure and liveness. This gives it the
 * slice of a `ws` socket it uses (`ClientSocket`), and turns what it sends into relay items:
 *
 * - `send` queues a `data` item; everything queued within `batchMs` goes as one batch, so a
 *   burst of envelopes is one Broadcast (and one billed message) rather than many. On a link
 *   that was quiet, the first one goes at once.
 * - `ping` queues a `ping`; the loader answers `pong`, which is reported as the socket's pong.
 * - `close` and `terminate` both send a `close` and end the socket: the tab cannot see the
 *   channel go away.
 * - `bufferedAmount` is what is queued plus what is on its way, so the backpressure ceiling
 *   still closes a connection whose phone stopped reading.
 *
 * Only one batch is in flight at a time: the next is sent when the previous one's send
 * settles, which keeps the parts of one batch together and in sequence.
 */
import type { ClientSocket } from '../../core/web/browserConnections';
import type { RelayItem } from '../../shared/relay';

type MessageListener = (data: Buffer, isBinary: boolean) => void;

/** A traced item (#190) in a batch: what the click waiting on it saw of the queue. */
export interface TracedItem {
  cid: string;
  /** How long it sat before its batch was taken. */
  queuedMs: number;
  /** Items ahead of it when it was queued. */
  queueDepth: number;
  /** A batch was in flight when it was queued. */
  behindBatch: boolean;
}

export interface RelaySocketOptions {
  /** Send one batch; resolves once it is handed to the relay. `traced` is what a click is waiting on in it. */
  send(items: RelayItem[], traced: TracedItem[]): Promise<void>;
  /** The socket ended, either way: leave the channel. */
  onEnd(): void;
  batchMs: number;
}

export class RelaySocket implements ClientSocket {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  private state = 1;
  private queue: RelayItem[] = [];
  private queuedBytes = 0;
  private flightBytes = 0;
  private sending = false;
  private traced: { cid: string; at: number; depth: number; behind: boolean }[] = [];
  /** When the last batch's send settled. */
  private settledAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly messageListeners: MessageListener[] = [];
  private readonly pongListeners: (() => void)[] = [];
  private readonly closeListeners: (() => void)[] = [];

  constructor(private readonly opts: RelaySocketOptions) {}

  get readyState(): number {
    return this.state;
  }

  get bufferedAmount(): number {
    return this.queuedBytes + this.flightBytes;
  }

  send(data: string): void {
    if (this.state !== this.OPEN) return;
    this.push({ k: 'data', line: data }, data.length);
  }

  /** `send`, remembering when it was queued so its batch can say how long it waited. */
  sendTraced(data: string, cid: string): void {
    if (this.state !== this.OPEN) return;
    this.traced.push({ cid, at: Date.now(), depth: this.queue.length, behind: this.sending });
    this.push({ k: 'data', line: data }, data.length);
  }

  ping(): void {
    if (this.state !== this.OPEN) return;
    this.push({ k: 'ping' }, 8);
  }

  close(code?: number, reason?: string): void {
    if (this.state !== this.OPEN) return;
    this.push({ k: 'close', ...(code !== undefined ? { code } : {}), ...(reason ? { reason } : {}) }, 16);
    this.flushNow();
    this.end();
  }

  /**
   * Unlike a TCP socket, ending here does not reach the tab: its channel stays subscribed and
   * it would go on sending into nothing. So the tab is told, as for a close; if it cannot hear
   * it, its own silence check ends it (`relayLoader/connection.ts`).
   */
  terminate(): void {
    this.close(4408, 'dropped');
  }

  on(event: 'message', listener: MessageListener): this;
  on(event: 'pong' | 'close' | 'error', listener: () => void): this;
  on(event: string, listener: MessageListener | (() => void)): this {
    if (event === 'message') this.messageListeners.push(listener as MessageListener);
    else if (event === 'pong') this.pongListeners.push(listener as () => void);
    else if (event === 'close') this.closeListeners.push(listener as () => void);
    return this;
  }

  /**
   * Items from the remote tab. `data` is delivered as a text message; `ping` is answered;
   * `close` ends the socket. Anything else is not for a socket and is ignored.
   */
  receive(items: RelayItem[]): void {
    for (const item of items) {
      if (this.state !== this.OPEN) return;
      if (item.k === 'data') for (const l of [...this.messageListeners]) l(Buffer.from(item.line, 'utf8'), false);
      else if (item.k === 'ping') this.push({ k: 'pong' }, 8);
      else if (item.k === 'pong') for (const l of [...this.pongListeners]) l();
      else if (item.k === 'close') this.end();
    }
  }

  /** Put an item first in line (the `open` that must precede everything the connection says). */
  sendFirst(item: RelayItem): void {
    this.queue.unshift(item);
    this.queuedBytes += 64;
    this.schedule();
  }

  /** Queue items the connection does not produce itself (assets). */
  sendItems(items: RelayItem[], bytes: number): void {
    if (this.state !== this.OPEN) return;
    this.queue.push(...items);
    this.queuedBytes += bytes;
    this.schedule();
  }

  private push(item: RelayItem, bytes: number): void {
    this.queue.push(item);
    this.queuedBytes += bytes;
    this.schedule();
  }

  /**
   * A link that has been quiet for `batchMs` sends on the next turn (so what one turn queues is
   * still one batch): waiting out the window there only delayed the answer to a click. Right
   * after a batch, it waits the window out, which is what caps a stream of patches.
   */
  private schedule(): void {
    if (this.timer || this.sending) return;
    const wait = Math.max(0, this.opts.batchMs - (Date.now() - this.settledAt));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushNow();
    }, wait);
  }

  private flushNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.sending || this.queue.length === 0) return;
    const batch = this.queue;
    this.flightBytes = this.queuedBytes;
    this.queue = [];
    this.queuedBytes = 0;
    this.sending = true;
    const at = Date.now();
    const traced = this.traced.map((t) => ({ cid: t.cid, queuedMs: at - t.at, queueDepth: t.depth, behindBatch: t.behind }));
    this.traced = [];
    this.opts
      .send(batch, traced)
      .catch(() => this.end())
      .finally(() => {
        this.sending = false;
        this.settledAt = Date.now();
        this.flightBytes = 0;
        if (this.queue.length > 0) this.schedule();
      });
  }

  private end(): void {
    if (this.state !== this.OPEN) return;
    this.state = this.CLOSED;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const l of [...this.closeListeners]) l();
    this.opts.onEnd();
  }
}
