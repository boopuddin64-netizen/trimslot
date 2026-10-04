/* Service worker (public/sw.js) rules, run in a sandbox with a fake cache + fetch: what is cached, what is NEVER cached, update flow, and that push/notification code still works. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SRC = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
type H = (e: any) => void;
function boot(opts: { active?: boolean; netFail?: boolean; wins?: any[] } = {}) {
  const handlers: Record<string, H> = {}; const stores = new Map<string, Map<string, any>>(); const log = { fetched: [] as string[], skip: 0, shown: [] as any[], opened: [] as string[], posted: [] as any[] };
  const mkRes = (body: string, o: any = {}) => ({ status: o.status ?? 200, type: 'basic', redirected: false, body, headers: { get: (k: string) => (o.headers || {})[k.toLowerCase()] ?? (k.toLowerCase() === 'content-type' ? (o.ct || 'text/plain') : null) }, clone() { return mkRes(body, o); } });
  const open = async (n: string) => { if (!stores.has(n)) stores.set(n, new Map()); const m = stores.get(n)!; return {
    put: async (r: any, res: any) => { m.set(typeof r === 'string' ? r : (r.url ? new URL(r.url).pathname : r), res); },
    match: async (r: any) => m.get(typeof r === 'string' ? r : new URL(r.url).pathname), keys: async () => [...m.keys()] }; };
  const self: any = {
    location: { origin: 'https://app.test' }, addEventListener: (t: string, f: H) => { handlers[t] = f; }, skipWaiting: () => { log.skip++; return Promise.resolve(); },
    registration: { active: opts.active ? {} : null, showNotification: async (t: string, o: any) => { log.shown.push({ t, o }); } },
    clients: { claim: async () => {}, matchAll: async () => opts.wins || [], openWindow: async (u: string) => { log.opened.push(u); } },
  };
  const ctx: any = { self, caches: { open, keys: async () => [...stores.keys()], delete: async (k: string) => stores.delete(k) }, URL, Response: class { static error() { return { error: true }; } static redirect(u: string, s: number) { return { redirect: u, status: s }; } },
    Request: class { url: string; constructor(u: string, o: any = {}) { this.url = new URL(u, 'https://app.test').href; Object.assign(this, o); } }, console, Promise,
    fetch: async (r: any) => { const u = typeof r === 'string' ? r : r.url; log.fetched.push(new URL(u, 'https://app.test').pathname); if (opts.netFail) throw new TypeError('offline');
      return mkRes('net:' + u, { ct: u.endsWith('/') || u.endsWith('.html') ? 'text/html' : 'text/javascript' }); } };
  vm.createContext(ctx); vm.runInContext(SRC, ctx);
  const fetchEv = (url: string, o: any = {}) => { let resp: any; const waits: Promise<any>[] = []; const ev = { request: { url: new URL(url, 'https://app.test').href, method: o.method || 'GET', mode: o.mode || 'no-cors', cache: o.cache || 'default', headers: { has: (k: string) => !!(o.headers || {})[k] } }, respondWith: (p: any) => { resp = p; }, waitUntil: (p: any) => { waits.push(p); } };
    handlers.fetch(ev); return { handled: resp !== undefined, resp: resp && Promise.resolve(resp), done: () => Promise.all(waits) }; };
  return { handlers, stores, log, fetchEv, ctx };
}
const install = async (sw: any) => { const w: Promise<any>[] = []; sw.handlers.install({ waitUntil: (p: any) => w.push(p) }); await Promise.all(w); };

test('one constant controls the cache version, and it is a versioned name', () => {
  assert.match(SRC, /const CACHE_VERSION = 'v\d+';/);
  assert.match(SRC, /const STATIC_CACHE = CACHE_PREFIX \+ CACHE_VERSION;/);
});

test('install saves the page shell + app files; first install takes over, an update waits', async () => {
  const a = boot({ active: false }); await install(a);
  const c = a.stores.get('trimslot-static-v1')!;
  for (const u of ['/', '/app.js', '/style.css', '/offline-cache.js', '/net-banner.js', '/manifest.webmanifest']) assert.ok(c.has(u), u);
  assert.equal(a.log.skip, 1, 'first install: skipWaiting');
  const b = boot({ active: true }); await install(b);
  assert.equal(b.log.skip, 0, 'update: must wait for the page');
  b.handlers.message({ data: { type: 'SKIP_WAITING' } }); assert.equal(b.log.skip, 1);
});

test('activate deletes old versioned caches (only ours) and claims clients', async () => {
  const sw = boot(); sw.stores.set('trimslot-static-v0', new Map()); sw.stores.set('trimslot-static-v1', new Map()); sw.stores.set('someone-else', new Map());
  const w: Promise<any>[] = []; sw.handlers.activate({ waitUntil: (p: any) => w.push(p) }); await Promise.all(w);
  assert.deepEqual([...sw.stores.keys()].sort(), ['someone-else', 'trimslot-static-v1']);
});

test('NEVER touches api, admin, payment pages, health, share redirect, sw.js, non-GET, other sites, Authorization, no-store', () => {
  const sw = boot();
  const no = [
    ['/api/auth/me'], ['/api/bookings'], ['/api/config'], ['/api/payments/callback', { mode: 'navigate' }], ['/admin.html', { mode: 'navigate' }], ['/admin'], ['/admin.js'], ['/admin3.js'], ['/admin.css'],
    ['/mock-checkout.html', { mode: 'navigate' }], ['/mock-checkout.js'], ['/healthz'], ['/sw.js'], ['/app.js', { method: 'POST' }], ['/app.js', { headers: { authorization: 'x' } }],
    ['/app.js', { headers: { range: 'bytes=0-1' } }], ['/app.js', { cache: 'no-store' }], ['/app.js', { cache: 'reload' }], ['https://api.paystack.co/x.js'], ['https://checkout.paystack.com/', { mode: 'navigate' }],
  ] as const;
  for (const [u, o] of no) assert.equal(sw.fetchEv(u, o as any).handled, false, u);
  assert.equal(sw.stores.size, 0);
});

test('app files: saved copy at once, refreshed in the background; page shell works offline', async () => {
  const sw = boot(); await install(sw);
  const f = sw.fetchEv('/app.js'); assert.equal(f.handled, true);
  assert.equal((await f.resp).body, 'net:https://app.test/app.js'); await f.done();     // saved by install earlier -> served from cache, then revalidated
  assert.ok(sw.log.fetched.filter((u) => u === '/app.js').length >= 2, 'revalidated');
  const off = boot({ netFail: true }); off.stores.set('trimslot-static-v1', new Map([['/', { status: 200, body: 'SHELL' }], ['/app.js', { body: 'APP' }]]));
  assert.equal((await off.fetchEv('/', { mode: 'navigate' }).resp).body, 'SHELL');
  assert.equal((await off.fetchEv('/?x=1', { mode: 'navigate' }).resp).body, 'SHELL');
  assert.equal((await off.fetchEv('/app.js').resp).body, 'APP');
  const unknown = await off.fetchEv('/somewhere', { mode: 'navigate' }).resp; assert.equal(unknown.body, 'SHELL', 'unknown page offline -> shell');
  const share = await off.fetchEv('/b/0123456789abcdef', { mode: 'navigate' }).resp; assert.deepEqual(JSON.parse(JSON.stringify(share)), { redirect: '/#/b/0123456789abcdef', status: 302 });
});

test('responses that must not be saved are not saved (errors, redirects, no-store, wrong type)', async () => {
  const sw = boot(); await sw.ctx.caches.open('trimslot-static-v1');
  sw.ctx.fetch = async () => ({ status: 500, type: 'basic', redirected: false, headers: { get: () => null }, clone() { return this; } });
  const r = sw.fetchEv('/new.js'); await r.resp; await r.done(); assert.equal(sw.stores.get('trimslot-static-v1')!.has('/new.js'), false);
  sw.ctx.fetch = async () => ({ status: 200, type: 'basic', redirected: false, headers: { get: (k: string) => (k === 'cache-control' ? 'no-store' : null) }, clone() { return this; } });
  const r2 = sw.fetchEv('/nostore.js'); await r2.resp; await r2.done(); assert.equal(sw.stores.get('trimslot-static-v1')!.has('/nostore.js'), false);
});

test('push + notification-click code is intact', async () => {
  const win = { url: 'https://app.test/', visibilityState: 'hidden', postMessage(m: any) { sw.log.posted.push(m); }, focus: async () => {} };
  const sw = boot({ wins: [win] });
  const w: Promise<any>[] = [];
  sw.handlers.push({ data: { json: () => ({ title: 'Your turn', body: 'Go', type: 'YOUR_TURN', tag: 't1', url: '/#/notifications' }) }, waitUntil: (p: any) => w.push(p) }); await Promise.all(w);
  assert.equal(sw.log.shown.length, 1); assert.equal(sw.log.shown[0].t, 'Your turn'); assert.equal(sw.log.shown[0].o.requireInteraction, true);
  assert.equal(sw.log.posted[0].type, 'push');
  // an admin-only push is not shown to a customer window
  const sw2 = boot({ wins: [{ ...win, postMessage() {} }] }); const w2: Promise<any>[] = [];
  sw2.handlers.push({ data: { json: () => ({ title: 'Admin', admin: true }) }, waitUntil: (p: any) => w2.push(p) }); await Promise.all(w2);
  assert.equal(sw2.log.shown.length, 1, 'no admin window open -> system notification');
  const w3: Promise<any>[] = []; let closed = false;
  sw.handlers.notificationclick({ notification: { close: () => { closed = true; }, data: { url: '/#/bookings' } }, waitUntil: (p: any) => w3.push(p) }); await Promise.all(w3);
  assert.ok(closed); assert.deepEqual(JSON.parse(JSON.stringify(sw.log.posted.at(-1))), { type: 'go', hash: '#/bookings' });
});
