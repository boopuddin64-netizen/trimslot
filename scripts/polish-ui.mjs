/* Splash, screen change and scrolling checks (headless Chrome) against a throw-away local server: `npm run polish-ui` (see scripts/with-server.ts).
   Covers: splash is in the HTML (shows before any script), follows light/dark, fades out when the first screen is drawn, is gone after,
   never blocks clicks, reduced motion has no animation, theme-color + manifest colours match the splash, sheets scroll on their own and keep the page still,
   screen change finishes in 150-220 ms (view transition or fallback), skeleton placeholders are used (no spinner), no horizontal overflow at 360/390.
   Usage: BASE=http://localhost:4110 node scripts/polish-ui.mjs   -> exit 1 on any failure. Screenshots -> SHOTS (default /tmp/polish-shots). */
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:4110', SHOTS = process.env.SHOTS || '/tmp/polish-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let fails = 0, total = 0;
const ok = (c, n, x = '') => { total++; if (!c) { fails++; console.log('FAIL ' + n + (x !== '' ? ' :: ' + x : '')); } else if (process.env.VERBOSE) console.log('PASS ' + n); };
const mk = async (w, o = {}) => {
  const ctx = await b.newContext({ baseURL: BASE, viewport: { width: w, height: 800 }, isMobile: true, hasTouch: true, reducedMotion: o.reduced ? 'reduce' : 'no-preference', colorScheme: o.dark ? 'dark' : 'light' });
  if (o.saved) await ctx.addInitScript((t) => { try { localStorage.setItem('trimslot_theme', t); } catch {} }, o.saved);
  const p = await ctx.newPage(); p.__errs = []; p.on('pageerror', (e) => p.__errs.push(e.message)); p.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) p.__errs.push('CSP: ' + m.text().slice(0, 120)); }); return { ctx, p };
};
const login = async (p, id, pw) => { await p.goto('/#/login'); await p.fill('[name=identifier]', id); await p.fill('[name=password]', pw); await p.click('button[type=submit]'); await p.waitForSelector('#tabs:not(.hidden)', { timeout: 15000 }); await p.waitForSelector('h1', { timeout: 15000 }); await p.waitForTimeout(400); };

/* ---- splash is in the HTML itself (no JS needed) ---- */
{ const html = await (await fetch(BASE + '/')).text();
  ok(/<div id="splash"/.test(html) && /id="splash-css"/.test(html), 'splash markup and styles are inline in index.html');
  ok(html.indexOf('id="splash"') < html.indexOf('<script src="/app.js"'), 'splash comes before the app scripts');
  ok(/<meta name="theme-color" content="#f6f7fb">/.test(html), 'theme-color matches splash (light)');
  const m = await (await fetch(BASE + '/manifest.webmanifest')).json(); ok(m.background_color === '#f6f7fb' && m.theme_color === '#f6f7fb', 'manifest colours match splash', JSON.stringify([m.background_color, m.theme_color]));
  const sw = await (await fetch(BASE + '/sw.js')).text(); ok(sw.includes("'/polish.js'") && sw.includes("'/polish.css'"), 'service worker precaches polish.js and polish.css');
  for (const f of ['/polish.js', '/polish.css']) ok((await fetch(BASE + f)).status === 200, f + ' is served'); }

