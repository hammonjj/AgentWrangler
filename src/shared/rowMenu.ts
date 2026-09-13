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
 */
export function canCloseSession(s: SessionDTO): boolean {
  if (s.status === 'ended') return false;
  return s.runnerOwned === true || s.pid !== undefined;
}

/**
 * The row menu, in order: the two things you do to a row you are keeping
 * (pin, go to it), the one thing you take off it (its id), then the two that
 * change its place in the world — archive, and close.
 *
 * `close` is offered even while a turn is in flight, unlike *Take over*: the
 * session that most needs closing is the wedged one, and the modal that follows
 * is where the cost of interrupting it gets spelled out.
 */
export function rowMenuItems(s: SessionDTO): RowMenuItem[] {
  const items: RowMenuItem[] = [];

  // No transcript, nothing to show in a tab of its own.
  if (s.transcriptPath) {
    items.push({
      action: 'pin',
      label: 'Pin in its own tab',
      title: 'Open this conversation in a tab that row clicks never swap away',
    });
  }
  if (s.status !== 'ended') {
    items.push({
      action: 'goTo',
      label: 'Go to where it runs',
      title: 'Reveal the terminal, Claude Code panel or VSCode window running this session',
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
