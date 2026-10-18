/**
 * Remote control over the relay, as a service of the core daemon (#173, #174;
 * `docs/plans/remote-control-supabase.md`).
 *
 * Follows `remote.relay.*` live. With the switch on, a project URL and key set, and a sign-in
 * in the Keychain, it signs in to Supabase, joins the lobby and serves remote tabs through
 * their own `browserConnections` (relay-tuned limits: fewer table snapshots, slower pings).
 * Otherwise nothing is open.
 *
 * Also owns what Preferences offers for it: Sign in with GitHub (PKCE, finished at the
 * loopback `/remote/callback`), Pair a device (loopback only: a QR code at `/remote/pair`),
 * Sign out, and a status under the switch.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { currentRequest } from '../core/requestScope';
import { Emitter, type Disposable } from '../core/events';
import type { ClientSocket } from '../core/web/browserConnections';
import type { WebDeviceStore } from '../core/web/devices';
import { encodeQr, qrToSvg } from '../core/web/qr';
import { PAIR_CSS_PATH, pairMessagePage } from '../core/web/pairPages';
import type { WebRoute } from '../core/web/server';
import type { HostNotice, HostServices } from '../host/hostServices';
import { NoticeDeduper } from '../shared/webCapabilities';
import { loadOrCreateVapid, parsePushSubscription, sendPush, type VapidKeys } from '../remote/relay/webPush';
import type { RequestContext } from '../core/access';
import type { RelayAsset, RelayLink } from '../remote/relay/relayLink';
import { startRelayLink } from '../remote/relay/relayLink';
import { connectSupabaseNetwork } from '../remote/relay/supabaseNetwork';
import {
  RELAY_CALLBACK_PATH,
  RELAY_REFRESH_TOKEN_SECRET,
  signInFresh,
  signOutRelay,
  startRelaySignIn,
  type RelaySignIn,
} from '../remote/relay/relayAuth';
import type { SettingStatus } from '../shared/preferences';
import { newRelayKey, relayPairingLink } from '../shared/relay';
import { RELAY_WORKBENCH_PAGE } from '../ui/html';

export const RELAY_SETTING_KEYS = ['remote.relay.enabled', 'remote.relay.url', 'remote.relay.anonKey', 'remote.relay.siteUrl'] as const;
export const RELAY_PAIR_PATH = '/remote/pair';
const DAEMON_ID_KEY = 'remote.relay.daemonId';
const DEFAULT_SITE = 'https://agentwrangler.netlify.app';
/** Seconds between attempts to sign in again after the link fails, doubling to an hour. */
const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 60 * 60 * 1000;

export interface RelayServiceOptions {
  host: HostServices;
  devices: WebDeviceStore;
  /** `dist/webview`: the files a remote tab's page is made of. */
  webviewDir: string;
  /** Hand a remote tab to its own `browserConnections`. */
  attach(socket: ClientSocket, context: RequestContext, build: string): void;
  /** Close a revoked device's tabs on the connections' side too. */
  closeDevice(deviceId: string): void;
  /** The loopback port, for the sign-in callback. Undefined while nothing listens. */
  port(): number | undefined;
  log(line: string): void;
}

export interface RelayService extends Disposable {
  /** `/remote/callback` and `/remote/pair`, on the loopback listener only. */
  readonly routes: WebRoute[];
  runAction(id: 'connectRelay' | 'pairRelayDevice' | 'disconnectRelay'): Promise<{ ok: boolean; lines: string[] }>;
  status(): SettingStatus;
  readonly onDidChange: (listener: () => void) => Disposable;
  /** The build a remote tab must be on (the loader fetches its assets). */
  build(): string;
  /**
   * A "needs you" notice (#177): to every paired device with a push subscription, by Web Push,
   * while remote control is on. The same tag within a minute goes once.
   */
  push(notice: HostNotice): void;
  /** The Mac woke (#186): check the lobby now, or retry a failed sign-in now. */
  wake(): void;
}

type State =
  | { kind: 'off'; why: string }
  | { kind: 'connecting'; why?: string }
  | { kind: 'on'; login: string; link: RelayLink; dispose: () => void }
  | { kind: 'error'; why: string };

