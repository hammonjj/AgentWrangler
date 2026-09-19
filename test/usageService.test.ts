import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type WranglerConfig } from '../src/core/config';
import { MemoryUsageCache } from '../src/core/usageCache';
import { UsageService, type UsageReader } from '../src/core/usageService';
import type { UsageSnapshot } from '../src/shared/usage';

const snap = (pct: number, at: number): UsageSnapshot => ({
  fetchedAtMs: at,
  windows: [{ id: 'session', label: 'Session (5hr)', percent: pct, active: false }],
  spendKnown: true,
});

const noJitter = { jitter: () => Promise.resolve() };

describe('UsageService', () => {
  let cfg: WranglerConfig;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000);
    cfg = { ...DEFAULT_CONFIG, usagePollIntervalSeconds: 60 };
  });
  afterEach(() => vi.useRealTimers());

  const flush = () => vi.advanceTimersByTimeAsync(0);
  const okReader = (pct = 10) => vi.fn<UsageReader>(async (now) => ({ ok: true, snapshot: snap(pct, now) }));

  it('reads on start, then again every interval', async () => {
    const read = okReader();
    const svc = new UsageService(read, new MemoryUsageCache(), () => cfg, undefined, noJitter);
    const changes = vi.fn();
    svc.onDidChange(changes);

    svc.start();
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(svc.usage.last?.windows[0].percent).toBe(10);
    expect(changes).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
    svc.dispose();
  });

  /**
   * The cadence is not fixed: once a limit is close the cards stop being a
   * background fact and become the thing being watched — and with auto-pause
   * armed, a stale reading is the difference between stopping at 98% and
   * finding out at 100%.
   */
  it('speeds up by itself once a limit is close, and settles again when it is not', async () => {
    const read = okReader(95);
    const svc = new UsageService(read, new MemoryUsageCache(), () => cfg, undefined, noJitter);
    svc.start();
    await flush();
    expect(read).toHaveBeenCalledTimes(1);

    // The configured 60s would still be waiting here; the near-limit 20s is not.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(read).toHaveBeenCalledTimes(2);

    // Usage drops (the window reset): back to the interval the user set.
    read.mockImplementation(async (now) => ({ ok: true, snapshot: snap(5, now) }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(read).toHaveBeenCalledTimes(4);
    svc.dispose();
  });

  /**
   * Hiding the cards is a preference about a 300px dock. Auto-pause reads the
   * same numbers, so a display setting must not quietly switch off a spending
   * guard — nothing in either setting's description would lead you to expect it.
   */
  it('keeps reading for auto-pause when the cards are hidden', async () => {
    cfg = { ...cfg, showUsage: false, autoPauseEnabled: true };
    const read = okReader(99);
    const svc = new UsageService(read, new MemoryUsageCache(), () => cfg, undefined, noJitter);
    svc.start();
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(svc.usage.last?.windows[0].percent).toBe(99);
    // Still hidden, though: the dashboard asks `enabled`, not `reading`.
    expect(svc.enabled).toBe(false);
    svc.dispose();
  });

  it('two windows sharing a cache make one request between them', async () => {
    const cache = new MemoryUsageCache();
    const readA = okReader(30);
    const readB = okReader(31);
    const a = new UsageService(readA, cache, () => cfg, undefined, noJitter);
    const b = new UsageService(readB, cache, () => cfg, undefined, noJitter);

    a.start();
    await flush();
    b.start();
    await flush();
    expect(readA).toHaveBeenCalledTimes(1);
    expect(readB).toHaveBeenCalledTimes(0); // B found A's read in the cache
    expect(b.usage.last?.windows[0].percent).toBe(30);

    // Once A's read ages out, whichever wakes first reads; the other adopts it again.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readA.mock.calls.length + readB.mock.calls.length).toBe(2);
    a.dispose();
    b.dispose();
  });

  it('a dashboard opening (plain refresh) uses the cache; the refresh button (force) does not', async () => {
    const cache = new MemoryUsageCache();
    const read = okReader();
    const svc = new UsageService(read, cache, () => cfg, undefined, noJitter);
    svc.start();
    await flush();
    expect(read).toHaveBeenCalledTimes(1);

    await svc.refresh();
    expect(read).toHaveBeenCalledTimes(1);

    await svc.refresh({ force: true });
    expect(read).toHaveBeenCalledTimes(2);
    svc.dispose();
  });

  it('keeps the last good read through a failure and backs off', async () => {
    let fail = false;
    const read = vi.fn<UsageReader>(async (now) =>
      fail ? { ok: false, error: { kind: 'network', detail: 'ETIMEDOUT', atMs: now } } : { ok: true, snapshot: snap(42, now) },
    );
    const svc = new UsageService(read, new MemoryUsageCache(), () => cfg, undefined, noJitter);
    svc.start();
    await flush();
    expect(svc.usage.last?.windows[0].percent).toBe(42);

    fail = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(svc.usage.last?.windows[0].percent).toBe(42); // still shown
    expect(svc.usage.error?.kind).toBe('network');

    // First failure → next try after 2× the interval, not 1×.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(3);

    // Recovery clears the error and the backoff.
    fail = false;
    await svc.refresh({ force: true });
    expect(svc.usage.error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(5);
    svc.dispose();
  });

  it('after a 429 waits at least five minutes, or Retry-After if that is longer', async () => {
    let retryAfterMs: number | undefined;
    const read = vi.fn<UsageReader>(async (now) => ({
      ok: false,
      error: { kind: 'rate-limited', detail: 'HTTP 429', atMs: now, retryAfterMs },
    }));
    const svc = new UsageService(read, new MemoryUsageCache(), () => cfg, undefined, noJitter);
    svc.start();
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(svc.usage.error?.kind).toBe('rate-limited');

    await vi.advanceTimersByTimeAsync(4 * 60_000 + 59_000);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(2);

    retryAfterMs = 10 * 60_000;
    await svc.refresh({ force: true });
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(4);
    svc.dispose();
  });

  it('a failing window still shows a sibling’s fresher read from the cache', async () => {
    const cache = new MemoryUsageCache();
    await cache.write(snap(77, Date.now() - 90_000)); // older than the interval: not adopted up front
    const read = vi.fn<UsageReader>(async (now) => ({ ok: false, error: { kind: 'network', atMs: now } }));
    const svc = new UsageService(read, cache, () => cfg, undefined, noJitter);
    svc.start();
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(svc.usage.error?.kind).toBe('network');
    expect(svc.usage.last?.windows[0].percent).toBe(77);
    svc.dispose();
  });

  it('does not read while the cards are turned off, and clears what it had', async () => {
    const read = okReader(5);
    const svc = new UsageService(read, new MemoryUsageCache(), () => cfg, undefined, noJitter);
    svc.start();
    await flush();
    expect(svc.usage.last).toBeDefined();

    cfg = { ...cfg, showUsage: false };
    await svc.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    expect(svc.usage).toEqual({});

    cfg = { ...cfg, showUsage: true };
    await svc.refresh({ force: true });
    expect(read).toHaveBeenCalledTimes(2);
    svc.dispose();
  });

  /**
   * The windows are always in the body; `spend` is not. A read that omits it
   * used to replace the last snapshot wholesale and take the extra-usage card
   * off the dashboard — which looks exactly like the credits being gone, and
   * is not what the response said.
   */
  describe('extra usage across reads', () => {
    const SPEND = { usedMinor: 326, limitMinor: 100000, exponent: 2, currency: 'USD', percent: 0 };

    const readerOf = (...snapshots: UsageSnapshot[]) => {
      let i = 0;
      return vi.fn<UsageReader>(async () => ({ ok: true, snapshot: snapshots[Math.min(i++, snapshots.length - 1)] }));
    };

    it('keeps the last figure when a later read does not mention it', async () => {
      const withSpend: UsageSnapshot = { ...snap(10, 1), spend: SPEND, spendKnown: true };
      const silent: UsageSnapshot = { ...snap(11, 2), spendKnown: false };
      const svc = new UsageService(readerOf(withSpend, silent), new MemoryUsageCache(), () => cfg, undefined, noJitter);

      svc.start();
      await flush();
      expect(svc.usage.last?.spend).toEqual(SPEND);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(svc.usage.last?.windows[0].percent).toBe(11);
      expect(svc.usage.last?.spend).toEqual(SPEND);
      svc.dispose();
    });

    it('clears it when a later read says the account has none', async () => {
      const withSpend: UsageSnapshot = { ...snap(10, 1), spend: SPEND, spendKnown: true };
      const disabled: UsageSnapshot = { ...snap(11, 2), spendKnown: true };
      const svc = new UsageService(readerOf(withSpend, disabled), new MemoryUsageCache(), () => cfg, undefined, noJitter);

      svc.start();
      await flush();
      expect(svc.usage.last?.spend).toEqual(SPEND);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(svc.usage.last?.spend).toBeUndefined();
      svc.dispose();
    });

    /** Carrying is only ever forward: nothing to carry means nothing appears. */
    it('invents nothing when it has never seen a figure', async () => {
      const silent: UsageSnapshot = { ...snap(10, 1), spendKnown: false };
      const svc = new UsageService(readerOf(silent), new MemoryUsageCache(), () => cfg, undefined, noJitter);
      svc.start();
      await flush();
      expect(svc.usage.last?.spend).toBeUndefined();
      svc.dispose();
    });

    /** The cache is "the last good read", so the carried figure belongs in it. */
    it('writes the carried figure to the cache', async () => {
      const cache = new MemoryUsageCache();
      const withSpend: UsageSnapshot = { ...snap(10, 1), spend: SPEND, spendKnown: true };
      const silent: UsageSnapshot = { ...snap(11, 2), spendKnown: false };
      const svc = new UsageService(readerOf(withSpend, silent), cache, () => cfg, undefined, noJitter);

      svc.start();
      await flush();
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await cache.read())?.spend).toEqual(SPEND);
      svc.dispose();
    });
  });

  it('stops after dispose', async () => {
    const read = okReader(1);
    const svc = new UsageService(read, new MemoryUsageCache(), () => cfg, undefined, noJitter);
    svc.start();
    await flush();
    svc.dispose();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
