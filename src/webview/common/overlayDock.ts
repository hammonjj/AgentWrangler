/**
 * Where a browser tab's transient overlays stack (#133): the notification
 * banner (`#awBanner`, drawn by the web shim) and the toasts (`#awToasts`).
 * Both used to be fixed to a corner of their own, and on a phone-width screen
 * they sat on top of each other. In the dock they are one column: the banner at
 * the bottom, toasts above it. The rules are in `theme/vscodeTokens.css`.
 */
import { dockReserve } from '../../shared/phoneLayout';

export function overlayDock(): HTMLElement {
  let dock = document.getElementById('awDock');
  if (!dock) {
    dock = document.createElement('div');
    dock.id = 'awDock';
    document.body.appendChild(dock);
  }
  return dock;
}

/** The CSS variable the page's box pads its bottom by while the banner shows. */
export const DOCK_RESERVE_VAR = '--aw-dock-h';

let observed: { el: HTMLElement; ro: ResizeObserver } | undefined;

function writeReserve(px: number): void {
  const root = document.documentElement;
  if (px > 0) root.style.setProperty(DOCK_RESERVE_VAR, `${px}px`);
  else root.style.removeProperty(DOCK_RESERVE_VAR);
}

/**
 * Keep the page clear of the dock's banner (#134): the banner sits fixed at
 * the bottom, so without this it covers the composer and the end of whatever
 * page is open. Its height (plus a gap) is written into `--aw-dock-h` on
 * `<html>` through the CSSOM (the CSP allows that, not inline styles), and the
 * page's box adds it to its bottom padding. Toasts stack above the banner and
 * are not counted. Pass `undefined` when the banner goes.
 */
export function reserveDockSpace(banner: HTMLElement | undefined): void {
  if (observed && observed.el !== banner) {
    observed.ro.disconnect();
    observed = undefined;
  }
  if (!banner) {
    writeReserve(0);
    return;
  }
  if (observed || typeof ResizeObserver !== 'function') {
    writeReserve(dockReserve(banner.getBoundingClientRect().height));
    return;
  }
  // Fires for every change of the banner's box, including `display: none`
  // while the keyboard is up, which measures 0.
  const ro = new ResizeObserver(() => {
    writeReserve(banner.isConnected ? dockReserve(banner.getBoundingClientRect().height) : 0);
  });
  ro.observe(banner);
  observed = { el: banner, ro };
  writeReserve(dockReserve(banner.getBoundingClientRect().height));
}
