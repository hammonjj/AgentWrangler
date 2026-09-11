import { describe, expect, it } from 'vitest';
import { endProcess, KILL_GRACE_MS, TERM_GRACE_MS, type ProcessControl } from '../src/claude/runner/adopt';

/**
 * A fake process with a scripted lifetime, so the escalation can be tested
 * without signalling anything real. `delay` advances a virtual clock rather
 * than sleeping, so the 5s and 2s budgets cost nothing to test.
 */
function fakeProcess(opts: { diesAfterTermMs?: number; diesAfterKillMs?: number; alive?: boolean }) {
  let now = 0;
  let termAt: number | undefined;
  let killAt: number | undefined;
  const signals: string[] = [];

  const ctl: ProcessControl = {
    kill(_pid, signal) {
      signals.push(signal);
      if (signal === 'SIGTERM') termAt = now;
      else killAt = now;
    },
    isAlive() {
      if (opts.alive === false) return false;
      if (termAt !== undefined && opts.diesAfterTermMs !== undefined && now - termAt >= opts.diesAfterTermMs) {
        return false;
      }
      if (killAt !== undefined && opts.diesAfterKillMs !== undefined && now - killAt >= opts.diesAfterKillMs) {
        return false;
      }
      return true;
    },
    async delay(ms) {
      now += ms;
    },
  };
  return { ctl, signals, elapsed: () => now };
}

describe('endProcess', () => {
  it('does nothing to a process that is already gone', async () => {
    const { ctl, signals } = fakeProcess({ alive: false });
    expect(await endProcess(123, ctl)).toBe('already-gone');
    expect(signals).toEqual([]);
  });

  it('asks politely first, and stops there when that works', async () => {
    const { ctl, signals } = fakeProcess({ diesAfterTermMs: 300 });
    expect(await endProcess(123, ctl)).toBe('exited');
    expect(signals).toEqual(['SIGTERM']);
  });

  it('escalates when the CLI will not exit on its own', async () => {
    // A wedged session is exactly the one worth taking over, so giving up at
    // SIGTERM would fail the case that needs this most.
    const { ctl, signals, elapsed } = fakeProcess({ diesAfterKillMs: 200 });
    expect(await endProcess(123, ctl)).toBe('killed');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(elapsed()).toBeGreaterThanOrEqual(TERM_GRACE_MS);
  });

  it('refuses rather than letting two processes share one session', async () => {
    // The caller must not resume after this: two writers on one transcript is
    // the corruption this whole dance exists to prevent.
    const { ctl, signals, elapsed } = fakeProcess({});
    expect(await endProcess(123, ctl)).toBe('refused');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(elapsed()).toBeGreaterThanOrEqual(TERM_GRACE_MS + KILL_GRACE_MS);
  });

  it('survives a kill that throws because the process vanished mid-signal', async () => {
    let alive = true;
    const ctl: ProcessControl = {
      kill() {
        alive = false;
        throw new Error('ESRCH');
      },
      isAlive: () => alive,
      delay: async () => undefined,
    };
    expect(await endProcess(123, ctl)).toBe('exited');
  });
});
