/**
 * The bridge a pane uses to talk to the extension host, and the reason the
 * dashboard and the conversation can share one webview.
 *
 * Three things are single-per-webview and would otherwise collide the moment
 * both panes run in one document:
 *
 * 1. **`acquireVsCodeApi()` may be called once.** The second call throws, which
 *    would kill whichever pane's module happened to evaluate second. It is
 *    called here, once, and both panes import the result.
 * 2. **`window.onmessage` is shared.** Every message reaches every listener, and
 *    the two protocols are not disjoint — `ready` and `openExternal` exist in
 *    both — so a pane cannot tell its own traffic apart by shape. Everything is
 *    therefore enveloped as `{ pane, body }` and each pane reads only its own.
 * 3. **`setState` is one slot.** The dashboard keeps `{collapsed, project, …}`
 *    and the conversation keeps `{key}`; last writer would win and silently
 *    erase the other. State is namespaced per pane under one object, with the
 *    divider position beside them.
 *
 * The envelope is used even when a pane is alone in its own panel (a pinned
 * conversation), so there is exactly one wire format to reason about rather
 * than one that depends on where the pane happens to be mounted.
 *
 * The host itself is reached through `createWebviewBridge`, which prefers an
 * `agentWranglerHost` injected by a preload script and falls back to
 * `acquireVsCodeApi`. That is the seam a desktop shell would use, and it is
 * here rather than at each call site because `acquireVsCodeApi` may only be
 * called once — so this module is the single place that knows what the host is.
 */

import { createWebviewBridge, type WebviewBridge } from '../../shared/webviewBridge';
import { RECONNECT_EVENT, SHELL_PANE, type HostToShell, type ShellToHost } from '../../shared/shellProtocol';

declare function acquireVsCodeApi(): WebviewBridge<WorkbenchState>;

/**
 * Once per webview. Both panes share this.
 *
 * Wrapped in a lambda rather than passed by name: outside VSCode there is no
 * `acquireVsCodeApi` binding at all, and evaluating the bare identifier throws
 * a `ReferenceError` before `createWebviewBridge` gets the chance to prefer the
 * host the preload injected. Inside the lambda it is only reached if there was
 * no such host, which is exactly when it does exist.
 */
const api = createWebviewBridge<WorkbenchState>(() => acquireVsCodeApi());

export type PaneName = 'dashboard' | 'conversation';

/** What `setState` holds: a slot per pane, plus the shared split. */
interface WorkbenchState {
  dashboard?: unknown;
  conversation?: unknown;
  /** Fraction of the width given to the table, 0–1. */
  split?: number;
}

function readAll(): WorkbenchState {
  const s = api.getState();
  return s && typeof s === 'object' ? (s as WorkbenchState) : {};
}

function writeAll(next: WorkbenchState): void {
  api.setState(next);
}

export interface PaneApi<S> {
  /** Send one of this pane's messages to the host. */
  post(body: unknown): void;
  /** Receive this pane's messages. Anything addressed to the other pane is ignored. */
  onMessage(listener: (body: unknown) => void): void;
  /**
   * The connection to the host dropped and is back (a browser, #128). The
   * host on the other end is a fresh one: send `ready` again. Never fires in
   * the window, whose host cannot drop.
   */
  onReconnect(listener: () => void): void;
  getState(): S | undefined;
  setState(state: S): void;
}

/**
 * Unique per document, so a resend after a drop can be recognised and not
 * acted on twice (#128). Every message gets one: the host decides which are
 * worth remembering.
 */
const tab = randomId();
let commandSeq = 0;

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function paneApi<S>(pane: PaneName): PaneApi<S> {
  return {
    post(body) {
      api.postMessage({ pane, body, commandId: `${tab}.${++commandSeq}` });
    },
    onReconnect(listener) {
      window.addEventListener(RECONNECT_EVENT, () => listener());
    },
    onMessage(listener) {
      window.addEventListener('message', (e: MessageEvent) => {
        const m = e.data as { pane?: PaneName; body?: unknown } | undefined;
        // Not an envelope, or not ours. Both are normal: the other pane's
        // traffic arrives here too, and VSCode sends its own messages.
        if (!m || typeof m !== 'object' || m.pane !== pane) return;
        listener(m.body);
      });
    },
    getState() {
      return readAll()[pane] as S | undefined;
    },
    setState(state) {
      writeAll({ ...readAll(), [pane]: state });
    },
  };
}

/**
 * The `shell` channel (#126), for the app shell (#133): prompts, toasts and
 * navigation addressed to this document rather than to a pane.
 *
 * Separate from `paneApi` because its envelopes carry no `commandId`: the
 * server never acknowledges a shell message, so one tracked for resending
 * would be resent forever, and a prompt is cancelled host-side when its
 * connection drops anyway. In the browser the shim delivers the host's shell
 * messages as `message` events like any pane's; the Electron window has no
 * shell channel yet and never sends one.
 */
export const shellApi = {
  post(body: ShellToHost): void {
    api.postMessage({ pane: SHELL_PANE, body });
  },
  onMessage(listener: (body: HostToShell) => void): void {
    window.addEventListener('message', (e: MessageEvent) => {
      const m = e.data as { pane?: unknown; body?: unknown } | undefined;
      if (!m || typeof m !== 'object' || m.pane !== SHELL_PANE) return;
      if (!m.body || typeof m.body !== 'object') return;
      listener(m.body as HostToShell);
    });
  },
  /** The connection dropped and is back: whatever the host was asking is cancelled. */
  onReconnect(listener: () => void): void {
    window.addEventListener(RECONNECT_EVENT, () => listener());
  },
};

/** The divider position, shared by the panes rather than owned by either. */
export const splitState = {
  get(): number | undefined {
    const v = readAll().split;
    return typeof v === 'number' && v > 0 && v < 1 ? v : undefined;
  },
  set(fraction: number): void {
    writeAll({ ...readAll(), split: fraction });
  },
};
