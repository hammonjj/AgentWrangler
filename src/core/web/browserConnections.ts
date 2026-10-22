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
 * it (#126). Run by the core daemon.
 */
import { createHash } from 'node:crypto';
import type { RawData } from 'ws';
import { Emitter, type Disposable } from '../events';
import { ownerContext, type RequestContext } from '../access';
import type { ClientRegistry } from '../clients';
import type { HostShell } from '../../host/hostServices';
import { CommandResults } from './commandResults';
import type { InteractionTracer } from './interactionTrace';
import { parseTraceId } from '../../shared/trace';
import { createShellChannel, type ShellConversation } from './shellChannel';
import { SHELL_PANE, WIRE_PROTOCOL, isCommandId, parseShellToHost, type AppActionName, type HostToShell } from '../../shared/shellProtocol';
import { MAX_ASSEMBLED_CHARS, MAX_SOCKET_MESSAGE_BYTES, PartAssembler, mb, parseWirePart } from '../../shared/wireParts';

/**
 * The part of a `ws` WebSocket a connection uses. A real socket from the listeners is one; the
 * remote-control relay (#173, `src/remote/relay/virtualSocket.ts`) supplies another, whose
 * bytes go through Supabase, so everything below is the same for both.
 */
export interface ClientSocket {
  readonly bufferedAmount: number;
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string): void;
  /**
   * `send`, saying where in the queue the message goes and which click (#190) is waiting on it.
   * A transport that queues behind a slow link (the relay) uses it so a reply to a click is not
   * stuck behind a transcript (#193); one that does not simply has no such method.
   */
  sendWith?(data: string, meta: SendMeta): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): unknown;
  on(event: 'pong' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (err?: unknown) => void): unknown;
}

/**
 * How soon a message needs to arrive, for a transport with a queue (#193). `interactive`: the
 * answer to something a person just did. `live`: a conversation as it happens, batched. `bulk`:
 * a whole table, a conversation's opening, a page of history, which may be overtaken.
 */
export type RelayLane = 'interactive' | 'live' | 'bulk';

export interface SendMeta {
  lane?: RelayLane;
  /** Messages of one stream (a pane) are never reordered; streams may overtake each other. */
  stream?: string;
  /** The correlation id of the click this reply is for (#190). */
  cid?: string;
}

const BULK_TYPES = new Set(['snapshot', 'init', 'archive', 'subagent', 'blockText', 'analyticsDetail']);
const LIVE_TYPES = new Set(['append', 'patch', 'composer', 'session']);
/** Anything this long is bulk whatever it is: a long line must not hold a click's reply behind it. */
const BULK_LINE_CHARS = 32 * 1024;

/** Which lane and stream an envelope belongs to. Unknown messages are interactive: small replies are the common case. */
export function classifyEnvelope(envelope: unknown, chars: number): SendMeta {
  const e = envelope as { pane?: unknown; body?: { type?: unknown } } | null;
  const stream = typeof e?.pane === 'string' ? e.pane : '*';
  const type = typeof e?.body?.type === 'string' ? e.body.type : '';
  if (chars > BULK_LINE_CHARS || (stream !== SHELL_PANE && BULK_TYPES.has(type))) return { lane: 'bulk', stream };
  if (stream !== SHELL_PANE && LIVE_TYPES.has(type)) return { lane: 'live', stream };
  return { lane: 'interactive', stream };
}

/** What carries a document's pane envelopes; the pane hosts are written against it. */
export interface EnvelopeTransport {
  postMessage(msg: unknown): PromiseLike<boolean>;
  onDidReceiveMessage(listener: (msg: unknown) => void): Disposable;
}

export interface BrowserPanes {
  dashboard: Disposable;
  conversation: ShellConversation & Disposable;
  /** The `#/preferences` route's host (#135). */
  preferences?: Disposable;
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
  /** Whether a folder a browser chose is one the folder browser may offer (#139); see `ShellChannelOptions`. */
  folderAllowed?(dir: string): Promise<boolean>;
  /** The Mac's own shell, for a loopback client's explicit "Open on this Mac" (#140). Never for a LAN one. */
  hostShell?: HostShell;
  /** A window-menu action a browser asked for (#146), with who asked. The callee authorises it. */
  appAction?(action: AppActionName, context: RequestContext): void;
  /** Shared by every connection, so a resend on a new one is recognised. */
  results?: CommandResults;
  limits?: Partial<ConnectionLimits>;
  /** Times a row click end to end (#190). Absent: nothing is traced. */
  tracer?: InteractionTracer;
}

