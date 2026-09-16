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
 * **The OS is the source of truth, not this class.** An earlier cut kept a
 * persisted set of "sessions this window paused", which was wrong in a way
 * worth recording: a second window could neither see those records nor preserve
 * them, so pausing anything there overwrote them — and a stopped process whose
 * record has been erased is frozen with no button left to start it again. The
 * process state answers the same question exactly, is shared by every window
 * for free, survives a reload, needs no reconciliation, self-heals when a
 * signal is refused, and is true even for a process stopped from a shell.
 * `refresh()` reads it; everything else here only asks.
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
 */

import { Emitter, type Disposable, type Listener } from './events';

/**
 * The OS seam, injected so the whole service is testable without ever stopping
 * a real process.
 */
export interface SignalControl {
  /** `process.kill`. Throws ESRCH when the pid is gone, EPERM when it is not ours. */
  signal(pid: number, signal: 'SIGSTOP' | 'SIGCONT'): void;
  isAlive(pid: number): boolean;
  /** Which of these pids the OS has stopped. `undefined` means it could not say. */
  stopped(pids: number[]): Promise<Set<number> | undefined>;
}

export type PauseOutcome = 'paused' | 'resumed' | 'already' | 'gone' | 'refused';

/** What a pause/resume sweep did, for the message that follows it. */
export interface SweepResult {
  ok: number;
  gone: number;
  refused: number;
}

export class PauseService {
  /** Session pids the last `refresh()` found stopped. */
  private frozen = new Set<number>();
  private emitter = new Emitter<void>();

  constructor(
    private ctl: SignalControl,
    private log: (msg: string) => void = () => undefined,
  ) {}

  readonly onDidChange = (listener: Listener<void>): Disposable => this.emitter.event(listener);

  isPaused(pid: number | undefined): boolean {
    return pid !== undefined && this.frozen.has(pid);
  }

  get count(): number {
    return this.frozen.size;
  }

  pausedPids(): number[] {
    return [...this.frozen];
  }

  /**
   * Re-read which of `pids` are stopped. Fires only on a real change, since
   * this runs on every dashboard snapshot and an event per poll would redraw
   * every row for nothing.
   *
   * A `ps` that could not answer leaves the previous set alone: "no
   * information" must not be rendered as "nothing is paused", which would drop
   * the Resume button for a process that is still frozen.
   */
  async refresh(pids: number[]): Promise<void> {
    const stopped = await this.ctl.stopped(pids);
    if (stopped === undefined) return;
    // Pids we were not asked about keep whatever we last knew: a snapshot that
    // omits a session (it briefly left the registry) should not un-pause it.
    const asked = new Set(pids);
    const next = new Set(stopped);
    for (const pid of this.frozen) if (!asked.has(pid)) next.add(pid);
    if (sameSet(next, this.frozen)) return;
    this.frozen = next;
    this.emitter.fire();
  }

  pause(pid: number | undefined): PauseOutcome {
    if (pid === undefined) return 'gone';
    if (this.frozen.has(pid)) return 'already';
    if (!this.ctl.isAlive(pid)) return 'gone';
    try {
      this.ctl.signal(pid, 'SIGSTOP');
    } catch (err) {
      this.log(`pause: could not stop pid ${pid}: ${String(err)}`);
      return 'refused';
    }
    // Believe the signal until the next `ps` confirms it, so the row and the
    // bar button change under the click rather than a poll later. A signal that
    // silently did nothing is corrected by the next refresh.
    this.note(pid, true);
    return 'paused';
  }

  resume(pid: number | undefined): PauseOutcome {
    if (pid === undefined) return 'gone';
    if (!this.frozen.has(pid)) return 'already';
    if (!this.ctl.isAlive(pid)) {
      // It died while stopped. Nothing to signal, but the set has to let go of
      // it or the paused count counts a ghost forever.
      this.note(pid, false);
      return 'gone';
    }
    try {
      this.ctl.signal(pid, 'SIGCONT');
    } catch (err) {
      // Deliberately keep it in the set: it is still stopped, so the row must
      // keep offering Resume rather than pretending the problem went away.
      this.log(`pause: could not resume pid ${pid}: ${String(err)}`);
      return 'refused';
    }
    this.note(pid, false);
    return 'resumed';
  }

  /** Pause every candidate that is not stopped already. */
  pauseAll(pids: (number | undefined)[]): SweepResult {
    return this.sweep(pids, (pid) => this.pause(pid), 'paused');
  }

  /** Resume everything currently stopped. */
  resumeAll(): SweepResult {
    return this.sweep(this.pausedPids(), (pid) => this.resume(pid), 'resumed');
  }

  private sweep(
    pids: (number | undefined)[],
    act: (pid: number | undefined) => PauseOutcome,
    success: PauseOutcome,
  ): SweepResult {
    const out: SweepResult = { ok: 0, gone: 0, refused: 0 };
    for (const pid of pids) {
      const r = act(pid);
      if (r === success) out.ok++;
      else if (r === 'gone') out.gone++;
      else if (r === 'refused') out.refused++;
    }
    return out;
  }

  private note(pid: number, stopped: boolean): void {
    if (stopped ? this.frozen.has(pid) : !this.frozen.has(pid)) return;
    const next = new Set(this.frozen);
    if (stopped) next.add(pid);
    else next.delete(pid);
    this.frozen = next;
    this.emitter.fire();
  }
}

function sameSet(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