export function startRelayService(opts: RelayServiceOptions): RelayService {
  const { host, devices, log } = opts;
  const changed = new Emitter<void>();
  let state: State = { kind: 'off', why: 'Off.' };
  let pending: RelaySignIn | undefined;
  let generation = 0;
  let retryMs = RETRY_FIRST_MS;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Before rebuilding a link whose lobby went deaf: none at first, doubling while new links fail their check too. */
  let lostDelayMs = 0;
  let disposed = false;

  const setState = (next: State) => {
    state = next;
    changed.fire();
  };
  const settings = () => ({
    enabled: host.settings.get<boolean>('remote.relay.enabled', false) === true,
    url: String(host.settings.get<string>('remote.relay.url', '') ?? '').trim().replace(/\/+$/, ''),
    anonKey: String(host.settings.get<string>('remote.relay.anonKey', '') ?? '').trim(),
    site: String(host.settings.get<string>('remote.relay.siteUrl', DEFAULT_SITE) ?? '').trim() || DEFAULT_SITE,
  });

  // ---- Web Push (#177) ----

  let vapid: VapidKeys | undefined;
  const vapidKeys = (): VapidKeys | undefined => {
    try {
      return (vapid ??= loadOrCreateVapid(host.dataDir));
    } catch (e) {
      log(`relay: no push keys: ${String(e)}`);
      return undefined;
    }
  };
  const pushDedupe = new NoticeDeduper(60_000);
  const push = (notice: HostNotice) => {
    if (!settings().enabled) return;
    if (notice.tag !== undefined && !pushDedupe.first(notice.tag, Date.now())) return;
    const keys = vapidKeys();
    if (!keys) return;
    // Short and id-only: the push service carries it encrypted, but it is shown on a lock screen.
    const payload = {
      title: notice.title.slice(0, 80),
      body: notice.body.slice(0, 160),
      ...(notice.tag ? { tag: notice.tag } : {}),
      ...(notice.sessionKey ? { key: notice.sessionKey } : {}),
    };
    for (const target of devices.relayPushTargets()) {
      void sendPush(target.push, payload, keys, settings().site).then((outcome) => {
        if (outcome === 'gone') devices.setRelayPush(target.id, undefined);
        else if (outcome === 'failed') log(`relay: push to device ${target.id.slice(0, 8)} failed`);
      });
    }
  };
  const onPush = (deviceId: string, raw: unknown) => {
    const sub = raw === null ? undefined : parsePushSubscription(raw);
    if (raw !== null && !sub) return log(`relay: device ${deviceId.slice(0, 8)} sent a push subscription that is not one`);
    devices.setRelayPush(deviceId, sub);
  };

  const daemonId = (): string => {
    let id = host.globalState.get<string>(DAEMON_ID_KEY, '');
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      id = crypto.randomUUID();
      void host.globalState.update(DAEMON_ID_KEY, id);
    }
    return id;
  };

  // ---- the workbench's files, for the loader ----

  let assetCache: { build: string; files: RelayAsset[] } | undefined;
  const fileHash = (name: string): string => {
    try {
      const st = fs.statSync(path.join(opts.webviewDir, name));
      return `${name}:${st.size}:${st.mtimeMs}`;
    } catch {
      return `${name}:missing`;
    }
  };
  const build = (): string => {
    const names = [...RELAY_WORKBENCH_PAGE.styles, ...RELAY_WORKBENCH_PAGE.scripts];
    return crypto.createHash('sha256').update(names.map(fileHash).join('|')).digest('hex').slice(0, 16);
  };
  const assets = async (wanted: string): Promise<RelayAsset[] | undefined> => {
    if (assetCache?.build === wanted) return assetCache.files;
    if (wanted !== build()) return undefined;
    const files: RelayAsset[] = [{ name: 'page.json', type: 'application/json', text: JSON.stringify(RELAY_WORKBENCH_PAGE) }];
    for (const name of [...RELAY_WORKBENCH_PAGE.styles, ...RELAY_WORKBENCH_PAGE.scripts]) {
      const text = await fs.promises.readFile(path.join(opts.webviewDir, name), 'utf8').catch(() => undefined);
      if (text === undefined) return undefined;
      files.push({ name, type: name.endsWith('.css') ? 'text/css' : 'text/javascript', text });
    }
    assetCache = { build: wanted, files };
    return files;
  };

  // ---- the link ----

  const stop = () => {
    generation++;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    if (state.kind === 'on') state.dispose();
  };

  /** The lobby stopped hearing itself (#186): rebuild the link, sooner the first time. */
  const lobbyLost = (reason: string) => {
    if (disposed || state.kind !== 'on') return;
    stop();
    log(`relay: reconnecting (${reason})${lostDelayMs ? ` in ${Math.round(lostDelayMs / 1000)} s` : ''}`);
    setState({ kind: 'connecting', why: reason });
    retryTimer = setTimeout(() => void sync(reason), lostDelayMs);
    retryTimer.unref?.();
    lostDelayMs = Math.min(RETRY_MAX_MS, lostDelayMs ? lostDelayMs * 2 : RETRY_FIRST_MS);
  };

  const sync = async (why?: string) => {
    if (disposed) return;
    stop();
    const mine = generation;
    const s = settings();
    if (!s.enabled) return setState({ kind: 'off', why: 'Off. Nothing connects out.' });
    if (!s.url || !s.anonKey) return setState({ kind: 'off', why: 'Set the Supabase project URL and anon key below, then sign in.' });
    if (!host.secrets.available) return setState({ kind: 'error', why: 'The macOS Keychain is not available, so the sign-in cannot be kept.' });
    const refreshToken = await host.secrets.get(RELAY_REFRESH_TOKEN_SECRET);
    if (mine !== generation) return;
    if (!refreshToken) return setState({ kind: 'off', why: 'Not signed in. Press “Sign in with GitHub…”.' });
    setState({ kind: 'connecting', why });
    try {
      const network = await connectSupabaseNetwork({
        url: s.url,
        anonKey: s.anonKey,
        refreshToken,
        onRefreshToken: (t) => void host.secrets.store(RELAY_REFRESH_TOKEN_SECRET, t).catch((e) => log(`relay: could not keep the sign-in: ${String(e)}`)),
        onSignedOut: () => {
          if (mine !== generation) return;
          log('relay: signed out by Supabase');
          stop();
          setState({ kind: 'error', why: 'Supabase ended the sign-in. Sign in again.' });
        },
        log,
      });
      if (mine !== generation) return network.dispose();
      const link = await startRelayLink({
        network,
        keyOf: (id) => devices.relayKeyOf(id),
        attach: (socket, context) => opts.attach(socket, context, build()),
        build,
        assets,
        vapidKey: () => vapidKeys()?.publicKey,
        onPush,
        daemonId: daemonId(),
        log,
        onLobbyLost: (reason) => {
          if (mine === generation) lobbyLost(reason);
        },
      }).catch((e) => {
        network.dispose();
        throw e;
      });
      if (mine !== generation) {
        link.dispose();
        network.dispose();
        return;
      }
      retryMs = RETRY_FIRST_MS;
      const sub = link.onDidChange(() => {
        if (link.health.lastOkAt !== undefined) lostDelayMs = 0;
        changed.fire();
      });
      log(`relay: connected as ${network.login}`);
      setState({
        kind: 'on',
        login: network.login,
        link,
        dispose: () => {
          sub.dispose();
          link.dispose();
          network.dispose();
        },
      });
    } catch (e) {
      if (mine !== generation) return;
      const why = e instanceof Error ? e.message : String(e);
      log(`relay: not connected: ${why}`);
      setState({ kind: 'error', why: refusedJoin(why) ? 'Supabase refused the lobby: is this account the project’s owner? (docs/remote-control-setup.md §3)' : `Not connected: ${why}` });
      // A network blip or a paused project: try again later, less and less often.
      retryTimer = setTimeout(() => void sync(), retryMs);
      retryTimer.unref?.();
      retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
    }
  };

  const settingsSub = host.settings.onDidChange((affects) => {
    if (RELAY_SETTING_KEYS.some(affects)) void sync();
  });
  const revokeSub = devices.onDidRevoke((id) => {
    if (state.kind === 'on') state.link.closeDevice(id);
    opts.closeDevice(id);
  });
  void sync();

  // ---- actions ----

  async function connect(): Promise<{ ok: boolean; lines: string[] }> {
    const s = settings();
    if (!s.enabled) return { ok: false, lines: ['Turn on “Remote control over the internet” first.'] };
    if (!s.url || !s.anonKey) return { ok: false, lines: ['Set the Supabase project URL and anon key first.'] };
    const port = opts.port();
    if (!port) return { ok: false, lines: ['The browser workbench is not listening on this Mac, so the sign-in has nowhere to come back to.'] };
    pending = await startRelaySignIn({ url: s.url, anonKey: s.anonKey, callbackUrl: `http://127.0.0.1:${port}${RELAY_CALLBACK_PATH}` });
    // To the browser that pressed the button (#126): that is where GitHub's page should open.
    host.shell.openExternal(pending.url);
    return { ok: true, lines: ['A GitHub sign-in opened in a new tab. Finish it there; this page updates when it is done.'] };
  }

  async function pair(): Promise<{ ok: boolean; lines: string[] }> {
    // The key is shown on screen: only to a browser on this Mac, never to a remote one.
    if (currentRequest()?.deviceScope !== 'loopback') return { ok: false, lines: ['Pair from a browser on this Mac (aw web open), not from a remote device.'] };
    const port = opts.port();
    if (!port) return { ok: false, lines: ['The browser workbench is not listening on this Mac.'] };
    const device = devices.issueRelay('Remote device', newRelayKey());
    host.shell.openExternal(`http://127.0.0.1:${port}${RELAY_PAIR_PATH}?d=${encodeURIComponent(device.id)}`);
    return { ok: true, lines: ['A pairing QR code opened in a new tab. Scan it with the device’s camera.', 'It is listed under Browser › Devices as “Remote device”; revoke it there.'] };
  }

  async function disconnect(): Promise<{ ok: boolean; lines: string[] }> {
    const s = settings();
    const token = await host.secrets.get(RELAY_REFRESH_TOKEN_SECRET);
    stop();
    if (token && s.url && s.anonKey) await signOutRelay({ url: s.url, anonKey: s.anonKey, refreshToken: token }).catch(() => undefined);
    await host.secrets.delete(RELAY_REFRESH_TOKEN_SECRET);
    setState({ kind: 'off', why: 'Signed out. Nothing connects out.' });
    return { ok: true, lines: ['Signed out. Remote tabs are closed and the sign-in is gone from the Keychain.'] };
  }

  // ---- routes ----

  const callbackRoute: WebRoute = {
    match: (p) => p === RELAY_CALLBACK_PATH,
    async handle(ctx) {
      const { res, url } = ctx;
      const reply = (title: string, message: string, status = 200) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'self'", 'cache-control': 'no-store' });
        res.end(pairMessagePage(title, message));
      };
      if (ctx.scope !== 'loopback') return reply('Not here', 'Remote control is signed in from a browser on the Mac.', 404);
      if (!ctx.gate.admit(ctx.context, 'settings.write', { kind: 'setting', id: 'action.connectRelay' })) return reply('Not permitted', 'This browser may not do that.', 403);
      const code = url.searchParams.get('code');
      const now = Date.now();
      if (!code || !signInFresh(pending, now)) {
        const err = url.searchParams.get('error_description');
        return reply('Sign-in not finished', err ? err.slice(0, 200) : 'This sign-in is not one Agent Wrangler started, or it took too long. Press “Sign in with GitHub…” again.', 400);
      }
      const signIn = pending;
      pending = undefined;
      try {
        const token = await signIn.finish(code);
        await host.secrets.store(RELAY_REFRESH_TOKEN_SECRET, token);
        void sync();
        reply('Signed in', 'This Mac is signed in for remote control. You can close this tab.');
      } catch (e) {
        reply('Sign-in failed', e instanceof Error ? e.message : String(e), 400);
      }
    },
  };

  const pairRoute: WebRoute = {
    match: (p) => p === RELAY_PAIR_PATH,
    handle(ctx) {
      const { res, url } = ctx;
      const html = (status: number, body: string) => {
        res.writeHead(status, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'none'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        });
        res.end(body);
      };
      if (ctx.scope !== 'loopback') return html(404, pairMessagePage('Not here', 'Pairing is shown on the Mac only.'));
      if (!ctx.gate.admit(ctx.context, 'web.pair.start')) return html(403, pairMessagePage('Not permitted', 'This browser may not pair devices.'));
      const id = url.searchParams.get('d') ?? '';
      const key = devices.relayKeyOf(id);
      if (!key) return html(404, pairMessagePage('No such device', 'Press “Pair a device…” in Preferences again.'));
      const s = settings();
      if (!s.url || !s.anonKey) return html(400, pairMessagePage('Not set up', 'Set the Supabase project URL and anon key in Preferences first.'));
      const link = relayPairingLink(s.site, id, key, { url: s.url, anonKey: s.anonKey });
      const svg = qrToSvg(encodeQr(link, 'M'), { title: 'Remote control pairing code' });
      html(
        200,
        pairQrPage(svg, link),
      );
    },
  };

  return {
    routes: [callbackRoute, pairRoute],
    runAction: async (id) => {
      if (id === 'connectRelay') return connect();
      if (id === 'pairRelayDevice') return pair();
      return disconnect();
    },
    status: (): SettingStatus => {
      switch (state.kind) {
        case 'off':
          return { ok: true, lines: [state.why] };
        case 'connecting':
          return state.why ? { ok: false, lines: [`Reconnecting (${state.why})…`] } : { ok: true, lines: ['Connecting…'] };
        case 'error':
          return { ok: false, lines: [state.why] };
        case 'on': {
          const c = state.link.counts;
          const h = state.link.health;
          const time = (t: number) => new Date(t).toLocaleTimeString();
          const lobby =
            h.misses > 0
              ? `The lobby did not answer its last check (${time(h.lastCheckAt ?? Date.now())}); checking again.`
              : h.lastOkAt !== undefined
                ? `Lobby checked ${time(h.lastOkAt)}.`
                : 'Checking the lobby…';
          return {
            ok: h.misses === 0,
            lines: [
              `Connected as ${state.login}. Only outbound; Supabase sees ciphertext.`,
              lobby,
              `${state.link.tabs} remote tab${state.link.tabs === 1 ? '' : 's'} open.`,
              `Since ${new Date(c.since).toLocaleTimeString()}: sent ${c.sentMessages} messages (${Math.round(c.sentBytes / 1024)} KB), received ${c.receivedMessages}.`,
            ],
          };
        }
      }
    },
    onDidChange: (listener) => changed.event(listener),
    build,
    push,
    wake: () => {
      if (disposed) return;
      if (state.kind === 'on') return state.link.check('woke from sleep');
      // A failed sign-in may be waiting out a long back-off: the network is likely back now.
      if (state.kind === 'error' && retryTimer) {
        retryMs = RETRY_FIRST_MS;
        void sync('woke from sleep');
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      settingsSub.dispose();
      revokeSub.dispose();
      stop();
      changed.dispose();
    },
  };
}

function refusedJoin(message: string): boolean {
  return /unauthori[sz]ed|permission/i.test(message);
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The loopback QR page. The link carries the device key in its fragment: shown here, nowhere else. */
function pairQrPage(svg: string, link: string): string {
  return (
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>Pair a remote device</title><link rel="stylesheet" href="${PAIR_CSS_PATH}"></head><body><main>` +
    '<h1>Scan with the device’s camera</h1>' +
    `<div class="qr">${svg}</div>` +
    '<p>Then sign in with GitHub on the device. It can reach this Mac from anywhere until you revoke it (Preferences › Browser › Devices).</p>' +
    '<p class="muted">The code holds this device’s key. Anyone who scans it can use it, so show it only to the device you are pairing, and close this tab after.</p>' +
    `<details><summary>No camera?</summary><p>Open this address on the device:</p><p><code>${escapeHtml(link)}</code></p></details>` +
    '</main></body></html>\n'
  );
}
