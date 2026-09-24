/**
 * One client's outbound queue: bounded by bytes, never blocking the host.
 *
 * The host drains the SDK at full speed always, or `claude`'s stdout pipe fills
 * and the agent stalls (playbook §9.7). So a slow or stuck client cannot be
 * waited for. Events queue up to a byte budget (4 MiB); past it the queued
 * events are dropped and the client is told to `resync` (snapshot, then page
 * `messages`). Replies to its requests are never dropped: it is waiting on them.
 */

export interface Writable {
  write(chunk: Buffer): boolean;
  once(event: 'drain', listener: () => void): unknown;
}

export const DEFAULT_QUEUE_BYTES = 4 * 1024 * 1024;

interface Item {
  buf: Buffer;
  droppable: boolean;
}

export class OutQueue {
  private items: Item[] = [];
  private bytes = 0;
  private blocked = false;
  overflows = 0;

  constructor(
    private sink: Writable,
    private maxBytes: number = DEFAULT_QUEUE_BYTES,
    private onOverflow: () => void = () => undefined,
  ) {}

  /** Queued and not yet handed to the socket. */
  get queuedBytes(): number {
    return this.bytes;
  }

  get idle(): boolean {
    return this.items.length === 0 && !this.blocked;
  }

  /** Queue one line. `droppable` for events, not for replies. */
  push(line: string, droppable: boolean): void {
    const buf = Buffer.from(line, 'utf8');
    if (droppable && this.bytes + buf.length > this.maxBytes) {
      this.overflow();
      return;
    }
    this.items.push({ buf, droppable });
    this.bytes += buf.length;
    this.flush();
  }

  private overflow(): void {
    this.overflows++;
    this.items = this.items.filter((i) => !i.droppable);
    this.bytes = this.items.reduce((n, i) => n + i.buf.length, 0);
    this.onOverflow();
  }

  private flush(): void {
    while (!this.blocked && this.items.length > 0) {
      const item = this.items.shift()!;
      this.bytes -= item.buf.length;
      // `false` means the socket buffered it and wants us to wait: the item is
      // on its way, but nothing more goes until it drains.
      if (!this.sink.write(item.buf)) {
        this.blocked = true;
        this.sink.once('drain', () => {
          this.blocked = false;
          this.flush();
        });
      }
    }
  }
}
