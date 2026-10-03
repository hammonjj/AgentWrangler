/**
 * Spike #120: the preload, for an ordinary browser.
 *
 * `createWebviewBridge` looks for `globalThis.agentWranglerHost` before
 * anything else, so supplying that object over a WebSocket is the whole
 * browser-side port — the same claim the Electron preload makes. This script is
 * loaded before the workbench bundle and must have defined the host by the time
 * `paneApi` evaluates.
 *
 * Prototype only (`AW_WEB_PROTOTYPE`). What it does not do yet, on purpose:
 * resume a dropped connection (it reloads the page, and the panes re-initialise
 * from the host's `ready` replies).
 *
 * It answers the `shell` channel (#126): prompts the host asks *this* browser,
 * toasts, and navigation notices. Prompts use the browser's own `confirm()`
 * and `prompt()` as a stopgap; the app shell (#133) replaces them with
 * in-page modals.
 */

import { SHELL_PANE, type HostToShell, type ShellPrompt, type ShellToHost } from '../../shared/shellProtocol';

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
  let message: unknown;
  try {
    message = JSON.parse(String(event.data));
  } catch {
    return; // A frame that is not JSON is not ours.
  }
  const envelope = message as { pane?: unknown; body?: unknown } | null;
  if (envelope && typeof envelope === 'object' && envelope.pane === SHELL_PANE) {
    // A native dialog blocks the page; let this frame's handler return first.
    setTimeout(() => onShell(envelope.body as HostToShell), 0);
    return;
  }
  // Same delivery as the preload: a `message` event on the window, which is
  // what `paneApi.onMessage` listens for. Same-origin target, not `*`.
  window.postMessage(message, location.origin);
});

function sendShell(body: ShellToHost): void {
  host.postMessage({ pane: SHELL_PANE, body });
}

function onShell(body: HostToShell | undefined): void {
  if (!body || typeof body !== 'object') return;
  switch (body.type) {
    case 'prompt':
      sendShell({ type: 'promptResult', id: body.id, value: answer(body.prompt) ?? null });
      return;
    case 'toast':
      toast(body.text, body.timeoutMs);
      return;
    case 'navigate':
      // The conversation pane has already been pointed there by its host; on a
      // layout where it can be out of view, bring it in.
      if (body.target === 'conversation') document.getElementById('wbConv')?.scrollIntoView({ block: 'nearest' });
      return;
    case 'promptCancel':
      // A native dialog cannot be closed from script; its answer is ignored.
      return;
  }
}

/** A numbered list for `prompt()`, answered by number. Undefined for cancelled or out of range. */
function chooseByNumber(heading: string, labels: string[]): number | undefined {
  const lines = labels.map((label, i) => `${i + 1}. ${label}`);
  const raw = window.prompt(`${heading}\n\n${lines.join('\n')}\n\nType a number:`, '1');
  const n = raw === null ? NaN : Number(raw.trim());
  return Number.isInteger(n) && n >= 1 && n <= labels.length ? n - 1 : undefined;
}

/** The stopgap: the browser's own dialogs. */
function answer(p: ShellPrompt): string | number | undefined {
  switch (p.kind) {
    case 'message': {
      const text = p.detail ? `${p.message}\n\n${p.detail}` : p.message;
      if (p.items.length === 0) {
        toast(p.message);
        return undefined;
      }
      if (p.items.length === 1) return window.confirm(`${text}\n\nOK: ${p.items[0]}`) ? p.items[0] : undefined;
      const i = chooseByNumber(text, p.items);
      return i === undefined ? undefined : p.items[i];
    }
    case 'input': {
      // A password shows as typed in `prompt()`; acceptable only because this
      // is the prototype on loopback, and #133 replaces it with a masked field.
      const heading = [p.title, p.prompt ?? p.placeHolder].filter(Boolean).join('\n');
      return window.prompt(heading || 'Enter a value', p.value ?? '') ?? undefined;
    }
    case 'pick':
      return chooseByNumber(
        p.placeHolder ?? 'Choose one',
        p.items.map((item) => (item.description ? `${item.label} — ${item.description}` : item.label)),
      );
    case 'pickFolder': {
      const raw = window.prompt(`${p.openLabel ?? 'Folder'}: a path on the Mac running Agent Wrangler`, '');
      return raw?.trim() || undefined;
    }
  }
}

/** One line of feedback, as the Electron preload draws it. Classes only: the CSP has no inline styles. */
function toast(text: string, timeoutMs = 4000): void {
  const show = () => {
    let toasts = document.getElementById('awToasts');
    if (!toasts) {
      toasts = document.createElement('div');
      toasts.id = 'awToasts';
      document.body.appendChild(toasts);
    }
    const el = document.createElement('div');
    el.className = 'aw-toast';
    el.textContent = text;
    toasts.appendChild(el);
    setTimeout(() => el.remove(), timeoutMs);
  };
  if (document.body) show();
  else window.addEventListener('DOMContentLoaded', show, { once: true });
}
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
