// Nudge service worker. It does two jobs only: show Web Push notifications and route taps on them into the app.
// It deliberately caches nothing, so the app is always the version the server is serving.

// Take over as soon as a new version installs. Without this the old worker keeps handling pushes until every window
// on the site is closed, so a fix to push handling would not reach a phone that keeps the app in memory.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/* A push is { title, body, url, tag }. */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Nudge', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    (async () => {
      // Chrome insists every push produces a visible notification; if we show none it posts its own generic
      // "Tap to copy the URL for this app". So never return without calling showNotification.
      await self.registration.showNotification(data.title || 'Nudge', {
        body: data.body || '',
        tag: data.tag,
        renotify: !!data.tag,
        icon: '/icon-192.png',
        badge: '/badge-96.png',
        data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/inbox' },
      });
      // If Nudge is open and in view the user is already watching the comment arrive, so dismiss it again. The test
      // push stays up, otherwise pressing "Send a test" with the app open would appear to do nothing.
      if (data.tag === 'nudge-test') return;
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (windows.some((c) => c.visibilityState === 'visible' && c.focused)) {
        for (const n of await self.registration.getNotifications({ tag: data.tag })) n.close();
      }
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/inbox';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) {
        // Hand the path to the running app so it navigates without a reload (and keeps its state).
        await open.focus();
        open.postMessage({ type: 'nudge.open', url });
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});

// Chrome has required a fetch handler for installability; this one passes every request straight through.
self.addEventListener('fetch', () => {});
