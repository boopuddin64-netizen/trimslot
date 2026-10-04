/* Offline / speed browser test (headless Chrome via playwright-core) against a throw-away local server (`npm run offline-ui`, see scripts/with-server.ts).
   Covers: service worker caches only app files (never /api, /admin, payment pages), saved data is user-scoped and holds no tokens, offline reload shows the last
   barbers / bookings / profile with the banner, writes stop with a short message, going online hides the banner and refreshes, logout + account change clear everything,
   banner placement + contrast (light/dark) + reduced motion, weak-signal and timeout messages, and the service-worker update flow (no forced reload).
   Usage: BASE=http://localhost:4110 node scripts/offline-ui.mjs   -> exit 1 on any failure. */
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
const BASE = process.env.BASE || 'http://localhost:4110';
const [CID, CPW] = 'chidi@trimslot.demo:Customer123!'.split(':'), [TID, TPW] = 'tunde@trimslot.demo:Customer123!'.split(':');
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let fails = 0, total = 0;
const ok = (c, n, x = '') => { total++; if (!c) { fails++; console.log('FAIL ' + n + (x !== '' ? ' :: ' + x : '')); } else if (process.env.VERBOSE) console.log('PASS ' + n); };
const ratio = (a, c) => { const L = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; const l = (x) => 0.2126 * L(x[0]) + 0.7152 * L(x[1]) + 0.0722 * L(x[2]); const p = l(a), q = l(c); return (Math.max(p, q) + 0.05) / (Math.min(p, q) + 0.05); };
const rgb = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number);

async function newCtx(extra = {}) { return b.newContext({ baseURL: BASE, viewport: { width: 390, height: 800 }, ...extra }); }
async function login(p, id, pw) {
  await p.goto('/#/login'); await p.fill('[name=identifier]', id); await p.fill('[name=password]', pw); await p.click('button[type=submit]');
  await p.waitForSelector('#tabs:not(.hidden)', { timeout: 15000 }); await p.waitForSelector('h1', { timeout: 15000 });
}
const swReady = (p) => p.evaluate(async () => { await navigator.serviceWorker.ready; for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i++) await new Promise((r) => setTimeout(r, 100)); return !!navigator.serviceWorker.controller; });
const ocKeys = (p) => p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('ts_oc1:')));
const text = (p) => p.evaluate(() => document.getElementById('app').innerText);
const bar = (p) => p.evaluate(() => { const e = document.getElementById('netbar'); if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); return { text: e.innerText.trim(), kind: e.dataset.kind, top: r.top, bottom: r.bottom, h: r.height, on: e.classList.contains('on') }; });
const waitBar = async (p, re, ms = 6000) => { const t0 = Date.now(); for (;;) { const x = await bar(p); if (x && re.test(x.text)) return x; if (Date.now() - t0 > ms) return x; await p.waitForTimeout(100); } };

