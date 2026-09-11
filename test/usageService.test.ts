import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type WranglerConfig } from '../src/core/config';
import { UsageService, type UsageReader } from '../src/core/usageService';
import type { UsageSnapshot } from '../src/shared/usage';

const snap = (pct: number, at: number): UsageSnapshot => ({
  fetchedAtMs: at,
  windows: [{ id: 'session', label: 'Session (5hr)', percent: pct, active: false }],
});

describe('UsageService', () => {
  let cfg: WranglerConfig;
  beforeEach(() => {
    vi.useFakeTimers();
    cfg = { ...DEFAULT_CONFIG, usagePollIntervalSeconds: 60 };
  });
  afterEach(() => vi.useRealTimers());

  const flush = () => vi.advanceTimersByTimeAsync(0);

  it('reads on start, then again every interval', async () => {
    const read = vi.fn<UsageReader>(async (now) => ({ ok: true, snapshot: snap(10, now) }));
    const svc = new UsageService(read, () => cfg);
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

  it('keeps the last good read through a failure and backs off', async () => {
    let fail = false;
    const read = vi.fn<UsageReader>(async (now) =>
      fail ? { ok: false, error: { kind: 'network', detail: 'ETIMEDOUT', atMs: now } } : { ok: true, snapshot: snap(42, now) },
    );
    const svc = new UsageService(read, () => cfg);
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
    await svc.refresh();
    expect(svc.usage.error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(5);
    svc.dispose();
  });

  it('does not read while the cards are turned off, and clears what it had', async () => {
    const read = vi.fn<UsageReader>(async (now) => ({ ok: true, snapshot: snap(5, now) }));
    const svc = new UsageService(read, () => cfg);
    svc.start();
    await flush();
    expect(svc.usage.last).toBeDefined();

    cfg = { ...cfg, showUsage: false };
    await svc.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    expect(svc.usage).toEqual({});

    cfg = { ...cfg, showUsage: true };
    await svc.refresh();
    expect(read).toHaveBeenCalledTimes(2);
    svc.dispose();
  });

  it('stops after dispose', async () => {
    const read = vi.fn<UsageReader>(async (now) => ({ ok: true, snapshot: snap(1, now) }));
    const svc = new UsageService(read, () => cfg);
    svc.start();
    await flush();
    svc.dispose();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
