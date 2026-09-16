/**
 * Pausing an agent: freezing the process that runs it, and thawing it again.
 *
 * The lever is SIGSTOP/SIGCONT on the session's own pid, and it is the only one
 * that works for every session on the machine. A Claude Code session running in
 * another VSCode window or a terminal cannot be typed into, interrupted or
 * asked to stand down — there is no supported channel into a running TUI (see
 * the conversation-pane plan, §2.7) — but any process can be stopped. A stopped
 * `claude` issues no further API requests, so it spends nothing, and SIGCONT
 * puts it back exactly where it was.
 *
 * Why this is safe, and where it is not:
 *
 * - The transcript is append-only and written by the session itself. SIGSTOP
 *   between writes leaves a complete file; a stop *mid-write* leaves the write
 *   unfinished only until the process is resumed and completes it. Nothing
 *   truncates. (SIGKILL is the one that can strand a partial line, which is why
 *   `endProcess` is a different operation with a different warning.)
 * - A stopped process keeps its pid file in `~/.claude/sessions`, so the row
 *   stays in the dashboard rather than flipping to Ended.
 * - **A turn in flight is the exception.** Its HTTPS request is held open by a
 *   process that has stopped reading it, so a long pause can have the far end
 *   drop the connection; on resume that turn fails and has to be retried. Work
 *   already written to the transcript is kept, so this costs the turn, never
 *   the conversation. Pausing an *idle* session costs nothing at all.
 *
 * The paused set is persisted, and deliberately in **global** state: pausing is
 * about this machine's token budget, not about one window, and the sessions
 * being frozen mostly belong to other windows anyway. Persisting also means a
 * reload cannot strand a frozen process with no UI left to thaw it.
 */

import { Emitter, type Disposable, type Listener } from './events';
import type { KeyValueStorage } from './archive';

const STORAGE_KEY = 'agentWrangler.pausedSessions';

/**
 * The signalling seam, injected so the whole service is testable without ever
 * stopping a real process.
 */
export interface SignalControl {
  /** `process.kill`. Throws ESRCH when the pid is gone, EPERM when it is not ours. */
  signal(pid: number, signal: 'SIGSTOP' | 'SIGCONT'): void;
  isAlive(pid: number): boolean;
}

/** A session we have stopped, and the process we stopped to do it. */
export interface PausedRecord {
  key: string;
  /**
   * The pid at the moment of pausing. Held here rather than re-read from the
   * store at resume time because the store's copy can go stale — and sending
   * SIGCONT to a pid that has been recycled onto someone else's process is the
   * one genuinely destructive way to get this wrong.
   */
  pid: number;
  atMs: number;
}

export type PauseOutcome = 'paused' | 'resumed' | 'already' | 'gone' | 'refused';

/** What a pause/resume sweep did, for the status-bar message. */
export interface SweepResult {
  ok: number;
  gone: number;
  refused: number;
}

export class PauseService {
  private records = new Map<string, PausedRecord>();
  private emitter = new Emitter<void>();

  constructor(
    private storage: KeyValueStorage,
    private ctl: SignalControl,
    private log: (msg: string) => void = () => undefined,
  ) {
    for (const r of storage.get<PausedRecord[]>(STORAGE_KEY, [])) {
      if (isRecord(r)) this.records.set(r.key, r);
    }
  }

  readonly onDidChange = (listener: Listener<void>): Disposable => this.emitter.event(listener);

  isPaused(key: string): boolean {
    return this.records.has(key);
  }

  get count(): number {
    return this.records.size;
  }

  keys(): string[] {
    return [...this.records.keys()];
  }

  /**
   * Drop records whose process has gone — it was killed, or the machine
   * restarted and the pid means nothing now. Called at activation and before
   * every sweep, so the "N paused" count never counts ghosts.
   */
  reconcile(): boolean {
    let changed = false;
    for (const [key, r] of [...this.records]) {
      if (!this.ctl.isAlive(r.pid)) {
        this.records.delete(key);
        changed = true;
        this.log(`pause: forgot ${key} — its process is gone`);
      }
    }
    if (changed) this.persist();
    return changed;
  }

  pause(key: string, pid: number | undefined): PauseOutcome {
    if (this.records.has(key)) return 'already';
    if (pid === undefined) return 'gone';
    if (!this.ctl.isAlive(pid)) return 'gone';
    try {
      this.ctl.signal(pid, 'SIGSTOP');
    } catch (err) {
      this.log(`pause: could not stop ${key} (pid ${pid}): ${String(err)}`);
      return 'refused';
    }
    this.records.set(key, { key, pid, atMs: Date.now() });
    this.persist();
    return 'paused';
  }

  resume(key: string): PauseOutcome {
    const r = this.records.get(key);
    if (!r) return 'already';
    // Forget it either way: a record whose process has gone is a ghost, and one
    // we have signalled is no longer paused. Both stop being our business here.
    this.records.delete(key);
    this.persist();
    if (!this.ctl.isAlive(r.pid)) return 'gone';
    try {
      this.ctl.signal(r.pid, 'SIGCONT');
    } catch (err) {
      this.log(`pause: could not resume ${r.key} (pid ${r.pid}): ${String(err)}`);
      return 'refused';
    }
    return 'resumed';
  }

  /** Pause every candidate that is not paused already. */
  pauseAll(candidates: { key: string; pid?: number }[]): SweepResult {
    const out: SweepResult = { ok: 0, gone: 0, refused: 0 };
    for (const c of candidates) {
      const r = this.pause(c.key, c.pid);
      if (r === 'paused') out.ok++;
      else if (r === 'gone') out.gone++;
      else if (r === 'refused') out.refused++;
    }
    return out;
  }

  /** Resume everything currently paused. */
  resumeAll(): SweepResult {
    const out: SweepResult = { ok: 0, gone: 0, refused: 0 };
    for (const key of this.keys()) {
      const r = this.resume(key);
      if (r === 'resumed') out.ok++;
      else if (r === 'gone') out.gone++;
      else if (r === 'refused') out.refused++;
    }
    return out;
  }

  private persist(): void {
    void this.storage.update(STORAGE_KEY, [...this.records.values()]);
    this.emitter.fire();
  }
}

function isRecord(r: unknown): r is PausedRecord {
  const o = r as PausedRecord | undefined;
  return typeof o?.key === 'string' && typeof o.pid === 'number' && Number.isInteger(o.pid);
}
