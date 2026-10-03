/**
 * The browser shell's toast host (#133): the one-liners `HostDialogs.flash`
 * produces ("Copied session id …"), and informational prompts with nothing to
 * choose. The Electron preload draws the window's own the same way, into the
 * same `#awToasts`; the rules for both are in `theme/vscodeTokens.css`.
 *
 * Classes only: the CSP has no `unsafe-inline`. The one length that is data —
 * how long this toast lives — is written through the CSSOM, which the CSP
 * allows, so the fade matches the removal.
 */

import { overlayDock } from '../common/overlayDock';

const DEFAULT_TIMEOUT_MS = 4000;
/** Older lines go first when a burst would stack past this. */
const MAX_TOASTS = 4;

function container(): HTMLElement {
  let host = document.getElementById('awToasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'awToasts';
    // Read out without taking focus: these report, they never ask.
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    overlayDock().appendChild(host);
  }
  return host;
}

export function showToast(text: string, timeoutMs = DEFAULT_TIMEOUT_MS): void {
  const host = container();
  const el = document.createElement('div');
  el.className = 'aw-toast';
  el.textContent = text;
  el.style.animationDuration = `${Math.max(1000, timeoutMs)}ms`;
  host.appendChild(el);
  while (host.childElementCount > MAX_TOASTS) host.firstElementChild?.remove();
  setTimeout(() => el.remove(), timeoutMs);
}
