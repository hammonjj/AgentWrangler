/**
 * Where a browser tab's transient overlays stack (#133): the notification
 * banner (`#awBanner`, drawn by the web shim) and the toasts (`#awToasts`).
 * Both used to be fixed to a corner of their own, and on a phone-width screen
 * they sat on top of each other. In the dock they are one column: the banner at
 * the bottom, toasts above it. The rules are in `theme/vscodeTokens.css`.
 */
export function overlayDock(): HTMLElement {
  let dock = document.getElementById('awDock');
  if (!dock) {
    dock = document.createElement('div');
    dock.id = 'awDock';
    document.body.appendChild(dock);
  }
  return dock;
}
