/**
 * The daemon's end of the remote-control relay (#173; `docs/plans/remote-control-supabase.md`).
 *
 * Waits on the lobby topic for a paired device to ask for a channel, checks the request was
 * sealed with that device's key, joins the channel the device named, and hands the tab to
 * `browserConnections` as a `RelaySocket`. From there the tab is an ordinary workbench client:
 * the same pane hosts, the same `authorize()`, the same approval path, with
 * `deviceScope: 'relay'` so nothing host-local is offered to it.
 *
 * Everything on the wire is sealed by `RelayCodec` (`src/shared/relay.ts`); this file never
 * sends a clear-text payload. It also keeps the daemon's heartbeat row current and counts what
 * it sends and receives, so the free-tier budget can be watched.
 */
import { ownerContext, type RequestContext } from '../../core/access';
import { Emitter, type Disposable } from '../../core/events';
import type { ClientSocket } from '../../core/web/browserConnections';
import {
  RELAY_BATCH_MS,
  RELAY_EVENT_CONNECT,
  RELAY_EVENT_FRAME,
  RELAY_PROTOCOL,
  RelayCodec,
  connectionTopic,
  importRelayKey,
  lobbyTopic,
  openConnect,
  parseConnectRequest,
  parseSealedPart,
  type RelayItem,
} from '../../shared/relay';
import type { RelayChannel, RelayNetwork } from './network';
import { RelaySocket } from './virtualSocket';

/** A workbench file, for the loader (#175). */
export interface RelayAsset {
  name: string;
  type: string;
  text: string;
}

export interface RelayLinkOptions {
  network: RelayNetwork;
  /** A current relay device's key, or undefined (unknown, revoked, expired). */
  keyOf(deviceId: string): string | undefined;
  /** A tab, as a socket, for `browserConnections`. */
  attach(socket: ClientSocket, context: RequestContext): void;
  /** The daemon's build: the `open` item carries it, and the loader fetches assets for it. */
  build(): string;
  /** The workbench's files for a build, or undefined when it is not this daemon's. */
  assets?(build: string): Promise<RelayAsset[] | undefined>;
  /** The VAPID public key a device subscribes to Web Push with (#177), sent with `open`. */
  vapidKey?(): string | undefined;
  /** A device sent its push subscription (unchecked: `sub` is foreign input), or null to stop. */
  onPush?(deviceId: string, sub: unknown): void;
  /** The heartbeat row's id; kept by the caller so a restart updates the same row. */
  daemonId: string;
  log(line: string): void;
  now?: () => number;
  /** How often the heartbeat is written. Default: six hours (it keeps a free project awake). */
  heartbeatMs?: number;
  /** Open tabs per device. Default 4. */
  maxTabsPerDevice?: number;
  batchMs?: number;
}

/** What the relay sent and received since the counters last reset (the daemon's day). */
export interface RelayCounts {
  sentMessages: number;
  sentBytes: number;
  receivedMessages: number;
  receivedBytes: number;
  since: number;
}

export interface RelayLink extends Disposable {
  /** Open remote tabs. */
  readonly tabs: number;
  readonly counts: RelayCounts;
  readonly onDidChange: (listener: () => void) => Disposable;
  /** Close every tab of a device now (it was revoked). */
  closeDevice(deviceId: string): number;
}

interface Tab {
  deviceId: string;
  channel: RelayChannel;
  socket: RelaySocket;
}

/** Connection ids accepted lately, so a replayed `connect` cannot open a second channel. */
const SEEN_TTL_MS = 10 * 60 * 1000;

