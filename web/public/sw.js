// Nudge service worker. It does two jobs only: show Web Push notifications and route taps on them into the app.
// It deliberately caches nothing, so the app is always the version the server is serving.

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
      // If Nudge is open and in view the user is already looking at the new comment arriving: stay quiet.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (windows.some((c) => c.visibilityState === 'visible' && c.focused)) return;
      await self.registration.showNotification(data.title || 'Nudge', {
        body: data.body || '',
        tag: data.tag,
        renotify: !!data.tag,
        icon: '/icon-192.png',
        badge: '/badge-96.png',
        data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/inbox' },
      });
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
