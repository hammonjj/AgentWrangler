/**
 * Phone support for the browser (#134): the DOM half of `shared/phoneLayout.ts`.
 *
 * Browser-only, and shared by the panes and the shell — each of these is a
 * thing a document has exactly one of (the pointer type, the visual viewport),
 * so they are measured once here rather than by each pane. The panes still
 * size off themselves: what they get from this file is a `touch` class, not a
 * width.
 */

import { LONG_PRESS_MS, movedPastSlop, viewportFrame } from '../../shared/phoneLayout';

/**
 * Put `touch` on each root while the primary pointer is a finger.
 *
 * A class rather than `@media (pointer: coarse)` in the pane's stylesheet, so a
 * pane's rules key off the pane (`#convApp.touch`) like its `.narrow` does, and
 * so the same sheet can be looked at on a desktop by adding the class by hand.
 */
export function trackTouch(...roots: (HTMLElement | null | undefined)[]): void {
  if (typeof matchMedia !== 'function') return;
  const mq = matchMedia('(pointer: coarse)');
  const apply = () => {
    for (const el of roots) el?.classList.toggle('touch', mq.matches);
  };
  apply();
  mq.addEventListener('change', apply);
}

/**
 * Keep the app's box on the visible part of the page while the on-screen
 * keyboard is up (iOS Safari does not resize the layout viewport for it).
 *
 * Writes `--aw-vv-top` and `--aw-vv-h` on `<html>` through the CSSOM — the CSP
 * has no `unsafe-inline`, and the CSSOM is not inline style — and `aw-kbd` on
 * `<body>` while a keyboard is open, so the bottom safe-area inset can give way.
 * Where `visualViewport` is missing the page's own `100dvh` stands.
 */
export function trackViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const apply = () => {
    const frame = viewportFrame({ layoutHeight: window.innerHeight, height: vv.height, offsetTop: vv.offsetTop, scale: vv.scale });
    if (!frame) {
      root.style.removeProperty('--aw-vv-top');
      root.style.removeProperty('--aw-vv-h');
      document.body.classList.remove('aw-kbd');
      return;
    }
    root.style.setProperty('--aw-vv-top', `${frame.top}px`);
    root.style.setProperty('--aw-vv-h', `${frame.height}px`);
    document.body.classList.toggle('aw-kbd', frame.keyboard);
    // iOS scrolls the layout viewport to bring a focused field into view; the
    // app is fixed to the visual one, so there is nothing for the page to scroll.
    if (frame.keyboard && window.scrollY !== 0) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}

/**
 * A long-press on `selector` inside `root`, for what a right-click does on a
 * desktop (iOS Safari never sends `contextmenu`; Android Chrome does, which
 * the callers' own handlers still take). Touch pointers only: a mouse keeps its
 * own right-click.
 *
 * It cancels on movement (a scroll), release, or a second finger. When it
 * fires, the click that the release would produce is swallowed once, so the
 * row's own click handler does not also run.
 */
export function onLongPress(root: HTMLElement, selector: string, handler: (el: HTMLElement, x: number, y: number) => void): void {
  let timer: number | undefined;
  let start: { x: number; y: number } | undefined;
  let fired = false;

  const cancel = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    start = undefined;
  };

  root.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !e.isPrimary) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>(selector);
    if (!el) return;
    fired = false;
    start = { x: e.clientX, y: e.clientY };
    timer = window.setTimeout(() => {
      timer = undefined;
      fired = true;
      handler(el, start?.x ?? e.clientX, start?.y ?? e.clientY);
    }, LONG_PRESS_MS);
  });
  root.addEventListener('pointermove', (e: PointerEvent) => {
    if (start && movedPastSlop(e.clientX - start.x, e.clientY - start.y)) cancel();
  });
  root.addEventListener('pointerup', cancel);
  root.addEventListener('pointercancel', cancel);
  // Capture, so it runs before the pane's delegated click handler on the same node.
  root.addEventListener(
    'click',
    (e) => {
      if (!fired) return;
      fired = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
}
