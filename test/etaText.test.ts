import { describe, expect, it } from 'vitest';
import { FALLBACK_P50_MS, FALLBACK_P90_MS } from '../src/core/turnStats';
import { etaText } from '../src/shared/model';

describe('etaText', () => {
  const p50 = 180_000; // 3m
  const p90 = 1_800_000; // 30m
  const at = (elapsedMs: number) => etaText(elapsedMs, p50, p90);

  it('counts down to the median while the turn is still typical', () => {
    // A three-second-old turn most likely finishes soon; p50 says so without
    // quoting the 30-minute tail that only a quarter of turns ever reach.
    expect(at(0)).toBe('~3m');
    expect(at(60_000)).toBe('~2m');
    expect(at(p50 - 1)).toBe('~0s');
  });

  it('switches to the p90 bound once the turn has outlived half its peers', () => {
    expect(at(p50)).toBe('~27m');
    expect(at(300_000)).toBe('~25m');
    expect(at(1_500_000)).toBe('~5m');
  });

  it('stops predicting at p90 rather than counting to zero', () => {
    // Past here the distribution has nothing left to say, so the cell reports
    // the bound it has passed instead of a deadline it cannot know.
    expect(at(p90)).toBe('>30m');
    expect(at(3 * p90)).toBe('>30m');
  });

  it('reads sensibly against the seeded baseline a new install starts with', () => {
    const seeded = (ms: number) => etaText(ms, FALLBACK_P50_MS, FALLBACK_P90_MS);
    expect(seeded(0)).toBe('~2m');
    expect(seeded(FALLBACK_P50_MS)).toBe('~26m');
    expect(seeded(FALLBACK_P90_MS)).toBe('>28m');
  });
});
