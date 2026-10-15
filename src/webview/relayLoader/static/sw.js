// The remote-control loader's service worker (#177): shows the Mac's "needs you" notices sent
// by Web Push, and opens the conversation when one is tapped. It caches nothing: the page and
// the workbench always come fresh from the site and the Mac.
//
// Every push is shown (browsers revoke a subscription whose pushes show nothing); the tag
// collapses repeats of the same ask.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let notice = {};
  try {
    notice = event.data ? event.data.json() : {};
  } catch {
    notice = {};
  }
  const title = typeof notice.title === 'string' && notice.title ? notice.title : 'Agent Wrangler';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof notice.body === 'string' ? notice.body : '',
      tag: typeof notice.tag === 'string' ? notice.tag : undefined,
      icon: '/icon-192.png',
      data: { key: typeof notice.key === 'string' ? notice.key : undefined },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const key = event.notification.data && event.notification.data.key;
  const target = key ? `/#/c/${encodeURIComponent(key)}` : '/';
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        if (key) open.postMessage({ awRelay: 'show', key });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
