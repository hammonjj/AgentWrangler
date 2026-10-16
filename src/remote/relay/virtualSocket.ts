/**
 * One remote tab, as a socket `browserConnections` can attach (#173).
 *
 * `browserConnections` does the hard parts of a browser connection: handshake, acks,
 * exactly-once mutations, snapshot coalescing, backpressure and liveness. This gives it the
 * slice of a `ws` socket it uses (`ClientSocket`), and turns what it sends into relay items:
 *
 * - `send` queues a `data` item; everything queued within `batchMs` goes as one batch, so a
 *   burst of envelopes is one Broadcast (and one billed message) rather than many.
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

export interface RelaySocketOptions {
  /** Send one batch; resolves once it is handed to the relay. */
  send(items: RelayItem[]): Promise<void>;
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

  private schedule(): void {
    if (this.timer || this.sending) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushNow();
    }, this.opts.batchMs);
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
    this.opts
      .send(batch)
      .catch(() => this.end())
      .finally(() => {
        this.sending = false;
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
