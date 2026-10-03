/**
 * A browser connection as a `ClientChannel` (#126): prompts, toasts and
 * navigation over the connection's own `shell` envelopes.
 *
 * Transport-agnostic: it posts `{pane: 'shell', body}` through whatever
 * carries the connection's pane envelopes and is handed the `shell` bodies
 * that come back. `browserConnections.ts` (#128) wires it to each WebSocket;
 * the connection's own shell messages (`hello`, `ack`, `visibility`) are
 * handled there and never reach this.
 *
 * Navigation is applied here, to the connection's own `ConversationHost`:
 * a `SessionHandle` cannot cross a wire, and the pane host already knows how to
 * show one. The client is told with a `navigate` notice, for a layout that has
 * to bring its conversation forward.
 */
import * as path from 'node:path';
import type { Disposable } from '../events';
import type { HostShell } from '../../host/hostServices';
import type { SessionHandle } from '../session/sessionHandle';
import type { ClientChannel, ClientPrompt, NavigateTarget } from '../clients';
import type { AnalyticsDetail } from '../../shared/orchestration/analyticsView';
import { SHELL_PANE, parseShellToHost, type HostToShell, type ShellPrompt, type ShellPromptValue } from '../../shared/shellProtocol';
import type { NotificationState } from '../../shared/webCapabilities';

/** The connection's conversation pane, as navigation needs it. */
export interface ShellConversation {
  show(key: string): void;
  showSession(handle: SessionHandle): void;
  showDetail(detail: AnalyticsDetail): void;
}

export interface ShellChannelOptions {
  connectionId: string;
  /** Send one envelope down the connection. */
  post(envelope: { pane: typeof SHELL_PANE; body: HostToShell }): void;
  conversation(): ShellConversation | undefined;
  /**
   * Whether a folder a client chose may be used as a host path (#139). The
   * client's answer is only a string it sent, so it is checked against what the
   * folder browser may offer. Absent: no folder is accepted.
   */
  folderAllowed?(dir: string): Promise<boolean>;
  /** `loopback` may offer "Open on this Mac"; `lan` never acts on the host (#140). */
  kind: 'loopback' | 'lan';
  /**
   * The Mac's own shell, for a loopback client's explicit "Open on this Mac".
   * Never used for a `lan` client, whatever it sends, and never unasked.
   */
  hostShell?: HostShell;
}

/** What `showFile` / `showCommand` offered, so a `hostAction` can name it by id and nothing else. */
type Offer = { type: 'file'; path: string } | { type: 'command'; command: string; cwd: string; name: string };
const MAX_OFFERS = 32;
const nameOf = (p: string): string => path.basename(p) || p;

export interface ShellChannel extends Disposable {
  readonly channel: ClientChannel;
  /** A `shell` envelope's body from the client. Anything that is not a known answer is ignored. */
  receive(body: unknown): void;
}

