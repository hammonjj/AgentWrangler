/**
 * A browser's WebSocket, once `WebServer` has let it in (#128, plan §7): one
 * connection per tab, carrying the panes' `{pane, body}` envelopes and the
 * `shell` channel, with what a phone on flaky Wi-Fi needs on top.
 *
 * - **Handshake.** `shell.hello {protocol, build}` goes out first. A page from
 *   another build (left open across an update) reloads itself on seeing it.
 * - **Acks and exactly-once.** Every pane envelope from a browser carries a
 *   `commandId`; each is acknowledged (`shell.ack`, batched) so the client
 *   can forget it, and a mutating one already acted on is not acted on again
 *   when resent after a drop (`CommandResults`).
 * - **Backpressure.** A connection whose unsent bytes pass a ceiling is
 *   closed. Its client reconnects to a fresh snapshot rather than the server
 *   buffering a backlog it would only have to throw away.
 * - **Coalescing.** The table's snapshot (the whole table, ~85 KB) goes out
 *   at most once a second, and once every ten while the tab says it is hidden.
 *   Everything else goes straight through; a held snapshot is sent before any
 *   other table message, so their order is kept.
 * - **Liveness.** A ping every 30 s; a connection that has not answered the
 *   last one is dropped, so a phone that walked out of range does not keep its
 *   pane hosts forever.
 *
 * Each connection gets its own pane hosts (`createPanes`) and registers as a
 * client, so prompts, toasts and navigation its own clicks cause come back to
 * it (#126). No Electron here: the window's main process today and the daemon
 * later both run this.
 */
import type { RawData, WebSocket } from 'ws';
import { Emitter, type Disposable } from '../events';
import { ownerContext, type RequestContext } from '../access';
import type { ClientRegistry } from '../clients';
import { CommandResults } from './commandResults';
import { createShellChannel, type ShellConversation } from './shellChannel';
import { SHELL_PANE, WIRE_PROTOCOL, isCommandId, parseShellToHost, type HostToShell } from '../../shared/shellProtocol';

/** What carries a document's pane envelopes; the pane hosts are written against it. */
export interface EnvelopeTransport {
  postMessage(msg: unknown): PromiseLike<boolean>;
  onDidReceiveMessage(listener: (msg: unknown) => void): Disposable;
}

export interface BrowserPanes {
  dashboard: Disposable;
  conversation: ShellConversation & Disposable;
}

export interface ConnectionLimits {
  /** Unsent bytes past which a connection is closed (1013) and left to reconnect. */
  maxBufferedBytes: number;
  /** The table snapshot, at most once per this, while the tab is visible. */
  snapshotIntervalMs: number;
  /** ...and while it is hidden. */
  hiddenSnapshotIntervalMs: number;
  /** Ping period; a connection that missed the previous pong is dropped. 0: off. */
  pingIntervalMs: number;
}

export const DEFAULT_CONNECTION_LIMITS: ConnectionLimits = {
  // Two conversation inits (256 KB tail each) and a few snapshots, with room.
  maxBufferedBytes: 8 * 1024 * 1024,
  snapshotIntervalMs: 1_000,
  hiddenSnapshotIntervalMs: 10_000,
  pingIntervalMs: 30_000,
};

export interface BrowserConnectionsOptions {
  /** Each browser registers as a client, so what it causes comes back to it (#126). */
  clients: ClientRegistry;
  log: (line: string) => void;
  /** This connection's own table and conversation hosts, over its transport. */
  createPanes(transport: EnvelopeTransport, context: RequestContext): BrowserPanes;
  /**
   * Whether a pane message changes something (the access classifiers, #123).
   * Only those are remembered by `commandId`; a read is run again on a resend,
   * which is what a client that lost the answer wants.
   */
  isMutating(pane: string, body: unknown): boolean;
  /** The build the page's assets come from; a page from another one reloads. */
  build(): string;
  /** Shared by every connection, so a resend on a new one is recognised. */
  results?: CommandResults;
  limits?: Partial<ConnectionLimits>;
}

