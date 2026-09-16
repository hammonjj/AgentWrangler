/**
 * The Agent Wrangler workbench: the agent table and the conversation side by
 * side in one tab, with a divider you can move.
 *
 * They were two editor tabs, which meant two things that are always used
 * together could be closed independently, shoved apart by a file opening into
 * either group, and rearranged by hand every time. One tab cannot drift.
 *
 * This module is only the frame. The two panes are the same modules that
 * shipped as standalone webviews, imported for their side effects — each finds
 * its own root in the document below and initialises itself. That is the whole
 * reason the split is cheap: the panes did not have to be rewritten, only
 * stopped from fighting over the three things a webview has exactly one of
 * (the API handle, the message channel and the saved state), which is what
 * `common/paneApi.ts` does.
 *
 * Import order matters and is deliberate: the roots are in the HTML shell
 * (`ui/html.ts`), not created here, because an ES import is evaluated before
 * the importing module's body and the panes look for their roots as they load.
 */

import './workbench.css';
import { splitState } from '../common/paneApi';
import '../dashboard/main';
import '../conversation/main';

/** Neither pane may be squeezed below this. Both stop being usable well before. */
const MIN_PANE_PX = 260;
/** Where the divider sits when nothing has been saved: a little under half to the table. */
const DEFAULT_SPLIT = 0.45;

const split = document.getElementById('wbSplit') as HTMLElement;
const table = document.getElementById('wbTable') as HTMLElement;
const root = document.getElementById('wb') as HTMLElement;

/**
 * The table's share of the width, 0–1.
 *
 * A fraction rather than a pixel width so the balance survives the window
 * changing size — which it does every time the editor group is resized, and on
 * every move between displays.
 */
let fraction = splitState.get() ?? DEFAULT_SPLIT;

/**
 * Written through the CSSOM rather than a `style` attribute: the webview CSP has
 * no `unsafe-inline`, so an inline style would be dropped silently.
 */
function paint(): void {
  table.style.flexBasis = `${(fraction * 100).toFixed(3)}%`;
}

function clampToPixels(px: number, total: number): number {
  if (total <= MIN_PANE_PX * 2) return 0.5; // too narrow to honour either floor
  return Math.min(Math.max(px, MIN_PANE_PX), total - MIN_PANE_PX) / total;
}

paint();

let dragging = false;

split.addEventListener('pointerdown', (e: PointerEvent) => {
  dragging = true;
  split.setPointerCapture(e.pointerId);
  root.classList.add('dragging');
  e.preventDefault();
});

split.addEventListener('pointermove', (e: PointerEvent) => {
  if (!dragging) return;
  const box = root.getBoundingClientRect();
  fraction = clampToPixels(e.clientX - box.left, box.width);
  paint();
});

function endDrag(e: PointerEvent): void {
  if (!dragging) return;
  dragging = false;
  split.releasePointerCapture(e.pointerId);
  root.classList.remove('dragging');
  // Saved on release, not on every move: `setState` is a round trip to the
  // extension host, and a drag produces one of these per frame.
  splitState.set(fraction);
}

split.addEventListener('pointerup', endDrag);
split.addEventListener('pointercancel', endDrag);

/** Double-click resets, which is the fastest way back from a drag gone wrong. */
split.addEventListener('dblclick', () => {
  fraction = DEFAULT_SPLIT;
  paint();
  splitState.set(fraction);
});

/**
 * Keyboard access, because a pointer-only divider is unreachable for anyone who
 * cannot use one — and useful to anyone who wants an exact nudge.
 */
split.addEventListener('keydown', (e: KeyboardEvent) => {
  const step = e.shiftKey ? 0.1 : 0.02;
  if (e.key === 'ArrowLeft') fraction = Math.max(0.1, fraction - step);
  else if (e.key === 'ArrowRight') fraction = Math.min(0.9, fraction + step);
  else if (e.key === 'Home') fraction = DEFAULT_SPLIT;
  else return;
  e.preventDefault();
  paint();
  splitState.set(fraction);
});

// A window that shrinks can push a pane under its floor without the divider
// moving; re-clamp against the new width rather than leaving a pane unusable.
window.addEventListener('resize', () => {
  const box = root.getBoundingClientRect();
  if (box.width === 0) return;
  const next = clampToPixels(fraction * box.width, box.width);
  if (Math.abs(next - fraction) < 0.001) return;
  fraction = next;
  paint();
});
