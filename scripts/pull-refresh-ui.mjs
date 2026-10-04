/* Pull-down to refresh tests (real touch events through Chrome DevTools) at 360 / 390, light + dark.
   Usage: BASE=http://localhost:4310 node scripts/pull-refresh-ui.mjs  (demo seed). Screenshots -> SHOTS (default /workspace/ts-edith-shots). */
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:4102', SHOTS = process.env.SHOTS || '/workspace/ts-edith-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let fails = 0, total = 0;
const ok = (c, n, x = '') => { total++; if (!c) { fails++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } else if (process.env.VERBOSE) console.log('PASS ' + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SESS = {};
async function mk(w, o = {}) {
  const ctx = await b.newContext({ viewport: { width: w, height: 760 }, isMobile: true, hasTouch: true, baseURL: BASE, reducedMotion: o.reduced ? 'reduce' : 'no-preference', colorScheme: o.dark ? 'dark' : 'light' });
  if (o.dark) await ctx.addInitScript(() => { try { localStorage.setItem('trimslot_theme', 'dark'); } catch {} });
  await ctx.addInitScript(() => { window.__vib = []; navigator.vibrate = (p) => { window.__vib.push(p); return true; }; });
  const p = await ctx.newPage(); p.__errs = []; p.on('pageerror', (e) => p.__errs.push(e.message));
  const cdp = await ctx.newCDPSession(p);
  p.touch = {
    tp: (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts }),
    async pull(x, y, dx, dy, { hold = 0, release = true, steps = 14 } = {}) {
      await this.tp('touchStart', [{ x, y }]);
      for (let i = 1; i <= steps; i++) { await this.tp('touchMove', [{ x: x + dx * i / steps, y: y + dy * i / steps }]); await sleep(14); }
      if (hold) await sleep(hold);
      if (release) await this.tp('touchEnd', []);
    },
    end: () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
  };
  return { ctx, p };
}
async function login(p, id, pw) {
  if (SESS[id]) { await p.context().addCookies(SESS[id]); await p.goto('/'); await p.waitForTimeout(500); return; }
  await p.goto('/#/login'); await p.fill('[name=identifier]', id); await p.fill('[name=password]', pw); await p.click('button[type=submit]');
  await p.waitForFunction(() => !location.hash.includes('login'), null, { timeout: 8000 }); await p.waitForTimeout(500); SESS[id] = await p.context().cookies();
}
const stub = (p, mode = 'ok') => p.evaluate((m) => {
  window.__rf = 0; window.__vib.length = 0;
  window.refreshFromNetwork = async () => { window.__rf++; await new Promise((r) => setTimeout(r, 100)); if (m === 'fail') throw new Error('x'); };
}, mode);
const pad = (p) => p.evaluate(() => { if (!document.getElementById('padfill')) document.getElementById('app').insertAdjacentHTML('beforeend', '<div id="padfill" style="height:1600px"></div>'); window.scrollTo(0, 0); });
const st = (p) => p.evaluate(() => { const e = document.getElementById('ptr'); return e ? { state: e.dataset.state, on: e.classList.contains('ptr-on'), txt: e.querySelector('.ptr-txt').textContent, op: getComputedStyle(e).opacity, disp: getComputedStyle(e).display } : null; });
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, c) => { const l1 = lum(a), l2 = lum(c); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
const colors = (p) => p.evaluate(() => {
  const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  const chip = document.querySelector('#ptr .ptr-chip'), cs = getComputedStyle(chip), ar = getComputedStyle(chip.querySelector('.ptr-arrow')), sp = getComputedStyle(chip.querySelector('.ptr-spin'));
  return { fg: rgb(cs.color), bg: rgb(cs.backgroundColor), arrow: rgb(ar.stroke), spin: rgb(sp.borderTopColor), alpha: cs.backgroundColor };
});
const overflow = (p, w) => p.evaluate(() => document.documentElement.scrollWidth - innerWidth);

for (const w of [360, 390]) for (const dark of [false, true]) {
  const tag = `${w} ${dark ? 'dark' : 'light'}`;
  const { ctx, p } = await mk(w, { dark }); await login(p, 'chidi@trimslot.demo', 'Customer123!');
  await p.goto('/#/'); await p.waitForSelector('#tabs a'); await p.waitForTimeout(600); await pad(p); await stub(p);
  const X = Math.round(w / 2), Y0 = 150;

  // 1. pull from top -> ready -> release -> refreshes once
  await p.touch.pull(X, Y0, 0, 230, { hold: 150, release: false });
  let s = await st(p); ok(s && s.state === 'ready' && s.txt === 'Release to refresh' && s.on, tag + ' long pull shows "Release to refresh"', JSON.stringify(s));
  ok(await overflow(p, w) <= 1, tag + ' no horizontal overflow while pulling');
  const c = await colors(p); ok(ratio(c.fg, c.bg) >= 4.5, tag + ' indicator text contrast >= 4.5', ratio(c.fg, c.bg).toFixed(2)); ok(ratio(c.arrow, c.bg) >= 3, tag + ' arrow contrast >= 3', ratio(c.arrow, c.bg).toFixed(2));
  ok(!c.alpha.includes('rgba') || c.alpha.endsWith(', 1)'), tag + ' chip background is opaque', c.alpha);
  if (w === 360) await p.screenshot({ path: `${SHOTS}/pull-ready-${w}-${dark ? 'dark' : 'light'}.png` });
  const t0 = Date.now(); await p.touch.end(); await sleep(60);
  s = await st(p); ok(s && s.state === 'busy' && s.txt === 'Refreshing…', tag + ' after release shows "Refreshing…"', JSON.stringify(s));
  if (w === 360) await p.screenshot({ path: `${SHOTS}/pull-busy-${w}-${dark ? 'dark' : 'light'}.png` });
  const c2 = await colors(p); ok(ratio(c2.spin, c2.bg) >= 3, tag + ' spinner contrast >= 3', ratio(c2.spin, c2.bg).toFixed(2));
  await sleep(300); s = await st(p); ok(s && s.on && s.state === 'busy', tag + ' indicator stays >= ~500 ms although refresh took 100 ms', JSON.stringify(s) + ' ' + (Date.now() - t0));
  await sleep(1000); s = await st(p); ok(!s || !s.on, tag + ' indicator hides afterwards', JSON.stringify(s));
  ok(await p.evaluate(() => window.__rf) === 1, tag + ' refresh ran exactly once');
  ok(await p.evaluate(() => window.__vib.some((v) => v === 15)), tag + ' refresh buzz (15ms) when the trigger fires');
  ok(await p.evaluate(() => window.scrollY) === 0, tag + ' page still at top');

  // 2. short pull cancels
  await stub(p); await p.touch.pull(X, Y0, 0, 60, { hold: 100 }); await sleep(500); ok(await p.evaluate(() => window.__rf) === 0, tag + ' short pull does not refresh');
  s = await st(p); ok(!s || !s.on, tag + ' short pull indicator goes away', JSON.stringify(s));

  // 3. scrolled down -> pull does nothing
  await p.evaluate(() => window.scrollTo(0, 300)); await p.waitForTimeout(150);
  await p.touch.pull(X, Y0, 0, 230, { hold: 80 }); await sleep(600);
  ok(await p.evaluate(() => window.__rf) === 0, tag + ' pull while scrolled down does not refresh'); s = await st(p); ok(!s || !s.on, tag + ' no indicator while scrolled down');
  await p.evaluate(() => window.scrollTo(0, 0));

  // 4. modal open -> ignored
  await p.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<div class="scrim" id="tm"><div class="sheet" role="dialog" aria-modal="true"><p>Test</p></div></div>'); });
  await p.touch.pull(X, 60, 0, 230, { hold: 80 }); await sleep(600);
  ok(await p.evaluate(() => window.__rf) === 0, tag + ' modal open: pull ignored'); await p.evaluate(() => document.getElementById('tm').remove());

  // 5. normal scroll (swipe up) is not affected; 6. sideways swipe is ignored; 7. start on tab bar ignored
  await p.touch.pull(X, 500, 0, -300, { hold: 40 }); await sleep(500);
  ok(await p.evaluate(() => window.scrollY) > 100, tag + ' normal scroll still works', String(await p.evaluate(() => window.scrollY)));
  ok(await p.evaluate(() => window.__rf) === 0, tag + ' scroll does not refresh'); await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(150);
  await p.touch.pull(30, Y0, w - 80, 40, { hold: 60 }); await sleep(500); ok(await p.evaluate(() => window.__rf) === 0, tag + ' sideways swipe ignored');
  const tb = await p.locator('#tabs').boundingBox(); await p.touch.pull(X, Math.round(tb.y + tb.height / 2), 0, 120, { hold: 60 }) .catch(() => {}); await sleep(500);
  ok(await p.evaluate(() => window.__rf) === 0, tag + ' pull that starts on the bottom bar ignored');

  // 8. failure state
  await stub(p, 'fail'); await p.touch.pull(X, Y0, 0, 230, { hold: 60 }); await sleep(750);
  s = await st(p); ok(s && s.state === 'error' && s.txt === 'Could not refresh. Try again.', tag + ' failed refresh shows simple error', JSON.stringify(s));
  const ce = await colors(p); ok(ratio(ce.fg, ce.bg) >= 4.5, tag + ' error text contrast >= 4.5', ratio(ce.fg, ce.bg).toFixed(2));
  ok(await p.evaluate(() => window.__vib.some((v) => JSON.stringify(v) === '[30,40,30,40,30]')), tag + ' error buzz on failure');
  if (w === 360) await p.screenshot({ path: `${SHOTS}/pull-error-${w}-${dark ? 'dark' : 'light'}.png` });
  await sleep(2300); s = await st(p); ok(!s || !s.on, tag + ' error clears by itself');
  ok(p.__errs.length === 0, tag + ' no page errors', p.__errs.join('|')); await ctx.close();
}

/* barber screens, ineligible screen, route() fallback, reduced motion */
for (const w of [360, 390]) {
  const { ctx, p } = await mk(w); await login(p, 'mike@trimslot.demo', 'Barber123!');
  for (const r of ['#/today', '#/upcoming']) {
    await p.goto('/' + r); await p.waitForTimeout(700); await pad(p); await stub(p); await p.touch.pull(Math.round(w / 2), 150, 0, 230, { hold: 60 }); await sleep(900);
    ok(await p.evaluate(() => window.__rf) === 1, `${w} barber ${r} pull refreshes`);
  }
  await p.goto('/#/profile'); await p.waitForTimeout(700); await pad(p); await stub(p); await p.touch.pull(Math.round(w / 2), 150, 0, 230, { hold: 60 }); await sleep(800);
  ok(await p.evaluate(() => window.__rf) === 0, `${w} barber profile (forms) is not a pull screen`);
  await p.goto('/#/today'); await p.waitForTimeout(700);
  await p.evaluate(() => { window.__rt = 0; const o = window.route; window.route = function () { window.__rt++; return o.apply(this, arguments); }; delete window.refreshFromNetwork; });
  await p.touch.pull(Math.round(w / 2), 150, 0, 230, { hold: 60 }); await sleep(1200);
  ok(await p.evaluate(() => window.__rt) === 1, `${w} no refreshFromNetwork: re-runs the screen with route() once`);
  ok(await p.locator('.card, .now, h1').count() > 0 && (await p.evaluate(() => document.getElementById('app').innerText.length)) > 20, `${w} screen still rendered after route() refresh`);
  await ctx.close();
}
{ const { ctx, p } = await mk(390, { reduced: true }); await login(p, 'chidi@trimslot.demo', 'Customer123!'); await p.goto('/#/'); await p.waitForTimeout(700); await pad(p); await stub(p);
  await p.touch.pull(195, 150, 0, 230, { hold: 150, release: false }); const s = await st(p);
  ok(s && s.on && s.state === 'ready', 'reduced motion: indicator still shows', JSON.stringify(s));
  const tr = await p.evaluate(() => [getComputedStyle(document.querySelector('#ptr .ptr-chip')).transitionDuration, getComputedStyle(document.querySelector('#ptr .ptr-arrow')).transitionDuration, getComputedStyle(document.querySelector('#ptr .ptr-chip')).transform]);
  ok(tr[0] === '0s' && tr[1] === '0s', 'reduced motion: no transitions', tr.join(' '));
  await p.touch.end(); await sleep(1300); ok(await p.evaluate(() => window.__rf) === 1, 'reduced motion: refresh works'); await ctx.close(); }
await b.close();
console.log(`${total - fails}/${total} pull-to-refresh checks passed`); process.exit(fails ? 1 : 0);