export interface BrowserConnections extends Disposable {
  /** An upgraded socket from an authenticated device. Owned from here on. */
  attach(ws: WebSocket, device: RequestContext): void;
  /**
   * Close every connection of a revoked device now (#137): its client
   * registrations go (and its prompts resolve as cancelled) and its pane hosts
   * are disposed in this call. The number closed.
   */
  closeDevice(deviceId: string): number;
  /** Open connections (tests, diagnostics). */
  readonly size: number;
}

/**
 * Per process, not per `createBrowserConnections`: the server is rebuilt when
 * the port changes, and a new connection must never reuse an id the registry
 * still holds for one that is closing.
 */
let connectionSeq = 0;

export function createBrowserConnections(opts: BrowserConnectionsOptions): BrowserConnections {
  const { clients, log } = opts;
  const limits: ConnectionLimits = { ...DEFAULT_CONNECTION_LIMITS, ...opts.limits };
  const results = opts.results ?? new CommandResults();
  /** Each open socket, and how to close it. */
  const connections = new Map<WebSocket, () => void>();
  /** Each open socket's device, for revocation (#137). */
  const deviceOf = new Map<WebSocket, string | undefined>();

  function attach(ws: WebSocket, device: RequestContext): void {
    const incoming = new Emitter<unknown>();
    let open = true;
    let alive = true;
    const tracker = results.connection(device.deviceId ?? 'unknown');
    // The device cookie is the owner's, so the owner it is; the device and
    // connection ids are for the audit and for sending this browser's prompts,
    // toasts and navigation back to it (#126), never identity (#123).
    const connectionId = `web-${++connectionSeq}`;

    const sendNow = (envelope: unknown): boolean => {
      if (!open) return false;
      if (ws.bufferedAmount > limits.maxBufferedBytes) {
        log(`web: closing ${connectionId}: ${ws.bufferedAmount} bytes unsent`);
        close(1013, 'backpressure');
        return false;
      }
      ws.send(JSON.stringify(envelope));
      return true;
    };

    const snapshots = new SnapshotCoalescer(sendNow, limits);

    const transport: EnvelopeTransport = {
      postMessage: async (msg) => {
        // Before the open check: a reply posted after its connection dropped is
        // still the result a resend on the next connection is owed.
        tracker.observe(msg);
        if (!open) return false;
        const m = msg as { pane?: unknown; body?: { type?: unknown } } | undefined;
        if (m?.pane === 'dashboard') {
          if (m.body?.type === 'snapshot') {
            snapshots.push(msg);
            return true;
          }
          // In order: whatever the table is told next may assume the snapshot before it.
          snapshots.flush();
        }
        return sendNow(msg);
      },
      onDidReceiveMessage: (listener) => incoming.event(listener),
    };

    // First on the wire, before the panes can post anything.
    sendNow({ pane: SHELL_PANE, body: { type: 'hello', protocol: WIRE_PROTOCOL, build: opts.build() } satisfies HostToShell });

    let panes: BrowserPanes | undefined = opts.createPanes(
      transport,
      ownerContext('browser', { deviceId: device.deviceId, connectionId }),
    );
    const shell = createShellChannel({
      connectionId,
      post: (envelope) => void transport.postMessage(envelope),
      conversation: () => panes?.conversation,
    });
    const registration = clients.register(shell.channel);
    const sendShell = (body: HostToShell) => sendNow({ pane: SHELL_PANE, body });

    // Acknowledged in batches: a burst of messages costs one frame back.
    let acks: string[] = [];
    let ackTimer: NodeJS.Immediate | undefined;
    const ack = (id: string) => {
      acks.push(id);
      ackTimer ??= setImmediate(() => {
        ackTimer = undefined;
        const ids = acks;
        acks = [];
        sendShell({ type: 'ack', ids });
      });
    };

    const onShell = (body: unknown) => {
      const m = parseShellToHost(body);
      if (!m) return;
      if (m.type === 'hello') {
        if (m.protocol !== WIRE_PROTOCOL || m.build !== opts.build()) {
          log(`web: ${connectionId} is a page from another build; it will reload`);
        }
        return;
      }
      if (m.type === 'visibility') {
        snapshots.setHidden(m.hidden);
        return;
      }
      shell.receive(body);
    };

    const onMessage = (data: RawData, isBinary: boolean) => {
      alive = true;
      if (isBinary) return close(1003, 'text only');
      let msg: unknown;
      try {
        msg = JSON.parse(rawText(data));
      } catch {
        return close(1007, 'not JSON');
      }
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { pane?: unknown; body?: unknown; commandId?: unknown };
      if (m.pane === SHELL_PANE) return onShell(m.body);
      if (isCommandId(m.commandId)) {
        ack(m.commandId);
        if (typeof m.pane === 'string' && opts.isMutating(m.pane, m.body)) {
          const replay = (envelope: unknown) => void transport.postMessage(envelope);
          if (!tracker.admit(m.commandId, m.pane, m.body, replay)) return;
        }
      }
      incoming.fire(msg);
    };

    const ping =
      limits.pingIntervalMs > 0
        ? setInterval(() => {
            if (!alive) {
              log(`web: ${connectionId} stopped answering; dropping it`);
              return close();
            }
            alive = false;
            ws.ping();
          }, limits.pingIntervalMs)
        : undefined;
    ping?.unref?.();

    function close(code?: number, reason?: string): void {
      if (!open) return;
      open = false;
      if (ping) clearInterval(ping);
      if (ackTimer) clearImmediate(ackTimer);
      snapshots.dispose();
      if (code !== undefined && ws.readyState === ws.OPEN) ws.close(code, reason);
      else ws.terminate();
      // Before the panes: whatever this browser was being asked resolves as cancelled.
      registration.dispose();
      shell.dispose();
      panes?.dashboard.dispose();
      panes?.conversation.dispose();
      panes = undefined;
      connections.delete(ws);
      deviceOf.delete(ws);
      log(`web: browser disconnected (${connections.size} open)`);
    }

    connections.set(ws, () => close(1001, 'going away'));
    deviceOf.set(ws, device.deviceId);
    log(`web: browser connected (${connections.size} open)`);

    ws.on('message', onMessage);
    ws.on('pong', () => {
      alive = true;
    });
    ws.on('close', () => close());
    ws.on('error', () => close());
  }

  return {
    attach,
    closeDevice: (deviceId) => {
      const mine = [...deviceOf].filter(([, id]) => id === deviceId).map(([ws]) => ws);
      for (const ws of mine) connections.get(ws)?.();
      return mine.length;
    },
    get size() {
      return connections.size;
    },
    dispose: () => {
      // Closed here, not on the sockets' later 'close' events, so every client
      // is unregistered (and its prompts cancelled) before this returns.
      for (const close of [...connections.values()]) close();
    },
  };
}

