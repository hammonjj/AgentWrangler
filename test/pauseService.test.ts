import { beforeEach, describe, expect, it } from 'vitest';
import { PauseService, type SignalControl } from '../src/core/pauseService';

/**
 * A fake machine: which pids exist, which the OS has stopped, and every signal
 * that was aimed at them. `signal` moves the stopped set the way a real kernel
 * would, so `refresh()` reads back what the service actually did.
 */
function machine(alive: number[] = [1, 2, 3]) {
  const live = new Set(alive);
  const stopped = new Set<number>();
  const sent: { pid: number; signal: string }[] = [];
  const refuse = new Set<number>();
  /** Set to true to make `ps` unanswerable. */
  let blind = false;

  const ctl: SignalControl = {
    signal(pid, signal) {
      if (refuse.has(pid)) throw new Error('EPERM');
      sent.push({ pid, signal });
      if (signal === 'SIGSTOP') stopped.add(pid);
      else stopped.delete(pid);
    },
    isAlive: (pid) => live.has(pid),
    stopped: async (pids) =>
      blind ? undefined : new Set([...pids].filter((p) => stopped.has(p) && live.has(p))),
  };
  return { ctl, sent, live, stopped, refuse, blind: (v: boolean) => (blind = v) };
}

describe('PauseService', () => {
  let m: ReturnType<typeof machine>;
  let svc: PauseService;

  beforeEach(() => {
    m = machine();
    svc = new PauseService(m.ctl);
  });

  it('stops a process with SIGSTOP and reports it as paused', () => {
    expect(svc.pause(1)).toBe('paused');
    expect(m.sent).toEqual([{ pid: 1, signal: 'SIGSTOP' }]);
    expect(svc.isPaused(1)).toBe(true);
    expect(svc.count).toBe(1);
  });

  it('continues it again with SIGCONT', () => {
    svc.pause(1);
    expect(svc.resume(1)).toBe('resumed');
    expect(m.sent[1]).toEqual({ pid: 1, signal: 'SIGCONT' });
    expect(svc.isPaused(1)).toBe(false);
  });

  it('does not stop the same process twice', () => {
    svc.pause(1);
    expect(svc.pause(1)).toBe('already');
    expect(m.sent).toHaveLength(1);
  });

  it('refuses to act with no pid, rather than guessing at one', () => {
    expect(svc.pause(undefined)).toBe('gone');
    expect(svc.resume(undefined)).toBe('gone');
    expect(m.sent).toHaveLength(0);
  });

  it('reports a dead pid as gone and signals nothing', () => {
    expect(svc.pause(99)).toBe('gone');
    expect(m.sent).toHaveLength(0);
  });

  it('reports a refused SIGSTOP without claiming the process is paused', () => {
    m.refuse.add(1);
    expect(svc.pause(1)).toBe('refused');
    expect(svc.isPaused(1)).toBe(false);
  });

  /**
   * The asymmetry is deliberate. A refused SIGSTOP means nothing was stopped,
   * so the row must not say "paused". A refused SIGCONT means the process is
   * *still stopped*, so the row must keep offering Resume — dropping it would
   * leave a frozen process with no way back.
   */
  it('keeps a process paused when SIGCONT is refused', () => {
    svc.pause(1);
    m.refuse.add(1);
    expect(svc.resume(1)).toBe('refused');
    expect(svc.isPaused(1)).toBe(true);
  });

  it('lets go of a process that died while it was stopped', () => {
    svc.pause(1);
    m.live.delete(1);
    expect(svc.resume(1)).toBe('gone');
    expect(svc.isPaused(1)).toBe(false);
    expect(m.sent.filter((s) => s.signal === 'SIGCONT')).toHaveLength(0);
  });

  describe('refresh', () => {
    /**
     * The whole point of reading the OS rather than keeping records: a process
     * this window never touched — stopped by another window, or by hand from a
     * shell — is still a paused agent, and has to be resumable from here.
     */
    it('finds a process something else stopped', async () => {
      m.stopped.add(2);
      await svc.refresh([1, 2, 3]);
      expect(svc.isPaused(2)).toBe(true);
      expect(svc.resume(2)).toBe('resumed');
    });

    it('drops a process something else continued', async () => {
      svc.pause(1);
      m.stopped.delete(1);
      await svc.refresh([1]);
      expect(svc.isPaused(1)).toBe(false);
    });

    it('only asks about the pids given, so an unrelated stopped process is never adopted', async () => {
      m.stopped.add(42); // a suspended editor, say
      await svc.refresh([1, 2, 3]);
      expect(svc.isPaused(42)).toBe(false);
      expect(svc.count).toBe(0);
    });

    /**
     * "ps could not answer" is not "nothing is paused". Rendering it that way
     * would drop the Resume button for processes that are still frozen.
     */
    it('leaves the set alone when the OS cannot be read', async () => {
      svc.pause(1);
      m.blind(true);
      await svc.refresh([1]);
      expect(svc.isPaused(1)).toBe(true);
    });

    // A session can drop out of a snapshot briefly; that must not un-pause it.
    it('keeps a paused pid it was not asked about', async () => {
      svc.pause(1);
      await svc.refresh([2, 3]);
      expect(svc.isPaused(1)).toBe(true);
    });

    it('fires only when the set actually changes, since it runs every snapshot', async () => {
      let fired = 0;
      svc.onDidChange(() => fired++);
      m.stopped.add(1);
      await svc.refresh([1, 2]);
      expect(fired).toBe(1);
      await svc.refresh([1, 2]);
      expect(fired).toBe(1);
    });
  });

  describe('sweeps', () => {
    it('pauses every candidate and counts what happened', () => {
      const r = svc.pauseAll([1, 2, 99, undefined]);
      expect(r).toEqual({ ok: 2, gone: 2, refused: 0 });
      expect(svc.count).toBe(2);
    });

    it('skips what is already paused, so a second press is not a second signal', () => {
      svc.pause(1);
      expect(svc.pauseAll([1, 2]).ok).toBe(1);
      expect(m.sent.filter((s) => s.pid === 1)).toHaveLength(1);
    });

    it('resumes everything and leaves nothing behind', () => {
      svc.pauseAll([1, 2]);
      expect(svc.resumeAll()).toEqual({ ok: 2, gone: 0, refused: 0 });
      expect(svc.count).toBe(0);
    });

    it('clears processes that died while the fleet was paused', () => {
      svc.pauseAll([1, 2]);
      m.live.delete(1);
      expect(svc.resumeAll()).toEqual({ ok: 1, gone: 1, refused: 0 });
      expect(svc.count).toBe(0);
    });

    it('resumes what another window paused, once a refresh has seen it', async () => {
      m.stopped.add(3);
      await svc.refresh([1, 2, 3]);
      expect(svc.resumeAll().ok).toBe(1);
      expect(m.sent).toEqual([{ pid: 3, signal: 'SIGCONT' }]);
    });
  });

  it('fires a change event on pause and on resume, so every dashboard redraws', () => {
    let fired = 0;
    svc.onDidChange(() => fired++);
    svc.pause(1);
    svc.resume(1);
    expect(fired).toBe(2);
  });
});
