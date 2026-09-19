/**
 * What this window was running, so a reload does not lose it.
 *
 * Runner sessions are child processes of the extension host: *Developer:
 * Reload Window* ends every one of them. The conversation itself survives —
 * it is the transcript — so all that has to be remembered is which sessions
 * this window had, and which one the pane was showing.
 *
 * Deliberately **workspace** state, not global. Global state is shared by every
 * VSCode window, so two windows starting up would both see the same record and
 * both resume the same session id, which is the one thing that corrupts a
 * transcript. Scoped per window, the window you were working in is the one that
 * brings your session back.
 */

/**
 * The slice of `vscode.Memento` this needs, so the runner never imports vscode.
 * `update` returns `unknown` rather than `Thenable<void>` because the host
 * behind it may be a plain JSON file that writes synchronously; every caller
 * here discards the result anyway.
 */
export interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): unknown;
}

export interface RunnerRecord {
  sessionId: string;
  cwd: string;
  /** ms epoch, last time the pane showed it. Decides which one comes back. */
  lastShownAt: number;
}

const KEY = 'agentWrangler.runnerSessions';
/** Records older than this are history, not an interrupted session. */
export const RESUME_WINDOW_MS = 8 * 60 * 60 * 1000;
/** Keep the list short; only the most recent is ever offered automatically. */
const MAX_RECORDS = 20;

export class RunnerRegistry {
  constructor(private memento: MementoLike) {}

  all(): RunnerRecord[] {
    const raw = this.memento.get<unknown>(KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r): r is RunnerRecord => {
        if (!r || typeof r !== 'object') return false;
        const rr = r as Partial<RunnerRecord>;
        return typeof rr.sessionId === 'string' && typeof rr.cwd === 'string' && typeof rr.lastShownAt === 'number';
      })
      .sort((a, b) => b.lastShownAt - a.lastShownAt);
  }

  /** Record (or refresh) a session this window is running. */
  remember(sessionId: string, cwd: string, at: number = Date.now()): void {
    const next = [{ sessionId, cwd, lastShownAt: at }, ...this.all().filter((r) => r.sessionId !== sessionId)];
    void this.memento.update(KEY, next.slice(0, MAX_RECORDS));
  }

  wasRunning(sessionId: string, now = Date.now()): boolean {
    return this.all().some((r) => r.sessionId === sessionId && now - r.lastShownAt <= RESUME_WINDOW_MS);
  }

  forget(sessionId: string): void {
    void this.memento.update(
      KEY,
      this.all().filter((r) => r.sessionId !== sessionId),
    );
  }

  /**
   * The session to bring back on startup: the most recently shown one, if it
   * is recent enough to be an interrupted session rather than old history.
   */
  resumable(now: number = Date.now()): RunnerRecord | undefined {
    const newest = this.all()[0];
    if (!newest) return undefined;
    return now - newest.lastShownAt <= RESUME_WINDOW_MS ? newest : undefined;
  }
}
