/**
 * The decisions behind the phone layout (#134, plan §5), kept pure so they can
 * be tested without a browser. The DOM wiring is `webview/common/phone.ts`.
 *
 * Imported by the main process and the webviews: no Node or DOM here.
 */

/**
 * Below this width the conversation pane folds into its compact form: the
 * header collapses, the composer's controls wrap, cards and blocks tighten.
 * Measured on the pane itself (`#convApp`), never on the viewport, because the
 * divider moves and a pane can be 300px inside a 2000px window.
 *
 * 560 rather than the table's 720: a conversation reads fine at 600px, and what
 * breaks first is its header and composer bar, which need about 520px to keep
 * three dropdowns, the Send button and the title on a line each.
 */
export const CONV_NARROW_PX = 560;

/**
 * Whether a pane of this width is narrow. A hidden pane measures 0 and keeps
 * its last real answer, so toggling the pane away does not re-render it in the
 * other form for nothing.
 */
export function isNarrowWidth(width: number, threshold: number, previous: boolean): boolean {
  if (!(width > 0)) return previous;
  return width < threshold;
}

/** A keyboard is open when the visual viewport is at least this much shorter than the layout one. */
export const KEYBOARD_MIN_PX = 120;

/** What `window.visualViewport` reports, as numbers. */
export interface ViewportMetrics {
  /** `window.innerHeight`: the layout viewport. */
  layoutHeight: number;
  /** `visualViewport.height`. */
  height: number;
  /** `visualViewport.offsetTop`: how far iOS has scrolled the visual viewport inside the layout one. */
  offsetTop: number;
  /** `visualViewport.scale`: above 1 the reader has pinch-zoomed. */
  scale?: number;
}

export interface ViewportFrame {
  /** Where the app's box starts, from the top of the layout viewport. */
  top: number;
  /** How tall it is: what is actually visible. */
  height: number;
  /** The on-screen keyboard is covering part of the page. */
  keyboard: boolean;
}

/**
 * The box the app should fill so the composer stays visible with the on-screen
 * keyboard open. iOS Safari does not resize the layout viewport for a keyboard
 * (`100dvh` does not move); it shrinks the *visual* viewport and may scroll it,
 * so the app is sized and positioned to that instead.
 *
 * Returns `undefined` for nonsense (no viewport yet, a zero height), in which
 * case the page's own `100dvh` stands.
 */
export function viewportFrame(m: ViewportMetrics): ViewportFrame | undefined {
  if (!(m.height > 0) || !(m.layoutHeight > 0)) return undefined;
  // Pinch-zoom shrinks the visual viewport as well, and is not a keyboard: leave
  // the page alone while the reader has zoomed in.
  if ((m.scale ?? 1) > 1.05) return undefined;
  const height = Math.round(Math.min(m.height, m.layoutHeight));
  const top = Math.max(0, Math.round(m.offsetTop));
  return { top, height, keyboard: m.layoutHeight - m.height >= KEYBOARD_MIN_PX };
}

/** The gap between the overlay dock's banner and the page content above it. */
export const DOCK_GAP_PX = 6;

/**
 * How much of the page's bottom the overlay dock's banner needs kept clear
 * (`--aw-dock-h`, #134), in whole pixels: its height plus a gap, or 0 when
 * there is no banner or it is not drawn (hidden while the keyboard is up).
 * Toasts are not counted: they come and go, and the page must not jump for them.
 */
export function dockReserve(bannerHeight: number | undefined): number {
  if (!(bannerHeight !== undefined && bannerHeight > 0)) return 0;
  return Math.ceil(bannerHeight) + DOCK_GAP_PX;
}

/** A press held this long, without moving, is a long-press: the touch way to a context menu. */
export const LONG_PRESS_MS = 500;
/** Moving further than this since touchdown is a scroll, not a long-press. */
export const LONG_PRESS_SLOP_PX = 10;

export function movedPastSlop(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) > LONG_PRESS_SLOP_PX;
}
