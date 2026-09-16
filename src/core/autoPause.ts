/**
 * Stopping every agent by itself when the plan is nearly spent.
 *
 * The decision is deliberately a pure function of (usage, threshold, armed), so
 * the thing that matters — that it fires exactly once per approach to the limit
 * — is testable without a clock, a network or a process.
 *
 * Hysteresis, and why it is not symmetrical: after firing, auto-pause disarms
 * and only re-arms once usage is back *below* the threshold. Without that, a
 * user who looked at the paused rows and resumed one on purpose would have it
 * frozen again at the very next poll, since usage is still at 98% and will stay
 * there until the window resets. Re-arming on the way down means the override
 * is respected for the rest of the window and the guard is ready again for the
 * next one.
 */

import type { UsageSnapshot } from '../shared/usage';

export interface AutoPauseSettings {
  enabled: boolean;
  /** Fire once any limit reaches this percent of its window. */
  percent: number;
}

export interface AutoPauseDecision {
  fire: boolean;
  /** The armed flag to carry into the next evaluation. */
  armed: boolean;
}

/**
 * The highest percent across every reported window.
 *
 * All of them, not just the one flagged `active`: a weekly limit at 99% ends
 * the day just as firmly as the five-hour one, and which window is "currently
 * constraining" says nothing about which is closest to the edge.
 */
export function maxUsagePercent(snap: UsageSnapshot | undefined): number | undefined {
  if (!snap || snap.windows.length === 0) return undefined;
  return snap.windows.reduce((max, w) => Math.max(max, w.percent), 0);
}

export function autoPauseDecision(
  percent: number | undefined,
  settings: AutoPauseSettings,
  armed: boolean,
): AutoPauseDecision {
  if (!settings.enabled) return { fire: false, armed: true };
  // No reading at all (a failed fetch, or the cards turned off) is not evidence
  // of headroom, but it is not evidence of exhaustion either — and pausing
  // every agent on the machine is far too blunt a thing to do on a guess.
  if (percent === undefined) return { fire: false, armed };
  if (percent < settings.percent) return { fire: false, armed: true };
  return armed ? { fire: true, armed: false } : { fire: false, armed: false };
}

/**
 * Usage is close enough that the cards should be read more often than the
 * ordinary cadence — the point at which "am I near the limit" turns into
 * "how many minutes do I have left", and, when auto-pause is on, the point
 * where a stale reading is the difference between stopping at 98% and
 * discovering it at 100%.
 */
export const NEAR_LIMIT_PERCENT = 90;
/** How often to re-read while near the limit. Floored by the setting's own minimum. */
export const NEAR_LIMIT_INTERVAL_SECONDS = 20;

/** How far below the auto-pause threshold the fast cadence starts. */
const APPROACH_MARGIN = 10;

/**
 * The poll interval to use right now, in seconds: the configured one normally,
 * a much shorter one while a limit is being approached.
 */
export function usageIntervalSeconds(
  configured: number,
  percent: number | undefined,
  settings: AutoPauseSettings,
): number {
  if (percent === undefined) return configured;
  const nearThreshold = settings.enabled
    ? Math.min(NEAR_LIMIT_PERCENT, settings.percent - APPROACH_MARGIN)
    : NEAR_LIMIT_PERCENT;
  if (percent < nearThreshold) return configured;
  return Math.min(configured, NEAR_LIMIT_INTERVAL_SECONDS);
}
