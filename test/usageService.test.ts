import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type WranglerConfig } from '../src/core/config';
import { MemoryUsageCache } from '../src/core/usageCache';
import { UsageService, type UsageReader } from '../src/core/usageService';
import type { UsageSnapshot } from '../src/shared/usage';

const snap = (pct: number, at: number): UsageSnapshot => ({
  fetchedAtMs: at,
  windows: [{ id: 'session', label: 'Session (5hr)', percent: pct, active: false }],
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
