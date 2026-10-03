/**
 * The shared pending-action pattern for buttons whose action takes the host
 * a while (git, the network, a dialog): see `docs/plans/pending-actions.md`.
 *
 * A pane keeps one `PendingActions`. On a click it calls `begin(key, label)`:
 * that returns a request id to send with the request, or `undefined` when an
 * action with the same key is already in flight (a double click, Enter held
 * down) — the second press does nothing. The pane draws the button from
 * `get(key)`: off, relabelled (`Merging…`), `aria-busy`, until the host
 * answers with that request id and the pane calls `settle`.
 *
 * This is the pane's half only, for the moment between the click and the
 * host's own state arriving. It is not what stops a second merge: the core
 * deduplicates (a disabled button is a courtesy, not a guarantee), and the
 * host's snapshot is what keeps a button off across a re-render, a reload of
 * the pane, or a restart.
 *
 * No Node, no DOM: the panes import it, and it is tested as a plain class.
 */

export interface PendingAction {
  key: string;
  requestId: string;
  /** What the button says meanwhile: "Merging…". */
  label: string;
  startedAt: number;
}

export class PendingActions {
  private readonly byKey = new Map<string, PendingAction>();
  private seq = 0;

  /** `prefix` keeps request ids from two panes (or two loads of one) apart. */
  constructor(private readonly prefix: string = Math.random().toString(36).slice(2, 8)) {}

  /** Start one. Its request id, or `undefined` if one with this key is already in flight. */
  begin(key: string, label: string, now: number = Date.now()): string | undefined {
    if (this.byKey.has(key)) return undefined;
    const requestId = `${this.prefix}-${++this.seq}`;
    this.byKey.set(key, { key, requestId, label, startedAt: now });
    return requestId;
  }

  /** The host answered `requestId`, however it went. The key it was for, if it was still pending. */
  settle(requestId: string): string | undefined {
    for (const [key, p] of this.byKey) {
      if (p.requestId === requestId) {
        this.byKey.delete(key);
        return key;
      }
    }
    return undefined;
  }

  get(key: string): PendingAction | undefined {
    return this.byKey.get(key);
  }

  /** The first in flight whose key starts with `prefix`: actions on one mission conflict with each other. */
  under(prefix: string): PendingAction | undefined {
    for (const p of this.byKey.values()) if (p.key.startsWith(prefix)) return p;
    return undefined;
  }

  /**
   * Forget ones the host never answered after `maxAgeMs` (a host reload, a
   * lost message), so that no button stays off for ever on the pane's word
   * alone. The keys dropped. The host's own state still keeps a button off
   * while its action really is under way.
   */
  expire(now: number, maxAgeMs: number): string[] {
    const gone: string[] = [];
    for (const [key, p] of this.byKey) {
      if (now - p.startedAt > maxAgeMs) {
        this.byKey.delete(key);
        gone.push(key);
      }
    }
    return gone;
  }

  get size(): number {
    return this.byKey.size;
  }
}

/**
 * A button's attributes while its action is under way (`busy`) or another
 * action blocks it (`blocked`). `aria-disabled` rather than `disabled`, so
 * the button keeps keyboard focus and a screen reader still finds it and
 * reads it as busy; the pane's click handling refuses an `aria-disabled`
 * button itself (`isInert`). `fk` names the button so focus can be put back
 * on it after a re-render.
 */
export function pendingAttrs(state: 'busy' | 'blocked' | undefined, fk?: string): string {
  const focus = fk ? ` data-fk="${fk.replace(/[&<>"']/g, '')}"` : '';
  if (state === 'busy') return `${focus} aria-disabled="true" aria-busy="true"`;
  if (state === 'blocked') return `${focus} aria-disabled="true"`;
  return focus;
}
