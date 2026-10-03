/**
 * The `shell` channel (#126): what belongs to a client's document rather than
 * to one of its panes. Carried in the same `{pane, body}` envelope as pane
 * traffic, with `pane: 'shell'`, so the pane hosts ignore it.
 *
 * Today it carries the prompts, toasts and navigation that a client's own
 * requests cause (`src/core/clients.ts`). The app shell (#133) gives them
 * real modals and routes; the web prototype answers them with the browser's
 * own `confirm()` and `prompt()`.
 *
 * No Node or DOM imports: the server and the browser shim both use it.
 */

export const SHELL_PANE = 'shell';

/** A question a client is asked. Everything here is serialisable. */
export type ShellPrompt =
  | {
      kind: 'message';
      level: 'info' | 'warn' | 'error';
      message: string;
      detail?: string;
      /** The buttons, by label. Empty means a notice with only a way to dismiss it. */
      items: string[];
      modal?: boolean;
      defaultToCancel?: boolean;
    }
  | {
      kind: 'input';
      title?: string;
      prompt?: string;
      value?: string;
      placeHolder?: string;
      password?: boolean;
    }
  | {
      kind: 'pick';
      items: Array<{ label: string; description?: string; detail?: string }>;
      placeHolder?: string;
      matchOnDescription?: boolean;
      matchOnDetail?: boolean;
    }
  | {
      /** A folder on the machine the app runs on, never on the client's. */
      kind: 'pickFolder';
      openLabel?: string;
    };

/**
 * The answer to a prompt: a button label for `message`, the text for `input`
 * and `pickFolder`, the item's index for `pick`. `undefined` (or `null`, as
 * JSON has it) is cancelled.
 */
export type ShellPromptValue = string | number | undefined;

export type HostToShell =
  | { type: 'prompt'; id: number; prompt: ShellPrompt }
  /** A prompt the client no longer needs to answer: it was cancelled host-side. */
  | { type: 'promptCancel'; id: number }
  | { type: 'toast'; text: string; timeoutMs?: number }
  /**
   * The host has pointed this client's conversation pane somewhere. The pane
   * itself is updated by its own host; this tells the shell, so a layout that
   * hides the conversation (a phone) can bring it forward.
   */
  | { type: 'navigate'; target: 'conversation' | 'workbench'; key?: string }
  /**
   * The server's half of the handshake (#128), sent first on every connection.
   * A `build` other than the page's means the page is stale (left open across
   * an update): the client reloads, since the assets come from the same build.
   */
  | { type: 'hello'; protocol: number; build: string }
  /** These pane envelopes (by `commandId`) arrived; the client may forget them. */
  | { type: 'ack'; ids: string[] };

export type ShellToHost =
  | { type: 'promptResult'; id: number; value: string | number | null }
  /** The client's half of the handshake (#128): what it was loaded as. */
  | { type: 'hello'; protocol: number; build: string }
  /** The tab was hidden or shown: a hidden one gets the table less often (#128). */
  | { type: 'visibility'; hidden: boolean };

/** A shell message as it arrives off the wire, checked. */
export function parseShellToHost(body: unknown): ShellToHost | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const m = body as { type?: unknown; id?: unknown; value?: unknown; protocol?: unknown; build?: unknown; hidden?: unknown };
  if (m.type === 'hello') {
    if (typeof m.protocol !== 'number' || typeof m.build !== 'string') return undefined;
    return { type: 'hello', protocol: m.protocol, build: m.build };
  }
  if (m.type === 'visibility') return typeof m.hidden === 'boolean' ? { type: 'visibility', hidden: m.hidden } : undefined;
  if (m.type !== 'promptResult' || typeof m.id !== 'number' || !Number.isInteger(m.id)) return undefined;
  const value = m.value;
  if (value !== null && value !== undefined && typeof value !== 'string' && typeof value !== 'number') return undefined;
  return { type: 'promptResult', id: m.id, value: value ?? null };
}

// ---- the connection (#128, plan §7.2) ----

/**
 * The wire protocol's version. Bumped when an envelope or a shell message
 * changes shape incompatibly; a client that sees another one reloads.
 */
export const WIRE_PROTOCOL = 1;

/**
 * Every pane envelope a browser sends carries a `commandId`, unique per tab:
 * `{pane, body, commandId}`. The server acknowledges each one (`ack`), and a
 * mutating one it has already acted on is not acted on again: a resend after
 * a drop gets the first result instead. The Electron window ignores it.
 */
export interface PaneEnvelope {
  pane: string;
  body: unknown;
  commandId?: string;
}

/** A `commandId` the server will look at. Anything else is treated as absent. */
export function isCommandId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 128;
}

/**
 * Dispatched on `window` by the browser shim once a dropped connection is back
 * (new socket, handshake done). Each pane answers by sending `ready` again,
 * and the host replies with a fresh snapshot / init: no page reload.
 */
export const RECONNECT_EVENT = 'agentwrangler:reconnect';
