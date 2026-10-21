/**
 * One tab's channel to the Mac over the relay (#175), and the WebSocket the webshim sees.
 *
 * A `RelayConnection` chooses a connection id, joins its private topic, asks the daemon for it
 * on the lobby (sealed with the device key), and then speaks the codec: batches out, items in.
 * The daemon answers with `open` (its build) and then whatever its `browserConnections` says.
 *
 * `RelayWebSocket` dresses a connection up as the `WebSocket` the webshim was written against:
 * `readyState`, `send`, `close`, and `open` / `message` / `close` events. Pings are answered
 * here; `data` items become messages.
 */
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import {
  RELAY_BATCH_MS,
  RELAY_RESUME_PROBE_MS,
  RELAY_SILENCE_PROBE_MS,
  RELAY_EVENT_CONNECT,
  RELAY_EVENT_FRAME,
  RelayCodec,
  connectionTopic,
  lobbyTopic,
  newRelayId,
  parseSealedPart,
  sealConnect,
  shouldProbeOnResume,
  silenceVerdict,
  type RelayItem,
} from '../../shared/relay';

/** How long the daemon has to answer a connect before the Mac counts as unreachable. */
const OPEN_TIMEOUT_MS = 12_000;
/**
 * The daemon pings every `RELAY_PING_MS`; `RELAY_SILENCE_MS` (three periods) without a frame
 * means it has dropped this tab or cannot reach it. Nothing else would say so: the channel stays
 * subscribed from this end, and a tab that went on sending into it would wait for acks and
 * updates that never come. Before giving up the tab pings the daemon itself (#189), so a throttled
 * timer or a sleep is not taken for a dead Mac.
 */
const SILENCE_CHECK_MS = 15_000;

export interface RelayDevice {
  deviceId: string;
  key: CryptoKey;
}

