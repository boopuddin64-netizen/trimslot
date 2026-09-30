/* TrimSlot service worker: web push + notification taps. Deliberately does NOT cache pages or API responses (no stale-data risk). */
'use strict';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: 'TrimSlot', body: event.data ? event.data.text() : '' }; }
  const title = d.title || 'TrimSlot';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = wins.some((c) => c.visibilityState === 'visible');
    // App is open and in view: show the in-app banner instead of a system notification (no double alerts).
    for (const c of wins) c.postMessage({ type: 'push', payload: d });
    if (visible) return;
    await self.registration.showNotification(title, {
      body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag, data: { url: d.url || '/#/notifications', id: d.id },
      icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', timestamp: Date.now(),
      vibrate: d.type === 'YOUR_TURN' || d.type === 'YOURE_NEXT' ? [120, 60, 120, 60, 200] : [90, 40, 90],
      requireInteraction: d.type === 'YOUR_TURN',
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/#/notifications';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hash = url.includes('#') ? url.slice(url.indexOf('#')) : '#/notifications';
    for (const c of wins) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus().catch(() => {});
        c.postMessage({ type: 'go', hash });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
