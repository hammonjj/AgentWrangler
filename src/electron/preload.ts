/**
 * The preload: the only thing the renderer is given.
 *
 * `createWebviewBridge` already looks for `globalThis.agentWranglerHost` before
 * it falls back to `acquireVsCodeApi`, and it is called in exactly one place
 * (`src/webview/common/paneApi.ts`), so supplying that object is the entire
 * renderer-side port. The pane bundles are unchanged.
 *
 * Nothing else crosses. No `ipcRenderer`, no `require`, no filesystem: the
 * renderer renders other people's transcripts, and a bridge that handed it a
 * general-purpose channel would make every one of those a way in. The three
 * methods below are the whole surface.
 *
 * Node integration is off and context isolation is on, so this runs in its own
 * world. `window.postMessage` still reaches the page — same frame, different
 * context — which is how incoming messages arrive as the `message` events
 * `paneApi` already listens for.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { STATE_GET, STATE_SET, TO_HOST, TO_WEBVIEW, TOAST } from './channels';

/**
 * VSCode's `getState` is synchronous and the panes call it while they are
 * still evaluating, so the saved state has to be here before the bundle runs.
 * One blocking round trip at load is the price; there is no second one, since
 * every later read is served from this copy.
 */
let state: unknown = ipcRenderer.sendSync(STATE_GET) ?? undefined;

contextBridge.exposeInMainWorld('agentWranglerHost', {
  postMessage(message: unknown): void {
    ipcRenderer.send(TO_HOST, message);
  },
  getState(): unknown {
    return state;
  },
  setState(next: unknown): void {
    state = next;
    ipcRenderer.send(STATE_SET, next);
  },
});

ipcRenderer.on(TO_WEBVIEW, (_event, message: unknown) => {
  window.postMessage(message, '*');
});

/**
 * The transient one-liners `HostDialogs.flash` produces — "Copied session id
 * …", "that prompt has already been answered". VSCode has a status bar for
 * these; this window does not, so the shell grows one. Built here rather than
 * in a pane bundle because it belongs to the window, not to either pane, and
 * because neither pane should have to know it is running in an app.
 *
 * Classes, not inline styles: the CSP has no `unsafe-inline`, and these would
 * be dropped silently. The rules are in `vscodeTokens.css`.
 */
ipcRenderer.on(TOAST, (_event, text: string) => {
  const show = () => {
    let host = document.getElementById('awToasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'awToasts';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = 'aw-toast';
    el.textContent = text;
    host.appendChild(el);
    // Long enough to read a sentence, short enough not to stack up during a
    // burst. The class drives the fade; this only removes the node.
    setTimeout(() => el.remove(), 4000);
  };
  if (document.body) show();
  else window.addEventListener('DOMContentLoaded', show, { once: true });
});
