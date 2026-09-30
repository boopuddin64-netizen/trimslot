// Screenshots + layout audit for the barber review workflow (admin Barbers tabs, detail, reason forms, suspend warning, barber-side banners).
// Usage: BASE=http://localhost:4102 KEY=... node scripts/admin-review-shots.mjs [outdir]   (local seeded server only)
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:4102', KEY = process.env.KEY || '';
const OUT = process.argv[2] || new URL('../screenshots/admin/review/', import.meta.url).pathname;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let problems = 0; const log = (ok, m) => { if (!ok) problems++; console.log((ok ? 'ok   ' : 'FAIL ') + m); };
for (const W of [390, 1280]) {
  fs.mkdirSync(OUT + W, { recursive: true });
  const mobile = W < 500;
  const mk = async () => { const ctx = await browser.newContext({ viewport: { width: W, height: mobile ? 780 : 860 }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, baseURL: BASE }); const p = await ctx.newPage(); p.on('pageerror', (e) => log(false, 'PAGE ERROR ' + e.message)); return p; };
  const audit = async (p, label) => { const o = await p.evaluate(() => { const vw = document.documentElement.clientWidth; const r = []; if (document.documentElement.scrollWidth > vw + 1) r.push('page ' + document.documentElement.scrollWidth); for (const el of document.querySelectorAll('.sheet *, main *')) { const b = el.getBoundingClientRect(); if (b.width && (b.right > vw + 1 || b.left < -1) && !el.closest('.anav') && !el.closest('.tblwrap')) r.push(el.tagName + '.' + el.className + ' ' + Math.round(b.right)); } return r; }); log(!o.length, `${W}px ${label}: no overflow ${o.slice(0, 3).join(' | ')}`); };
  const shot = async (p, n) => { await p.screenshot({ path: `${OUT}${W}/${n}.png` }); };
  const a = await mk(); await a.goto('/admin.html'); await a.fill('#key', KEY); await a.click('#lf button[type=submit]'); await a.waitForSelector('#shell:not(.hidden)');
  await a.goto('/admin.html#/barbers'); await a.waitForSelector('[data-tab]'); await a.waitForTimeout(500); await shot(a, '01-barbers-pending-tab'); await audit(a, 'barbers pending tab');
  await a.click('[data-tab=ALL]'); await a.waitForTimeout(300); await a.screenshot({ path: `${OUT}${W}/02-barbers-all-tab-full.png`, fullPage: true });
  await a.click('[data-tab=NEEDS_INFO]'); await a.waitForTimeout(300); await shot(a, '03-barbers-needs-info-tab');
  await a.click('[data-tab=PENDING]'); await a.waitForTimeout(300);
  await a.locator('[data-do=detail]').first().click(); await a.waitForSelector('.sheet'); await a.waitForTimeout(400); await shot(a, '04-barber-detail'); await audit(a, 'detail sheet');
  await a.locator('.sheet .btns.sticky [data-k=reject]').click(); await a.waitForSelector('#rtxt'); await a.fill('#rtxt', 'Please add a clear shop photo.'); await shot(a, '05-reject-reason-form'); await audit(a, 'reject form');
  await a.keyboard.press('Escape');
  await a.click('[data-tab=VERIFIED]'); await a.waitForTimeout(300);
  await a.locator('[data-do=detail]').first().click(); await a.waitForSelector('.sheet'); await a.locator('.sheet [data-k=suspend]').click(); await a.fill('#rtxt', 'Investigating repeated no-show complaints.'); await a.click('#rgo'); await a.waitForSelector('.warnbox'); await a.waitForTimeout(300); await shot(a, '06-suspend-upcoming-bookings-warning'); await audit(a, 'suspend warning');
  await a.keyboard.press('Escape');
  const b = await mk(); await b.goto('/#/login');
  for (const [email, name] of [['femi@demo.test', '07-barber-rejected-banner'], ['kemi@demo.test', '08-barber-needs-info-banner'], ['ade@demo.test', '09-barber-pending-banner']]) {
    await b.context().clearCookies(); await b.goto('/#/login'); await b.waitForSelector('#f'); await b.fill('[name=identifier]', email); await b.fill('[name=password]', 'Barber123!'); await b.click('button[type=submit]'); await b.waitForSelector('#rvbox'); await b.waitForTimeout(400); await shot(b, name); await audit(b, name);
  }
  await b.context().clearCookies(); await b.goto('/#/login'); await b.waitForSelector('#f'); await b.fill('[name=identifier]', 'femi@demo.test'); await b.fill('[name=password]', 'Barber123!'); await b.click('button[type=submit]'); await b.waitForSelector('[data-resubmit]'); await b.click('[data-resubmit]'); await b.waitForSelector('#rvbox:has-text("Awaiting verification")'); log(true, `${W}px resubmit moves the banner to pending`); await shot(b, '10-barber-after-resubmit');
  await a.context().close(); await b.context().close();
  // restore femi to rejected for the second width
  await fetch(BASE + '/api/admin/barbers?x=1', { headers: { Authorization: 'Bearer ' + KEY } }).then(async (r) => { const j = await r.json(); const id = j.barbers.find((x) => x.shop_name === 'Gent Lounge').id; await fetch(`${BASE}/api/admin/barbers/${id}/reject`, { method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'We could not match the shop address. Please enter your full street address.' }) }); });
}
console.log(problems ? `\n${problems} problem(s)` : '\nAll review layout checks passed'); await browser.close(); process.exit(problems ? 1 : 0);