/* ---- splash before JS, theme-aware ---- */
for (const [label, o, bg] of [['light', { dark: false }, 'rgb(246, 247, 251)'], ['dark (saved)', { dark: false, saved: 'dark' }, 'rgb(11, 18, 32)'], ['dark (system)', { dark: true }, 'rgb(11, 18, 32)'], ['light saved on dark system... follows saved', { dark: true, saved: 'light' }, null]]) {
  const { ctx, p } = await mk(390, o);
  await ctx.route('**/*.js', (r) => { const u = r.request().url(); if (/\/(app|polish|offline-cache|net-banner|imgdecode|forms|cropmath|avatar-crop|account|notify|haptics)\.js/.test(u)) return setTimeout(() => r.continue(), 1500); r.continue(); });
  await p.goto('/', { waitUntil: 'commit' }); await p.waitForSelector('#splash', { state: 'attached' }); await p.waitForTimeout(500);
  const s = await p.evaluate(() => { const e = document.getElementById('splash'); const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return { bg: cs.backgroundColor, op: cs.opacity, vis: cs.visibility, w: r.width, h: r.height, app: document.getElementById('app').childElementCount, htmlbg: getComputedStyle(document.documentElement).backgroundColor }; });
  ok(s.op === '1' && s.vis === 'visible' && s.w >= 389 && s.h >= 799, `splash ${label}: visible full-screen before any app script ran`, JSON.stringify(s));
  ok(s.app === 0, `splash ${label}: app scripts had not run yet`);
  if (bg) ok(s.bg === bg && s.htmlbg === bg, `splash ${label}: background ${bg}`, JSON.stringify(s)); else ok(s.bg === 'rgb(246, 247, 251)', 'splash follows the saved light theme even on a dark phone', s.bg);
  if (label === 'light') await p.screenshot({ path: SHOTS + '/splash-light.png' });
  if (label === 'dark (saved)') await p.screenshot({ path: SHOTS + '/splash-dark.png' });
  await p.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 8000 }).then(() => ok(true, `splash ${label}: removed after the first screen`), () => ok(false, `splash ${label}: removed after the first screen`));
  ok(p.__errs.length === 0, `splash ${label}: no page errors`, p.__errs.join('|')); await ctx.close(); }

/* ---- fades out smoothly, never blocks taps ---- */
{ const { ctx, p } = await mk(390); await p.goto('/', { waitUntil: 'commit' });
  await p.waitForFunction(() => document.getElementById('app').childElementCount > 0);
  const seen = await p.evaluate(async () => { const e = document.getElementById('splash'); const ops = []; const t0 = performance.now(); while (performance.now() - t0 < 700 && document.getElementById('splash')) { const c = getComputedStyle(e); ops.push([Math.round(+c.opacity * 100) / 100, c.pointerEvents]); await new Promise((r) => requestAnimationFrame(r)); } return ops; });
  ok(seen.some(([o]) => o > 0 && o < 1) || seen.length < 3, 'splash fades (passes through partial opacity) instead of snapping', JSON.stringify(seen.slice(0, 20)));
  ok(seen.filter(([, pe]) => pe !== 'none').length <= 2, 'splash lets taps through as soon as it starts leaving');
  await ctx.close(); }

/* ---- reduced motion: nothing animates ---- */
{ const { ctx, p } = await mk(390, { reduced: true }); await p.goto('/', { waitUntil: 'commit' }); await p.waitForSelector('#splash', { state: 'attached' });
  const a = await p.evaluate(() => { const e = document.querySelector('#splash .sl'); const i = document.querySelector('#splash .sb i'); return [getComputedStyle(e).animationName, getComputedStyle(i).animationName, getComputedStyle(document.getElementById('splash')).transitionDuration]; });
  ok(a[0] === 'none' && a[1] === 'none' && /^0s/.test(a[2]), 'reduced motion: splash has no animation or fade', JSON.stringify(a));
  await p.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 5000 }).then(() => ok(true, 'reduced motion: splash goes away'), () => ok(false, 'reduced motion: splash goes away')); await ctx.close(); }

/* ---- fail-safe: the splash goes away even if the app never draws ---- */
{ const { ctx, p } = await mk(390); await ctx.route('**/app.js', (r) => r.abort()); await p.goto('/'); await p.waitForTimeout(6800);
  ok(await p.evaluate(() => !document.getElementById('splash') || document.getElementById('splash').classList.contains('out')), 'fail-safe: splash leaves after 6 s even if the app cannot start'); await ctx.close(); }

