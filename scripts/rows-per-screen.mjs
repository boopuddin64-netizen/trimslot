/* Measures list density (rows per screen) for admin, customer and barber lists at a phone viewport.
   Usage: node scripts/rows-per-screen.mjs [label]   (env BASE, ADMINKEY, W=360, H=800, THEME=light|dark, SHOTS=dir)
   Prints a table: loaded rows, average row pitch (px), rows fully visible on the first screen, rows that fit in one viewport-height of list. */
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:4102', KEY = process.env.ADMINKEY || 'local-admin-key-xyz';
const W = Number(process.env.W || 360), H = Number(process.env.H || 800), THEME = process.env.THEME || 'light', LABEL = process.argv[2] || 'run', SHOTS = process.env.SHOTS || '';
const CUST = (process.env.CUST || 'chidi@trimslot.demo:Customer123!').split(':'), BARB = (process.env.BARB || 'mike@trimslot.demo:Barber123!').split(':');
const ROWSEL = '#lbody .crow, #lbody tbody tr[data-id], .crow, .tbl tbody tr, .bk-row, .lrow, .card.bk, a.bkcard, [data-row]';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
async function ctx() { const c = await b.newContext({ viewport: { width: W, height: H }, isMobile: true, hasTouch: true, baseURL: BASE, colorScheme: THEME }); await c.addInitScript((t) => { try { localStorage.setItem('trimslot_theme', t); } catch {} }, THEME); return c; }
async function measure(p, name, sel = ROWSEL) {
  const m = await p.evaluate(({ sel, H }) => {
    const els = [...document.querySelectorAll(sel)].filter((e) => e.getBoundingClientRect().height > 8 && getComputedStyle(e).display !== 'none');
    if (!els.length) return null;
    const tops = els.map((e) => e.getBoundingClientRect().top + scrollY), hs = els.map((e) => e.getBoundingClientRect().height);
    const pitch = els.length > 1 ? (tops[tops.length - 1] - tops[0]) / (els.length - 1) : hs[0];
    const vis = els.filter((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= H; }).length;
    return { n: els.length, h: Math.round(hs.reduce((a, c) => a + c, 0) / hs.length), pitch: Math.round(pitch * 10) / 10, vis, per: Math.round((H / pitch) * 10) / 10, firstTop: Math.round(tops[0]) };
  }, { sel, H });
  console.log(`${LABEL} | ${THEME} ${W}x${H} | ${name.padEnd(22)} | ` + (m ? `rows=${String(m.n).padStart(2)} height=${m.h}px pitch=${m.pitch}px  visible-on-first-screen=${m.vis}  rows-per-${H}px=${m.per}` : 'NO ROWS FOUND'));
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: `${SHOTS}/${name.replace(/[^a-z0-9]+/gi, '_')}.png` }); }
  return m;
}
{ const c = await ctx(); const p = await c.newPage(); await p.goto('/admin.html'); await p.fill('#key', KEY); await p.click('#lf button'); await p.waitForSelector('.tiles', { timeout: 10000 });
  const go = async (r, name, click) => { await p.goto('/admin.html#/' + r); await p.waitForTimeout(1200); if (click) { await p.locator(click).first().click().catch(() => {}); await p.waitForTimeout(900); } await measure(p, 'admin-' + (name || r)); };
  await go('bookings'); await go('barbers', 'barbers', '#lpills button[data-v=""]'); await go('customers'); await go('plans', 'plans-purchases'); await go('credits'); await go('reports', 'reports', '#lpills button[data-v=""]'); await go('payments', 'payments', '#lpills button[data-v="all"]'); await go('ledger'); await go('reviews'); await go('waitlist', 'waitlist', '#lpills button[data-v=""]'); await go('decisions');
  await p.goto('/admin.html#/plans'); await p.waitForTimeout(900); await p.locator('[data-tab=plans]').click(); await p.waitForTimeout(1000); await measure(p, 'admin-plans-offer');
  await c.close(); }
{ const c = await ctx(); const p = await c.newPage(); await p.goto('/#/login'); await p.fill('[name=identifier]', CUST[0]); await p.fill('[name=password]', CUST[1]); await p.click('button[type=submit]'); await p.waitForFunction(() => !location.hash.includes('login')); await p.waitForTimeout(600);
  for (const r of ['bookings', 'wallet', 'notifications']) { await p.goto('/#/' + r); await p.waitForTimeout(1000); await measure(p, 'customer-' + r, '.card.bk, .bkcard, .lrow, .crow, .card'); }
  await c.close(); }
{ const c = await ctx(); const p = await c.newPage(); await p.goto('/#/login'); await p.fill('[name=identifier]', BARB[0]); await p.fill('[name=password]', BARB[1]); await p.click('button[type=submit]'); await p.waitForFunction(() => !location.hash.includes('login')); await p.waitForTimeout(600);
  for (const r of ['today', 'upcoming', 'customers', 'plans', 'reviews', 'notifications']) { await p.goto('/#/' + r); await p.waitForTimeout(1000); await measure(p, 'barber-' + r, '.card.bk, .bkcard, .lrow, .crow, .card'); }
  await c.close(); }
await b.close();
