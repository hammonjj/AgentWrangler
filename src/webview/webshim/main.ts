/**
 * Spike #120: the preload, for an ordinary browser.
 *
 * `createWebviewBridge` looks for `globalThis.agentWranglerHost` before
 * anything else, so supplying that object over a WebSocket is the whole
 * browser-side port — the same claim the Electron preload makes. This script is
 * loaded before the workbench bundle and must have defined the host by the time
 * `paneApi` evaluates.
 *
 * Served by `core/web/server.ts` (#127); the other end of the socket is
 * `core/web/browserConnections.ts` (#128, plan §7.2):
 *
 * - **Handshake.** Both sides say `hello {protocol, build}`. A server on
 *   another build than this page (`<meta name="aw-build">`) means the page is
 *   stale, and it reloads; that is the only time it does.
 * - **Reconnect.** A dropped socket is reopened with backoff (0.5 s doubling
 *   to 10 s, jittered; at once when the tab comes back or the network does).
 *   Once the handshake is done the panes are told (`RECONNECT_EVENT`) and send
 *   `ready` again, so the table and the same conversation come back in place.
 * - **Resend.** Every pane envelope carries a `commandId` (`paneApi`). Each is
 *   kept until the server acknowledges it, and those not acknowledged when the
 *   socket dropped are sent again on the next one. The server acts on a
 *   mutating one once however often it arrives.
 * - **Visibility.** The tab says when it is hidden, and gets the table less often.
 *
 * It answers the `shell` channel (#126): prompts the host asks *this* browser,
 * toasts, and navigation notices. Prompts use the browser's own `confirm()`
 * and `prompt()` as a stopgap; the app shell (#133) replaces them with
 * in-page modals.
 */

import {
  RECONNECT_EVENT,
  SHELL_PANE,
  WIRE_PROTOCOL,
  isCommandId,
  parseShellNotice,
  type HostToShell,
  type ShellPrompt,
  type ShellToHost,
} from '../../shared/shellProtocol';
import { NoticeDeduper, secureContextProblem, shouldShowNotice, type NotificationState } from '../../shared/webCapabilities';

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

// ---- the connection ----

/** The build this page was served as; the server's `hello` must match it. */
const BUILD = document.querySelector<HTMLMetaElement>('meta[name="aw-build"]')?.content ?? '';
const SOCKET_URL = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
const BACKOFF_FIRST_MS = 500;
const BACKOFF_MAX_MS = 10_000;
/** Envelopes kept for resending. A tab offline for long enough loses the oldest. */
const MAX_UNACKED = 500;
/** After this many attempts that never opened, check whether the device is still signed in. */
const AUTH_PROBE_AFTER = 3;

interface Unacked {
  line: string;
  /** A pane's `ready`: never resent, since every pane sends a fresh one on reconnect. */
  ready: boolean;
}

/** Pane envelopes the server has not acknowledged, by commandId, oldest first. */
const unacked = new Map<string, Unacked>();
let socket: WebSocket | undefined;
/** The current socket has opened and the server's `hello` matched. */
let live = false;
/** Some earlier socket got that far: the next handshake is a reconnect. */
let connectedBefore = false;
let attempt = 0;
let failedOpens = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function connect(): void {
  retryTimer = undefined;
  const ws = new WebSocket(SOCKET_URL);
  socket = ws;
  let opened = false;
  ws.addEventListener('open', () => {
    opened = true;
    failedOpens = 0;
    sendRaw({ pane: SHELL_PANE, body: { type: 'hello', protocol: WIRE_PROTOCOL, build: BUILD } });
  });
  ws.addEventListener('message', (event) => {
    if (socket === ws) onFrame(String(event.data));
  });
  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    socket = undefined;
    live = false;
    if (!opened) failedOpens++;
    scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  if (retryTimer !== undefined) return;
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** attempt);
  attempt++;
  // Jittered, so every tab of a restarted server does not come back in step.
  const delay = ceiling / 2 + Math.random() * (ceiling / 2);
  retryTimer = setTimeout(() => void reconnect(), delay);
}

async function reconnect(): Promise<void> {
  // A server that answers but will not upgrade us has most likely signed this
  // device out; the page itself says so, and how to sign in again.
  if (failedOpens >= AUTH_PROBE_AFTER) {
    try {
      const res = await fetch('/', { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' });
      if (res.status === 401) {
        location.reload();
        return;
      }
    } catch {
      // Not reachable at all: keep trying.
    }
  }
  connect();
}

/** Waiting to reconnect, and there is reason to think it would work now: try at once. */
function reconnectNow(): void {
  if (socket || retryTimer === undefined) return;
  clearTimeout(retryTimer);
  retryTimer = undefined;
  attempt = 0;
  void reconnect();
}
window.addEventListener('online', reconnectNow);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) reconnectNow();
  if (live) {
    sendRaw({ pane: SHELL_PANE, body: { type: 'visibility', hidden: document.hidden } });
    // The permission may have been changed in the browser's settings meanwhile.
    reportNotifications();
    renderBanner();
  }
});

function sendRaw(envelope: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(envelope));
}