export async function startRelayLink(opts: RelayLinkOptions): Promise<RelayLink> {
  const { network, log } = opts;
  const now = opts.now ?? (() => Date.now());
  const maxTabs = opts.maxTabsPerDevice ?? 4;
  const batchMs = opts.batchMs ?? RELAY_BATCH_MS;
  const uid = network.uid;
  const tabs = new Map<string, Tab>();
  const seen = new Map<string, number>();
  const changed = new Emitter<void>();
  let disposed = false;
  const counts: RelayCounts = { sentMessages: 0, sentBytes: 0, receivedMessages: 0, receivedBytes: 0, since: now() };

  const count = (dir: 'sent' | 'received', payload: unknown) => {
    const bytes = JSON.stringify(payload).length;
    if (dir === 'sent') {
      counts.sentMessages++;
      counts.sentBytes += bytes;
    } else {
      counts.receivedMessages++;
      counts.receivedBytes += bytes;
    }
  };

  const lobby = await network.join(lobbyTopic(uid), { presence: { role: 'daemon', build: opts.build() } });

  lobby.on(RELAY_EVENT_CONNECT, (payload) => {
    count('received', payload);
    void accept(payload).catch((e) => log(`relay: connect failed: ${e instanceof Error ? e.message : String(e)}`));
  });

  async function accept(payload: unknown): Promise<void> {
    if (disposed) return;
    const req = parseConnectRequest(payload);
    if (!req) return;
    const keyText = opts.keyOf(req.d);
    // Ids only in the log: a device id is not a secret, and nothing else is in clear.
    if (!keyText) return log(`relay: connect from unknown or revoked device ${req.d.slice(0, 8)}`);
    const key = await importRelayKey(keyText);
    const at = now();
    for (const [id, t] of seen) if (at - t > SEEN_TTL_MS) seen.delete(id);
    if (seen.has(req.t) || tabs.has(req.t)) return log('relay: refused a repeated connect');
    if (!(await openConnect(key, req, uid, at))) return log(`relay: refused a connect that did not authenticate (device ${req.d.slice(0, 8)})`);
    seen.set(req.t, at);
    // A device at its cap opens a new tab by closing its oldest: a phone that reloaded or lost
    // its network cannot always say goodbye, and its old tab would otherwise hold a place until
    // the next missed ping.
    const theirs = [...tabs.values()].filter((t) => t.deviceId === req.d);
    if (theirs.length >= maxTabs) {
      log(`relay: device ${req.d.slice(0, 8)} has ${maxTabs} tabs open; closing its oldest`);
      theirs[0].socket.close(1001, 'replaced');
    }

    const topic = connectionTopic(uid, req.t);
    const channel = await network.join(topic);
    const codec = new RelayCodec(key, req.d, topic, 'd2b');
    let ended = false;
    const socket = new RelaySocket({
      batchMs,
      send: async (items) => {
        for (const part of await codec.seal(items)) {
          count('sent', part);
          await channel.send(RELAY_EVENT_FRAME, part);
        }
      },
      onEnd: () => {
        if (ended) return;
        ended = true;
        tabs.delete(req.t);
        // After the close item has gone: leaving drops anything still queued on the channel.
        setTimeout(() => void channel.leave().catch(() => undefined), 1_000).unref?.();
        log(`relay: tab closed (${tabs.size} open)`);
        changed.fire();
      },
    });

    // In order, one part at a time: the codec refuses anything out of sequence.
    let inbound = Promise.resolve();
    channel.on(RELAY_EVENT_FRAME, (raw) => {
      count('received', raw);
      inbound = inbound.then(async () => {
        if (ended) return;
        const part = parseSealedPart(raw);
        const items = part ? await codec.open(part) : undefined;
        if (!items) {
          log('relay: dropped a tab whose frame did not authenticate or arrived out of order');
          socket.terminate();
          return;
        }
        const assets = items.filter((i): i is Extract<RelayItem, { k: 'assets' }> => i.k === 'assets');
        for (const i of items) if (i.k === 'push') opts.onPush?.(req.d, i.sub);
        socket.receive(items.filter((i) => i.k !== 'assets' && i.k !== 'push'));
        for (const a of assets) await sendAssets(socket, a.build);
      });
    });

    tabs.set(req.t, { deviceId: req.d, channel, socket });
    // First on the wire: the build, so the loader knows which assets it needs.
    const vapid = opts.vapidKey?.();
    socket.sendFirst({ k: 'open', build: opts.build(), protocol: RELAY_PROTOCOL, ...(vapid ? { vapid } : {}) });
    opts.attach(socket, ownerContext('browser', { deviceId: req.d, deviceScope: 'relay' }));
    log(`relay: tab opened for device ${req.d.slice(0, 8)} (${tabs.size} open)`);
    changed.fire();
  }

  async function sendAssets(socket: RelaySocket, build: string): Promise<void> {
    const files = build === opts.build() ? await opts.assets?.(build) : undefined;
    if (!files || files.length === 0) {
      socket.sendItems([{ k: 'close', code: 4404, reason: 'assets unavailable' }], 32);
      return;
    }
    const items: RelayItem[] = files.map((f, i) => ({ k: 'asset', build, name: f.name, type: f.type, text: f.text, ...(i === files.length - 1 ? { last: true } : {}) }));
    socket.sendItems(items, files.reduce((n, f) => n + f.text.length, 0));
  }

  const beat = () =>
    network.heartbeat(opts.daemonId, opts.build()).catch((e) => log(`relay: heartbeat failed: ${e instanceof Error ? e.message : String(e)}`));
  void beat();
  const heartbeat = setInterval(beat, opts.heartbeatMs ?? 6 * 60 * 60 * 1000);
  heartbeat.unref?.();

  // A daily line, so drift toward the free tier's quota shows in the log first.
  const daily = setInterval(() => {
    log(
      `relay: last 24 h sent ${counts.sentMessages} messages (${Math.round(counts.sentBytes / 1024)} KB), ` +
        `received ${counts.receivedMessages} (${Math.round(counts.receivedBytes / 1024)} KB)`,
    );
    Object.assign(counts, { sentMessages: 0, sentBytes: 0, receivedMessages: 0, receivedBytes: 0, since: now() });
  }, 24 * 60 * 60 * 1000);
  daily.unref?.();

  return {
    get tabs() {
      return tabs.size;
    },
    counts,
    onDidChange: (listener) => changed.event(listener),
    closeDevice(deviceId) {
      const mine = [...tabs.values()].filter((t) => t.deviceId === deviceId);
      for (const t of mine) t.socket.close(4401, 'revoked');
      return mine.length;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(heartbeat);
      clearInterval(daily);
      for (const t of [...tabs.values()]) t.socket.close(1001, 'going away');
      void lobby.leave().catch(() => undefined);
      changed.dispose();
    },
  };
}
