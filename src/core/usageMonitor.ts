/**
 * Keeps the plan-usage snapshot the dashboard cards show, refreshed on a timer.
 *
 * A failed fetch never blanks the cards: the last good limits stay up with the
 * failure reason attached, and `fetchedAtMs` says how old they are. A rejected
 * token backs off to a slower cadence rather than hammering the endpoint — the
 * token comes back on its own once a Claude session refreshes it.
 */
import type { UsageSnapshot } from '../shared/model';
import { Emitter, type Disposable } from './events';

export interface UsageFetcher {
  /** Resolve a snapshot, or throw an Error whose message fits the dashboard. */
  (): Promise<UsageSnapshot>;
}

export interface UsageMonitorOptions {
  fetcher: UsageFetcher;
  /** Seconds between polls; read on every schedule so a settings change lands. */
  intervalSeconds: () => number;
  /** False turns polling off entirely (and clears the snapshot). */
  enabled: () => boolean;
  log?: (msg: string) => void;
}

/** Floor between two fetches, whatever asks for them. */
const MIN_GAP_MS = 10_000;
/** Cadence after a permanently failing fetch (no token, token rejected). */
const BACKOFF_SECONDS = 300;

export class UsageMonitor implements Disposable {
  private snap?: UsageSnapshot;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private lastAttemptMs = 0;
  private backingOff = false;
  private disposed = false;
  private emitter = new Emitter<void>();

  constructor(private opts: UsageMonitorOptions) {}

  get snapshot(): UsageSnapshot | undefined {
    return this.opts.enabled() ? this.snap : undefined;
  }

  onDidChange = (listener: () => void): Disposable => this.emitter.event(listener);

  start(): void {
    void this.refresh();
  }

  /**
   * Fetch now if the floor allows, else do nothing — the timer will get there.
   * Callers (dashboard open, manual refresh) never wait on the result; the
   * snapshot change fires when it lands.
   */
  refresh(): Promise<void> {
    if (this.disposed || !this.opts.enabled()) {
      this.schedule();
      return Promise.resolve();
    }
    if (this.inFlight) return this.inFlight;
    if (Date.now() - this.lastAttemptMs < MIN_GAP_MS) return Promise.resolve();

    this.lastAttemptMs = Date.now();
    this.inFlight = this.opts
      .fetcher()
      .then((next) => {
        this.backingOff = false;
        this.set(next);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.backingOff = (err as { permanent?: boolean })?.permanent === true;
        this.opts.log?.(`usage fetch failed: ${message}`);
        // Keep the last good limits; say why they are not fresher.
        this.set({
          fetchedAtMs: this.snap?.fetchedAtMs ?? 0,
          limits: this.snap?.limits ?? [],
          error: message,
        });
      })
      .finally(() => {
        this.inFlight = undefined;
        this.schedule();
      });
    return this.inFlight;
  }

  private set(next: UsageSnapshot): void {
    const changed = JSON.stringify(next) !== JSON.stringify(this.snap);
    this.snap = next;
    if (changed) this.emitter.fire();
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    const seconds = this.backingOff ? BACKOFF_SECONDS : Math.max(15, this.opts.intervalSeconds());
    this.timer = setTimeout(() => void this.refresh(), seconds * 1000);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.emitter.dispose();
  }
}