export interface BrowserConnections extends Disposable {
  /** An upgraded socket from an authenticated device. Owned from here on. */
  attach(ws: ClientSocket, device: RequestContext): void;
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
  const connections = new Map<ClientSocket, () => void>();
  /** Each open socket's device, for revocation (#137). */
  const deviceOf = new Map<ClientSocket, string | undefined>();

  function attach(ws: ClientSocket, device: RequestContext): void {
    const incoming = new Emitter<unknown>();
    let open = true;
    let alive = true;
    const tracker = results.connection(device.deviceId ?? 'unknown');
    // The device cookie is the owner's, so the owner it is; the device and
    // connection ids are for the audit and for sending this browser's prompts,
    // toasts and navigation back to it (#126), never identity (#123).
    const connectionId = `web-${++connectionSeq}`;

    const tracer = opts.tracer;
    const transportKind = device.deviceScope === 'relay' ? 'relay' : 'lan';

    const sendNow = (envelope: unknown, cid?: string): boolean => {
      if (!open) return false;
      if (ws.bufferedAmount > limits.maxBufferedBytes) {
        log(`web: closing ${connectionId}: ${ws.bufferedAmount} bytes unsent`);
        close(1013, 'backpressure');
        return false;
      }
      const line = JSON.stringify(envelope);
      if (ws.sendWith) ws.sendWith(line, { ...classifyEnvelope(envelope, line.length), ...(cid ? { cid } : {}) });
      else ws.send(line);
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
        if (tracer) {
          const pane = m?.pane;
          const type = m?.body?.type;
          if (pane === SHELL_PANE && type === 'navigate') tracer.navigated(connectionId);
          else if (pane === 'conversation' && type === 'init') {
            // The reply a waiting click is for: it carries the click's id back to the page.
            const cid = tracer.awaiting(connectionId);
            if (cid) {
              tracer.initQueued(connectionId);
              return sendNow({ ...(msg as object), cid }, cid);
            }
          }
        }
        return sendNow(msg);
      },
      onDidReceiveMessage: (listener) => incoming.event(listener),
    };

    // First on the wire, before the panes can post anything.
    sendNow({ pane: SHELL_PANE, body: { type: 'hello', protocol: WIRE_PROTOCOL, build: opts.build() } satisfies HostToShell });

    // `deviceScope` rides along so the pane hosts' actions know where this tab is: pairing a
    // remote device (#174) is refused to anything but a loopback tab.
    const context = ownerContext('browser', {
      deviceId: device.deviceId,
      connectionId,
      ...(device.deviceScope ? { deviceScope: device.deviceScope } : {}),
    });
    let panes: BrowserPanes | undefined = opts.createPanes(transport, context);
    const shell = createShellChannel({
      connectionId,
      ...(opts.appAction ? { appAction: (action: AppActionName) => opts.appAction?.(action, context) } : {}),
      post: (envelope) => void transport.postMessage(envelope),
      conversation: () => panes?.conversation,
      ...(opts.folderAllowed ? { folderAllowed: opts.folderAllowed } : {}),
      kind: device.deviceScope === 'loopback' ? 'loopback' : 'lan',
      ...(opts.hostShell ? { hostShell: opts.hostShell } : {}),
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
        // The table is out of sight when the tab is hidden, or when the pane it lives in is: a
        // phone showing a conversation has no use for table snapshots (#191). `table` absent is
        // an older page, which has the table wherever it has the tab.
        snapshots.setHidden(m.hidden || m.table === false);
        return;
      }
      if (m.type === 'trace') {
        tracer?.complete(connectionId, m);
        return;
      }
      if (m.type === 'oversized') {
        log(`web: ${connectionId} did not send a ${m.label} of ${mb(m.chars)}: over the ${mb(MAX_ASSEMBLED_CHARS)} limit`);
        return;
      }
      if (m.type === 'reconnected') {
        log(`web: ${connectionId} (${transportKind}) is a tab back after its last socket closed (${m.reason}), down ${(m.downMs / 1000).toFixed(1)} s`);
        return;
      }
      shell.receive(body);
    };

