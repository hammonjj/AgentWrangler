/**
 * The core's end of a session host: `ClaudeExecution` over a Unix socket.
 *
 * `RunnerView` sits on this exactly as it sits on an in-process
 * `ClaudeSdkSession`: host events in, commands out. What this adds is the
 * link: connecting (and waiting for a new host to come up), authenticating,
 * catching up, following, reconnecting while the host lives, and noticing
 * when it has gone (playbook §5.1, §9).
 *
 * **Catching up** always has the same shape, on first connect, on reconnect
 * and after a `resync`: take a snapshot, page the held events with `events`
 * (never more than a page at a time; spike S3), hand over what the view has
 * not seen, reconcile with the snapshot, then `subscribe` from where the
 * paging stopped, which leaves only a small tail to replay. The snapshot is
 * authoritative for the host's state, its pending asks and its exit: after
 * every catch-up the view is told the state, given any pending ask it lacks,
 * and told of any ask it holds that the host no longer does.
 *
 * **Adopting** a host a previous run of the app left behind adds a filter to
 * the first catch-up. The transcript already holds most of the conversation
 * and is the view's history; SDK message uuids are transcript uuids (spike
 * S1). So everything in the ring up to and including the last message the
 * transcript read contains is left out, as are messages from an earlier
 * conversation id (a `/clear` inside the ring) and stream deltas of messages
 * that have since completed.
 */
import * as net from 'node:net';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Emitter, type Disposable } from '../events';
import { NdjsonPeer, RpcRemoteError } from '../rpc/ndjsonPeer';
import { isSameProcessAlive } from '../procStart';
import {
  CAPABILITY_CONFIGURE_IDLE,
  CLIENT_CAPABILITY_PASSIVE,
  HOST_PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  MAX_PAGE_BYTES,
  RPC_PROTOCOL_MISMATCH,
  RPC_RESYNC,
  RPC_UNAUTHORIZED,
  emptyHostState,
  reduceHostSnapshot,
  type ControlRequest,
  type EventsResult,
  type HelloResult,
  type HostEvent,
  type HostEventBody,
  type HostExit,
  type HostSnapshot,
  type RawAsk,
  type RawPermissionResult,
  type RespondOutcome,
  type SendResult,
} from '../../shared/sessionProtocol';

/** The state of the link, which `RunnerView` shows as `connecting` / `unreachable`. */
export type LinkState = 'connecting' | 'live' | 'unreachable';

export interface HostClientOptions {
  hostId: string;
  socketPath: string;
  token: string;
  cwd: string;
  startedAt: number;
  /** Known once the host has written its manifest; checked before each reconnect. */
  hostPid?: () => number | undefined;
  hostStartTime?: () => string | undefined;
  /** The host's exit record, if its manifest has one: tells "exited" from "lost" when the socket is gone. */
  readTombstone?: () => HostExit | undefined;
  /** `spawn`: a host this client started. `adopt`: one a previous run left behind (see the header). */
  mode: 'spawn' | 'adopt';
  /** Adopt only: uuids in the part of the transcript the view's history was read from. */
  transcriptUuids?: Promise<Set<string>>;
  /** Spawn only: resolves once the host is up (its manifest exists), rejects if it never comes up. */
  hostReady?: Promise<void>;
  build: string;
  log: (msg: string) => void;
  /** The idle-orphan rule's hours, pushed to a host that takes `configure` on every connect. */
  orphanIdleHours?: () => number;
  /** Follow without counting as someone looking (the remote daemon): see `CLIENT_CAPABILITY_PASSIVE`. */
  passive?: boolean;
  /** Heartbeat and waits, injectable for tests. */
  pingIntervalMs?: number;
  pingMisses?: number;
  readyTimeoutMs?: number;
}

const DEFAULT_PING_MS = 10_000;
const DEFAULT_MISSES = 3;
const DEFAULT_READY_MS = 15_000;
const RECONNECT_FIRST_MS = 250;
const RECONNECT_MAX_MS = 5_000;
/** Catch-up attempts before giving the connection up (the ring kept moving under the paging). */
const CATCH_UP_ATTEMPTS = 3;

