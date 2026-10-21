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
 * settles, which keeps the parts of one batch together and in sequence (the codec refuses a part
 * that is not the next, and takes a batch's parts as contiguous). A queue that is one first-in
 * first-out line would make a click's reply wait behind a whole transcript, so (#193) the queue
 * has three lanes and the next batch is chosen from them:
 *
 * - `interactive`: replies to a command, prompts, navigation, acks, pongs. Sent at once, in a
 *   batch of their own, without waiting out the batch window.
 * - `live`: what a conversation streams as it happens (appends, patches). Batched by the window.
 * - `bulk`: a table snapshot, a conversation's opening, an archive page, assets. Cut into
 *   batches of at most `bulkBatchBytes`, each of which can be overtaken.
 *
 * What may not be overtaken is order within a *stream* (a pane): a table message that follows a
 * snapshot is sent after it, and a conversation's patch after its opening. An item with no
 * stream is ordered against everything, which is how `open`, `close` and anything unclassified
 * keep the order they always had. The worst a click waits for is the one batch already in
 * flight, and that is bounded by `bulkBatchBytes` and what one line is allowed to be.
 */
import type { ClientSocket, RelayLane, SendMeta } from '../../core/web/browserConnections';
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

/** What a batch was, for the diagnostics and the stress tests. */
export interface BatchInfo {
  lane: RelayLane | 'mixed';
  bytes: number;
}

export interface RelaySocketOptions {
  /** Send one batch; resolves once it is handed to the relay. `traced` is what a click is waiting on in it. */
  send(items: RelayItem[], traced: TracedItem[], info: BatchInfo): Promise<void>;
  /**
   * The socket ended, either way: leave the channel. `send-failed`: a batch could not be sent, so
   * the tab was not told, and will not know until its own checks find the silence.
   */
  onEnd(why: 'closed' | 'send-failed'): void;
  /** After `onEnd('closed')`: the batch carrying the `close` failed, so the tab was not told after all. */
  onUndelivered?(): void;
  batchMs: number;
  /** A bulk batch ends once it holds this many bytes (one item may pass it). Default 192 KB. */
  bulkBatchBytes?: number;
}

/** After this many batches in a row that were not bulk, a waiting bulk batch goes next. */
const BULK_EVERY = 8;
const DEFAULT_BULK_BATCH_BYTES = 192 * 1024;
/** Live and interactive items are small; one batch of them holds at most this much. */
const LIVE_BATCH_BYTES = 192 * 1024;

interface Entry {
  item: RelayItem;
  bytes: number;
  lane: RelayLane;
  /** `*`: ordered against every other item. */
  stream: string;
  traced?: { cid: string; at: number; depth: number; behind: boolean };
}

export class RelaySocket implements ClientSocket {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  private state = 1;
  private queue: Entry[] = [];
  private queuedBytes = 0;
  private flightBytes = 0;
  private sending = false;
  /** Closing: whatever is queued goes in one last batch, close last. */
  private closing = false;
  private notBulk = 0;
  /** When the last batch's send settled. */
  private settledAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The pending timer was set for an item that does not wait the window. */
  private timerUrgent = false;
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
    this.sendWith(data, {});
  }

  /** `send`, with where in the queue it goes (`SendMeta`) and, for a traced click, its id. */
  sendWith(data: string, meta: SendMeta): void {
    if (this.state !== this.OPEN) return;
    const entry: Entry = { item: { k: 'data', line: data }, bytes: data.length, lane: meta.lane ?? 'live', stream: meta.stream ?? '*' };
    if (meta.cid) entry.traced = { cid: meta.cid, at: Date.now(), depth: this.queue.length, behind: this.sending };
    this.push(entry);
  }

  ping(): void {
    if (this.state !== this.OPEN) return;
    this.push({ item: { k: 'ping' }, bytes: 8, lane: 'interactive', stream: 'ctl' });
  }

  close(code?: number, reason?: string): void {
    if (this.state !== this.OPEN) return;
    this.push({ item: { k: 'close', ...(code !== undefined ? { code } : {}), ...(reason ? { reason } : {}) }, bytes: 16, lane: 'interactive', stream: '*' });
    this.closing = true;
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
      else if (item.k === 'ping') this.push({ item: { k: 'pong' }, bytes: 8, lane: 'interactive', stream: 'ctl' });
      else if (item.k === 'pong') for (const l of [...this.pongListeners]) l();
      else if (item.k === 'close') this.end();
    }
  }

  /** Put an item first in line (the `open` that must precede everything the connection says). */
  sendFirst(item: RelayItem): void {
    this.queue.unshift({ item, bytes: 64, lane: 'interactive', stream: '*' });
    this.queuedBytes += 64;
    this.schedule();
  }

  /** Queue items the connection does not produce itself (assets): bulk, ordered only among themselves. */
  sendItems(items: RelayItem[], bytes: number): void {
    if (this.state !== this.OPEN) return;
    const each = Math.ceil(bytes / Math.max(1, items.length));
    for (const item of items) this.push({ item, bytes: each, lane: 'bulk', stream: 'assets' });
  }

  private push(entry: Entry): void {
    this.queue.push(entry);
    this.queuedBytes += entry.bytes;
    this.schedule();
  }

  /**
   * A link that has been quiet for `batchMs` sends on the next turn (so what one turn queues is
   * still one batch): waiting out the window there only delayed the answer to a click. Right
   * after a batch, it waits the window out, which is what caps a stream of patches. Only `live`
   * items are held to the window: an interactive reply goes when the batch in flight is done, and
   * bulk is already cut into batches, so it goes back to back.
   */
  private schedule(): void {
    if (this.sending) return;
    const urgent = this.queue.some((e) => e.lane !== 'live');
    // A reply that arrives while a live batch is waiting out the window does not wait with it.
    if (this.timer) {
      if (!urgent || this.timerUrgent) return;
      clearTimeout(this.timer);
    }
    this.timerUrgent = urgent;
    const wait = urgent ? 0 : Math.max(0, this.opts.batchMs - (Date.now() - this.settledAt));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushNow();
    }, wait);
  }

  /**
   * The next batch: interactive and live items first, in queue order, each only once nothing
   * earlier in its stream is left behind; bulk when there is nothing else, or every `BULK_EVERY`th
   * batch so a busy link cannot starve it.
   */
  private take(): { entries: Entry[]; lane: RelayLane | 'mixed' } {
    if (this.closing) return { entries: this.queue.splice(0), lane: 'mixed' };
    const bulkWaiting = this.queue.some((e) => e.lane === 'bulk');
    const bulkTurn = bulkWaiting && this.notBulk >= BULK_EVERY;
    const first = bulkTurn ? this.pick(['bulk'], this.opts.bulkBatchBytes ?? DEFAULT_BULK_BATCH_BYTES) : this.pick(['interactive', 'live'], LIVE_BATCH_BYTES);
    if (first.length > 0) {
      this.notBulk = bulkTurn ? 0 : this.notBulk + 1;
      return { entries: first, lane: bulkTurn ? 'bulk' : first.every((e) => e.lane === 'interactive') ? 'interactive' : 'live' };
    }
    const bulk = this.pick(['bulk'], this.opts.bulkBatchBytes ?? DEFAULT_BULK_BATCH_BYTES);
    this.notBulk = 0;
    return { entries: bulk, lane: 'bulk' };
  }

  /** Remove and return the entries of these lanes that are free to go, stopping at `cap` bytes (one is always taken). */
  private pick(lanes: RelayLane[], cap: number): Entry[] {
    const out: Entry[] = [];
    const taken = new Set<Entry>();
    const blocked = new Set<string>();
    let blockedAll = false;
    let left = 0;
    let bytes = 0;
    for (const e of this.queue) {
      const free = e.stream === '*' ? left === 0 : !blockedAll && !blocked.has(e.stream);
      if (free && lanes.includes(e.lane) && (out.length === 0 || bytes + e.bytes <= cap)) {
        out.push(e);
        taken.add(e);
        bytes += e.bytes;
        continue;
      }
      left++;
      blocked.add(e.stream);
      if (e.stream === '*') blockedAll = true;
    }
    if (out.length > 0) this.queue = this.queue.filter((e) => !taken.has(e));
    return out;
  }

  private flushNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.sending || this.queue.length === 0) return;
    const { entries, lane } = this.take();
    if (entries.length === 0) return;
    const bytes = entries.reduce((n, e) => n + e.bytes, 0);
    this.queuedBytes = Math.max(0, this.queuedBytes - bytes);
    this.flightBytes = bytes;
    this.sending = true;
    const at = Date.now();
    const traced = entries.flatMap((e) => (e.traced ? [{ cid: e.traced.cid, queuedMs: at - e.traced.at, queueDepth: e.traced.depth, behindBatch: e.traced.behind }] : []));
    this.opts
      .send(
        entries.map((e) => e.item),
        traced,
        { lane, bytes },
      )
      .catch(() => {
        // A part that failed leaves the sequence broken: nothing queued behind it can be opened
        // by the tab, so none of it is sent. The tab reconnects and resends its unacknowledged commands.
        this.queue = [];
        this.queuedBytes = 0;
        // Already ended by a close whose last batch this was: the `close` did not reach the tab either.
        if (this.state !== this.OPEN) this.opts.onUndelivered?.();
        else this.end('send-failed');
      })
      .finally(() => {
        this.sending = false;
        this.settledAt = Date.now();
        this.flightBytes = 0;
        if (this.queue.length > 0) this.schedule();
      });
  }

  private end(why: 'closed' | 'send-failed' = 'closed'): void {
    if (this.state !== this.OPEN) return;
    this.state = this.CLOSED;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const l of [...this.closeListeners]) l();
    this.opts.onEnd(why);
  }
}