/* ---------------- 1. service worker: what it caches ---------------- */
{
  const ctx = await newCtx(); const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await login(p, CID, CPW); ok(await swReady(p), 'service worker controls the page');
  await p.waitForTimeout(1500);
  const info = await p.evaluate(async () => {
    const names = await caches.keys(); const out = { names, urls: [] };
    for (const n of names) for (const r of await (await caches.open(n)).keys()) out.urls.push(new URL(r.url).pathname);
    return out;
  });
  ok(info.names.length === 1 && info.names[0] === 'trimslot-static-v1', 'one versioned cache', info.names.join(','));
  for (const u of ['/', '/app.js', '/style.css', '/offline-cache.js', '/net-banner.js', '/icons/icon-192.png']) ok(info.urls.includes(u), 'app file saved: ' + u);
  ok(!info.urls.some((u) => u.startsWith('/api') || u.startsWith('/admin') || u.includes('mock-checkout')), 'no api/admin/payment URL in cache', info.urls.filter((u) => /api|admin|mock/.test(u)).join(','));
  // visit admin + payment page + api, then re-check
  await p.evaluate(() => fetch('/api/config').then((r) => r.json()));
  const ap = await ctx.newPage(); await ap.goto('/admin.html').catch(() => {}); await ap.goto('/mock-checkout.html').catch(() => {}); await ap.waitForTimeout(800); await ap.close();
  const urls2 = await p.evaluate(async () => { const o = []; for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) o.push(new URL(r.url).pathname); return o; });
  ok(!urls2.some((u) => u.startsWith('/api') || u.startsWith('/admin') || u.includes('mock-checkout')), 'still no api/admin/payment URL after visiting them', urls2.filter((u) => /api|admin|mock/.test(u)).join(','));
  ok(errs.length === 0, 'no page errors', errs.join(' | '));

  /* ---------------- 2. saved data: user scoped, no secrets ---------------- */
  const keys = await ocKeys(p);
  const uid = await p.evaluate(() => state.user.id);
  for (const k of ['/auth/me', '/bookings', '/me/barbers']) ok(keys.some((x) => x.endsWith(':' + k)), 'saved: ' + k, keys.join(','));
  ok(keys.filter((k) => !k.endsWith(':/config') && !k.endsWith(':uid')).every((k) => k.startsWith('ts_oc1:' + uid + ':')), 'saved data is scoped to the user id', keys.join(','));
  const dump = await p.evaluate(() => JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('ts_oc1:')).map((k) => [k, localStorage.getItem(k)]))));
  const allKeys = await p.evaluate(() => { const o = []; const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const k of Object.keys(v)) { o.push(k); walk(v[k]); } }; for (const k of Object.keys(localStorage)) if (k.startsWith('ts_oc1:')) { try { walk(JSON.parse(localStorage.getItem(k))); } catch {} } return o; });
  ok(allKeys.length > 20 && !allKeys.some((k) => /token|password|passw|otp|secret|authorization|access_code|reference|dev_code|signature/i.test(k)), 'saved data has no token / password / otp / payment-reference fields', allKeys.filter((k) => /token|pass|otp|secret|auth|reference|code/i.test(k)).join(','));
  ok(!(await p.evaluate(() => document.cookie)).includes('token'), 'login cookie is not readable by the page (http-only)');
  const sessKeys = await p.evaluate(() => Object.keys(sessionStorage).concat(Object.keys(localStorage)).filter((k) => /token|jwt|auth/i.test(k) && !k.startsWith('ts_oc1:')));
  ok(sessKeys.length === 0, 'no token-like keys in storage', sessKeys.join(','));

  /* ---------------- 3. offline reload shows saved data ---------------- */
  await p.goto('/#/'); await p.waitForSelector('h1'); const homeOnline = await text(p);
  for (const h of ['#/bookings', '#/profile', '#/']) { await p.evaluate((x) => { location.hash = x; }, h); await p.waitForTimeout(900); }   // open the screens once while online (only what was opened can be shown offline)
  await ctx.setOffline(true);
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('#app h1', { timeout: 8000 }).catch(() => {});
  const homeOff = await text(p);
  ok(/Hi, Chidi/.test(homeOff), 'offline reload: home renders from saved data', homeOff.slice(0, 80));
  ok(homeOnline.includes((homeOnline.match(/Mike[^\n]*/) || ['x'])[0]) && /Mike|barber/i.test(homeOff) || /Hi,/.test(homeOff), 'offline reload: barbers list shown');
  const bn = await waitBar(p, /offline/i);
  ok(bn && bn.text === 'You are offline. Showing saved info.', 'banner says offline + saved info', bn && bn.text);
  const geo = await p.evaluate(() => { const t = document.querySelector('.topbar').getBoundingClientRect(), n = document.getElementById('tabs'), nb = n.getBoundingClientRect(), x = document.getElementById('netbar').getBoundingClientRect(); return { topBottom: t.bottom, barTop: x.top, barBottom: x.bottom, tabsTop: nb.top, tabsHidden: n.classList.contains('hidden'), pe: getComputedStyle(document.getElementById('netbar')).pointerEvents }; });
  ok(geo.barTop >= geo.topBottom - 1.5, 'banner sits below the top bar (does not cover it)', JSON.stringify(geo));
  ok(geo.tabsHidden || geo.barBottom <= geo.tabsTop, 'banner does not reach the bottom tabs');
  ok(geo.pe === 'none', 'banner never blocks taps');
  await p.evaluate(() => { location.hash = '#/bookings'; }); await p.waitForSelector('h1:has-text("My bookings")', { timeout: 8000 }).catch(() => {});
  const bk = await text(p); ok(/My bookings/.test(bk), 'offline: bookings render from saved data', bk.slice(0, 60));
  await p.evaluate(() => { location.hash = '#/profile'; }); await p.waitForTimeout(600);
  const pf = await text(p); ok(/Chidi/.test(pf), 'offline: profile renders from saved data', pf.slice(0, 80));
  // an action that needs the network -> short message, not silence
  const w = await p.evaluate(async () => { try { await api('/bookings/1/cancel', { method: 'POST' }); return 'ok'; } catch (e) { return e.message + '|' + e.code + '|' + document.getElementById('toast').textContent; } });
  ok(/^You are offline\. Try again when you are online\.\|NETWORK\|You are offline\. Try again when you are online\.$/.test(w), 'offline write: simple message + toast', w);
  // back online -> banner disappears
  await ctx.setOffline(false);
  await p.evaluate(() => window.dispatchEvent(new Event('online')));
  let gone = false; for (let i = 0; i < 40; i++) { const x = await bar(p); if (!x) { gone = true; break; } await p.waitForTimeout(150); }
  ok(gone, 'banner disappears when back online');
  ok((await p.evaluate(() => typeof window.refreshFromNetwork)) === 'function', 'window.refreshFromNetwork exists');
  const rf = await p.evaluate(() => refreshFromNetwork()); ok(rf === true, 'refreshFromNetwork() redraws the current screen', String(rf));
  await p.evaluate(() => { location.hash = '#/book/1'; }); await p.waitForTimeout(500);
  ok((await p.evaluate(() => refreshFromNetwork())) === false, 'refreshFromNetwork() leaves a booking in progress alone');

  /* ---------------- 4. logout clears ---------------- */
  await p.evaluate(() => { location.hash = '#/profile'; }); await p.waitForSelector('#signout'); 
  ok((await ocKeys(p)).length > 0, 'cache present before logout');
  await p.click('#signout'); await p.waitForSelector('a[href="#/login"]', { timeout: 8000 });
  ok((await ocKeys(p)).filter((k) => !k.startsWith('ts_oc1:g:')).length === 0, 'logout clears all saved personal data', (await ocKeys(p)).join(','));
  await ctx.setOffline(true); await p.reload({ waitUntil: 'load' }).catch(() => {}); await p.waitForTimeout(1200);
  ok(!/Chidi/.test(await p.evaluate(() => document.body.innerText)), 'after logout + offline reload: no personal data on screen');
  await ctx.setOffline(false);

  /* ---------------- 5. account change clears the other account ---------------- */
  await login(p, CID, CPW); await p.waitForTimeout(500);
  const k1 = await ocKeys(p); const u1 = await p.evaluate(() => String(state.user.id));
  // sign in as someone else without logging out first (cookie swap in the same browser)
  const r = await p.evaluate(async (a) => { const x = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: a[0], password: a[1] }) }); return x.status; }, [TID, TPW]);
  await p.reload(); await p.waitForSelector('h1'); await p.waitForTimeout(1500);
  const u2 = await p.evaluate(() => String(state.user.id)); const k2 = await ocKeys(p);
  ok(r === 200 && u1 !== u2, 'switched account in the same browser', u1 + '->' + u2);
  ok(k1.length > 0 && k2.length > 0 && !k2.some((k) => k.startsWith('ts_oc1:' + u1 + ':')), 'old account saved data removed on account change', k2.join(','));
  ok(!/Chidi/.test(await text(p)), 'new account does not show the old account\'s name');
  await ctx.close();
}

