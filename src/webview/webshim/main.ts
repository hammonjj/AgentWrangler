/**
 * Spike #120: the preload, for an ordinary browser.
 *
 * `createWebviewBridge` looks for `globalThis.agentWranglerHost` before
 * anything else, so supplying that object over a WebSocket is the whole
 * browser-side port — the same claim the Electron preload makes. This script is
 * loaded before the workbench bundle and must have defined the host by the time
 * `paneApi` evaluates.
 *
 * Served by `core/web/server.ts` (#127). What it does not do yet, on purpose:
 * resume a dropped connection (it reloads the page, and the panes re-initialise
 * from the host's `ready` replies), carry toasts, or answer host dialogs.
 */

interface Bridge {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

/**
 * View state is per browser, not per host: two devices may look at different
 * conversations with the divider in different places. `localStorage` is also
 * synchronous, which `getState` has to be.
 */
const STATE_KEY = 'aw.workbench.state';

function readState(): unknown {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

const outbox: string[] = [];
const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(`${scheme}//${location.host}/ws`);

socket.addEventListener('open', () => {
  for (const line of outbox.splice(0)) socket.send(line);
});
socket.addEventListener('message', (event) => {
  try {
    // Same delivery as the preload: a `message` event on the window, which is
    // what `paneApi.onMessage` listens for. Same-origin target, not `*`.
    window.postMessage(JSON.parse(String(event.data)), location.origin);
  } catch {
    // A frame that is not JSON is not ours.
  }
});
socket.addEventListener('close', () => {
  // The panes only send `ready` once, at load, so a fresh document is the
  // simplest way to get a fresh `init` and `snapshot` after a drop.
  setTimeout(() => location.reload(), 2000);
});

const host: Bridge = {
  postMessage(message) {
    const line = JSON.stringify(message);
    if (socket.readyState === WebSocket.OPEN) socket.send(line);
    else outbox.push(line);
  },
  getState: readState,
  setState(state) {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch {
      // Private browsing or a full quota: view state is a convenience.
    }
  },
};

(globalThis as { agentWranglerHost?: Bridge }).agentWranglerHost = host;