/** An error that retrying cannot fix: the wrong token, or a protocol this build does not speak. */
class FatalLinkError extends Error {}

export class HostClient {
  readonly cwd: string;
  readonly startedAt: number;
  hello?: HelloResult;

  /** A host runs one `Query` for its whole life, across core restarts: its id names the execution. */
  get executionId(): string {
    return this.opts.hostId;
  }

  private peer?: NdjsonPeer;
  private socket?: net.Socket;
  /** The host's state as this client knows it: the last snapshot, plus every event since. */
  private snap: HostSnapshot;
  private listeners = new Set<(event: HostEvent) => void>();
  private link = new Emitter<LinkState>();
  private linkState: LinkState = 'connecting';
  /** Highest host seq handed to listeners (or deliberately skipped). */
  private lastSeq = 0;
  /** Asks the listeners were told of and not yet told were settled. */
  private knownAsks = new Map<string, RawAsk>();
  private exitDelivered = false;
  private connectedOnce = false;
  private detached = false;
  private gaveUp = false;
  /** While catching up, live events are held here and handed over once the catch-up is done. */
  private buffer?: HostEvent[];
  private readyWaiters: (() => void)[] = [];
  private pingTimer?: ReturnType<typeof setTimeout>;
  private misses = 0;
  private reconnectDelay = RECONNECT_FIRST_MS;
  private skipUuids?: Set<string>;

  constructor(private opts: HostClientOptions) {
    this.cwd = opts.cwd;
    this.startedAt = opts.startedAt;
    this.snap = { ...emptyHostState(), epoch: '', ring: { fromSeq: 0, truncated: false } };
  }

  // ---- ClaudeExecution ----

  snapshot(): HostSnapshot {
    return { ...this.snap, pendingAsks: [...this.snap.pendingAsks] };
  }

  /** Events from now on. A remote client catches up itself (see the header), so `fromSeq` is ignored. */
  subscribe(_fromSeq: number, listener: (event: HostEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  onLink(listener: (state: LinkState) => void): Disposable {
    return this.link.event(listener);
  }

  /** Begin: wait for the host (spawn) and connect. The host starts its agent itself. */
  start(): void {
    void this.connectLoop();
  }

  /** Throws when the host cannot be reached: the view keeps the draft and says so. */
  async send(message: SDKUserMessage): Promise<SendResult> {
    return this.call<SendResult>('send', { message });
  }

  /** Throws when the host cannot be reached: the card stays answerable rather than being called gone. */
  async respondAsk(requestId: string, result: RawPermissionResult): Promise<RespondOutcome> {
    return (await this.call<{ outcome: RespondOutcome }>('respondAsk', { requestId, result })).outcome;
  }

  async control(req: ControlRequest): Promise<unknown> {
    return (await this.call<{ result: unknown }>('control', req)).result;
  }

  /**
   * End the agent (the host runs the §7.1 sequence; the host exits by itself
   * afterwards) and wait for it. If the host cannot be asked, it is sent
   * SIGTERM instead (checked against its recorded start time), which ends its
   * agent the same way a logout would.
   */
  async end(opts: { graceMs?: number } = {}): Promise<void> {
    if (this.exitDelivered) return;
    try {
      await this.call('end', opts.graceMs === undefined ? {} : { graceMs: opts.graceMs }, 30_000);
    } catch (err) {
      this.opts.log(`host ${this.opts.hostId}: end over the socket failed (${String(err)}); signalling the host`);
      const pid = this.opts.hostPid?.();
      if (pid !== undefined && isSameProcessAlive(pid, this.opts.hostStartTime?.())) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // gone meanwhile
        }
      }
    }
  }

  /**
   * The host runs an older (or other) build than this app (§7.4). Known once
   * connected; a host this client started is always current.
   */
  get outdated(): boolean {
    return this.hello !== undefined && this.hello.hostBuild !== this.opts.build;
  }

