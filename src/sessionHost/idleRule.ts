/**
 * The idle-orphan rule (playbook §7.5), as the host applies it.
 *
 * A host whose session nobody has looked at for `orphanIdleHours` (the
 * Preferences setting "End idle sessions with no Agent Wrangler connected
 * after") ends it gracefully and exits. That is parking, not loss: the
 * conversation is its transcript, and it resumes with the same id.
 *
 * Never a busy session, never one waiting on a question or a permission (a
 * pending ask is held indefinitely, because an auto-deny derails the agent),
 * never one with background tasks (ending the CLI kills them). The clock is
 * monotonic (`process.hrtime`, which on macOS does not advance while the
 * machine sleeps), so a laptop left shut overnight does not trip it.
 *
 * Pure: time and the session's state are handed in.
 */
import type { HostState } from '../shared/sessionProtocol';

export interface IdleInputs {
  /** Authenticated clients connected right now. */
  clients: number;
  state: HostState;
  pendingAsks: number;
  backgroundTasks: number;
}

const HOUR_MS = 60 * 60 * 1000;

export class IdleRule {
  private lastClientMs: number;
  private fired = false;

  constructor(
    private hours: number,
    nowMs: number,
  ) {
    this.lastClientMs = nowMs;
  }

  /** From `configure`. Non-numbers and negatives mean never. */
  setHours(hours: unknown): void {
    this.hours = typeof hours === 'number' && Number.isFinite(hours) && hours > 0 ? hours : 0;
  }

  get currentHours(): number {
    return this.hours;
  }

  /** A client was here: the clock starts again from now. */
  touch(nowMs: number): void {
    this.lastClientMs = nowMs;
  }

  /** True, once, when the session should be parked now. */
  check(nowMs: number, s: IdleInputs): boolean {
    if (this.fired) return false;
    if (s.clients > 0) {
      this.lastClientMs = nowMs;
      return false;
    }
    if (!(this.hours > 0)) return false;
    if (s.state !== 'idle' || s.pendingAsks > 0 || s.backgroundTasks > 0) return false;
    if (nowMs - this.lastClientMs < this.hours * HOUR_MS) return false;
    this.fired = true;
    return true;
  }
}

/** Milliseconds on a monotonic clock that stands still while the machine sleeps. */
export function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}
