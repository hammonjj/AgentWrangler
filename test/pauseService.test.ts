import { beforeEach, describe, expect, it } from 'vitest';
import type { KeyValueStorage } from '../src/core/archive';
import { PauseService, type SignalControl } from '../src/core/pauseService';

function storage(): KeyValueStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T,>(key: string, dflt: T): T => (data.has(key) ? (data.get(key) as T) : dflt),
    update: (key: string, value: unknown) => data.set(key, value),
  };
}

/** A fake process table: which pids are alive, and every signal that was sent. */
function control(alive: number[] = [1, 2, 3]) {
  const live = new Set(alive);
  const sent: { pid: number; signal: string }[] = [];
  const refuse = new Set<number>();
  const ctl: SignalControl = {
    signal(pid, signal) {
      if (refuse.has(pid)) throw new Error('EPERM');
      sent.push({ pid, signal });
    },
    isAlive: (pid) => live.has(pid),
  };
  return { ctl, sent, live, refuse };
}

describe('PauseService', () => {
  let store: ReturnType<typeof storage>;
  let c: ReturnType<typeof control>;
  let svc: PauseService;

  beforeEach(() => {
    store = storage();
    c = control();
    svc = new PauseService(store, c.ctl);
  });

  it('stops a process with SIGSTOP and remembers it', () => {
    expect(svc.pause('claude:a', 1)).toBe('paused');
    expect(c.sent).toEqual([{ pid: 1, signal: 'SIGSTOP' }]);
    expect(svc.isPaused('claude:a')).toBe(true);
    expect(svc.count).toBe(1);
  });

  it('continues it again with SIGCONT and forgets it', () => {
    svc.pause('claude:a', 1);
    expect(svc.resume('claude:a')).toBe('resumed');
    expect(c.sent[1]).toEqual({ pid: 1, signal: 'SIGCONT' });
    expect(svc.isPaused('claude:a')).toBe(false);
  });

  it('does not stop the same session twice', () => {
    svc.pause('claude:a', 1);
    expect(svc.pause('claude:a', 1)).toBe('already');
    expect(c.sent).toHaveLength(1);
  });

  it('refuses to pause a session with no pid, rather than guessing at one', () => {
    expect(svc.pause('claude:a', undefined)).toBe('gone');
    expect(c.sent).toHaveLength(0);
    expect(svc.isPaused('claude:a')).toBe(false);
  });

  it('reports a dead pid as gone and signals nothing', () => {
    expect(svc.pause('claude:a', 99)).toBe('gone');
    expect(c.sent).toHaveLength(0);
  });

  it('reports a refused signal without recording a pause that did not happen', () => {
    c.refuse.add(1);
    expect(svc.pause('claude:a', 1)).toBe('refused');
    expect(svc.isPaused('claude:a')).toBe(false);
  });

  /**
   * The one genuinely destructive way to get this wrong: pids are recycled, and
   * a SIGCONT aimed at whatever inherited the number would hit a stranger's
   * process. So the pid is captured at pause time and checked for liveness
   * before the signal — a dead one is forgotten, never signalled.
   */
  it('does not signal a pid that died while paused', () => {
    svc.pause('claude:a', 1);
    c.live.delete(1);
    expect(svc.resume('claude:a')).toBe('gone');
    expect(c.sent.filter((s) => s.signal === 'SIGCONT')).toHaveLength(0);
    expect(svc.isPaused('claude:a')).toBe(false);
  });

  it('signals the pid captured at pause time, not one supplied later', () => {
    svc.pause('claude:a', 2);
    svc.resume('claude:a');
    expect(c.sent).toEqual([
      { pid: 2, signal: 'SIGSTOP' },
      { pid: 2, signal: 'SIGCONT' },
    ]);
  });

  it('survives a reload: the paused set is read back from storage', () => {
    svc.pause('claude:a', 1);
    const revived = new PauseService(store, c.ctl);
    expect(revived.isPaused('claude:a')).toBe(true);
    expect(revived.resume('claude:a')).toBe('resumed');
  });

  it('ignores junk in storage rather than throwing on startup', () => {
    store.data.set('agentWrangler.pausedSessions', [{ key: 'claude:a' }, null, { pid: 3 }, 'nope']);
    expect(new PauseService(store, c.ctl).count).toBe(0);
  });

  it('reconcile drops records whose process has gone, and keeps the rest', () => {
    svc.pause('claude:a', 1);
    svc.pause('claude:b', 2);
    c.live.delete(1);
    expect(svc.reconcile()).toBe(true);
    expect(svc.keys()).toEqual(['claude:b']);
    // Nothing left to clean up, so nothing changes and no event is worth firing.
    expect(svc.reconcile()).toBe(false);
  });

  describe('sweeps', () => {
    it('pauses every candidate and counts what happened', () => {
      const r = svc.pauseAll([
        { key: 'claude:a', pid: 1 },
        { key: 'claude:b', pid: 2 },
        { key: 'claude:c', pid: 99 }, // not alive
        { key: 'claude:d' }, // no pid
      ]);
      expect(r).toEqual({ ok: 2, gone: 2, refused: 0 });
      expect(svc.count).toBe(2);
    });

    it('skips what is already paused, so a second press is not a second signal', () => {
      svc.pause('claude:a', 1);
      const r = svc.pauseAll([
        { key: 'claude:a', pid: 1 },
        { key: 'claude:b', pid: 2 },
      ]);
      expect(r.ok).toBe(1);
      expect(c.sent.filter((s) => s.pid === 1)).toHaveLength(1);
    });

    it('resumes everything and leaves nothing behind', () => {
      svc.pauseAll([
        { key: 'claude:a', pid: 1 },
        { key: 'claude:b', pid: 2 },
      ]);
      expect(svc.resumeAll()).toEqual({ ok: 2, gone: 0, refused: 0 });
      expect(svc.count).toBe(0);
    });

    /**
     * A resume sweep has to clear the record even for the processes it could
     * not reach, or the paused count would be permanently wrong and the button
     * would stay stuck on "Resume".
     */
    it('clears records for processes that died while the fleet was paused', () => {
      svc.pauseAll([
        { key: 'claude:a', pid: 1 },
        { key: 'claude:b', pid: 2 },
      ]);
      c.live.delete(1);
      expect(svc.resumeAll()).toEqual({ ok: 1, gone: 1, refused: 0 });
      expect(svc.count).toBe(0);
    });
  });

  it('fires a change event on pause and on resume, so every dashboard redraws', () => {
    let fired = 0;
    svc.onDidChange(() => fired++);
    svc.pause('claude:a', 1);
    svc.resume('claude:a');
    expect(fired).toBe(2);
  });
});
