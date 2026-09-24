/**
 * A numbered, bounded event log with replay.
 *
 * Every event gets the next `seq`. The log keeps recent events so a subscriber
 * can join at any `seq` it has seen and be replayed only what it missed, then
 * follow live — the "subscribe from seq" half of the session protocol
 * (`docs/plans/session-lifecycle-architecture.md` §9.4, §9.7).
 *
 * Bounded by an estimated byte size, not a count: one image message can outweigh
 * ten thousand stream deltas. A `fromSeq` is too old only once the log has
 * actually evicted past it (`evictedThrough`). "Older than the oldest entry
 * held" is not the test, because early on nothing has been evicted, the log
 * just has not produced that much yet (spike S3 hit exactly that false resync).
 */
import type { Disposable } from '../events';

/** Thrown by `subscribe` when the events after `fromSeq` are no longer held. */
export class ResyncNeeded extends Error {
  constructor(
    readonly fromSeq: number,
    readonly evictedThrough: number,
  ) {
    super(`events after seq ${fromSeq} were evicted (through ${evictedThrough}); take a snapshot`);
  }
}

export interface SeqLogOptions {
  /** Estimated bytes to keep. Default 16 MiB, the playbook's ring size. */
  maxBytes?: number;
  /** How to estimate an event's size. Default: its JSON length. */
  sizeOf?: (event: unknown) => number;
  /** Where listener failures are reported. They never break the log. */
  onListenerError?: (err: unknown) => void;
}

/** `T` without its `seq`, distributed over a union so each variant keeps its own fields. */
export type WithoutSeq<T> = T extends unknown ? Omit<T, 'seq'> : never;

interface Entry<T> {
  event: T;
  bytes: number;
}

export class SeqLog<T extends { seq: number }> {
  private entries: Entry<T>[] = [];
  private bytes = 0;
  private lastSeq = 0;
  /** Highest seq no longer held. 0 = nothing evicted yet. */
  private evicted = 0;
  private listeners = new Set<(event: T) => void>();
  /** Events numbered but not yet handed out; see `push`. */
  private outbox: T[] = [];
  private delivering = false;
  /** Highest seq handed (or being handed) to listeners. A new subscriber's backlog stops here. */
  private handedOut = 0;
  private readonly maxBytes: number;
  private readonly sizeOf: (event: unknown) => number;

  constructor(private opts: SeqLogOptions = {}) {
    this.maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
    this.sizeOf = opts.sizeOf ?? defaultSize;
  }

  /** The seq of the newest event, 0 before the first. */
  get seq(): number {
    return this.lastSeq;
  }

  get evictedThrough(): number {
    return this.evicted;
  }

  /**
   * Number and append an event, keep it, and hand it to every subscriber.
   * `numbered` runs before any listener sees the event, which is where an
   * owner folds it into state its listeners may read.
   */
  push(body: WithoutSeq<T>, numbered?: (event: T) => void): T {
    const event = { ...body, seq: ++this.lastSeq } as unknown as T;
    numbered?.(event);
    const bytes = this.sizeOf(event);
    this.entries.push({ event, bytes });
    this.bytes += bytes;
    // Always keep the newest event, however large, so a subscriber that is
    // exactly caught up can still be handed it.
    while (this.bytes > this.maxBytes && this.entries.length > 1) {
      const dropped = this.entries.shift()!;
      this.bytes -= dropped.bytes;
      this.evicted = dropped.event.seq;
    }
    // A listener may push in turn (an event handler that sends a message).
    // Deliver strictly in seq order anyway: queue, and let the outermost call
    // drain, so no listener ever sees N+1 before N.
    this.outbox.push(event);
    if (!this.delivering) {
      this.delivering = true;
      try {
        while (this.outbox.length > 0) {
          const next = this.outbox.shift()!;
          this.handedOut = next.seq;
          for (const listener of [...this.listeners]) {
            try {
              listener(next);
            } catch (err) {
              this.opts.onListenerError?.(err);
            }
          }
        }
      } finally {
        this.delivering = false;
      }
    }
    return event;
  }

  /**
   * Held events with `seq > fromSeq`. Throws `ResyncNeeded` if some were
   * evicted, or if `fromSeq` is ahead of this log (the client's seq came from
   * an earlier instance, such as a restarted host).
   */
  since(fromSeq: number): T[] {
    if (fromSeq < this.evicted || fromSeq > this.lastSeq) throw new ResyncNeeded(fromSeq, this.evicted);
    return this.entries.filter((e) => e.event.seq > fromSeq).map((e) => e.event);
  }

  /**
   * Replay everything after `fromSeq`, synchronously, then follow live events.
   * Throws `ResyncNeeded` (before calling the listener at all) when the gap is
   * no longer held; the caller then takes a snapshot and subscribes from its seq.
   */
  subscribe(fromSeq: number, listener: (event: T) => void): Disposable {
    // Events still queued for delivery reach the new listener through the
    // queue; replaying them here too would hand them over twice.
    const backlog = this.since(fromSeq).filter((e) => e.seq <= this.handedOut);
    for (const event of backlog) {
      try {
        listener(event);
      } catch (err) {
        this.opts.onListenerError?.(err);
      }
    }
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  dispose(): void {
    this.listeners.clear();
  }
}

/**
 * A cheap size estimate: string lengths plus a little per value, without
 * serializing anything. Close enough to bound a ring; it runs on every stream
 * delta, where a `JSON.stringify` of a long capped block would not be free.
 */
function defaultSize(event: unknown): number {
  return roughSize(event, 0);
}

function roughSize(value: unknown, depth: number): number {
  if (typeof value === 'string') return value.length + 2;
  if (value === null || typeof value !== 'object') return 8;
  if (depth > 8) return 64;
  let size = 2;
  if (Array.isArray(value)) {
    for (const item of value) size += roughSize(item, depth + 1) + 1;
    return size;
  }
  for (const key in value as Record<string, unknown>) {
    size += key.length + 4 + roughSize((value as Record<string, unknown>)[key], depth + 1);
  }
  return size;
}