  /** The host's build, once connected. */
  get hostBuild(): string | undefined {
    return this.hello?.hostBuild;
  }

  /**
   * The machine woke up (`powerMonitor` `resume`). Pings missed across the
   * sleep say nothing about the host: forget them and let one fresh ping
   * decide (§8 "Machine sleeps").
   */
  wake(): void {
    this.misses = 0;
    if (this.detached || this.exitDelivered) return;
    if (this.peer) {
      clearTimeout(this.pingTimer);
      void this.ping(this.opts.pingIntervalMs ?? DEFAULT_PING_MS);
    }
  }

  /**
   * Wait, up to `ms`, for the host process itself to be gone (checked by pid
   * and start time). A host exits only after its agent has, so this is how a
   * caller knows the `claude` is gone too. True if it is.
   */
  async waitGone(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    const pid = this.opts.hostPid?.();
    if (pid === undefined) return true;
    while (isSameProcessAlive(pid, this.opts.hostStartTime?.())) {
      if (Date.now() > deadline) return false;
      await sleep(100);
    }
    return true;
  }

  /** Push the settings a host applies on its own (the idle-orphan rule), if it takes them. */
  async configure(): Promise<void> {
    const peer = this.peer;
    if (!peer || !this.hello?.capabilities.includes(CAPABILITY_CONFIGURE_IDLE) || !this.opts.orphanIdleHours) return;
    try {
      await peer.request('configure', { orphanIdleHours: this.opts.orphanIdleHours() }, { timeoutMs: 10_000 });
    } catch (err) {
      this.opts.log(`host ${this.opts.hostId}: configure failed (${String(err)})`);
    }
  }

  /** Stop following without touching the host: the app is quitting and the session keeps running. */
  detach(): void {
    this.detached = true;
    clearTimeout(this.pingTimer);
    this.peer?.close(new Error('detached'));
    this.socket?.destroy();
    this.wakeReady();
  }

  // ---- calls ----

  private async call<T>(method: string, params: unknown, timeoutMs = 15_000): Promise<T> {
    if (!this.peer) await this.waitReady(this.opts.readyTimeoutMs ?? DEFAULT_READY_MS);
    const peer = this.peer;
    if (!peer || peer.isClosed) throw new Error('not connected to the session host');
    return peer.request<T>(method, params, { timeoutMs });
  }

