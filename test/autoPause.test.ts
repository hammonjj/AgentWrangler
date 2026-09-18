import { describe, expect, it } from 'vitest';
import {
  autoPauseDecision,
  maxUsagePercent,
  NEAR_LIMIT_INTERVAL_SECONDS,
  usageIntervalSeconds,
  type AutoPauseSettings,
} from '../src/core/autoPause';
import type { UsageSnapshot } from '../src/shared/usage';

function snapshot(...percents: number[]): UsageSnapshot {
  return {
    spendKnown: true,
    fetchedAtMs: 1_000,
    windows: percents.map((percent, i) => ({
      id: `w${i}`,
      label: `Window ${i}`,
      percent,
      active: i === 0,
    })),
  };
}

const on: AutoPauseSettings = { enabled: true, percent: 98 };
const off: AutoPauseSettings = { enabled: false, percent: 98 };

describe('maxUsagePercent', () => {
  it('takes the highest window, not the active one', () => {
    // The five-hour window is the one "currently constraining", but the weekly
    // one is the one about to run out — which is what a pause is for.
    expect(maxUsagePercent(snapshot(40, 99))).toBe(99);
  });

  it('is undefined with no snapshot and with no windows', () => {
    expect(maxUsagePercent(undefined)).toBeUndefined();
    expect(maxUsagePercent(snapshot())).toBeUndefined();
  });
});

describe('autoPauseDecision', () => {
  it('does nothing while the setting is off, and keeps the guard armed', () => {
    expect(autoPauseDecision(99, off, true)).toEqual({ fire: false, armed: true });
  });

  it('fires once the threshold is reached', () => {
    expect(autoPauseDecision(98, on, true)).toEqual({ fire: true, armed: false });
  });

  it('does not fire one point short', () => {
    expect(autoPauseDecision(97, on, true)).toEqual({ fire: false, armed: true });
  });

  /**
   * The hysteresis that makes the feature usable: after firing at 98%, usage
   * stays at 98% until the window resets. Without disarming, every poll would
   * re-pause the agent the user had just deliberately resumed.
   */
  it('does not fire again while still over the threshold', () => {
    const first = autoPauseDecision(98, on, true);
    expect(first.fire).toBe(true);
    expect(autoPauseDecision(99, on, first.armed)).toEqual({ fire: false, armed: false });
    expect(autoPauseDecision(100, on, false)).toEqual({ fire: false, armed: false });
  });

  it('re-arms when usage falls back below the threshold, ready for the next window', () => {
    expect(autoPauseDecision(12, on, false)).toEqual({ fire: false, armed: true });
    expect(autoPauseDecision(98, on, true).fire).toBe(true);
  });

  /**
   * A failed read is not evidence of headroom, but it is not evidence of
   * exhaustion either — and freezing every agent on the machine is far too
   * blunt to do on a guess. It also must not disturb the armed flag, or a
   * network blip would spend the one shot this has per window.
   */
  it('holds its fire, and its armed state, when there is no reading at all', () => {
    expect(autoPauseDecision(undefined, on, true)).toEqual({ fire: false, armed: true });
    expect(autoPauseDecision(undefined, on, false)).toEqual({ fire: false, armed: false });
  });

  it('honours a lowered threshold', () => {
    expect(autoPauseDecision(80, { enabled: true, percent: 80 }, true).fire).toBe(true);
  });
});

describe('usageIntervalSeconds', () => {
  it('leaves the configured cadence alone when nothing is near a limit', () => {
    expect(usageIntervalSeconds(60, 10, off)).toBe(60);
    expect(usageIntervalSeconds(60, 89, off)).toBe(60);
  });

  it('tightens near a limit, so the numbers keep up when they start mattering', () => {
    expect(usageIntervalSeconds(60, 90, off)).toBe(NEAR_LIMIT_INTERVAL_SECONDS);
    expect(usageIntervalSeconds(300, 99, off)).toBe(NEAR_LIMIT_INTERVAL_SECONDS);
  });

  /**
   * With auto-pause armed, the approach matters more than the cards do: the
   * fast cadence has to start far enough below the threshold that the trigger
   * is not read for the first time well past it.
   */
  it('starts the fast cadence ten points below a low auto-pause threshold', () => {
    const low: AutoPauseSettings = { enabled: true, percent: 70 };
    expect(usageIntervalSeconds(60, 59, low)).toBe(60);
    expect(usageIntervalSeconds(60, 60, low)).toBe(NEAR_LIMIT_INTERVAL_SECONDS);
  });

  it('never slows a cadence the user set faster than the near-limit one', () => {
    expect(usageIntervalSeconds(15, 99, on)).toBe(15);
  });

  it('keeps the configured cadence when there is no reading to judge by', () => {
    expect(usageIntervalSeconds(60, undefined, on)).toBe(60);
  });
});
