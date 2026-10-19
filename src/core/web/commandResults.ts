/**
 * Exactly-once for a browser's mutating messages (#128, plan §7.2 "Acks").
 *
 * A phone on flaky Wi-Fi sends `send`, the socket dies, and it cannot know
 * whether the message arrived. It sends it again on the new connection, with
 * the same client-generated `commandId`. This remembers, per device, every
 * mutating command it has let through for ten minutes, so the second copy is
 * not acted on: it gets the first one's result instead.
 *
 * "Result" is the reply that names the request (`sendResult`, `missionAck`,
 * `missionError`, by `requestId`). A command without one, or whose reply has
 * not been posted yet, is simply not run again; a reply that turns up later
 * is passed on to every connection that asked again in the meantime.
 *
 * Per device rather than per connection, because the resend arrives on a new
 * connection; and not per principal, because two tabs never share ids.
 */

/** Replies that carry the outcome of the request they name. */
const RESULT_TYPES: ReadonlySet<string> = new Set(['sendResult', 'missionAck', 'missionError']);

export const COMMAND_RESULT_TTL_MS = 10 * 60_000;
/** Per device. A tab sends a handful of mutations a minute; this is hours of them. */
export const COMMAND_RESULT_MAX = 512;
/** Devices remembered at once; the least recently active is forgotten first. */
const MAX_DEVICES = 64;

type Post = (envelope: unknown) => void;

interface Entry {
  at: number;
  /** The reply that answered it, once posted. */
  result?: unknown;
  /** Connections that resent it before the reply was posted. */
  waiters: Post[];
}

interface DeviceCache {
  /** By commandId, oldest first (insertion order). */
  entries: Map<string, Entry>;
}

export interface CommandResultsOptions {
  ttlMs?: number;
  maxPerDevice?: number;
  now?: () => number;
}

/** What one connection uses: `admit` on the way in, `observe` on the way out. */
export interface CommandTracker {
  /**
   * A mutating envelope arrived. True: act on it (first sight). False: it is
   * a resend: the first result has been (or will be) posted through `post`.
   */
  admit(commandId: string, pane: string, body: unknown, post: Post): boolean;
  /** Every envelope this connection posts, before it is sent, sent or not. */
  observe(envelope: unknown): void;
}

export class CommandResults {
  private readonly devices = new Map<string, DeviceCache>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(opts: CommandResultsOptions = {}) {
    this.ttlMs = opts.ttlMs ?? COMMAND_RESULT_TTL_MS;
    this.max = opts.maxPerDevice ?? COMMAND_RESULT_MAX;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * A tracker for one connection of `deviceId`. Replies are matched to
   * commands on the connection that ran them, by `requestId`, so two tabs
   * reusing a request id cannot answer each other's resends.
   */
  connection(deviceId: string): CommandTracker {
    /** `pane \0 requestId` → the entry its reply belongs to. */
    const awaiting = new Map<string, Entry>();
    return {
      admit: (commandId, pane, body, post) => {
        const cache = this.device(deviceId);
        const known = cache.entries.get(commandId);
        if (known && this.now() - known.at < this.ttlMs) {
          if (known.result !== undefined) post(known.result);
          else known.waiters.push(post);
          return false;
        }
        const entry: Entry = { at: this.now(), waiters: [] };
        cache.entries.delete(commandId);
        cache.entries.set(commandId, entry);
        this.trim(cache);
        const requestId = requestIdOf(body);
        if (requestId !== undefined) awaiting.set(`${pane}\0${requestId}`, entry);
        return true;
      },
      observe: (envelope) => {
        if (awaiting.size === 0 || !envelope || typeof envelope !== 'object') return;
        const { pane, body } = envelope as { pane?: unknown; body?: unknown };
        const type = (body as { type?: unknown } | undefined)?.type;
        if (typeof pane !== 'string' || typeof type !== 'string' || !RESULT_TYPES.has(type)) return;
        const requestId = requestIdOf(body);
        if (requestId === undefined) return;
        const key = `${pane}\0${requestId}`;
        const entry = awaiting.get(key);
        if (!entry) return;
        awaiting.delete(key);
        entry.result = envelope;
        for (const post of entry.waiters.splice(0)) post(envelope);
      },
    };
  }

  /** Commands remembered for a device (tests). */
  size(deviceId: string): number {
    return this.devices.get(deviceId)?.entries.size ?? 0;
  }

  private device(id: string): DeviceCache {
    let cache = this.devices.get(id);
    if (cache) {
      // Most recently active last, so the eviction below takes the stalest.
      this.devices.delete(id);
    } else {
      cache = { entries: new Map() };
    }
    this.devices.set(id, cache);
    while (this.devices.size > MAX_DEVICES) {
      const oldest = this.devices.keys().next().value as string;
      this.devices.delete(oldest);
    }
    return cache;
  }

  private trim(cache: DeviceCache): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, entry] of cache.entries) {
      if (cache.entries.size <= this.max && entry.at >= cutoff) break;
      cache.entries.delete(id);
    }
  }
}

function requestIdOf(body: unknown): string | undefined {
  const id = (body as { requestId?: unknown } | undefined)?.requestId;
  return typeof id === 'string' && id ? id : undefined;
}
