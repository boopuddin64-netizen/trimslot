/* TrimSlot service worker.
   1) Saved copy of the app files (page shell, CSS, JS, icons) so the app opens fast and also with no internet.
   2) Web push + notification taps (unchanged).
   What is NEVER saved here: /api/* (every API answer, signed-in or not), /admin*, payment pages (mock checkout), anything that is not a GET,
   requests with an Authorization header, other websites (Paystack etc.), or responses marked no-store. Data for offline use lives in offline-cache.js, not here. */
'use strict';

/* >>> Bump this ONE value to make every device drop its saved app files and download fresh ones (old caches are deleted on activate). <<< */
const CACHE_VERSION = 'v1';
const CACHE_PREFIX = 'trimslot-static-';
const STATIC_CACHE = CACHE_PREFIX + CACHE_VERSION;
const SHELL = '/';
/* Saved at install (the page shell must succeed; the rest is best effort, anything missing is saved the first time it is used). */
const PRECACHE = [
  '/style.css', '/avatars.css', '/theme.js', '/forms.js', '/offline-cache.js', '/net-banner.js', '/imgdecode.js', '/app.js', '/cropmath.js', '/avatar-crop.js', '/account.js', '/notify.js', '/haptics.js',
  '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png', '/icons/apple-touch-icon.png', '/icons/badge-96.png',
];
/* Never touched by the cache: API, admin, payment pages, health check, share-link redirect, this file itself. */
const BYPASS = /^\/(?:api(?:\/|$)|admin|mock-checkout|healthz|b\/|sw\.js$)/;
const LEGAL = /^\/(?:privacy|terms|refunds|cookies|plan-terms|barber-agreement)(?:\.html)?$/;
const STATIC_FILE = /\.(?:css|js|mjs|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|otf|webmanifest)$/;

const cacheable = (r, html) => !!r && r.status === 200 && r.type === 'basic' && !r.redirected
  && !/no-store/i.test(r.headers.get('cache-control') || '') && (!html || /text\/html/i.test(r.headers.get('content-type') || ''));

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    const shell = await fetch(new Request(SHELL, { cache: 'reload' }));
    if (!cacheable(shell, true)) throw new Error('shell not cacheable');   // install fails -> the old worker (if any) keeps running
    await cache.put(SHELL, shell);
    await Promise.allSettled(PRECACHE.map(async (u) => { const r = await fetch(new Request(u, { cache: 'reload' })); if (cacheable(r)) await cache.put(u, r); }));
    // First ever install: take over at once. An UPDATE waits until the page says it is safe (see 'message' below) - never in the middle of a booking.
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== STATIC_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) c.postMessage({ type: 'sw-activated', version: CACHE_VERSION });
  })());
});

/* The page asks to switch to a waiting version (it does this when the app is closed or in the background, or on the next open) - it never reloads by itself. */
self.addEventListener('message', (event) => {
  const m = event.data || {};
  if (m.type === 'SKIP_WAITING') self.skipWaiting();
  else if (m.type === 'GET_VERSION' && event.source) event.source.postMessage({ type: 'sw-version', version: CACHE_VERSION });
});

async function shellResponse(event) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(SHELL, { ignoreSearch: true });
  const fresh = fetch(new Request(SHELL, { cache: 'no-cache' })).then(async (r) => { if (cacheable(r, true)) await cache.put(SHELL, r.clone()); return r; });
  if (hit) { event.waitUntil(fresh.catch(() => {})); return hit; }     // stale-while-revalidate: show the saved page now, refresh the copy for next time
  return fresh;
}
async function networkFirst(event) {
  const cache = await caches.open(STATIC_CACHE);
  try { const r = await fetch(event.request); if (cacheable(r, true)) event.waitUntil(cache.put(event.request, r.clone())); return r; }
  catch (e) { const hit = await cache.match(event.request); if (hit) return hit; throw e; }
}
async function staleWhileRevalidate(event) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(event.request);
  const fresh = fetch(event.request.url, { cache: 'no-cache', credentials: 'same-origin' }).then(async (r) => { if (cacheable(r)) await cache.put(event.request, r.clone()); return r; });
  if (hit) { event.waitUntil(fresh.catch(() => {})); return hit; }
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.headers.has('range') || req.headers.has('authorization')) return;
  if (req.cache === 'no-store' || req.cache === 'reload') return;       // explicit "go to the network" (hard reload, connection checks)
  const p = url.pathname;
  if (req.mode === 'navigate') {
    const code = /^\/b\/([a-f0-9]{12,32})$/.exec(p);
    if (code) { event.respondWith(fetch(req).catch(() => Response.redirect('/#/b/' + code[1], 302))); return; }   // offline: open the app on the same link
    if (BYPASS.test(p)) return;
    if (p === '/' || p === '/index.html') { event.respondWith(shellResponse(event)); return; }
    if (LEGAL.test(p)) { event.respondWith(networkFirst(event)); return; }
    event.respondWith(fetch(req).catch(() => caches.open(STATIC_CACHE).then((c) => c.match(SHELL)).then((r) => r || Response.error())));
    return;
  }
  if (BYPASS.test(p)) return;
  if (STATIC_FILE.test(p)) event.respondWith(staleWhileRevalidate(event));
});

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: 'TrimSlot', body: event.data ? event.data.text() : '' }; }
  const title = d.title || 'TrimSlot';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // App is open and in view: show the in-app banner instead of a system notification (no double alerts).
    // Admin alerts only go to admin windows (never to a customer/barber app window that happens to be open).
    const isAdminWin = (c) => new URL(c.url).pathname.startsWith('/admin');
    const targets = d.admin ? wins.filter(isAdminWin) : wins.filter((c) => !isAdminWin(c));
    for (const c of targets) c.postMessage({ type: 'push', payload: d });
    if (targets.some((c) => c.visibilityState === 'visible')) return;
    await self.registration.showNotification(title, {
      body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag, data: { url: d.url || '/#/notifications', id: d.id },
      icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', timestamp: Date.now(),
      vibrate: d.type === 'YOUR_TURN' || d.type === 'YOURE_NEXT' || d.type === 'HELP_REQUEST' ? [120, 60, 120, 60, 200] : [90, 40, 90],
      requireInteraction: d.type === 'YOUR_TURN' || d.type === 'HELP_REQUEST',
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/#/notifications';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hash = url.includes('#') ? url.slice(url.indexOf('#')) : '#/notifications';
    const wantAdmin = new URL(url, self.location.origin).pathname.startsWith('/admin');
    for (const c of wins) {
      const u = new URL(c.url);
      if (u.origin === self.location.origin && u.pathname.startsWith('/admin') === wantAdmin) {
        await c.focus().catch(() => {});
        c.postMessage({ type: 'go', hash });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