function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/**
 * The table, at most once per interval per connection. The latest snapshot
 * wins: one held back is replaced, never queued, since each is the whole table.
 */
export class SnapshotCoalescer implements Disposable {
  private last = Number.NEGATIVE_INFINITY;
  private pending: unknown;
  private timer: NodeJS.Timeout | undefined;
  private hidden = false;

  constructor(
    private readonly send: (envelope: unknown) => void,
    private readonly intervals: Pick<ConnectionLimits, 'snapshotIntervalMs' | 'hiddenSnapshotIntervalMs'>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  push(envelope: unknown): void {
    this.pending = envelope;
    this.schedule();
  }

  /** Send a held snapshot now: another table message is about to follow it. */
  flush(): void {
    if (this.pending !== undefined) this.emit(false);
  }

  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    // A tab coming back gets its table within the visible interval, not the hidden one.
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.schedule();
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }

  private schedule(): void {
    if (this.timer || this.pending === undefined) return;
    const interval = this.hidden ? this.intervals.hiddenSnapshotIntervalMs : this.intervals.snapshotIntervalMs;
    const wait = this.last + interval - this.now();
    if (wait <= 0) {
      this.emit(false);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.emit(true);
    }, wait);
  }

  private emit(delayed: boolean): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const envelope = this.pending;
    this.pending = undefined;
    if (envelope === undefined) return;
    this.last = this.now();
    this.send(delayed ? restamp(envelope) : envelope);
  }
}

/**
 * A held snapshot's `nowMs` is the host's clock when it was built; the table
 * measures elapsed times against it, so one sent later says when it was sent.
 */
function restamp(envelope: unknown): unknown {
  const e = envelope as { pane: unknown; body?: { nowMs?: unknown } };
  if (typeof e.body?.nowMs !== 'number') return envelope;
  return { ...e, body: { ...e.body, nowMs: Date.now() } };
}