export function createShellChannel(opts: ShellChannelOptions): ShellChannel {
  let open = true;
  let seq = 0;
  const pending = new Map<number, (value: ShellPromptValue) => void>();
  const send = (body: HostToShell) => {
    if (open) opts.post({ pane: SHELL_PANE, body });
  };

  /** One round trip. Resolves undefined if the connection closes first. */
  const ask = (prompt: ShellPrompt): Promise<ShellPromptValue> => {
    if (!open) return Promise.resolve(undefined);
    const id = ++seq;
    return new Promise<ShellPromptValue>((resolve) => {
      pending.set(id, resolve);
      send({ type: 'prompt', id, prompt });
    });
  };

  const prompt = async (request: ClientPrompt): Promise<ShellPromptValue> => {
    const { validateInput, ...wire } = request as ClientPrompt & { validateInput?: unknown };
    let next = wire as ShellPrompt;
    for (;;) {
      const value = await ask(next);
      if (next.kind === 'pickFolder') {
        return typeof value === 'string' && value && opts.folderAllowed && (await opts.folderAllowed(value)) ? value : undefined;
      }
      // A browser cannot run the check as the user types, so it runs on each
      // answer, and a refused one is asked again with the complaint showing
      // beside the original question (the modal marks the field invalid).
      if (next.kind !== 'input' || typeof value !== 'string' || typeof validateInput !== 'function') return value;
      const complaint = (validateInput as (v: string) => string | undefined)(value);
      if (complaint === undefined) return value;
      next = { ...next, error: complaint, value };
    }
  };

  const navigate = (target: NavigateTarget) => {
    const conversation = opts.conversation();
    switch (target.kind) {
      case 'open':
        send({ type: 'navigate', target: 'workbench' });
        return;
      case 'session':
        conversation?.show(target.key);
        send({ type: 'navigate', target: 'conversation', key: target.key });
        return;
      case 'tab':
        conversation?.show(target.key);
        send({ type: 'navigate', target: 'conversation', key: target.key });
        send({ type: 'toast', text: 'A conversation of its own is not available in the browser yet.' });
        return;
      case 'handle':
        conversation?.showSession(target.handle);
        send({ type: 'navigate', target: 'conversation' });
        return;
      case 'detail':
        conversation?.showDetail(target.detail);
        send({ type: 'navigate', target: 'conversation' });
        return;
    }
  };

  /** The tab's `Notification.permission`, as it last said (#141). Nothing is sent until it says `granted`. */
  let permission: NotificationState = 'unsupported';

  const canActOnHost = opts.kind === 'loopback' && opts.hostShell !== undefined;
  const offers = new Map<number, Offer>();
  let offerSeq = 0;
  const offer = (o: Offer): number => {
    const id = ++offerSeq;
    if (canActOnHost) {
      offers.set(id, o);
      if (offers.size > MAX_OFFERS) offers.delete(offers.keys().next().value as number);
    }
    return id;
  };

  const channel: ClientChannel = {
    connectionId: opts.connectionId,
    kind: opts.kind,
    get isOpen() {
      return open;
    },
    get canNotify() {
      return open && permission === 'granted';
    },
    notify: (notice) => {
      if (open && permission === 'granted') send({ type: 'notify', ...notice });
    },
    // In the browser that asked, never on the host.
    openUrl: (url) => {
      if (/^https?:\/\//i.test(url)) send({ type: 'openUrl', url });
    },
    showFile: ({ path, intent }) =>
      send({ type: 'showFile', id: offer({ type: 'file', path }), path, name: nameOf(path), intent, hostActions: canActOnHost }),
    showCommand: ({ command, cwd, name }) =>
      send({
        type: 'showCommand',
        id: offer({ type: 'command', command, cwd, name }),
        command,
        cwd,
        title: name,
        hostActions: canActOnHost,
      }),
    prompt,
    toast: (text, timeoutMs) => send({ type: 'toast', text, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }),
    navigate,
  };

  return {
    channel,
    receive(body) {
      const m = parseShellToHost(body);
      if (m?.type === 'notifications') {
        permission = m.permission;
        return;
      }
      if (m?.type === 'show') {
        // A tapped notification: this tab's conversation goes where it said.
        navigate({ kind: 'session', key: m.key });
        return;
      }
      if (m?.type === 'hostAction') {
        const o = canActOnHost ? offers.get(m.id) : undefined;
        const hostShell = opts.hostShell;
        if (!o || !hostShell) return;
        if (o.type === 'file' && m.action === 'open') hostShell.openFile(o.path);
        else if (o.type === 'file' && m.action === 'reveal') hostShell.revealInFileManager(o.path);
        else if (o.type === 'command' && m.action === 'run') hostShell.runInTerminal?.(o.command, { cwd: o.cwd, name: o.name });
        return;
      }
      if (m?.type !== 'promptResult') return;
      const resolve = pending.get(m.id);
      if (!resolve) return;
      pending.delete(m.id);
      resolve(m.value ?? undefined);
    },
    dispose() {
      if (!open) return;
      open = false;
      // A prompt whose connection dropped is cancelled, not left waiting.
      for (const resolve of pending.values()) resolve(undefined);
      pending.clear();
    },
  };
}