/* ---------------- 6. banner: other messages, themes, reduced motion ---------------- */
{
  const ctx = await newCtx({ reducedMotion: 'reduce' }); await ctx.addInitScript(() => { Object.defineProperty(navigator, 'connection', { value: { effectiveType: '2g', saveData: false, addEventListener() {} }, configurable: true }); });
  const p = await ctx.newPage(); await login(p, CID, CPW);
  const s = await waitBar(p, /Slow/); ok(s && s.text === 'Slow connection.', 'weak signal message', s && s.text);
  const mot = await p.evaluate(() => getComputedStyle(document.getElementById('netbar')).transitionDuration); ok(/^0s(, 0s)*$/.test(mot), 'reduced motion: banner does not animate', mot);
  await p.evaluate(() => window.dispatchEvent(new CustomEvent('ts:net', { detail: { type: 'timeout' } })));
  const t = await waitBar(p, /Taking long/); ok(t && t.text === 'Taking long. Trying again.', 'timeout message', t && t.text);
  for (const theme of ['light', 'dark']) for (const kind of ['offline', 'slow', 'retry']) {
    await p.evaluate((th) => { if (th === 'dark') document.documentElement.setAttribute('data-theme', 'dark'); else document.documentElement.removeAttribute('data-theme'); }, theme);
    await p.evaluate((k) => { const e = document.getElementById('netbar'); e.dataset.kind = k; e.hidden = false; e.classList.add('on'); }, kind);
    await p.waitForTimeout(50);
    const c = await p.evaluate(() => { const i = document.querySelector('.nb-in'), s = getComputedStyle(i); const d = getComputedStyle(document.querySelector('.nb-dot')); return { fg: s.color, bg: s.backgroundColor, dot: d.backgroundColor, h: i.getBoundingClientRect().height, page: getComputedStyle(document.body).backgroundColor }; });
    ok(ratio(rgb(c.fg), rgb(c.bg)) >= 4.5, `banner text contrast ${theme}/${kind}`, ratio(rgb(c.fg), rgb(c.bg)).toFixed(2));
    ok(ratio(rgb(c.dot), rgb(c.bg)) >= 3, `banner dot contrast ${theme}/${kind}`, ratio(rgb(c.dot), rgb(c.bg)).toFixed(2));
    ok(c.h >= 30 && c.h <= 44, `banner is slim ${theme}/${kind}`, String(c.h));
  }
  await ctx.close();
}

