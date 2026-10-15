/**
 * Web Push for the loader (#177): register the service worker, and once notifications are
 * allowed, subscribe with the Mac's VAPID key and tell the Mac where to send. Told again on
 * every connection (it is one small item), so a Mac that lost it, or a key that changed, heals.
 *
 * Permission itself is asked by the workbench's own "Enable notifications" banner (the webshim).
 * On an iPhone or iPad that only works once the page is on the Home Screen.
 */
import { formatRoute } from '../../shared/appRoutes';
import { fromBase64Url, toBase64Url } from '../../shared/relay';
import type { RelayConnection } from './connection';

let registration: Promise<ServiceWorkerRegistration | undefined> | undefined;
let latest: RelayConnection | undefined;

function supported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
}

function register(): Promise<ServiceWorkerRegistration | undefined> {
  registration ??= navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  return registration;
}

async function subscribe(conn: RelayConnection): Promise<void> {
  if (!supported() || !conn.vapid || conn.closed || Notification.permission !== 'granted') return;
  const reg = await register();
  if (!reg) return;
  let sub = await reg.pushManager.getSubscription();
  const current = sub?.options.applicationServerKey;
  if (sub && (!current || toBase64Url(new Uint8Array(current)) !== conn.vapid)) {
    await sub.unsubscribe().catch(() => undefined);
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(conn.vapid) as BufferSource });
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return;
  conn.send({ k: 'push', sub: { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth } });
}

/** A new connection to the Mac: keep its push subscription current. */
export function pushOnConnect(conn: RelayConnection): void {
  if (!supported()) return;
  latest = conn;
  void register();
  void subscribe(conn).catch(() => undefined);
}

/** Once, at start: follow the permission, and open what a tapped notification names. */
export function watchPush(): void {
  if (!supported()) return;
  void navigator.permissions
    ?.query({ name: 'notifications' as PermissionName })
    .then((status) => {
      status.onchange = () => {
        if (latest) void subscribe(latest).catch(() => undefined);
      };
    })
    .catch(() => undefined);
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const m = e.data as { awRelay?: unknown; key?: unknown } | null;
    if (m?.awRelay === 'show' && typeof m.key === 'string') location.hash = formatRoute({ kind: 'conversation', key: m.key });
  });
}
