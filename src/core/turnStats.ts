/**
 * Learns how long this user's turns actually take, and answers the only
 * forward-looking question the data can honestly support: is the turn in flight
 * running longer than most, and by when are most turns like it finished?
 *
 * Why a band and not a percentage. Measured over 507 completed turns in this
 * machine's own transcripts, the distribution is:
 *
 *     p10 6s · p25 32s · p50 164s · p75 614s · p90 1726s · p99 4498s
 *
 * p90 is 10.5x the median and p99 is 27.5x. Any bar driven by `elapsed/median`
 * would sit at 100% for a quarter of all turns while ten more minutes of real
 * work remained — a confident lie, which is exactly what `statusIsEstimated`
 * exists to avoid. A percentile band degrades honestly instead: it says where
 * this turn sits among its peers and never claims to know the finish line.
 *
 * Samples are working time only (the reducer subtracts spells parked on a
 * permission prompt), so a prompt left sitting overnight can't poison the
 * baseline.
 */
import type { PaceBand, TurnPace } from '../shared/model';
import type { KeyValueStorage } from './archive';

const STORAGE_KEY = 'agentWrangler.turnDurationsMs';

/** Rolling window size. ~200 turns is a few days of steady use and keeps p90 stable. */
export const MAX_TURN_SAMPLES = 200;

/** Below this, the learned percentiles are too noisy to quote; the fallback is used. */
export const MIN_TURN_SAMPLES = 20;

/**
 * Fallback percentiles, used until enough real turns are recorded. Taken from
 * the measurement above, so day one is useful rather than blank; `provisional`
 * is set on anything derived from them so the UI can hedge.
 */
export const FALLBACK_P50_MS = 164_000;
export const FALLBACK_P75_MS = 614_000;
export const FALLBACK_P90_MS = 1_726_000;

/** Turns shorter than this are noise (a one-line answer, a rejected prompt). */
const MIN_RECORDED_MS = 2_000;

/** Guards against a clock jump or a resumed session banking an absurd sample. */
const MAX_RECORDED_MS = 6 * 3_600_000;

/** Nearest-rank percentile of an already-sorted array. */
export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

export class TurnStats {
  /** Insertion-ordered ring; oldest dropped first. Not kept sorted. */
  private samples: number[];
  private sortedCache?: number[];

  constructor(private storage: KeyValueStorage) {
    const raw = storage.get<number[]>(STORAGE_KEY, []);
    this.samples = Array.isArray(raw)
      ? raw.filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0).slice(-MAX_TURN_SAMPLES)
      : [];
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  /** Record one completed turn's working duration. Out-of-range values are ignored. */
  record(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < MIN_RECORDED_MS || durationMs > MAX_RECORDED_MS) return;
    this.samples.push(durationMs);
    if (this.samples.length > MAX_TURN_SAMPLES) this.samples = this.samples.slice(-MAX_TURN_SAMPLES);
    this.sortedCache = undefined;
    void this.storage.update(STORAGE_KEY, this.samples);
  }

  /** Current baseline: learned once there are enough samples, seeded before that. */
  baseline(): { p50Ms: number; p75Ms: number; p90Ms: number; samples: number; provisional: boolean } {
    const samples = this.samples.length;
    if (samples < MIN_TURN_SAMPLES) {
      return {
        p50Ms: FALLBACK_P50_MS,
        p75Ms: FALLBACK_P75_MS,
        p90Ms: FALLBACK_P90_MS,
        samples,
        provisional: true,
      };
    }
    const sorted = (this.sortedCache ??= [...this.samples].sort((a, b) => a - b));
    return {
      p50Ms: percentile(sorted, 0.5),
      p75Ms: percentile(sorted, 0.75),
      p90Ms: percentile(sorted, 0.9),
      samples,
      provisional: false,
    };
  }

  /** Where a turn's elapsed working time sits against the baseline. */
  classify(elapsedMs: number): TurnPace {
    const b = this.baseline();
    return { ...b, band: bandFor(elapsedMs, b.p75Ms, b.p90Ms) };
  }
}

export function bandFor(elapsedMs: number, p75Ms: number, p90Ms: number): PaceBand {
  if (elapsedMs >= p90Ms) return 'very-long';
  if (elapsedMs >= p75Ms) return 'long';
  return 'typical';
}
