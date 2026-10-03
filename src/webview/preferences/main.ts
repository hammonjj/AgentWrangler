/**
 * The Preferences window's own document (Electron): the shared view over the
 * preload's bridge. The browser workbench mounts the same view as a route
 * instead (`pane.ts`).
 */

import { createWebviewBridge, type WebviewBridge } from '../../shared/webviewBridge';
import type { HostToPreferences, PreferencesToHost } from '../../shared/preferences';
import { mountPreferences } from './view';

declare function acquireVsCodeApi(): WebviewBridge<unknown>;

// See `paneApi.ts` for why this is a lambda and not the bare identifier.
const host = createWebviewBridge<unknown>(() => acquireVsCodeApi());

const root = document.getElementById('prefsApp');
if (root) {
  mountPreferences(root, {
    post: (message: PreferencesToHost) => host.postMessage(message),
    onMessage: (listener) =>
      // The window has one thing in it, so its messages are not enveloped.
      window.addEventListener('message', (event: MessageEvent) => {
        if (event.data) listener(event.data as HostToPreferences);
      }),
    close: () => host.postMessage({ type: 'close' } satisfies PreferencesToHost),
  });
}
