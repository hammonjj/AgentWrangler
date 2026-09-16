import type { UsageError, UsageSnapshot, UsageState } from '../shared/usage';
import { maxUsagePercent, usageIntervalSeconds } from './autoPause';
import type { ConfigGetter } from './config';
import { Emitter, type Disposable, type Listener } from './events';
import type { UsageCache } from './usageCache';

export type UsageReader = (nowMs: number) => Promise<
  { ok: true; snapshot: UsageSnapshot } | { ok: false; error: UsageError }
>;

/** After a failure, wait this many times the normal interval before the next try (capped). */
const BACKOFF_STEPS = [1, 2, 4, 8];
/** Floor on the wait after a 429, whatever the interval is. The server said stop; mean it. */
const RATE_LIMIT_MIN_WAIT_MS = 5 * 60_000;
/** Spread simultaneous windows out so one of them reads and the rest find its result in the cache. */
const JITTER_MAX_MS = 4_000;

export interface UsageServiceOptions {
  /** Random delay before an uncached read; injectable so tests are deterministic. */
  jitter?: () => Promise<void>;
}

/**
 * Keeps the plan-usage numbers the dashboard cards show.
 *
 * Reads go through a cache shared by every window (see `UsageCache`): a tick
 * first looks there, and only asks Claude when nothing fresher than the poll
 * interval exists. The last good read stays up through a failed refresh and
 * the service simply tries again later (backing off), because a number from
 * ten minutes ago beats a blank when the question is "am I about to hit the
 * weekly limit". The error rides along in the state for the tooltip and log.
 */
export class UsageService implements Disposable {
  private state: UsageState = {};
  private emitter = new Emitter<void>();
  private timer?: NodeJS.Timeout;
  private failures = 0;
  private inFlight = false;
  private disposed = false;
  private jitter: () => Promise<void>;

  constructor(
    private read: UsageReader,
    private cache: UsageCache,
    private getConfig: ConfigGetter,
    private log: (msg: string) => void = () => undefined,
    opts: UsageServiceOptions = {},
  ) {
    this.jitter = opts.jitter ?? (() => new Promise((r) => setTimeout(r, Math.random() * JITTER_MAX_MS)));
  }

  readonly onDidChange = (listener: Listener<void>): Disposable => this.emitter.event(listener);

  get usage(): UsageState {
    return this.state;
  }

  /** Whether the dashboard should render the cards. */
  get enabled(): boolean {
    return this.getConfig().showUsage;
  }

  /**
   * Whether to keep reading at all. Not the same question as `enabled`: hiding
   * the cards is a preference about a 300px dock, but auto-pause reads the same
   * numbers, and letting a display setting quietly switch off a spending guard
   * is exactly the kind of coupling nobody would guess at from the setting's
   * description.
   */
  private get reading(): boolean {
    const c = this.getConfig();
    return c.showUsage || c.autoPauseEnabled;
  }

  start(): void {
    if (this.disposed) return;
    void this.tick(false);
  }

  /**
   * Read again now. Plain `refresh()` (a dashboard opening, a settings change)
   * is happy with a cached read; `force` (the user clicked refresh) goes to
   * Claude regardless. Either way the normal cadence resumes afterwards.
   */
  async refresh(opts: { force?: boolean } = {}): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.tick(opts.force === true);
  }

  /**
   * The current cadence. Not a constant: as a limit is approached the cards
   * stop being a background fact and become the thing being watched, so the
   * interval tightens (see `usageIntervalSeconds`). The setting's own 15s floor
   * still applies, and the shared cache means this is one read per interval for
   * the whole machine however many windows are open.
   */
  private intervalMs(): number {
    const cfg = this.getConfig();
    const seconds = usageIntervalSeconds(cfg.usagePollIntervalSeconds, maxUsagePercent(this.state.last), {
      enabled: cfg.autoPauseEnabled,
      percent: cfg.autoPausePercent,
    });
    return Math.max(15, seconds) * 1000;
  }

  private async tick(force: boolean): Promise<void> {
    if (this.disposed || this.inFlight) return;
    if (!this.reading) {
      // Off entirely: clear anything held and check back in case it returns.
      if (this.state.last || this.state.error) {
        this.state = {};
        this.emitter.fire();
      }
      this.schedule(this.intervalMs());
      return;
    }

    this.inFlight = true;
    try {
      if (!force) {
        // Another window may have read within the interval; if so, that's ours too.
        if (await this.adoptCached()) return;
        // Nobody has. Wait a random moment and look once more, so that of N
        // windows waking together only the first actually asks Claude.
        await this.jitter();
        if (this.disposed) return;
        if (await this.adoptCached()) return;
      }

      const res = await this.read(Date.now());
      if (this.disposed) return;
      if (res.ok) {
        this.failures = 0;
        this.state = { last: res.snapshot };
        await this.cache.write(res.snapshot);
      } else {
        this.failures++;
        if (this.failures === 1 || this.failures % 10 === 0) {
          this.log(`usage: ${res.error.kind}${res.error.detail ? ` (${res.error.detail})` : ''}, attempt ${this.failures}`);
        }
        // A sibling window may have succeeded where we failed.
        const cached = await this.cache.read();
        const last = cached && (!this.state.last || cached.fetchedAtMs > this.state.last.fetchedAtMs) ? cached : this.state.last;
        this.state = { last, error: res.error };
      }
      this.emitter.fire();
    } finally {
      this.inFlight = false;
    }
    this.schedule(this.nextWaitMs());
  }

  /** Use the shared cache when it is fresher than the poll interval. True when it was. */
  private async adoptCached(): Promise<boolean> {
    const cached = await this.cache.read();
    if (!cached || Date.now() - cached.fetchedAtMs >= this.intervalMs()) return false;
    if (this.state.last?.fetchedAtMs !== cached.fetchedAtMs || this.state.error) {
      this.state = { last: cached };
      this.emitter.fire();
    }
    this.failures = 0;
    // Wake when this read ages out, so windows stay staggered rather than re-syncing.
    this.schedule(Math.max(1000, this.intervalMs() - (Date.now() - cached.fetchedAtMs)));
    return true;
  }

  private nextWaitMs(): number {
    const base = this.intervalMs();
    const err = this.state.error;
    if (!err) return base;
    const backoff = base * BACKOFF_STEPS[Math.min(this.failures, BACKOFF_STEPS.length - 1)];
    if (err.kind === 'rate-limited') return Math.max(backoff, RATE_LIMIT_MIN_WAIT_MS, err.retryAfterMs ?? 0);
    return backoff;
  }

  private schedule(waitMs: number): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(false), waitMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.emitter.dispose();
  }
}
