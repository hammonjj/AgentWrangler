import { describe, expect, it } from 'vitest';
import {
  ORPHAN_TERM_GRACE_MS,
  classifyEntry,
  sweepOrphans,
  sweepRefusal,
  type ClaudeProcessEntry,
  type SweepDeps,
} from '../src/core/session/orphanSweep';

/**
 * The orphan sweep against a scripted process table: nothing real is ever
 * signalled, and the grace periods run on a virtual clock.
 */

const SID = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-2222-3333-4444-555555555555';

interface FakeProc {
  start: string;
  ppid: number;
  /** Dies this long after SIGTERM; undefined = ignores it. */
  termMs?: number;
  /** Dies this long after SIGKILL; undefined = unkillable. */
  killMs?: number;
}

function world(procs: Record<number, FakeProc>, entries: ClaudeProcessEntry[], held: number[] = []) {
  let now = 0;
  const signals: string[] = [];
  const termAt = new Map<number, number>();
  const killAt = new Map<number, number>();
  const alive = (pid: number) => {
    const p = procs[pid];
    if (!p) return false;
    const t = termAt.get(pid);
    if (t !== undefined && p.termMs !== undefined && now - t >= p.termMs) return false;
    const k = killAt.get(pid);
    if (k !== undefined && p.killMs !== undefined && now - k >= p.killMs) return false;
    return true;
  };
  const deps: SweepDeps = {
    entries: async () => entries,
    heldAgentPids: () => new Set(held),
    isAlive: alive,
    startTimeOf: (pid) => (alive(pid) ? procs[pid].start : undefined),
    parentOf: (pid) => (alive(pid) ? procs[pid].ppid : undefined),
    kill: (pid, sig) => {
      signals.push(`${sig} ${pid}`);
      (sig === 'SIGTERM' ? termAt : killAt).set(pid, now);
    },
    delay: async (ms) => {
      now += ms;
    },
    log: () => undefined,
  };
  return { deps, signals, alive, elapsed: () => now };
}

describe('classifyEntry', () => {
  const probe = (procs: Record<number, FakeProc>) => world(procs, []).deps;

  it('ignores entries for other sessions', () => {
    expect(classifyEntry({ pid: 10, sessionId: OTHER, procStart: 'a' }, SID, probe({ 10: { start: 'a', ppid: 1 } }), new Set())).toBeUndefined();
  });

  it('matches session ids case-insensitively', () => {
    expect(classifyEntry({ pid: 10, sessionId: SID.toUpperCase(), procStart: 'a' }, SID, probe({ 10: { start: 'a', ppid: 1 } }), new Set())).toBe('orphan');
  });

  it('calls a dead pid stale (a SIGKILLed CLI cannot remove its own file)', () => {
    expect(classifyEntry({ pid: 10, sessionId: SID, procStart: 'a' }, SID, probe({}), new Set())).toBe('stale');
  });

  it('calls a reused pid stale: alive, but not the process the file names', () => {
    expect(classifyEntry({ pid: 10, sessionId: SID, procStart: 'a' }, SID, probe({ 10: { start: 'b', ppid: 1 } }), new Set())).toBe('stale');
  });

  it('never calls an entry with no start time an orphan: it cannot be proved to be the CLI', () => {
    expect(classifyEntry({ pid: 10, sessionId: SID }, SID, probe({ 10: { start: 'a', ppid: 1 } }), new Set())).toBe('owner');
  });

  it("leaves a live host's agent to its host", () => {
    expect(classifyEntry({ pid: 10, sessionId: SID, procStart: 'a' }, SID, probe({ 10: { start: 'a', ppid: 1 } }), new Set([10]))).toBe('held');
  });

  it('calls a process with any parent but launchd an owner (take-over, not a sweep)', () => {
    expect(classifyEntry({ pid: 10, sessionId: SID, procStart: 'a' }, SID, probe({ 10: { start: 'a', ppid: 500 } }), new Set())).toBe('owner');
  });
});