    // A long envelope arrives as `shell.part`s (`shared/wireParts.ts`), joined here.
    const parts = new PartAssembler();

    const onMessage = (data: RawData, isBinary: boolean) => {
      alive = true;
      if (isBinary) return close(1003, 'text only');
      onText(rawText(data), false);
    };

    const onText = (text: string, joined: boolean) => {
      let msg: unknown;
      try {
        msg = JSON.parse(text);
      } catch {
        return close(1007, 'not JSON');
      }
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { pane?: unknown; body?: unknown; commandId?: unknown; cid?: unknown };
      if (m.pane === SHELL_PANE) {
        const part = parseWirePart(m.body);
        if (part) {
          // A joined envelope is a pane's; parts inside parts are not something the shim sends.
          if (joined) return;
          const r = parts.add(part);
          if (r.kind === 'refused') log(`web: ${connectionId} sent a ${r.label} of ${mb(r.chars)} in parts; dropped it: ${r.reason}`);
          else if (r.kind === 'done') {
            log(`web: ${connectionId} sent a ${r.label} of ${mb(r.line.length)} in ${r.count} parts`);
            onText(r.line, true);
          }
          return;
        }
        if ((m.body as { type?: unknown } | null)?.type === 'part') return;
        return onShell(m.body);
      }
      const cid = tracer ? parseTraceId(m.cid) : undefined;
      if (cid && tracer) tracer.begin(connectionId, cid, transportKind);
      // A pane that says `ready` has just (re)drawn from nothing: it is owed the table whatever
      // the last one said.
      if (m.pane === 'dashboard' && (m.body as { type?: unknown } | null)?.type === 'ready') snapshots.invalidate();
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
      tracer?.end(connectionId);
      snapshots.dispose();
      if (code !== undefined && ws.readyState === ws.OPEN) ws.close(code, reason);
      else ws.terminate();
      // Before the panes: whatever this browser was being asked resolves as cancelled.
      registration.dispose();
      shell.dispose();
      panes?.dashboard.dispose();
      panes?.conversation.dispose();
      panes?.preferences?.dispose();
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
    ws.on('error', (err?: unknown) => {
      // `ws` refused a message over `maxPayload` (and closes with 1009): say so, since the
      // tab's next socket will otherwise only report the code.
      const code = (err as { code?: unknown } | undefined)?.code;
      if (code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
        log(`web: ${connectionId} sent a message over the ${mb(MAX_SOCKET_MESSAGE_BYTES)} socket limit; closing it (1009)`);
      }
      close();
    });
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
  /** What the page was last sent, so a snapshot that says nothing new is not sent again (#191). */
  private sentPrint: string | undefined;
  /** Snapshots held back because they matched what was sent: the traffic this saved. */
  skipped = 0;

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

  /** The page has lost whatever it was showing (it re-initialised): the next snapshot is sent whatever it says. */
  invalidate(): void {
    this.sentPrint = undefined;
  }

  /** Hidden: the tab, or the pane the table is in. A page coming back gets the latest state at once. */
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
    const print = snapshotFingerprint(envelope);
    if (print !== undefined && print === this.sentPrint) {
      this.skipped++;
      return;
    }
    this.sentPrint = print;
    this.send(delayed ? restamp(envelope) : envelope);
  }
}

/**
 * Fields that change with the clock or the build of a snapshot rather than with what the table
 * shows. The page ages rows against its own clock, so `nowMs` is not needed to keep them right.
 */
const VOLATILE_SNAPSHOT_FIELDS: readonly string[] = ['nowMs'];

/**
 * A digest of what a snapshot says, ignoring `VOLATILE_SNAPSHOT_FIELDS`. Equal digests mean the
 * page already shows this table. Undefined for anything that is not an object (always sent).
 */
export function snapshotFingerprint(envelope: unknown): string | undefined {
  const body = (envelope as { body?: unknown } | null)?.body;
  if (!body || typeof body !== 'object') return undefined;
  const json = JSON.stringify(body, (key, value) => (VOLATILE_SNAPSHOT_FIELDS.includes(key) ? undefined : value));
  return createHash('sha1').update(json).digest('base64');
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
