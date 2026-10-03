/**
 * Noticing that the machine slept, on plain Node.
 *
 * A timer set to fire every few seconds fires far later than it was due when
 * the machine was asleep in between: timers do not run during sleep, and the
 * wall clock does. A gap much longer than the interval is a wake. The slack is
 * generous (30 s) so a busy event loop or a slow GC is never mistaken for one.
 *
 * Used by the core daemon (#130). The timer is unref'd: watching for sleep is
 * never a reason for the process to stay up.
 */
import type { Disposable } from './events';

export interface SleepWatcherOptions {
  /** Called once per detected wake, with how long the gap was. */
  onWake(gapMs: number): void;
  /** How often to look. Default 5 s. */
  everyMs?: number;
  /** How late a tick has to be to count as a sleep. Default 30 s. */
  slackMs?: number;
  /** Tests: the clock and the timer. */
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => { unref?(): void };
  clearInterval?: (handle: unknown) => void;
}

export function watchForSleep(opts: SleepWatcherOptions): Disposable {
  const everyMs = opts.everyMs ?? 5000;
  const slackMs = opts.slackMs ?? 30_000;
  const now = opts.now ?? Date.now;
  const set = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clear = opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  let last = now();
  const timer = set(() => {
    const t = now();
    const gap = t - last;
    last = t;
    if (gap > everyMs + slackMs) opts.onWake(gap);
  }, everyMs);
  timer.unref?.();
  return { dispose: () => clear(timer) };
}
