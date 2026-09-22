/**
 * Discord's REST API, with the two things that actually bite: rate limits, and
 * a token that must never reach a log.
 *
 * Requests are serialised through one queue. Everything this feature sends goes
 * to a single channel, so there is no parallelism to win — and a queue makes
 * ordering explicit, which matters for the one case where it does:
 * **edits outrank publishes**. A stale button is worse than a late
 * notification, so when a burst of prompts is queued and one of them resolves,
 * the edit that removes its buttons goes first.
 *
 * `fetch` and `sleep` are injected so the whole thing runs under vitest against
 * a scripted transcript, with no network and no real waiting.
 */

/** Higher runs first. Same priority falls back to submission order. */
export const PRIORITY = { close: 30, update: 20, publish: 10, reply: 5 } as const;

export interface DiscordRestDeps {
  /** Read lazily: the token may be connected, cleared and reconnected at runtime. */
  token: () => string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

export interface RequestOptions {
  priority?: number;
  /** Route to rate-limit against. Defaults to the path, minus ids. */
  bucket?: string;
}

export class DiscordHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'DiscordHttpError';
  }
  /** The message is gone for good — nothing to retry, nothing to edit. */
  get isUnknownMessage(): boolean {
    return this.status === 404 || this.code === 10008;
  }
  /** The bot cannot see or post in the channel. Configuration, not weather. */
  get isForbidden(): boolean {
    return this.status === 403;
  }
}

const API = 'https://discord.com/api/v10';
/** 429s and 5xx are retried this many times before giving up. */
const MAX_ATTEMPTS = 4;

interface QueueItem {
  priority: number;
  seq: number;
  run: () => Promise<void>;
}

export class DiscordRest {
  private queue: QueueItem[] = [];
  private draining = false;
  private seq = 0;
  /** When the global limit lifts; 0 when it is not in force. */
  private globalResetAtMs = 0;
  /** Per-bucket reset times, from `X-RateLimit-Remaining`/`Reset-After`. */
  private buckets = new Map<string, number>();

  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  private log: (message: string) => void;

  constructor(private deps: DiscordRestDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? (() => undefined);
  }

  request<T = unknown>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        priority: opts.priority ?? PRIORITY.publish,
        seq: this.seq++,
        run: async () => {
          try {
            resolve(await this.send<T>(method, path, body, opts.bucket ?? bucketOf(path)));
          } catch (err) {
            reject(err);
          }
        },
      });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        // Re-sorted each time, so an edit queued behind ten publishes still
        // goes next rather than after them.
        this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
        const item = this.queue.shift();
        if (item) await item.run();
      }
    } finally {
      this.draining = false;
    }
  }

  private async send<T>(method: string, path: string, body: unknown, bucket: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      await this.waitForLimits(bucket);

      let res: Response;
      try {
        res = await this.fetchImpl(`${API}${path}`, {
          method,
          headers: {
            Authorization: `Bot ${this.deps.token()}`,
            'Content-Type': 'application/json',
            'User-Agent': 'AgentWrangler (https://github.com/hammonjj/AgentWrangler, 0.0.1)',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        // Offline, DNS, TLS. Worth one or two retries; the caller treats a
        // final failure as "not published", which is safe.
        if (attempt >= MAX_ATTEMPTS) throw new Error(`discord ${method} ${bucket} failed: ${scrub(String(err))}`);
        await this.sleep(backoffMs(attempt));
        continue;
      }

      this.noteLimits(bucket, res);

      if (res.status === 429) {
        const retryAfterMs = await this.retryAfterMs(res);
        if (attempt >= MAX_ATTEMPTS) throw new DiscordHttpError(429, undefined, 'rate limited, gave up');
        this.log(`rate limited on ${bucket}, waiting ${retryAfterMs}ms`);
        await this.sleep(retryAfterMs);
        continue;
      }

      if (res.status >= 500) {
        if (attempt >= MAX_ATTEMPTS) throw new DiscordHttpError(res.status, undefined, `discord ${res.status}`);
        await this.sleep(backoffMs(attempt));
        continue;
      }

      if (!res.ok) {
        const parsed = await readJson(res);
        const code = typeof (parsed as { code?: number })?.code === 'number' ? (parsed as { code: number }).code : undefined;
        const message = typeof (parsed as { message?: string })?.message === 'string' ? (parsed as { message: string }).message : res.statusText;
        // `scrub` because a 401 body can echo request context.
        throw new DiscordHttpError(res.status, code, scrub(`discord ${method} ${bucket}: ${res.status} ${message}`));
      }

      return (await readJson(res)) as T;
    }
  }

  private async waitForLimits(bucket: string): Promise<void> {
    const until = Math.max(this.globalResetAtMs, this.buckets.get(bucket) ?? 0);
    const waitMs = until - this.now();
    if (waitMs > 0) await this.sleep(waitMs);
  }

  private noteLimits(bucket: string, res: Response): void {
    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    const resetAfter = Number(res.headers.get('x-ratelimit-reset-after'));
    if (Number.isFinite(remaining) && remaining <= 0 && Number.isFinite(resetAfter)) {
      this.buckets.set(bucket, this.now() + resetAfter * 1000);
    }
  }

  private async retryAfterMs(res: Response): Promise<number> {
    // Explicitly against null: `Number(null)` is 0, not NaN, so testing the
    // parsed value alone would read a missing header as "retry immediately"
    // and burn the attempt budget against a limit that is still in force.
    const header = res.headers.get('retry-after');
    let seconds = header === null ? NaN : Number(header);
    if (!Number.isFinite(seconds)) {
      const body = (await readJson(res)) as { retry_after?: number } | undefined;
      seconds = typeof body?.retry_after === 'number' ? body.retry_after : 1;
    }
    const ms = Math.max(0, seconds * 1000) + 100; // a beat past, to avoid a second 429
    if (res.headers.get('x-ratelimit-global') === 'true') this.globalResetAtMs = this.now() + ms;
    return ms;
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Discord's major parameters are channel, guild and webhook id; everything else
 * collapses so `/channels/123/messages/456` and `/channels/123/messages/789`
 * share a limit, as they do server-side.
 */
export function bucketOf(path: string): string {
  // The major parameter is held out of the collapse, then put back: without
  // that it is a snowflake like any other and two channels would share one
  // limit, so a busy channel would throttle a quiet one.
  const major = /^\/(channels|guilds|webhooks)\/(\d+)/.exec(path);
  const tail = major ? path.slice(major[0].length) : path;
  const collapsed = tail.replace(/\/\d{15,}/g, '/:id').replace(/\/[A-Za-z0-9_.-]{40,}/g, '/:token');
  return major ? `/${major[1]}/${major[2]}${collapsed}` : collapsed;
}

function backoffMs(attempt: number): number {
  return Math.min(8000, 250 * 2 ** (attempt - 1));
}

/**
 * Remove anything token-shaped from text that is about to be thrown or logged.
 * An error string is the one place a credential leaks by accident.
 */
export function scrub(text: string): string {
  return text
    .replace(/Bot\s+\S+/gi, 'Bot ‹redacted›')
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}/g, '‹redacted›');
}
