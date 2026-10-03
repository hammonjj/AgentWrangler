/**
 * Preferences as a route of the browser workbench (#135): `#/preferences`.
 *
 * The same view the Electron window shows (`view.ts`), mounted into the app
 * shell's page and carried by the `preferences` pane of the one WebSocket, so a
 * setting changed from a phone is the same write, through the same gate, as one
 * changed in the window. The shell calls the mounter each time the page is shown.
 *
 * Imported for its side effect by the workbench bundle. Where there is no
 * shell (the Electron workbench window) nothing ever calls the mounter, and
 * the Preferences window is what opens.
 */

import type { HostToPreferences, PreferencesToHost } from '../../shared/preferences';
import { paneApi } from '../common/paneApi';
import { openRoute, registerPage } from '../common/shellBus';
import { mountPreferences } from './view';

const pane = paneApi<never>('preferences');

registerPage('preferences', (target) => {
  const root = document.createElement('div');
  target.appendChild(root);
  mountPreferences(root, {
    post: (message: PreferencesToHost) => pane.post(message),
    onMessage: (listener) => pane.onMessage((body) => listener(body as HostToPreferences)),
    onReconnect: (listener) => pane.onReconnect(listener),
    // No window to close: Escape goes back to the table.
    close: () => openRoute({ kind: 'agents' }),
  });
});
