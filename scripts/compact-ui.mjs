/* Compact-rows UI checks (local mock server with scripts/compact-seed.mjs data): rows are 56-72px and never wrap, tapping a row opens the pop-up with the actions,
   bulk select still works, no horizontal overflow at 360px, wide screens keep the table. Usage: node scripts/compact-ui.mjs (env BASE, ADMINKEY, THEME) */
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
const BASE = process.env.BASE || 'http://localhost:4102', KEY = process.env.ADMINKEY || 'local-admin-key-xyz', THEME = process.env.THEME || 'light';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let fail = 0, n = 0; const ok = (name, cond, extra = '') => { n++; if (!cond) fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' :: ' + extra : '')); };
async function admin(w, h = 800) { const c = await b.newContext({ viewport: { width: w, height: h }, isMobile: w < 720, hasTouch: w < 720, baseURL: BASE, colorScheme: THEME }); await c.addInitScript((t) => localStorage.setItem('trimslot_theme', t), THEME);
  const p = await c.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); await p.goto('/admin.html'); await p.fill('#key', KEY); await p.click('#lf button'); await p.waitForSelector('.tiles'); return { c, p, errs }; }
const heights = (p) => p.evaluate(() => [...document.querySelectorAll('#lbody .crow')].map((e) => Math.round(e.getBoundingClientRect().height)));
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
{ const { c, p, errs } = await admin(360);
  for (const [route, name] of [['bookings', 'bookings'], ['customers', 'customers'], ['plans', 'plan purchases'], ['credits', 'credits'], ['reports', 'reports'], ['payments', 'payments'], ['reviews', 'reviews'], ['waitlist', 'waitlist'], ['ledger', 'ledger']]) {
    await p.goto('/admin.html#/' + route); await p.waitForTimeout(1200);
    if (route === 'reports' || route === 'waitlist') { await p.locator('#lpills button[data-v=""]').click(); await p.waitForTimeout(800); }
    if (route === 'payments') { await p.locator('#lpills button[data-v="all"]').click(); await p.waitForTimeout(800); }
    const hs = await heights(p); ok(`${name}: rows exist`, hs.length > 0, hs.length + ' rows');
    ok(`${name}: every row 56-72px at 360px`, hs.every((x) => x >= 56 && x <= 72), 'min ' + Math.min(...hs) + ' max ' + Math.max(...hs));
    ok(`${name}: no horizontal overflow`, (await overflow(p)) <= 0);
    ok(`${name}: no stacked label/value cells`, (await p.locator('#lbody td[data-l]').count()) === 0);
    const wrapped = await p.evaluate(() => [...document.querySelectorAll('#lbody .crow .ct,#lbody .crow .cm')].filter((e) => e.getBoundingClientRect().height > 24).length); ok(`${name}: titles/meta never wrap`, wrapped === 0);
  }
  // barbers: email truncated with an ellipsis on a single line
  await p.goto('/admin.html#/barbers'); await p.waitForTimeout(1000); await p.locator('#lpills button[data-v=""]').click(); await p.waitForTimeout(800);
  const em = await p.evaluate(() => { const e = [...document.querySelectorAll('#lbody .crow .cm')].find((x) => x.textContent.includes('@trimslot-demo-example.com')); if (!e) return null; return { h: e.getBoundingClientRect().height, clipped: e.scrollWidth > e.clientWidth, ell: getComputedStyle(e).textOverflow, ws: getComputedStyle(e).whiteSpace }; });
  ok('barbers: long email is one line with ellipsis', !!em && em.h <= 24 && em.ell === 'ellipsis' && em.ws === 'nowrap' && em.clipped, JSON.stringify(em));
  // tapping a row opens the sheet with actions (barber: Approve / Reject etc.)
  await p.locator('#lpills button[data-v="PENDING"]').click(); await p.waitForTimeout(800);
  await p.locator('#lbody .crow').first().click({ position: { x: 150, y: 12 } }); await p.waitForSelector('.modal .sheet', { timeout: 5000 }); await p.waitForTimeout(500);
  ok('barbers: tap opens pop-up with Approve', (await p.locator('.sheet button', { hasText: 'Approve' }).count()) > 0);
  const sheetBox = await p.locator('.sheet').boundingBox(); ok('pop-up is a bottom sheet on a phone', !!sheetBox && sheetBox.y + sheetBox.height >= 795 && sheetBox.width >= 350, JSON.stringify(sheetBox));
  await p.keyboard.press('Escape'); await p.waitForTimeout(300); ok('Escape closes the pop-up', (await p.locator('.modal').count()) === 0);
  // bulk select still works from the compact row
  await p.locator('#lbody .crow .selbox input').first().check(); await p.waitForSelector('#lbulk:not(.hidden)'); ok('bulk bar appears after ticking a row', /1 selected/.test(await p.locator('#lbulk').innerText()));
  await p.locator('#lbody .crow .selbox input').first().click(); await p.waitForTimeout(200);
  await p.locator('#lallc').check(); await p.waitForTimeout(300); const nsel = await p.locator('#lbody .crow .selbox input:checked').count(); ok('select-all ticks every loaded row', nsel === (await p.locator('#lbody .crow').count()) && nsel > 0, nsel + ' ticked');
  await p.locator('#bclear').click(); ok('Clear unticks rows', (await p.locator('#lbody .crow .selbox input:checked').count()) === 0);
  // plan purchase: sheet has Adjust and Cancel and they open their forms
  await p.goto('/admin.html#/plans'); await p.waitForTimeout(1200);
  const act = p.locator('#lbody .crow', { hasText: 'ACTIVE' }).first(); await act.click({ position: { x: 150, y: 12 } }); await p.waitForSelector('.modal .sheet');
  ok('plan purchase pop-up shows Adjust + Cancel', (await p.locator('.sheet button', { hasText: 'Adjust' }).count()) === 1 && (await p.locator('.sheet button', { hasText: 'Cancel' }).count()) === 1);
  await p.locator('.sheet button', { hasText: 'Adjust' }).click(); await p.waitForSelector('.modal form', { timeout: 4000 }); ok('Adjust opens its form from the pop-up', /Adjust plan purchase/.test(await p.locator('.modal').first().innerText()));
  await p.keyboard.press('Escape');
  // credits: Revoke from the pop-up
  await p.goto('/admin.html#/credits'); await p.waitForTimeout(1200);
  await p.locator('#lbody .crow', { hasText: 'AVAILABLE' }).first().click({ position: { x: 150, y: 12 } }); await p.waitForSelector('.modal .sheet');
  ok('credit pop-up shows Revoke', (await p.locator('.sheet button', { hasText: 'Revoke' }).count()) === 1);
  await p.locator('.sheet button', { hasText: 'Revoke' }).click(); await p.waitForTimeout(500); ok('Revoke opens its form', /Revoke credit/.test(await p.locator('.modal').first().innerText())); await p.keyboard.press('Escape');
  // reports: pop-up has Resolve / Dismiss / Delete
  await p.goto('/admin.html#/reports'); await p.waitForTimeout(1200); await p.locator('#lbody .crow', { hasText: 'OPEN' }).first().click({ position: { x: 150, y: 12 } }); await p.waitForSelector('.modal .sheet');
  { const t = (await p.locator('.sheet .btns button').allInnerTexts()).join('|'); ok('report pop-up shows Resolve, Dismiss, Delete', ['Resolve', 'Dismiss', 'Delete'].every((x) => t.includes(x)), t); }
  await p.keyboard.press('Escape');
  // refund decisions (legacy table helper): compact rows + proxy actions
  await p.goto('/admin.html#/decisions'); await p.waitForTimeout(1200);
  if (await p.locator('.tblset .crow').count()) { await p.locator('.tblset .crow').first().click(); await p.waitForSelector('.modal .sheet'); ok('refund decision pop-up shows Convert + Refund', /Convert to credit/.test(await p.locator('.sheet').innerText()) && /Refund/.test(await p.locator('.sheet .btns').innerText())); await p.keyboard.press('Escape'); }
  ok('no script errors', errs.length === 0, errs.join(' | ')); await c.close(); }
{ const { c, p, errs } = await admin(1280, 900);
  await p.goto('/admin.html#/bookings'); await p.waitForTimeout(1200);
  ok('desktop: table layout kept, no phone rows', (await p.locator('#ltbl tbody tr').count()) > 0 && (await p.locator('#lbody .crow').count()) === 0);
  await p.goto('/admin.html#/plans'); await p.waitForTimeout(1200); ok('desktop plans: inline Adjust/Cancel still in the table', (await p.locator('#ltbl button', { hasText: 'Adjust' }).count()) > 0);
  await p.setViewportSize({ width: 360, height: 800 }); await p.waitForTimeout(500); ok('resizing to a phone switches to compact rows', (await p.locator('#lbody .crow').count()) > 0 && (await p.locator('#ltbl').count()) === 0);
  ok('no script errors (desktop)', errs.length === 0, errs.join(' | ')); await c.close(); }
await b.close(); console.log(`\n${n - fail}/${n} checks passed`); process.exit(fail ? 1 : 0);
