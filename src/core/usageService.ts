import type { UsageError, UsageSnapshot, UsageState } from '../shared/usage';
import type { ConfigGetter } from './config';
import { Emitter, type Disposable, type Listener } from './events';

export type UsageReader = (nowMs: number) => Promise<
  { ok: true; snapshot: UsageSnapshot } | { ok: false; error: UsageError }
>;

/** After a failure, wait this many times the normal interval before the next try (capped). */
const BACKOFF_STEPS = [1, 2, 4, 8];

/**
 * Polls plan usage on a timer and keeps the last good read. The dashboard
 * shows that read even while a refresh fails, marked stale, because a number
 * from ten minutes ago beats a blank when the question is "am I about to hit
 * the weekly limit".
 *
 * Every VSCode window runs its own instance; at one request a minute that is
 * a handful of tiny GETs, well under anything that could matter.
 */
export class UsageService implements Disposable {
  private state: UsageState = {};
  private emitter = new Emitter<void>();
  private timer?: NodeJS.Timeout;
  private failures = 0;
  private inFlight = false;
  private disposed = false;

  constructor(
    private read: UsageReader,
    private getConfig: ConfigGetter,
    private log: (msg: string) => void = () => undefined,
  ) {}

  readonly onDidChange = (listener: Listener<void>): Disposable => this.emitter.event(listener);

  get usage(): UsageState {
    return this.state;
  }

  get enabled(): boolean {
    return this.getConfig().showUsage;
  }

  start(): void {
    if (this.disposed) return;
    void this.tick();
  }

  /** Read now (a manual refresh), then resume the normal cadence. */
  async refresh(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (this.disposed || this.inFlight) return;
    if (!this.enabled) {
      // Disabled: clear anything shown and check back in case it is re-enabled.
      if (this.state.last || this.state.error) {
        this.state = {};
        this.emitter.fire();
      }
      this.schedule(1);
      return;
    }

    this.inFlight = true;
    try {
      const res = await this.read(Date.now());
      if (this.disposed) return;
      if (res.ok) {
        this.failures = 0;
        this.state = { last: res.snapshot };
      } else {
        this.failures++;
        if (this.failures === 1 || this.failures % 10 === 0) {
          this.log(`usage: ${res.error.kind}${res.error.detail ? ` (${res.error.detail})` : ''}, attempt ${this.failures}`);
        }
        this.state = { last: this.state.last, error: res.error };
      }
      this.emitter.fire();
    } finally {
      this.inFlight = false;
    }
    this.schedule(BACKOFF_STEPS[Math.min(this.failures, BACKOFF_STEPS.length - 1)]);
  }

  private schedule(multiplier: number): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    const base = Math.max(15, this.getConfig().usagePollIntervalSeconds) * 1000;
    this.timer = setTimeout(() => void this.tick(), base * multiplier);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.emitter.dispose();
  }
}