  private waitReady(ms: number): Promise<void> {
    if (this.peer || this.detached || this.exitDelivered || this.gaveUp) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.readyWaiters.push(done);
    });
  }

  private wakeReady(): void {
    const waiters = this.readyWaiters.splice(0);
    for (const w of waiters) w();
  }

  private setLink(state: LinkState): void {
    if (this.linkState === state) return;
    this.linkState = state;
    this.link.fire(state);
  }

  // ---- the link ----

  private async connectLoop(): Promise<void> {
    if (this.opts.hostReady) {
      try {
        await this.opts.hostReady;
      } catch (err) {
        this.deliverSynthetic({
          type: 'exit',
          exit: { reason: 'error', error: `Could not start the session host: ${err instanceof Error ? err.message : String(err)}` },
        });
        return;
      }
    }
    if (this.opts.mode === 'adopt' && !this.connectedOnce && this.opts.transcriptUuids) {
      this.skipUuids = await this.opts.transcriptUuids.catch(() => new Set<string>());
    }
    let first = true;
    while (!this.detached && !this.exitDelivered && !this.gaveUp) {
      if (!first) {
        await sleep(this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      }
      first = false;
      try {
        await this.connectOnce();
        return; // connected; losing the socket restarts the loop
      } catch (err) {
        if (this.detached || this.exitDelivered) return;
        if (err instanceof FatalLinkError) {
          // Retrying cannot help, and a tight loop would flood the host (CP2 review).
          this.opts.log(`host ${this.opts.hostId}: ${err.message}; giving up on it`);
          this.gaveUp = true;
          this.setLink('unreachable');
          this.wakeReady();
          return;
        }
        if (!this.hostAlive()) {
          this.hostGone(err);
          return;
        }
        this.opts.log(`host ${this.opts.hostId}: connect failed (${String(err)}); retrying in ${this.reconnectDelay} ms`);
      }
    }
  }

  private hostAlive(): boolean {
    const pid = this.opts.hostPid?.();
    if (pid === undefined) return true; // not known yet: keep trying while the spawn settles
    return isSameProcessAlive(pid, this.opts.hostStartTime?.());
  }

  /** The socket is gone and so is the host: report its exit record if it wrote one, else that it was lost. */
  private hostGone(err: unknown): void {
    const tombstone = this.opts.readTombstone?.();
    if (tombstone) {
      this.deliverSynthetic({ type: 'exit', exit: tombstone });
      return;
    }
    this.opts.log(`host ${this.opts.hostId}: gone without an exit record (${String(err)})`);
    this.deliverSynthetic({ type: 'exit', exit: { reason: 'lost', error: 'The session host exited unexpectedly.' } });
  }

  /** Connect, authenticate, catch up, subscribe. Only then does the connection become the client's. */
  private connectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.opts.socketPath);
      let adopted = false;
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(err);
      };
      const peer = new NdjsonPeer({
        jsonrpc: true,
        maxLineBytes: MAX_FRAME_BYTES,
        write: (line) => {
          if (socket.destroyed) throw new Error('socket closed');
          socket.write(line);
        },
        log: (m) => this.opts.log(`host ${this.opts.hostId} sent ${m}`),
        onOversize: () => socket.destroy(),
      });
      socket.on('data', (chunk: Buffer) => peer.feed(chunk));
      socket.on('error', (err) => fail(err));
      socket.on('close', () => {
        peer.close(new Error('socket closed'));
        fail(new Error('socket closed during connect'));
        // Only a connection that completed its handshake is ours to lose.
        if (adopted && this.peer === peer) this.onClose();
      });
      socket.on('connect', () => {
        this.handshake(peer)
          .then(() => {
            if (settled) return;
            settled = true;
            adopted = true;
            this.peer = peer;
            this.socket = socket;
            this.connectedOnce = true;
            this.reconnectDelay = RECONNECT_FIRST_MS;
            this.misses = 0;
            this.setLink('live');
            this.wakeReady();
            this.schedulePing();
            void this.configure();
            resolve();
          })
          .catch(fail);
      });
    });
  }

  private async handshake(peer: NdjsonPeer): Promise<void> {
    peer.onNotification((n) => {
      if (n.method === 'event') {
        const event = (n.params as { event: HostEvent }).event;
        if (this.buffer) this.buffer.push(event);
        else if (peer === this.peer) this.deliver(event);
      } else if (n.method === 'resync') {
        // Mid-catch-up a `subscribe` answers RPC_RESYNC itself; only a live link resyncs.
        if (!this.buffer && peer === this.peer) void this.resync(peer);
      }
    });
    try {
      this.hello = await peer.request<HelloResult>(
        'hello',
        {
          client: {
            role: 'core',
            build: this.opts.build,
            pid: process.pid,
            capabilities: this.opts.passive ? [CLIENT_CAPABILITY_PASSIVE] : [],
          },
          protocol: { min: HOST_PROTOCOL_VERSION, max: HOST_PROTOCOL_VERSION },
          token: this.opts.token,
        },
        { timeoutMs: 10_000 },
      );
    } catch (err) {
      if (err instanceof RpcRemoteError && (err.code === RPC_UNAUTHORIZED || err.code === RPC_PROTOCOL_MISMATCH)) {
        throw new FatalLinkError(`the host refused this client (${err.message})`);
      }
      throw err;
    }
    await this.catchUp(peer);
  }

  /** The catch-up described in the header. Throws if the ring keeps moving under it. */
  private async catchUp(peer: NdjsonPeer): Promise<void> {
    for (let attempt = 0; attempt < CATCH_UP_ATTEMPTS; attempt++) {
      this.buffer = [];
      const snap = await peer.request<HostSnapshot>('snapshot', {}, { timeoutMs: 10_000 });
      const adopting = this.opts.mode === 'adopt' && !this.connectedOnce;
      const sameHost = this.snap.epoch === '' || this.snap.epoch === snap.epoch;
      if (!sameHost) this.lastSeq = 0; // another host instance: its seqs start again
      const from = adopting ? snap.ring.fromSeq : Math.max(this.lastSeq, snap.ring.fromSeq);
      if (!adopting && this.connectedOnce && this.lastSeq < snap.ring.fromSeq) {
        this.opts.log(`host ${this.opts.hostId}: events ${this.lastSeq + 1}-${snap.ring.fromSeq} were evicted while away; the transcript has them`);
      }
      let events: HostEvent[];
      let pagedTo: number;
      try {
        ({ events, pagedTo } = await this.page(peer, from, snap.epoch));
      } catch (err) {
        if (err instanceof RpcRemoteError && err.code === RPC_RESYNC) continue; // evicted mid-page: again
        throw err;
      }
      const fresh = events.filter((e) => e.seq > this.lastSeq);
      for (const e of adopting ? this.filterAdopt(fresh, snap) : fresh) this.deliver(e);
      this.lastSeq = Math.max(this.lastSeq, pagedTo);
      // The snapshot is authoritative; the paged events after it are laid on top.
      this.reconcile(snap, events.filter((e) => e.seq > snap.seq));
      try {
        await peer.request('subscribe', { fromSeq: this.lastSeq, epoch: snap.epoch }, { timeoutMs: 15_000 });
      } catch (err) {
        if (err instanceof RpcRemoteError && err.code === RPC_RESYNC) continue; // moved on meanwhile: again
        throw err;
      }
      const held = this.buffer;
      this.buffer = undefined;
      for (const e of held) this.deliver(e);
      this.skipUuids = undefined;
      return;
    }
    this.buffer = undefined;
    throw new Error('could not catch up with the host');
  }

  /** Every held event after `from`, a page at a time. */
  private async page(peer: NdjsonPeer, from: number, epoch: string): Promise<{ events: HostEvent[]; pagedTo: number }> {
    const events: HostEvent[] = [];
    let cursor = from;
    for (;;) {
      const page = await peer.request<EventsResult>('events', { fromSeq: cursor, maxBytes: MAX_PAGE_BYTES, epoch }, { timeoutMs: 15_000 });
      events.push(...page.events);
      const moved = page.nextSeq !== cursor;
      cursor = page.nextSeq;
      if (page.done || !moved) return { events, pagedTo: cursor };
    }
  }

  /**
   * Make the listeners agree with the host: the snapshot, plus the events
   * after it, decide the state (always told), the pending asks (the missing
   * ones given, the settled ones settled) and the exit.
   */
  private reconcile(snap: HostSnapshot, after: HostEvent[]): void {
    let truth: HostSnapshot = { ...snap, pendingAsks: [...snap.pendingAsks] };
    for (const e of after) truth = reduceHostSnapshot(truth, e);
    this.snap = truth;
    const hostAsks = new Map(truth.pendingAsks.map((a) => [a.requestId, a]));
    for (const [id] of this.knownAsks) {
      if (!hostAsks.has(id)) this.deliverSynthetic({ type: 'askSettled', requestId: id, reason: 'aborted' });
    }
    for (const [id, ask] of hostAsks) {
      if (!this.knownAsks.has(id)) this.deliverSynthetic({ type: 'ask', ask });
    }
    if (truth.exit) {
      if (!this.exitDelivered) this.deliverSynthetic({ type: 'exit', exit: truth.exit });
    } else {
      this.deliverSynthetic({ type: 'state', state: truth.state });
    }
  }

  /** Adopt: leave out what the transcript already shows (see the header). */
  private filterAdopt(events: HostEvent[], snap: HostSnapshot): HostEvent[] {
    const skip = this.skipUuids ?? new Set<string>();
    const current = snap.sessionId;
    let lastInTranscript = -1;
    let lastComplete = -1;
    events.forEach((e, i) => {
      if (e.type !== 'message') return;
      const m = e.msg as { type?: string; uuid?: unknown };
      if (typeof m.uuid === 'string' && skip.has(m.uuid)) lastInTranscript = i;
      if (m.type === 'assistant' || m.type === 'result' || m.type === 'user') lastComplete = i;
    });
    return events.filter((e, i) => {
      // Everything up to the transcript's last message is the history's to show;
      // pending asks and the state come from the snapshot in `reconcile`.
      if (i <= lastInTranscript) return false;
      if (e.type !== 'message') return true;
      const m = e.msg as { type?: string; uuid?: unknown; session_id?: unknown };
      // A conversation `/clear` replaced: not this one.
      if (typeof m.session_id === 'string' && current !== undefined && m.session_id !== current) return false;
      if (m.type === 'stream_event') return i > lastComplete;
      return !(typeof m.uuid === 'string' && skip.has(m.uuid));
    });
  }

  private async resync(peer: NdjsonPeer): Promise<void> {
    this.opts.log(`host ${this.opts.hostId}: fell behind; catching up from a snapshot`);
    try {
      await this.catchUp(peer);
    } catch (err) {
      this.opts.log(`host ${this.opts.hostId}: resync failed (${String(err)}); reconnecting`);
      this.socket?.destroy();
    }
  }

  private onClose(): void {
    clearTimeout(this.pingTimer);
    this.peer = undefined;
    this.socket = undefined;
    this.buffer = undefined;
    if (this.detached || this.exitDelivered || this.gaveUp) return;
    this.setLink('connecting');
    void this.connectLoop();
  }

  private schedulePing(): void {
    clearTimeout(this.pingTimer);
    const interval = this.opts.pingIntervalMs ?? DEFAULT_PING_MS;
    // A recursive timeout, not an interval: a machine waking from sleep runs
    // one late tick rather than a burst of missed ones (spike S3).
    this.pingTimer = setTimeout(() => void this.ping(interval), interval);
  }

  private async ping(interval: number): Promise<void> {
    const peer = this.peer;
    if (!peer || this.detached || this.exitDelivered) return;
    try {
      await peer.request('ping', {}, { timeoutMs: interval });
      this.misses = 0;
      if (this.linkState === 'unreachable') this.setLink('live');
    } catch {
      if (peer !== this.peer) return;
      this.misses++;
      if (this.misses >= (this.opts.pingMisses ?? DEFAULT_MISSES)) this.setLink('unreachable');
    }
    if (peer === this.peer) this.schedulePing();
  }

  // ---- handing events to the view ----

  private deliver(event: HostEvent): void {
    if (event.seq <= this.lastSeq) return; // already handed over
    this.lastSeq = event.seq;
    this.snap = reduceHostSnapshot(this.snap, event);
    this.fan(event);
  }

  /** An event the client made up (reconciling with a snapshot, a lost host): no seq of its own. */
  private deliverSynthetic(body: HostEventBody): void {
    const event = { ...body, seq: this.lastSeq } as HostEvent;
    this.snap = reduceHostSnapshot(this.snap, event);
    this.fan(event);
  }

  private fan(event: HostEvent): void {
    if (event.type === 'ask') this.knownAsks.set(event.ask.requestId, event.ask);
    if (event.type === 'askSettled') this.knownAsks.delete(event.requestId);
    if (event.type === 'exit') {
      if (this.exitDelivered) return;
      this.exitDelivered = true;
      this.knownAsks.clear();
      clearTimeout(this.pingTimer);
      this.wakeReady();
    }
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch (err) {
        this.opts.log(`host ${this.opts.hostId}: listener failed: ${String(err)}`);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
