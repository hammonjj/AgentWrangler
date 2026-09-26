/**
 * What a right-click on a session row offers, and where the menu lands.
 *
 * Pure and in `shared/` on purpose: which items a row gets is a set of rules
 * about session state, and rules are worth testing. `main.ts` only turns these
 * into HTML and posts the action back — it holds no opinion about which ones
 * apply.
 */
import type { DashboardAction } from './messages';
import type { SessionDTO } from './model';

export interface RowMenuItem {
  action: DashboardAction;
  label: string;
  /**
   * Ends a process. Rendered in the error colour, below a separator, and last —
   * the three things that stop a menu from being a place you lose a session by
   * misclicking.
   */
  danger?: boolean;
  /** Tooltip, for the items whose label cannot say the whole thing. */
  title?: string;
}

/**
 * Whether there is a process to close.
 *
 * An `ended` session has none by definition, and a live one we never saw a pid
 * for (no process table on this platform, or a registry entry that predates it)
 * cannot be signalled — offering the item there would only ever produce an
 * error message. A session this window runs is closable regardless of pid,
 * since the runner holds the handle itself.
 *
 * Deliberately **not** gated on the provider. It used to be Claude-only, which
 * left archiving as the only way to get a finished Codex conversation out of
 * the way — and archiving hides a row rather than stopping anything. The two
 * conditions above are the real ones, and they answer for any provider: a Codex
 * thread this window runs has no pid of its own (one app-server serves them
 * all) but is closable through `runnerOwned`, and a Codex conversation running
 * somewhere else has neither and correctly does not offer the item.
 */
export function canCloseSession(s: SessionDTO): boolean {
  if (s.status === 'ended') return false;
  return s.runnerOwned === true || s.pid !== undefined;
}

/**
 * What the row's hover-reveal × button does, which depends on whether there is
 * anything left to stop — and, for the row's fate afterwards, on which tab the
 * table is showing.
 *
 * The button means "I am done with this agent", so on a live session it ends
 * the process (`dismiss` — `close` with the confirm reserved for a turn in
 * flight). A session with no process to end cannot be *stopped* any further, so
 * there the same button falls back to `archive`.
 *
 * Where the row goes then differs by tab, because the tabs mean different
 * things. The Status tab groups by what the agent is doing, so a closed session
 * has somewhere to land — Ended, which ages out on its own, and is a true
 * statement about it. The Project tab groups by *where* it ran, which a closed
 * session still answers, so it would sit in its project for ever: there the ×
 * archives as well (`dismissHide`), which is the only way that tab can honour
 * "take it off my table".
 */
export function dismissAction(
  s: SessionDTO,
  view: 'status' | 'project',
): Extract<DashboardAction, 'dismiss' | 'dismissHide' | 'archive'> {
  if (!canCloseSession(s)) return 'archive';
  return view === 'project' ? 'dismissHide' : 'dismiss';
}

/**
 * Whether there is a process to freeze.
 *
 * Stricter than `canCloseSession` in the one case that matters: a runner-owned
 * session is closable without a pid because the runner holds the child handle
 * itself, but pausing is a signal and a signal needs a number. Runner sessions
 * do register a pid like every other session, so in practice they qualify —
 * just not *because* they are ours.
 */
export function canPauseSession(s: SessionDTO): boolean {
  return s.status !== 'ended' && s.pid !== undefined;
}

/**
 * The row menu, in order: what the row *is* (rename it),
 * where to look at it (its own tab, or wherever it runs), what to do to the
 * agent (pause it), what to take off it (its id), then the two that change its
 * place in the world — archive, and close.
 *
 * `pause` is not marked `danger` even though it stops a process, because it is
 * fully reversible by the same menu. `close` is offered even while a turn is in
 * flight, unlike *Take over*: the session that most needs closing is the wedged
 * one, and the modal that follows is where the cost of interrupting it gets
 * spelled out.
 *
 * Section assignment is rendered by the dashboard because its choices are
 * dynamic; this helper supplies the state-dependent action rows below it.
 */
export function rowMenuItems(s: SessionDTO): RowMenuItem[] {
  const items: RowMenuItem[] = [];

  items.push({
    action: 'rename',
    label: s.nickname ? 'Rename…' : 'Give it a name…',
    title: 'Your own name for this conversation. Clear it to get the original back.',
  });
  // No transcript, nothing to show in a tab of its own.
  if (s.transcriptPath) {
    items.push({
      action: 'openInTab',
      label: 'Open in its own tab',
      title: 'Open this conversation in a tab that row clicks never swap away',
    });
  }
  if (s.interrupted) {
    items.push({
      action: 'resumeHere',
      label: 'Resume here',
      title: 'Carry this conversation on in Agent Wrangler, on the model and mode it was started with',
    });
  }
  if (s.paused) {
    items.push({
      action: 'unpause',
      label: 'Resume agent',
      title: 'Let this session run again, from exactly where it was stopped',
    });
  } else if (canPauseSession(s)) {
    items.push({
      action: 'pause',
      label: 'Pause agent',
      title: 'Stop its process so it spends nothing. Reversible; a turn in flight may have to be retried.',
    });
  }
  items.push({ action: 'copyId', label: 'Copy session id' });
  items.push(
    s.archived
      ? { action: 'archive', label: 'Unarchive', title: 'Move it back into its status section' }
      : {
          action: 'archive',
          label: 'Archive',
          title: 'Move it to the Archived section: no bell, no toasts, out of the way',
        },
  );
  if (canCloseSession(s)) {
    items.push({
      action: 'close',
      label: 'Close session…',
      danger: true,
      title: 'End the process running it. The transcript is kept, so it can be resumed.',
    });
  }
  return items;
}

// Box metrics, kept in step with `.rowmenu` in dashboard.css. They only feed
// the clamp below, so being a pixel out costs nothing — being wildly out would
// let the menu hang off the bottom of a short dock.
export const ROW_MENU_WIDTH = 190;
const ITEM_H = 26;
const V_PAD = 8;
const SEPARATOR_H = 4;

export function rowMenuSize(items: RowMenuItem[]): { width: number; height: number } {
  const separators = items.some((i) => i.danger) ? 1 : 0;
  return {
    width: ROW_MENU_WIDTH,
    height: items.length * ITEM_H + V_PAD + separators * SEPARATOR_H,
  };
}

/**
 * Where to put the menu so all of it is on screen.
 *
 * It opens down and to the right of the pointer, as a context menu does, and
 * slides back only when that would run it off an edge. The dashboard is used at
 * 300px, where a 190px menu runs off the right of most clicks, so this is the
 * common path rather than an edge case. Sliding rather than flipping keeps the
 * menu under the pointer, which is what makes the first item clickable without
 * moving the mouse.
 */
export function clampMenuPosition(
  at: { x: number; y: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
  margin = 4,
): { left: number; top: number } {
  return {
    left: Math.max(margin, Math.min(at.x, view.width - size.width - margin)),
    top: Math.max(margin, Math.min(at.y, view.height - size.height - margin)),
  };
}
