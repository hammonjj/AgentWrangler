import { describe, expect, it } from 'vitest';
import type { KeyValueStorage } from '../src/core/archive';
import {
  bandFor,
  FALLBACK_P50_MS,
  FALLBACK_P75_MS,
  FALLBACK_P90_MS,
  MAX_TURN_SAMPLES,
  MIN_TURN_SAMPLES,
  percentile,
  TurnStats,
} from '../src/core/turnStats';

/** In-memory Memento stand-in, so persistence is observable. */
function storage(seed: Record<string, unknown> = {}): KeyValueStorage & { data: Record<string, unknown> } {
  const data = { ...seed };
  return {
    data,
    get<T>(key: string, defaultValue: T): T {
      return (key in data ? data[key] : defaultValue) as T;
    },
    update(key: string, value: unknown) {
      data[key] = value;
      return undefined;
    },
  };
}

const KEY = 'agentWrangler.turnDurationsMs';

/** n samples of 2s, 3s, … — starting above the noise floor so all of them count. */
function ramp(n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i + 2) * 1000);
}

describe('percentile', () => {
  it('uses nearest-rank on a sorted array', () => {
    const s = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(s, 0.5)).toBe(50);
    expect(percentile(s, 0.75)).toBe(80);
    expect(percentile(s, 0.9)).toBe(90);
  });

  it('clamps at the ends and tolerates an empty set', () => {
    expect(percentile([5], 0.9)).toBe(5);
    expect(percentile([10, 20], 1)).toBe(20);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe('bandFor', () => {
  it('splits at p75 and p90', () => {
    expect(bandFor(100, 500, 900)).toBe('typical');
    expect(bandFor(499, 500, 900)).toBe('typical');
    expect(bandFor(500, 500, 900)).toBe('long');
    expect(bandFor(899, 500, 900)).toBe('long');
    expect(bandFor(900, 500, 900)).toBe('very-long');
    expect(bandFor(60_000, 500, 900)).toBe('very-long');
  });
});

describe('TurnStats', () => {
  it('uses the seeded baseline until it has enough real turns', () => {
    const st = new TurnStats(storage());
    expect(st.baseline()).toEqual({
      p50Ms: FALLBACK_P50_MS,
      p75Ms: FALLBACK_P75_MS,
      p90Ms: FALLBACK_P90_MS,
      samples: 0,
      provisional: true,
    });

    for (const ms of ramp(MIN_TURN_SAMPLES - 1)) st.record(ms);
    expect(st.baseline().provisional).toBe(true);
    expect(st.baseline().p90Ms).toBe(FALLBACK_P90_MS);
  });

  it('switches to learned percentiles once the sample is big enough', () => {
    const st = new TurnStats(storage());
    for (const ms of ramp(MIN_TURN_SAMPLES)) st.record(ms);

    const b = st.baseline();
    expect(b.provisional).toBe(false);
    expect(b.samples).toBe(MIN_TURN_SAMPLES);
    // 20 samples of 2s..21s: nearest-rank p50 = 11s, p75 = 16s, p90 = 19s.
    expect(b.p50Ms).toBe(11_000);
    expect(b.p75Ms).toBe(16_000);
    expect(b.p90Ms).toBe(19_000);
  });

  it('classifies a turn against the learned baseline', () => {
    const st = new TurnStats(storage());
    for (const ms of ramp(MIN_TURN_SAMPLES)) st.record(ms);

    expect(st.classify(5_000).band).toBe('typical');
    expect(st.classify(17_000).band).toBe('long');
    expect(st.classify(20_000).band).toBe('very-long');
  });

  it('ignores samples that are noise or impossible', () => {
    const st = new TurnStats(storage());
    st.record(500); // a one-line answer says nothing about long work
    st.record(-1);
    st.record(Number.NaN);
    st.record(Number.POSITIVE_INFINITY);
    st.record(48 * 3_600_000); // clock jump or a resumed session
    expect(st.sampleCount).toBe(0);
  });

  it('keeps a rolling window, dropping the oldest turns', () => {
    const s = storage();
    const st = new TurnStats(s);
    for (const ms of ramp(MAX_TURN_SAMPLES + 50)) st.record(ms);

    expect(st.sampleCount).toBe(MAX_TURN_SAMPLES);
    const kept = s.data[KEY] as number[];
    expect(kept[0]).toBe(52_000); // the first 50 (2s..51s) were evicted
    expect(kept[kept.length - 1]).toBe((MAX_TURN_SAMPLES + 51) * 1000);
  });

  it('persists across construction and survives a corrupted store', () => {
    const s = storage();
    const first = new TurnStats(s);
    for (const ms of ramp(MIN_TURN_SAMPLES)) first.record(ms);
    expect(new TurnStats(s).baseline()).toEqual(first.baseline());

    // Anything unusable falls back to an empty window rather than throwing.
    expect(new TurnStats(storage({ [KEY]: 'not an array' })).sampleCount).toBe(0);
    expect(new TurnStats(storage({ [KEY]: [1000, 'x', null, -5, 2000] })).sampleCount).toBe(2);
  });
});