/** The server's `hello`: on this build, the connection is live; on another, reload. */
function onHello(protocol: number, build: string): void {
  if (protocol !== WIRE_PROTOCOL || build !== BUILD) {
    location.reload();
    return;
  }
  live = true;
  attempt = 0;
  sendRaw({ pane: SHELL_PANE, body: { type: 'visibility', hidden: document.hidden } });
  reportNotifications();
  // What was not acknowledged before the drop. A pane's old `ready` is
  // dropped: each pane sends a new one now, ahead of anything resent, so the
  // conversation is bound again before a resent `send` arrives for it.
  // The first connection sends the `ready`s the panes queued while it opened.
  const reconnecting = connectedBefore;
  connectedBefore = true;
  const resend = [...unacked].filter(([id, u]) => {
    if (!reconnecting || !u.ready) return true;
    unacked.delete(id);
    return false;
  });
  if (reconnecting) window.dispatchEvent(new Event(RECONNECT_EVENT));
  for (const [id, u] of resend) if (unacked.has(id) && socket) socket.send(u.line);
}

function onFrame(data: string): void {
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return; // A frame that is not JSON is not ours.
  }
  const envelope = message as { pane?: unknown; body?: unknown } | null;
  if (!envelope || typeof envelope !== 'object') return;
  if (envelope.pane === SHELL_PANE) {
    const body = envelope.body as HostToShell | undefined;
    if (body?.type === 'hello') return onHello(body.protocol, body.build);
    if (body?.type === 'ack') {
      for (const id of body.ids) unacked.delete(id);
      return;
    }
    // A native dialog blocks the page; let this frame's handler return first.
    setTimeout(() => onShell(body), 0);
    return;
  }
  // Same delivery as the preload: a `message` event on the window, which is
  // what `paneApi.onMessage` listens for. Same-origin target, not `*`.
  window.postMessage(message, location.origin);
}

function sendShell(body: ShellToHost): void {
  // Not kept for a resend: a prompt is cancelled server-side when its socket drops.
  if (live) sendRaw({ pane: SHELL_PANE, body });
}

function onShell(body: HostToShell | undefined): void {
  if (!body || typeof body !== 'object') return;
  switch (body.type) {
    case 'hello':
    case 'ack':
      return; // handled as they arrive
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
    case 'notify':
      showNotice(body);
      return;
  }
}

// ---- notifications (#141) ----

/** The panes ask which microphone to use by looking at this. */
document.documentElement.dataset.awHost = 'browser';

const deduper = new NoticeDeduper();

/** Why notifications cannot work in this page, or undefined. Computed once: a page does not become secure. */
const insecureReason = secureContextProblem({
  isSecureContext: window.isSecureContext,
  protocol: location.protocol,
  hostname: location.hostname,
});

function notificationState(): NotificationState {
  if (insecureReason || typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/** Tell the host what this tab can do; it sends notices only to a tab that said `granted`. */
function reportNotifications(): void {
  sendShell({ type: 'notifications', permission: notificationState() });
}

/**
 * A "needs you" notice from the host. Shown only while the user is not
 * looking at this page; the tag collapses the same ask arriving twice, here
 * and in the browser's own notification list.
 */
function showNotice(raw: HostToShell): void {
  const notice = parseShellNotice(raw);
  if (!notice) return;
  const state = {
    permission: notificationState(),
    hidden: document.hidden,
    focused: document.hasFocus(),
  };
  if (!shouldShowNotice(state) || !deduper.first(notice.tag, Date.now())) return;
  try {
    const n = new Notification(notice.title, { body: notice.body, tag: notice.tag });
    n.onclick = () => {
      window.focus();
      n.close();
      // The same flow as a click in the table: the host points this tab's conversation at it.
      if (notice.sessionKey) sendShell({ type: 'show', key: notice.sessionKey });
    };
  } catch {
    // Some mobile browsers refuse `new Notification()` outside a service worker.
  }
}

/** One line: "Enable notifications" while permission can still be asked, or why it cannot be here. */
function renderBanner(): void {
  const state = notificationState();
  let banner = document.getElementById('awBanner');
  const wanted = insecureReason !== undefined || state === 'default';
  if (!wanted) {
    banner?.remove();
    return;
  }
  if (banner) return;
  banner = document.createElement('div');
  banner.id = 'awBanner';
  banner.setAttribute('role', 'status');
  const label = document.createElement('span');
  banner.appendChild(label);
  if (insecureReason) {
    label.textContent = insecureReason;
  } else {
    label.textContent = 'Get a notification when an agent needs you.';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Enable notifications';
    // A user gesture: browsers only show the permission prompt for one.
    button.addEventListener('click', () => {
      void Notification.requestPermission().then(() => {
        reportNotifications();
        renderBanner();
      });
    });
    banner.appendChild(button);
  }
  document.body.appendChild(banner);
}

if (document.body) renderBanner();
else window.addEventListener('DOMContentLoaded', renderBanner, { once: true });

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
      // is loopback-only for now, and #133 replaces it with a masked field.
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
const host: Bridge = {
  postMessage(message) {
    const line = JSON.stringify(message);
    const m = message as { commandId?: unknown; body?: { type?: unknown } } | null;
    // Every pane envelope has an id (`paneApi`); kept until acknowledged, so a
    // drop between sending and arriving is made good on the next socket.
    if (m && isCommandId(m.commandId)) {
      unacked.set(m.commandId, { line, ready: m.body?.type === 'ready' });
      while (unacked.size > MAX_UNACKED) unacked.delete(unacked.keys().next().value as string);
    }
    if (live && socket?.readyState === WebSocket.OPEN) socket.send(line);
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
connect();