describe('sweepOrphans', () => {
  it('is clear with nothing to do', async () => {
    const { deps, signals } = world({}, []);
    const r = await sweepOrphans(SID, deps);
    expect(r).toMatchObject({ swept: [], clear: true });
    expect(signals).toEqual([]);
  });

  it('ends an orphan with SIGTERM and waits for it before saying clear', async () => {
    const w = world({ 10: { start: 'a', ppid: 1, termMs: 2800 } }, [{ pid: 10, sessionId: SID, procStart: 'a' }]);
    const r = await sweepOrphans(SID, w.deps);
    expect(r).toMatchObject({ swept: [10], refused: [], clear: true });
    expect(w.signals).toEqual(['SIGTERM 10']);
    expect(w.alive(10)).toBe(false);
    expect(w.elapsed()).toBeGreaterThanOrEqual(2800);
  });

  it('escalates to SIGKILL after the grace period', async () => {
    const w = world({ 10: { start: 'a', ppid: 1, killMs: 100 } }, [{ pid: 10, sessionId: SID, procStart: 'a' }]);
    const r = await sweepOrphans(SID, w.deps);
    expect(r).toMatchObject({ swept: [10], clear: true });
    expect(w.signals).toEqual(['SIGTERM 10', 'SIGKILL 10']);
    expect(w.elapsed()).toBeGreaterThanOrEqual(ORPHAN_TERM_GRACE_MS);
  });

  it('refuses a resume when an orphan will not die', async () => {
    const w = world({ 10: { start: 'a', ppid: 1 } }, [{ pid: 10, sessionId: SID, procStart: 'a' }]);
    const r = await sweepOrphans(SID, w.deps);
    expect(r).toMatchObject({ swept: [], refused: [10], clear: false });
    expect(sweepRefusal(r)).toMatch(/would not stop/);
  });

  it('never signals an owner or a held agent, and is not clear while either lives', async () => {
    const w = world(
      { 10: { start: 'a', ppid: 500, termMs: 0 }, 11: { start: 'b', ppid: 1, termMs: 0 } },
      [
        { pid: 10, sessionId: SID, procStart: 'a' },
        { pid: 11, sessionId: SID, procStart: 'b' },
      ],
      [11],
    );
    const r = await sweepOrphans(SID, w.deps);
    expect(w.signals).toEqual([]);
    expect(r).toMatchObject({ owners: [10], held: [11], clear: false });
    expect(sweepRefusal({ ...r, owners: [] })).toMatch(/session host/);
    expect(sweepRefusal({ ...r, held: [] })).toMatch(/take it over/);
  });

  it('ignores stale entries and entries for other sessions', async () => {
    const w = world(
      { 20: { start: 'new', ppid: 1, termMs: 0 }, 30: { start: 'x', ppid: 1, termMs: 0 } },
      [
        { pid: 10, sessionId: SID, procStart: 'dead' },
        { pid: 20, sessionId: SID, procStart: 'old' },
        { pid: 30, sessionId: OTHER, procStart: 'x' },
      ],
    );
    const r = await sweepOrphans(SID, w.deps);
    expect(w.signals).toEqual([]);
    expect(r.clear).toBe(true);
  });

  it('does not SIGKILL a pid reused while it waited', async () => {
    const procs: Record<number, FakeProc> = { 10: { start: 'a', ppid: 1 } };
    const w = world(procs, [{ pid: 10, sessionId: SID, procStart: 'a' }]);
    // Mid-wait, the orphan dies and a stranger gets its pid.
    const delay = w.deps.delay;
    let waited = 0;
    w.deps.delay = async (ms) => {
      await delay(ms);
      waited += ms;
      if (waited === 1000) procs[10] = { start: 'stranger', ppid: 1 };
    };
    const r = await sweepOrphans(SID, w.deps);
    expect(w.signals).toEqual(['SIGTERM 10']);
    expect(r).toMatchObject({ swept: [10], clear: true });
  });

  it('treats an unreadable registry as empty rather than failing the resume path', async () => {
    const w = world({}, []);
    w.deps.entries = async () => {
      throw new Error('EACCES');
    };
    expect((await sweepOrphans(SID, w.deps)).clear).toBe(true);
  });
});
