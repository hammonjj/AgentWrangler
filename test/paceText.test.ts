import { describe, expect, it } from 'vitest';
import { FALLBACK_P50_MS, FALLBACK_P75_MS, FALLBACK_P90_MS } from '../src/core/turnStats';
import { paceText } from '../src/shared/model';

describe('paceText', () => {
  const p50 = 180_000; // 3m
  const p75 = 600_000; // 10m
  const p90 = 1_800_000; // 30m
  const at = (elapsedMs: number) => paceText(elapsedMs, p50, p75, p90);

  it('says nothing about a turn that has not outrun the median', () => {
    // "~30m" on a three-second-old turn would read as a prediction of 30
    // minutes, when most turns finish in three.
    expect(at(0)).toBe('');
    expect(at(3_000)).toBe('');
    expect(at(p50 - 1)).toBe('');
  });

  it('offers a soft ETA once the turn has outlived half its peers', () => {
    expect(at(p50)).toBe('~27m');
    expect(at(300_000)).toBe('~25m');
  });

  it('says it is running long once past p75, and still counts down', () => {
    expect(at(p75)).toBe('long · ~20m');
    expect(at(1_500_000)).toBe('long · ~5m');
  });

  it('stops predicting at p90 rather than counting to zero', () => {
    // Past here the distribution has nothing left to say, so neither do we.
    expect(at(p90)).toBe('very long');
    expect(at(3 * p90)).toBe('very long');
  });

  it('reads sensibly against the seeded baseline a new install starts with', () => {
    const seeded = (ms: number) => paceText(ms, FALLBACK_P50_MS, FALLBACK_P75_MS, FALLBACK_P90_MS);
    expect(seeded(0)).toBe('');
    expect(seeded(FALLBACK_P50_MS)).toBe('~26m');
    expect(seeded(FALLBACK_P75_MS)).toBe('long · ~18m');
    expect(seeded(FALLBACK_P90_MS)).toBe('very long');
  });
});
