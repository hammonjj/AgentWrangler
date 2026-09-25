/**
 * How a model source is doing, from the plan-usage reads AW already makes
 * (`UsageService`, one per source): `ModelSource.health()` and `capacity()`
 * in `docs/plans/intelligent-orchestration.md` §6.2.
 *
 * Only what the reads establish. A source nobody has read is `unknown`, not
 * reachable; a failed read with an older good one behind it reports the older
 * one and says how old it is, as the dashboard cards do.
 *
 * Pure and shared: no Node or DOM here.
 */

import type { UsageState, UsageWindow } from '../usage';
import { UNKNOWN, known, type Known } from './catalog';
import type { Millis, ModelSourceId } from './types';

export type HealthState = 'reachable' | 'degraded' | 'down' | 'unknown';

export interface SourceHealth {
  state: HealthState;
  reason: string;
  /** When the facts behind this were read. */
  at?: Millis;
}

export interface SourceCapacity {
  /** The fullest usage window, as last read. */
  windowPercent: Known<number>;
  windowLabel?: string;
  resetsAtMs?: Millis;
  /** Don't start work on this source before then: a window is full until it resets. */
  backoffUntil?: Millis;
  /** Concurrent slots. Hosted sources do not say: unknown. */
  freeSlots: Known<number>;
}

export interface SourceStatus {
  source: ModelSourceId;
  health: SourceHealth;
  capacity: SourceCapacity;
}

export interface SourceStatusOptions {
  /** A window at or above this is `degraded`. */
  nearPercent?: number;
  /** A read older than this is called stale in the reason. */
  staleMs?: number;
}

const NEAR_PERCENT = 90;
const STALE_MS = 30 * 60_000;

function fullest(windows: UsageWindow[]): UsageWindow | undefined {
  return windows.reduce<UsageWindow | undefined>((max, w) => (!max || w.percent > max.percent ? w : max), undefined);
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  return `${Math.round(min / 60)}h`;
}

/** One source's health and capacity from its usage state. */
export function sourceStatus(
  source: ModelSourceId,
  usage: UsageState | undefined,
  now: Millis,
  opts: SourceStatusOptions = {},
): SourceStatus {
  const near = opts.nearPercent ?? NEAR_PERCENT;
  const staleMs = opts.staleMs ?? STALE_MS;
  const last = usage?.last;
  const error = usage?.error;
  const capacity: SourceCapacity = { windowPercent: UNKNOWN, freeSlots: UNKNOWN };

  if (!last) {
    if (!error) return { source, health: { state: 'unknown', reason: 'Usage not read yet' }, capacity };
    if (error.kind === 'no-credentials') return { source, health: { state: 'down', reason: 'Not signed in', at: error.atMs }, capacity };
    if (error.kind === 'unauthorized') {
      return { source, health: { state: 'degraded', reason: 'Login rejected; it usually refreshes on the next run', at: error.atMs }, capacity };
    }
    return { source, health: { state: 'unknown', reason: `Could not read usage (${error.kind})`, at: error.atMs }, capacity };
  }

  const top = fullest(last.windows);
  if (top) {
    capacity.windowPercent = known(top.percent, 'reported');
    capacity.windowLabel = top.label;
    capacity.resetsAtMs = top.resetsAtMs;
  }
  const age = now - last.fetchedAtMs;
  const staleNote = error || age > staleMs ? ` (as of ${ago(age)} ago)` : '';

  if (top && top.percent >= 100) {
    capacity.backoffUntil = top.resetsAtMs;
    return { source, health: { state: 'down', reason: `${top.label} limit reached${staleNote}`, at: last.fetchedAtMs }, capacity };
  }
  if (top && top.percent >= near) {
    return { source, health: { state: 'degraded', reason: `${top.label} at ${Math.round(top.percent)}%${staleNote}`, at: last.fetchedAtMs }, capacity };
  }
  const reason = top ? `${top.label} at ${Math.round(top.percent)}%${staleNote}` : `No usage windows reported${staleNote}`;
  return { source, health: { state: 'reachable', reason, at: last.fetchedAtMs }, capacity };
}
