/**
 * The row × moves the row the moment it is clicked, not when the process is
 * gone.
 *
 * Closing a session waits for the process to end (SIGTERM, then a grace
 * period), and the row only used to move once the registry and the transcript
 * said so. Clearing 20 finished agents meant watching each one sit there for
 * seconds. The table now draws the row where it is going straight away, and
 * puts it back only if the host says the close did not happen (`dismissResult`
 * with `ok: false`, which also carries the error the user is shown).
 *
 * A pending dismissal ends when the snapshot itself shows the outcome — the
 * session ended (`dismiss`) or archived (`dismissHide`) — or when the host said
 * it failed, or after `MAX_AGE_MS` with neither, so a row never stays hidden on
 * the pane's word alone.
 *
 * A row that is working right now is not moved: the host asks before throwing
 * away its turn, and a row that vanished before that question would be a lie
 * if the answer were no. The host's own idea of "working" may be newer than
 * the row's; a declined confirm then comes back as `ok: false` and the row
 * returns.
 *
 * No Node, no DOM: the table imports it, and it is tested as plain functions.
 */
import type { SessionDTO } from './model';

export type DismissKind = 'dismiss' | 'dismissHide';

interface Pending {
  kind: DismissKind;
  at: number;
}

/** Long enough for a stubborn process's SIGKILL and the refresh after it. */
export const MAX_AGE_MS = 60_000;

/** Whether the × can move this row before the host answers. */
export function canDismissAhead(s: SessionDTO): boolean {
  return s.status !== 'busy' && s.status !== 'stuck' && s.status !== 'blocked';
}

/** Whether the snapshot already shows what the × asked for. */
function reached(s: SessionDTO, kind: DismissKind): boolean {
  return kind === 'dismiss' ? s.status === 'ended' || s.archived === true : s.archived === true;
}

export class PendingDismissals {
  private readonly byKey = new Map<string, Pending>();

  begin(key: string, kind: DismissKind, now: number = Date.now()): void {
    this.byKey.set(key, { kind, at: now });
  }

  /** The host said the close did not go through: the row comes back. True if one was pending. */
  fail(key: string): boolean {
    return this.byKey.delete(key);
  }

  get size(): number {
    return this.byKey.size;
  }

  /**
   * Drop what the snapshot has caught up with, what is no longer in it, and
   * what has waited too long.
   */
  settle(sessions: readonly SessionDTO[], now: number = Date.now()): void {
    if (this.byKey.size === 0) return;
    const byKey = new Map(sessions.map((s) => [s.key, s]));
    for (const [key, p] of this.byKey) {
      const s = byKey.get(key);
      if (!s || reached(s, p.kind) || now - p.at > MAX_AGE_MS) this.byKey.delete(key);
    }
  }

  /** The sessions as they will be once every pending close lands. */
  apply(sessions: SessionDTO[]): SessionDTO[] {
    if (this.byKey.size === 0) return sessions;
    return sessions.map((s): SessionDTO => {
      const p = this.byKey.get(s.key);
      if (!p) return s;
      return p.kind === 'dismiss' ? { ...s, status: 'ended' } : { ...s, archived: true };
    });
  }
}
