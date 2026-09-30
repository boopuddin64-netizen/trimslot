// Screenshots + layout audit for the admin power tools and the off-app ledger (local seeded server only).
// Usage: BASE=http://localhost:4102 KEY=... node scripts/admin-power-shots.mjs [outdir]
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:4102', KEY = process.env.KEY || '';
const OUT = process.argv[2] || new URL('../screenshots/admin/power/', import.meta.url).pathname;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let problems = 0; const log = (ok, m) => { if (!ok) problems++; console.log((ok ? 'ok   ' : 'FAIL ') + m); };
for (const W of [390, 1280]) {
  fs.mkdirSync(OUT + W, { recursive: true });
  const mobile = W < 500;
  const mk = async () => { const ctx = await browser.newContext({ viewport: { width: W, height: mobile ? 780 : 860 }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, baseURL: BASE }); const p = await ctx.newPage(); p.on('pageerror', (e) => log(false, 'PAGE ERROR ' + e.message)); p.on('console', (m) => { if (m.type() === 'error') log(false, 'console: ' + m.text().slice(0, 100)); }); return p; };
  const audit = async (p, label) => { const o = await p.evaluate(() => { const vw = document.documentElement.clientWidth; const r = []; if (document.documentElement.scrollWidth > vw + 1) r.push('page ' + document.documentElement.scrollWidth); for (const el of document.querySelectorAll('.sheet *, main *, .topbar *')) { const b = el.getBoundingClientRect(); if (b.width && (b.right > vw + 1 || b.left < -1) && !el.closest('.anav') && !el.closest('.tblwrap') && !el.closest('.chart')) r.push(el.tagName + '.' + el.className + ' ' + Math.round(b.right)); } const small = []; for (const b of document.querySelectorAll('button, .btn, select, input:not([type=checkbox])')) { const r2 = b.getBoundingClientRect(); if (r2.width && r2.height && r2.height < 32 && !b.closest('.anav') && getComputedStyle(b).visibility !== 'hidden') small.push((b.textContent || b.name || b.id).trim().slice(0, 14) + ':' + Math.round(r2.height)); } return { r, small }; }); log(!o.r.length, `${W}px ${label}: no overflow ${o.r.slice(0, 3).join(' | ')}`); log(!o.small.length, `${W}px ${label}: controls >=32px tall ${o.small.slice(0, 4).join(',')}`); };
  const shot = async (p, n, full) => { await p.screenshot({ path: `${OUT}${W}/${n}.png`, fullPage: !!full }); };
  const a = await mk(); await a.goto('/admin.html'); await a.fill('#key', KEY); await a.click('#lf button[type=submit]'); await a.waitForSelector('#shell:not(.hidden)');
  const go = async (sec, sel, name, label) => { await a.goto('/admin.html#/' + sec); await a.waitForSelector(sel, { timeout: 8000 }); await a.waitForTimeout(450); await shot(a, name, true); await audit(a, label || sec); };
  await go('overview', '.tiles', '01-overview', 'overview');
  await go('customers', '.tbl', '02-customers', 'customers');
  await a.locator('[data-do=open]').first().click(); await a.waitForSelector('.sheet'); await a.waitForTimeout(400); await shot(a, '03-customer-sheet'); await audit(a, 'customer sheet'); await a.keyboard.press('Escape');
  await a.locator('tr', { hasText: 'Amaka' }).locator('[data-do=open]').click(); await a.waitForSelector('.sheet'); await a.locator('.sheet [data-k=reinstate]').waitFor(); await shot(a, '04-customer-suspended-sheet'); await a.keyboard.press('Escape');
  await a.locator('.sheet').count() || 0;
  await go('bookings', '.tbl', '05-bookings', 'bookings');
  await a.locator('[data-do=manage]').first().click(); await a.waitForSelector('.sheet'); await a.waitForTimeout(400); await shot(a, '06-booking-sheet'); await audit(a, 'booking sheet');
  if (await a.locator('.sheet [data-k=reschedule]').count()) { await a.locator('.sheet [data-k=reschedule]').click(); await a.waitForSelector('#fm'); await shot(a, '07-reschedule-form'); await audit(a, 'reschedule form'); }
  await a.keyboard.press('Escape');
  await go('earnings', '.tiles', '08-earnings', 'earnings');
  await go('ledger', '.tbl', '09-ledger', 'ledger');
  await a.locator('[data-do=open]').first().click(); await a.waitForSelector('.sheet'); await a.waitForTimeout(400); await shot(a, '10-ledger-sheet'); await audit(a, 'ledger sheet');
  await a.locator('.sheet [data-k=settle]').click(); await a.waitForSelector('#fm'); await a.fill('[name=amount_naira]', '100'); await a.fill('[name=reason]', 'Bank transfer ref 4471'); await shot(a, '11-ledger-settle-form'); await audit(a, 'settle form'); await a.keyboard.press('Escape');
  await go('reports', '.tbl', '12-reports', 'reports');
  await a.locator('[data-do=res]').first().click(); await a.waitForSelector('#fm'); await shot(a, '13-report-resolve-form'); await audit(a, 'resolve form'); await a.keyboard.press('Escape');
  await go('analytics', '.chart', '14-analytics', 'analytics');
  await go('broadcast', '#bf', '15-broadcast', 'broadcast');
  await go('controls', '#cf', '16-controls', 'controls');
  await go('audit', '#alist', '17-audit-filters', 'audit');
  await go('plans', '.tbl', '18-plans', 'plans');
  await go('payments', '.tiles', '19-payments', 'payments');
  // global search
  await a.goto('/admin.html#/overview'); await a.waitForSelector('#gsearch'); await a.fill('#gsearch', 'chidi'); await a.waitForSelector('.gres a'); await a.waitForTimeout(300); await shot(a, '20-global-search'); await audit(a, 'global search');
  // barber sheet with new controls
  await a.goto('/admin.html#/barbers'); await a.waitForSelector('[data-tab]'); await a.click('[data-tab=VERIFIED]'); await a.locator('[data-do=detail]').first().click(); await a.waitForSelector('.sheet'); await a.waitForTimeout(400); await shot(a, '21-barber-sheet-controls'); await audit(a, 'barber sheet'); await a.keyboard.press('Escape');
  // barber app + customer app
  const b = await mk(); await b.goto('/#/login'); await b.waitForSelector('#f'); await b.fill('[name=identifier]', 'mike@trimslot.demo'); await b.fill('[name=password]', 'Barber123!'); await b.click('button[type=submit]'); await b.waitForSelector('.tabs, #tabs a'); 
  await b.goto('/#/balance'); await b.waitForSelector('h1:has-text("Platform balance owed")'); await b.waitForTimeout(500); await shot(b, '22-barber-balance', true); await audit(b, 'barber balance');
  await b.goto('/#/profile'); await b.waitForTimeout(500); await shot(b, '23-barber-profile-balance-link', true);
  await b.goto('/#/b/6'); await b.waitForSelector('[data-report]'); await b.waitForTimeout(300); await shot(b, '24-barber-booking-report', true); await b.click('[data-report]'); await b.waitForSelector('#rform'); await shot(b, '25-barber-report-form'); await audit(b, 'barber report form');
  const c = await mk(); await c.goto('/#/login'); await c.waitForSelector('#f'); await c.fill('[name=identifier]', 'chidi@trimslot.demo'); await c.fill('[name=password]', 'Customer123!'); await c.click('button[type=submit]'); await c.waitForTimeout(800);
  await c.goto('/#/bookings'); await c.waitForTimeout(500); await shot(c, '26-customer-bookings');
  await a.context().close(); await b.context().close(); await c.context().close();
}
console.log(problems ? `\n${problems} problem(s)` : '\nAll power-tool layout checks passed'); await browser.close(); process.exit(problems ? 1 : 0);