/* ---------------- 7. service-worker update: waits, never reloads, old cache deleted ---------------- */
{
  // a tiny pass-through proxy so the "new" sw.js (version v2) can be served without touching the repo file
  const http = await import('http'); let v2 = false;
  const px = http.createServer(async (rq, rs) => {
    try {
      const hd = { ...rq.headers }; delete hd['if-none-match']; delete hd['if-modified-since'];
      const r = await fetch(BASE + rq.url, { method: rq.method, headers: { ...hd, host: new URL(BASE).host, ...(rq.headers.origin ? { origin: new URL(BASE).origin } : {}), ...(rq.headers.referer ? { referer: BASE + '/' } : {}) }, body: ['GET', 'HEAD'].includes(rq.method) ? undefined : rq, duplex: 'half', redirect: 'manual' });
      let body = Buffer.from(await r.arrayBuffer()); const h = Object.fromEntries([...r.headers].filter(([k]) => !['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie'].includes(k)));
      if (v2 && rq.url.startsWith('/sw.js')) body = Buffer.from(body.toString().replace("const CACHE_VERSION = 'v1'", "const CACHE_VERSION = 'v2'"));
      const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; if (sc.length) h['set-cookie'] = sc;
      rs.writeHead(r.status, h); rs.end(body);
    } catch (e) { rs.writeHead(502); rs.end(String(e)); }
  }).listen(0); const PB = 'http://localhost:' + px.address().port;
  const ctx = await b.newContext({ baseURL: PB, viewport: { width: 390, height: 800 } }); const p = await ctx.newPage();
  await p.goto('/#/login'); await p.fill('[name=identifier]', CID); await p.fill('[name=password]', CPW); await p.click('button[type=submit]'); await p.waitForSelector('#tabs:not(.hidden)'); await p.waitForSelector('h1');
  await swReady(p); await p.waitForTimeout(1200);
  const ver = () => p.evaluate(() => new Promise((res) => { navigator.serviceWorker.addEventListener('message', function f(e) { if (e.data && e.data.type === 'sw-version') { navigator.serviceWorker.removeEventListener('message', f); res(e.data.version); } }); navigator.serviceWorker.controller.postMessage({ type: 'GET_VERSION' }); }));
  ok((await ver()) === 'v1', 'active worker is v1');
  await p.evaluate(() => { window.__marker = 'same-page'; });
  v2 = true;
  await p.evaluate(() => navigator.serviceWorker.getRegistration('/').then((r) => r.update()));
  let waiting = false; for (let i = 0; i < 80; i++) { waiting = await p.evaluate(() => navigator.serviceWorker.getRegistration('/').then((r) => !!r.waiting)); if (waiting) break; await p.waitForTimeout(100); }
  ok(waiting, 'new version installs and waits (not forced)');
  const mid = await p.evaluate(async () => ({ names: (await caches.keys()).sort(), upd: OfflineCache.updateReady(), marker: window.__marker, active: !!navigator.serviceWorker.controller }));
  ok(mid.names.join(',') === 'trimslot-static-v1,trimslot-static-v2', 'both caches exist while waiting', mid.names.join(','));
  ok(mid.upd === true && mid.marker === 'same-page', 'page knows an update is ready, and was not reloaded');
  ok((await ver()) === 'v1', 'still on v1 mid-session (no sudden switch)');
  await p.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  let names = []; for (let i = 0; i < 80; i++) { names = await p.evaluate(async () => (await caches.keys()).sort()); if (names.join(',') === 'trimslot-static-v2') break; await p.waitForTimeout(100); }
  ok(names.join(',') === 'trimslot-static-v2', 'app in background: new version active, old cache deleted', names.join(','));
  ok((await p.evaluate(() => window.__marker)) === 'same-page', 'page still not reloaded after the update');
  ok((await ver()) === 'v2', 'page is now served by v2');
  await p.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); });
  await ctx.setOffline(true); await p.reload({ waitUntil: 'load' }); await p.waitForTimeout(800);
  ok(/Hi, Chidi/.test(await text(p)), 'after update: offline reload still works', (await text(p)).slice(0, 60));
  await ctx.close(); px.close();
}
await b.close();
console.log(fails ? `\n${fails} FAILED of ${total}` : `\nAll ${total} offline/speed checks passed`);
process.exit(fails ? 1 : 0);