/* ---- app: screen change, scrolling, skeletons ---- */
for (const w of [360, 390]) for (const dark of [false, true]) {
  const tag = `${w} ${dark ? 'dark' : 'light'}`;
  const { ctx, p } = await mk(w, { dark, saved: dark ? 'dark' : 'light' }); await login(p, 'chidi@trimslot.demo', 'Customer123!');
  ok(await p.evaluate(() => !document.getElementById('splash')), tag + ' splash gone after login');
  ok(await p.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY === 'contain'), tag + ' page: overscroll-behavior-y contain (own refresh, no browser reload)');
  /* screen change timing: tap a tab, measure until new content is drawn and the transition is done */
  const t = await p.evaluate(async () => {
    const anims = []; const oa = Element.prototype.animate; Element.prototype.animate = function (k, o) { anims.push([this.id, o && o.duration]); return oa.apply(this, arguments); }; window.__anims = anims;
    const tabs = [...document.querySelectorAll('#tabs a')]; const target = tabs.find((a) => !a.classList.contains('on')); const before = document.getElementById('app').innerText;
    const t0 = performance.now(); let usedVT = false; const orig = document.startViewTransition; if (orig) document.startViewTransition = function (...a) { usedVT = true; return orig.apply(this, a); };
    target.click();
    let drawn = null; for (let i = 0; i < 200; i++) { await new Promise((r) => requestAnimationFrame(r)); if (document.getElementById('app').innerText !== before) { drawn = performance.now() - t0; break; } }
    await new Promise((r) => setTimeout(r, 450)); const vtDone = !document.documentElement.classList.contains('vt');
    return { drawn, usedVT, vtDone, supports: !!orig, anims: window.__anims };
  });
  ok(t.drawn !== null && t.drawn < 900, tag + ' new screen drawn quickly after a tap', JSON.stringify(t));
  ok(!t.usedVT, tag + ' no browser view-transition (it freezes taps)', JSON.stringify(t));
  ok(t.anims.some(([id, d]) => id === 'app' && d >= 150 && d <= 220), tag + ' screen change is a 150-220 ms fade', JSON.stringify(t.anims));
  ok(await p.evaluate(() => !document.querySelector('.spinner, .loader, [class*=spin]')), tag + ' no spinner in the page');
  /* sheet: scrolls on its own, page behind stays */
  await p.goto('/#/profile'); await p.waitForTimeout(500);
  const sheet = await p.evaluate(() => { const sc = document.createElement('div'); sc.className = 'scrim'; sc.innerHTML = '<div class="sheet" id="tsheet"><div style="height:2000px">Tall</div></div>'; document.body.appendChild(sc); const s = document.getElementById('tsheet'); const cs = getComputedStyle(s); const r = s.getBoundingClientRect(); const o = { oy: cs.overflowY, ob: cs.overscrollBehaviorY, h: r.height, vh: innerHeight, sc: getComputedStyle(sc).overscrollBehaviorY }; sc.remove(); return o; });
  ok(sheet.oy === 'auto' && sheet.ob === 'contain' && sheet.sc === 'contain', tag + ' sheet scrolls on its own and does not move the page', JSON.stringify(sheet));
  ok(sheet.h <= sheet.vh * 0.93, tag + ' tall sheet stays inside the screen', JSON.stringify(sheet));
  /* fixed bars still fixed and in place */
  const bars = await p.evaluate(() => { const t = document.querySelector('.tabs').getBoundingClientRect(), h = document.querySelector('.topbar').getBoundingClientRect(); return { tabsBottom: innerHeight - t.bottom, top: h.top, ov: document.documentElement.scrollWidth - innerWidth }; });
  ok(bars.tabsBottom >= 0 && bars.tabsBottom < 40 && bars.top >= 0 && bars.top < 40, tag + ' tab bar and top bar stay in place', JSON.stringify(bars));
  ok(bars.ov <= 1, tag + ' no horizontal overflow', bars.ov + 'px');
  if (w === 390) await p.screenshot({ path: `${SHOTS}/app-${tag.replace(' ', '-')}.png` });
  ok(p.__errs.length === 0, tag + ' no page errors', p.__errs.join('|')); await ctx.close(); }

/* ---- skeleton placeholders appear on a slow screen (not a spinner) ---- */
{ const { ctx, p } = await mk(390); await login(p, 'chidi@trimslot.demo', 'Customer123!');
  await ctx.route('**/api/**', (r) => { const u = r.request().url(); if (/\/api\/bookings/.test(u)) return setTimeout(() => r.continue(), 900); r.continue(); });
  await p.evaluate(() => { location.hash = '#/bookings'; }); await p.waitForTimeout(450);
  ok(await p.evaluate(() => document.querySelectorAll('#app .sk').length > 0), 'slow screen shows skeleton placeholders');
  await ctx.close(); }

await b.close();
console.log(fails ? `\n${fails} FAILED of ${total} checks` : `\n${total}/${total} polish-ui checks passed`);
process.exit(fails ? 1 : 0);