export class RelayConnection {
  private channel: RealtimeChannel | undefined;
  private codec: RelayCodec | undefined;
  private queue: RelayItem[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending = false;
  /** When the last batch's send settled. */
  private settledAt = 0;
  private inbound = Promise.resolve();
  /** The socket's: everything but `open` and assets. Only one. */
  private listener: ((items: RelayItem[]) => void) | undefined;
  private assetListener: ((item: Extract<RelayItem, { k: 'asset' }>) => void) | undefined;
  private opened: ((build: string) => void) | undefined;
  private closeListeners: ((reason: string) => void)[] = [];
  private lastHeard = Date.now();
  private silenceTimer: ReturnType<typeof setInterval> | undefined;
  /** When this tab last pinged a silent daemon, until something is heard. */
  private probedAt: number | undefined;
  /** How long the probe out has to be answered: shorter when the user is looking. */
  private probeWindowMs = RELAY_SILENCE_PROBE_MS;
  /** Checks the probe out at the end of its window, since a hidden tab's interval may not. */
  private probeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Why the probe out was sent: part of the reason the tab gives if it goes unanswered. */
  private probeWhy = 'silent';
  private readonly checkSilence = () => {
    if (this.closed) return;
    const now = Date.now();
    const verdict = silenceVerdict(now, this.lastHeard, this.probedAt, this.probeWindowMs);
    if (verdict === 'dead') this.end(`${this.probeWhy}: no answer (quiet ${Math.round((now - this.lastHeard) / 1000)} s)`);
    else if (verdict === 'probe') this.probe(now, RELAY_SILENCE_PROBE_MS, 'silent');
  };
  /** The user is back (shown, focused, unfrozen, online again): find out now whether the link lived. */
  private readonly onReturn = () => {
    if (document.visibilityState === 'hidden') return;
    this.resume(false, 'resumed');
  };
  private readonly onVisibility = () => {
    // Throttled timers may have missed a deadline: check it before anything else.
    this.checkSilence();
    this.onReturn();
  };
  /** Items that arrived before the socket listened (the hello, while assets load). */
  private held: RelayItem[] = [];
  closed = false;
  build = '';
  /** The daemon's VAPID public key (#177), for a push subscription. */
  vapid: string | undefined;

  constructor(
    private readonly client: SupabaseClient,
    private readonly uid: string,
    private readonly device: RelayDevice,
  ) {}

  /** Join, ask, and wait for the daemon's `open`. Rejects when the Mac does not answer. */
  async open(): Promise<string> {
    const id = newRelayId();
    const topic = connectionTopic(this.uid, id);
    this.codec = new RelayCodec(this.device.key, this.device.deviceId, topic, 'b2d');
    const channel = this.client.channel(topic, { config: { private: true, broadcast: { self: false, ack: true } } });
    this.channel = channel;
    const opened = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('mac-unreachable')), OPEN_TIMEOUT_MS);
      this.opened = (build) => {
        clearTimeout(timer);
        resolve(build);
      };
      this.closeListeners.push((reason) => {
        clearTimeout(timer);
        reject(new Error(reason));
      });
    });
    channel.on('broadcast', { event: RELAY_EVENT_FRAME }, (m) => {
      this.lastHeard = Date.now();
      this.receive(m.payload);
    });
    // Settled by `open`, or rejected by an end; awaited only once the connect has gone out.
    opened.catch(() => undefined);
    let subscribed = false;
    const joined = new Promise<void>((resolve, reject) => {
      channel.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          subscribed = true;
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // Later, this is our own Supabase socket failing (a sleep, a frozen page, the network).
          // supabase-js rejoins by itself, but what was broadcast meanwhile is gone, and the daemon
          // may have dropped this tab: ask it rather than wait out the silence timeout.
          if (subscribed) this.resume(true, `channel ${status === 'TIMED_OUT' ? 'timed out' : 'error'}`);
          else reject(new Error(err?.message?.includes('nauthorized') ? 'not-owner' : 'relay-unreachable'));
        } else if (status === 'CLOSED' && !this.closed) this.end('closed');
      });
    });
    try {
      await joined;
      // Over REST: the lobby is the daemon's to sit on; a device only posts its request there.
      const lobby = this.client.channel(lobbyTopic(this.uid), { config: { private: true } });
      const r = await lobby.httpSend(RELAY_EVENT_CONNECT, await sealConnect(this.device.key, this.device.deviceId, this.uid, id, Date.now()));
      void this.client.removeChannel(lobby);
      if (!r.success) throw new Error(r.status === 401 || r.status === 403 ? 'not-owner' : 'relay-unreachable');
    } catch (e) {
      // Not left subscribed to a channel nobody will answer on.
      this.end(e instanceof Error ? e.message : String(e));
      throw e;
    }
    // A hidden window's timers are throttled to about one a minute, and a frozen one's do not run
    // at all, so the link is checked the moment the user is back.
    this.lastHeard = Date.now();
    this.silenceTimer = setInterval(this.checkSilence, SILENCE_CHECK_MS);
    document.addEventListener('visibilitychange', this.onVisibility);
    document.addEventListener('resume', this.onReturn);
    window.addEventListener('focus', this.onReturn);
    window.addEventListener('pageshow', this.onReturn);
    window.addEventListener('online', this.onReturn);
    return opened;
  }

  /**
   * Probe now if the link has been quiet long enough to be in doubt, or at once when `suspect`
   * (the channel reported an error). A probe already out gets the short window instead.
   */
  resume(suspect: boolean, why: string): void {
    if (this.closed || !this.codec) return;
    const now = Date.now();
    if (shouldProbeOnResume(now, this.lastHeard, this.probedAt, suspect)) {
      this.probe(now, RELAY_RESUME_PROBE_MS, why);
    } else if (this.probedAt !== undefined && this.probedAt >= this.lastHeard && this.probeWindowMs > RELAY_RESUME_PROBE_MS) {
      // A slow probe is already out: the user should not wait its full window.
      this.probeWindowMs = Math.max(RELAY_RESUME_PROBE_MS, now - this.probedAt + 1_000);
      this.armProbeTimer(this.probedAt + this.probeWindowMs - now);
    }
  }

  private probe(now: number, windowMs: number, why: string): void {
    this.probedAt = now;
    this.probeWindowMs = windowMs;
    this.probeWhy = why;
    this.send({ k: 'ping' }, true);
    this.armProbeTimer(windowMs);
  }

  private armProbeTimer(ms: number): void {
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => {
      this.probeTimer = undefined;
      this.checkSilence();
    }, Math.max(0, ms) + 50);
  }

  /** The socket's items. What came before it listened is delivered first. */
  onItems(listener: (items: RelayItem[]) => void): void {
    this.listener = listener;
    if (this.held.length > 0) {
      const held = this.held;
      this.held = [];
      listener(held);
    }
  }

  /** The workbench's files, as the daemon sends them after an `assets` request. */
  onAsset(listener: (item: Extract<RelayItem, { k: 'asset' }>) => void): void {
    this.assetListener = listener;
  }

  onClose(listener: (reason: string) => void): void {
    this.closeListeners.push(listener);
  }

  /**
   * Queue an item for the next batch. `now` sends it without waiting for the batch timer: a
   * hidden window's timers can be throttled past the daemon's ping deadline. A link quiet for
   * the batch window sends on the next turn anyway, so a click does not wait the window out.
   */
  send(item: RelayItem, now = false): void {
    if (this.closed) return;
    this.queue.push(item);
    if (now && !this.sending) {
      if (this.timer) clearTimeout(this.timer);
      this.flush();
    } else if (!this.timer && !this.sending) {
      this.timer = setTimeout(() => this.flush(), Math.max(0, RELAY_BATCH_MS - (Date.now() - this.settledAt)));
    }
  }

  close(): void {
    if (this.closed) return;
    this.send({ k: 'close' });
    this.flush();
    this.end('closed');
  }

  private flush(): void {
    this.timer = undefined;
    if (this.sending || this.queue.length === 0 || !this.codec || !this.channel) return;
    const batch = this.queue;
    this.queue = [];
    this.sending = true;
    const channel = this.channel;
    void this.codec
      .seal(batch)
      .then(async (parts) => {
        for (const p of parts) {
          const r = await channel.send({ type: 'broadcast', event: RELAY_EVENT_FRAME, payload: p });
          if (r !== 'ok') throw new Error(r);
        }
      })
      .catch(() => this.end('send-failed'))
      .finally(() => {
        this.sending = false;
        this.settledAt = Date.now();
        // What queued meanwhile is already a batch; a timer here could hold a pong too long.
        if (this.queue.length > 0 && !this.timer) this.flush();
      });
  }

  private receive(raw: unknown): void {
    this.inbound = this.inbound.then(async () => {
      if (this.closed || !this.codec) return;
      const part = parseSealedPart(raw);
      const items = part ? await this.codec.open(part) : undefined;
      if (!items) return this.end('refused');
      const rest: RelayItem[] = [];
      let close: Extract<RelayItem, { k: 'close' }> | undefined;
      for (const i of items) {
        if (i.k === 'open') {
          this.build = i.build;
          this.vapid = i.vapid;
          this.opened?.(i.build);
          this.opened = undefined;
        } else if (i.k === 'asset') this.assetListener?.(i);
        else if (i.k === 'close') close = i;
        else rest.push(i);
      }
      if (rest.length > 0) {
        if (this.listener) this.listener(rest);
        else this.held.push(...rest);
      }
      if (close) this.end(close.code === 4401 ? 'revoked' : close.reason ?? 'closed');
    });
  }

  private end(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.silenceTimer) clearInterval(this.silenceTimer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    document.removeEventListener('resume', this.onReturn);
    window.removeEventListener('focus', this.onReturn);
    window.removeEventListener('pageshow', this.onReturn);
    window.removeEventListener('online', this.onReturn);
    if (this.channel) void this.client.removeChannel(this.channel);
    for (const l of [...this.closeListeners]) l(reason);
  }
}

/** A relay connection as the webshim's `WebSocket`. */
export class RelayWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;

  constructor(
    connection: Promise<RelayConnection>,
    private readonly onBuild: (build: string) => void,
    private readonly onEnded: (reason: string) => void,
  ) {
    super();
    connection.then(
      (c) => this.attach(c),
      (e: unknown) => this.finish(e instanceof Error ? e.message : String(e)),
    );
  }

  private conn: RelayConnection | undefined;

  private attach(c: RelayConnection): void {
    this.conn = c;
    if (c.closed) return this.finish('closed');
    // A Mac that has been updated since this page loaded: start over with its files.
    this.onBuild(c.build);
    c.onClose((reason) => this.finish(reason));
    c.onItems((items) => {
      for (const item of items) {
        if (item.k === 'data') this.dispatchEvent(new MessageEvent('message', { data: item.line }));
        else if (item.k === 'ping') c.send({ k: 'pong' }, true);
      }
    });
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  send(data: string): void {
    if (this.readyState === 1) this.conn?.send({ k: 'data', line: data });
  }

  close(): void {
    this.conn?.close();
    this.finish('closed');
  }

  private finish(reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent('close', { reason }));
    this.onEnded(reason);
  }
}
