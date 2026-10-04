/* UI audit at 360 / 390 / 1280 for customer, barber and admin screens, against the local dev server (mock mode, demo seed).
   Per page: horizontal overflow, overlapping buttons/chips/links, controls cut off by the viewport, gradients/shadows, font scale, console errors.
   Screenshots -> screenshots/audit/<width>/<role>-<page>.png */
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:4102', ADMINKEY = process.env.ADMINKEY || 'local-admin-key-xyz';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let fails = 0, total = 0; const errs = [];
const res = (ok, name, extra = '') => { total++; if (!ok) fails++; if (!ok || process.env.VERBOSE) console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' :: ' + extra : '')); };
const SHOP = process.env.SHOP_ID || '1', OUT = process.env.OUT_DIR || 'audit';   // live run: SHOP_ID=<throwaway shop>, CUST/BARB=identifier:password, ADMIN_PAGES=comma list
const CUST = (process.env.CUST || 'chidi@trimslot.demo:Customer123!').split(':'), BARB = (process.env.BARB || 'mike@trimslot.demo:Barber123!').split(':');
const CUSTOMER = ['#/', `#/barber/${SHOP}`, `#/book/${SHOP}`, '#/bookings', '#/wallet', '#/profile', '#/notifications'];
const BARBER = ['#/today', '#/upcoming', '#/customers', '#/plans', '#/reviews', '#/settings', '#/payouts', '#/balance', '#/profile', '#/notifications'];
const ADMIN = process.env.ADMIN_PAGES ? process.env.ADMIN_PAGES.split(',') : ['home', 'customers', 'barbers', 'bookings', 'decisions', 'payments', 'credits', 'plans', 'earnings', 'ledger', 'analytics', 'reviews', 'waitlist', 'broadcast', 'reports', 'controls', 'rules', 'audit', 'pin', 'deleted', 'testdata'];
const inspect = () => {
  const collapsed = (e) => { for (let x = e.parentElement; x && x !== document.body; x = x.parentElement) { if (x.tagName === 'DETAILS' && !x.open && !e.closest('summary')) return true; const st = getComputedStyle(x); if ((st.overflow !== 'visible' || st.overflowY !== 'visible') && x.getBoundingClientRect().height < 2) return true; } return false; };
  const vis = (e) => { if (collapsed(e)) return false; const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  const fixedAnc = (e) => { for (let x = e; x && x !== document.body; x = x.parentElement) { const ps = getComputedStyle(x).position; if (ps === 'fixed' || ps === 'sticky') return true; } return false; };
  const scrollerAnc = (e) => { for (let x = e.parentElement; x && x !== document.body && x !== document.documentElement; x = x.parentElement) { const o = getComputedStyle(x).overflowX; if ((o === 'auto' || o === 'scroll') && x.scrollWidth > x.clientWidth + 1) return true; } return false; };
  const label = (e) => (e.textContent || e.name || e.tagName).trim().replace(/\s+/g, ' ').slice(0, 18) || (e.className || e.tagName).toString().slice(0, 18);
  const out = { shadowEls: [], overflow: document.documentElement.scrollWidth - innerWidth, overlaps: [], clipped: [], gradient: 0, shadow: 0, small: [] };
  const ctl = [...document.querySelectorAll('button, a.btn, .chip, .tab a, nav a, input:not([type=hidden]), select, textarea')].filter(vis).filter((e) => !e.closest('.hidden,[hidden],dialog:not([open])'));
  const rects = ctl.map((e) => ({ e, r: e.getBoundingClientRect() }));
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], c = rects[j]; if (a.e.contains(c.e) || c.e.contains(a.e)) continue;
    const w = Math.min(a.r.right, c.r.right) - Math.max(a.r.left, c.r.left), h = Math.min(a.r.bottom, c.r.bottom) - Math.max(a.r.top, c.r.top);
    if (w > 2 && h > 2) { if (!fixedAnc(a.e) && !fixedAnc(c.e)) out.overlaps.push(label(a.e) + ' x ' + label(c.e)); }
  }
  for (const { e, r } of rects) { if ((r.right > innerWidth + 1 || r.left < -1) && !scrollerAnc(e)) out.clipped.push(label(e)); if ((e.tagName === 'BUTTON' || e.classList.contains('btn')) && !e.classList.contains('switch') && r.height < 28) out.small.push(label(e) + ' h=' + Math.round(r.height)); }
  for (const e of document.querySelectorAll('*')) { const s = getComputedStyle(e); if (/gradient/.test(s.backgroundImage)) out.gradient++; if (s.boxShadow !== 'none' && !e.matches('input:focus,button:focus,:focus-visible,:focus')) { out.shadow++; out.shadowEls.push(e.tagName + '.' + String(e.className).slice(0, 20) + ' ' + s.boxShadow.slice(0, 40)); } }
  out.body = parseFloat(getComputedStyle(document.body).fontSize);
  out.h = [...document.querySelectorAll('h1,h2')].filter(vis).map((h) => parseFloat(getComputedStyle(h).fontSize));
  return out;
};
async function audit(p, w, role, name) {
  const o = await p.evaluate(inspect); const id = `${w} ${role} ${name}`;
  res(o.overflow <= 1, id + ' no horizontal overflow', o.overflow + 'px');
  res(o.overlaps.length === 0, id + ' no overlapping controls', o.overlaps.slice(0, 3).join(' | '));
  res(o.clipped.length === 0, id + ' no controls cut off', o.clipped.slice(0, 3).join(' | '));
  res(o.gradient === 0, id + ' no gradients', String(o.gradient));
  res(o.shadow === 0, id + ' no shadows', o.shadowEls.slice(0, 3).join(' | '));
  res(o.body <= 15 && o.h.every((x) => x >= 15 && x <= 22), id + ' type scale', `body ${o.body}, h ${o.h.join('/')}`);
  if (o.small.length) console.log(`NOTE ${id} small controls: ${o.small.slice(0, 4).join(', ')}`);
  const dir = `/workspace/trimslot/screenshots/${OUT}/${w}/`; fs.mkdirSync(dir, { recursive: true });
  await p.screenshot({ path: dir + `${role}-${name.replace(/[^a-z0-9]+/gi, '_')}.png`, fullPage: true });
}
async function mk(w) {
  const mobile = w < 800; const ctx = await b.newContext({ viewport: { width: w, height: mobile ? 800 : 900 }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, baseURL: BASE });
  if (process.env.THEME) await ctx.addInitScript((t) => { try { localStorage.setItem('trimslot_theme', t); } catch {} }, process.env.THEME);   // THEME=dark|light
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(w + ' ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/favicon|429|Failed to load resource/.test(m.text())) errs.push(w + ' console ' + m.text().slice(0, 120)); });
  return { ctx, p };
}
async function login(p, id, pw) { await p.goto('/#/login'); await p.fill('[name=identifier]', id); await p.fill('[name=password]', pw); await p.click('button[type=submit]'); await p.waitForFunction(() => !location.hash.includes('login'), null, { timeout: 8000 }); await p.waitForTimeout(500); }
for (const w of [360, 390, 1280]) {
  { const { ctx, p } = await mk(w); await p.goto('/'); await p.waitForTimeout(500); await audit(p, w, 'public', 'landing'); await p.goto('/#/login'); await p.waitForTimeout(300); await audit(p, w, 'public', 'login'); await p.goto('/#/signup?role=barber'); await p.waitForTimeout(300); await audit(p, w, 'public', 'signup-barber'); await ctx.close(); }
  { const { ctx, p } = await mk(w); await login(p, CUST[0], CUST[1]);
    for (const r of CUSTOMER) { await p.goto('/' + r); await p.waitForTimeout(700); await audit(p, w, 'customer', r); }
    // booking wizard: service -> slots -> payment step
    await p.goto(`/#/book/${SHOP}`); await p.waitForSelector('.svc'); await p.locator('.svc').first().click(); await audit(p, w, 'customer', 'wizard-service'); await p.click('#next'); await p.waitForSelector('[data-t]'); await p.waitForTimeout(400);
    await p.evaluate(() => { const c = document.querySelector('.chips'); c.innerHTML = Array.from({ length: 60 }, (_, i) => `<button class="chip" data-t="x">${(8 + Math.floor(i / 4)) % 12 || 12}:${['00', '15', '30', '45'][i % 4]} ${i < 16 ? 'AM' : 'PM'}</button>`).join(''); });
    await audit(p, w, 'customer', 'wizard-60-slots');
    await ctx.close(); }
  { const { ctx, p } = await mk(w); await login(p, BARB[0], BARB[1]);
    for (const r of BARBER) { await p.goto('/' + r); await p.waitForTimeout(700); await audit(p, w, 'barber', r); if (r === '#/settings') { await p.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; })); await p.waitForTimeout(300); await audit(p, w, 'barber', 'settings-all-open'); } }
    await ctx.close(); }
  { const { ctx, p } = await mk(w); await p.goto('/admin.html'); await p.fill('#key', ADMINKEY); await p.click('#lf button'); await p.waitForSelector('.tiles', { timeout: 10000 }); await p.waitForTimeout(500);
    for (const r of ADMIN) { await p.goto('/admin.html#/' + r); await p.waitForTimeout(900); await audit(p, w, 'admin', r); }
    await ctx.close(); }
}
console.log(`\nconsole/page errors: ${errs.length}`); errs.slice(0, 8).forEach((e) => console.log('  ' + e));
console.log(`${total - fails}/${total} checks passed`); await b.close(); process.exit(fails || errs.length ? 1 : 0);
