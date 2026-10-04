/* v5: tightening pass + payout setup + admin PIN/deletes, at 360 and 390px. Run against the local dev server (REQUIRE_PAYOUT=1, mock mode). */
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
const BASE = 'http://localhost:4102', ADMINKEY = 'local-admin-key-xyz';
import pg from 'pg';
const db = new pg.Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:54320/trimslot' }); await db.connect();
const resetState = async () => { await db.query(`UPDATE barbers SET paystack_subaccount=NULL, payout_bank_code=NULL, payout_bank_name=NULL, payout_account_last4=NULL, payout_account_name=NULL, payout_set_at=NULL WHERE id=1`); await db.query('DELETE FROM admin_pin'); await db.query(`UPDATE users SET account_status='ACTIVE', deleted_at=NULL WHERE account_status='DELETED'`); };
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let fails = 0; const errs = []; const ok = (n, c) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const noGradient = (p) => p.evaluate(() => ![...document.querySelectorAll('*')].some((e) => { const s = getComputedStyle(e); return /gradient/.test(s.backgroundImage) || /gradient/.test(s.boxShadow); }));
const fontsOk = (p) => p.evaluate(() => { const bs = parseFloat(getComputedStyle(document.body).fontSize); const hs = [...document.querySelectorAll('h1,h2')].map((h) => parseFloat(getComputedStyle(h).fontSize)); return bs === 14 && hs.every((x) => x >= 16 && x <= 22); });
async function ctxFor(w, dark = false) {
  const ctx = await b.newContext({ viewport: { width: w, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, baseURL: BASE, colorScheme: dark ? 'dark' : 'light' });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(w + ' ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/favicon|429|Failed to load resource/.test(m.text())) errs.push(w + ' console ' + m.text()); });
  return { ctx, p };
}
async function login(p, id, pw) { await p.goto('/#/login'); await p.fill('[name=identifier]', id); await p.fill('[name=password]', pw); await p.click('button[type=submit]'); await p.waitForFunction(() => !location.hash.includes('login'), null, { timeout: 8000 }); await p.waitForTimeout(500); }
for (const w of [360, 390]) {
  await resetState();
  const OUT = `/workspace/trimslot/screenshots/v5/${w}/`; const shot = (p, n, full) => p.screenshot({ path: OUT + n + '.png', fullPage: !!full });
  /* ---- logged-out: landing + login (button state) ---- */
  { const { ctx, p } = await ctxFor(w); await p.goto('/'); await p.waitForTimeout(600); await shot(p, '01-landing');
    ok(w + ' landing no overflow', await noOverflow(p)); ok(w + ' landing fonts 14px body / 16-22px headings', await fontsOk(p)); ok(w + ' landing no gradients', await noGradient(p));
    await p.goto('/#/login'); await p.waitForSelector('form'); await p.waitForTimeout(300);
    const btn = p.locator('form button[type=submit]'); const d0 = await btn.isDisabled(); const bg0 = await btn.evaluate((e) => getComputedStyle(e).backgroundColor); await shot(p, '02-login-invalid');
    await p.fill('[name=identifier]', 'chidi@trimslot.demo'); await p.fill('[name=password]', 'Customer123!'); await p.waitForTimeout(100);
    const d1 = await btn.isDisabled(); const bg1 = await btn.evaluate((e) => getComputedStyle(e).backgroundColor); const img = await btn.evaluate((e) => getComputedStyle(e).backgroundImage);
    await shot(p, '03-login-valid');
    ok(w + ' primary button disabled+neutral while form invalid', d0 && bg0 !== bg1); ok(w + ' primary button solid accent when valid (no gradient)', !d1 && img === 'none'); await ctx.close(); }
  /* ---- customer ---- */
  { const { ctx, p } = await ctxFor(w); await login(p, 'chidi@trimslot.demo', 'Customer123!'); await shot(p, '10-customer-home', true);
    ok(w + ' home no overflow', await noOverflow(p)); ok(w + ' home no gradients', await noGradient(p)); ok(w + ' home fonts', await fontsOk(p));
    await p.goto('/#/barber/1'); await p.waitForTimeout(700); await shot(p, '11-barber-page', true);
    await p.goto('/#/book/1'); await p.waitForSelector('.svc'); await p.locator('.svc').first().click(); await shot(p, '12-book-service'); await p.click('#next'); await p.waitForSelector('[data-t]'); await p.waitForTimeout(300);
    await shot(p, '13-book-slots', true);
    const n = await p.locator('[data-t]').count(); ok(w + ' real slots rendered: ' + n, n > 3);
    // stress: 60 slots, then pairwise overlap + overflow check
    await p.evaluate(() => { const c = document.querySelector('.chips'); c.innerHTML = Array.from({ length: 60 }, (_, i) => `<button class="chip ${i === 4 ? 'on' : ''}" data-t="x">${(8 + Math.floor(i / 4)) % 12 || 12}:${['00', '15', '30', '45'][i % 4]} ${i < 16 ? 'AM' : 'PM'}</button>`).join(''); });
    await p.waitForTimeout(150); await shot(p, '14-book-slots-60', true);
    const ov = await p.evaluate(() => { const r = [...document.querySelectorAll('.chips .chip')].map((e) => e.getBoundingClientRect()); const cont = document.querySelector('.chips').getBoundingClientRect(); let bad = 0; for (let i = 0; i < r.length; i++) { if (r[i].right > cont.right + 0.5 || r[i].left < cont.left - 0.5) bad++; for (let j = i + 1; j < r.length; j++) { const a = r[i], c = r[j]; if (a.left < c.right - 0.5 && c.left < a.right - 0.5 && a.top < c.bottom - 0.5 && c.top < a.bottom - 0.5) bad++; } } return { bad, n: r.length, widths: new Set(r.map((x) => Math.round(x.width))).size, heights: new Set(r.map((x) => Math.round(x.height))).size }; });
    ok(w + ' 60 slots: no overlap, none outside the grid (' + ov.n + ' cells)', ov.bad === 0); ok(w + ' slot cells uniform height', ov.heights === 1); ok(w + ' 60 slots no page overflow', await noOverflow(p));
    await p.goto('/#/book/1'); await p.reload(); await p.waitForSelector('.svc'); await p.locator('.svc').first().click(); await p.click('#next'); await p.waitForSelector('[data-t]'); await p.locator('[data-t]').nth(2).click(); await p.click('#next'); await p.waitForSelector('#confirm');
    await shot(p, '15-book-payment-blocked', true);
    ok(w + ' barber without payouts: Pay now blocked with clear message', await p.locator('#online-off').count() === 1 && (await p.locator('#online-off').innerText()).includes('cannot take online payments yet'));
    ok(w + ' pay on arrival still available', await p.locator('[data-p=ON_ARRIVAL]').count() === 1);
    await p.goto('/#/profile'); await p.waitForTimeout(500); await shot(p, '16-customer-profile', true); ok(w + ' profile no overflow', await noOverflow(p)); await ctx.close(); }
  /* ---- barber: payout setup ---- */
  { const { ctx, p } = await ctxFor(w); await login(p, 'mike@trimslot.demo', 'Barber123!'); await p.waitForTimeout(500); await shot(p, '20-barber-today-payout-banner', true);
    ok(w + ' barber banner asks to set up payouts', await p.locator('a.payban').count() === 1); ok(w + ' today no overflow', await noOverflow(p)); ok(w + ' today fonts', await fontsOk(p)); ok(w + ' today no gradients', await noGradient(p));
    await p.goto('/#/profile'); await p.waitForTimeout(500); await shot(p, '21-barber-profile', true);
    await p.click('a[href="#/payouts"].lrow'); await p.waitForSelector('#pof'); await p.waitForTimeout(300); await shot(p, '22-payouts-empty', true);
    ok(w + ' save disabled until bank + 10 digits resolve', await p.locator('#posave').isDisabled());
    await p.selectOption('#pobank', { index: 1 }); await p.fill('#poacct', '0123456789'); await p.waitForSelector('#poname .okt'); await shot(p, '23-payouts-resolved');
    ok(w + ' account name resolved + shown', (await p.locator('#poname').innerText()).includes('MOCK ACCOUNT')); ok(w + ' save enabled when valid', await p.locator('#posave').isEnabled());
    await p.fill('#poacct', '12345'); await p.waitForTimeout(150); ok(w + ' save disabled again for bad number', await p.locator('#posave').isDisabled()); await p.fill('#poacct', '0123456789'); await p.waitForSelector('#poname .okt'); await p.waitForTimeout(100);
    await p.click('#posave'); await p.waitForSelector('.payok'); await p.waitForTimeout(300); await shot(p, '24-payouts-active', true);
    ok(w + ' status "Payouts active" with last 4', (await p.locator('.payok').innerText()).includes('Payouts active') && (await p.locator('.payok').innerText()).includes('6789'));
    ok(w + ' banner gone after setup', await p.locator('a.payban').count() === 0); ok(w + ' payouts no overflow', await noOverflow(p));
    await p.goto('/#/settings'); await p.waitForTimeout(500); await shot(p, '25-barber-settings', true); ok(w + ' settings: raw subaccount field removed', await p.locator('[name=paystack_subaccount]').count() === 0); ok(w + ' settings no overflow', await noOverflow(p));
    await p.goto('/#/plans'); await p.waitForTimeout(500); await shot(p, '26-barber-plans', true); await ctx.close(); }
  /* ---- customer again: online now allowed ---- */
  { const { ctx, p } = await ctxFor(w); await login(p, 'tunde@trimslot.demo', 'Customer123!');
    await p.goto('/#/book/1'); await p.waitForSelector('.svc'); await p.locator('.svc').first().click(); await p.click('#next'); await p.waitForSelector('[data-t]'); await p.locator('[data-t]').nth(3).click(); await p.click('#next'); await p.waitForSelector('#confirm');
    await shot(p, '30-book-payment-online-ok', true); ok(w + ' after payout setup: Pay now available', await p.locator('[data-p=ONLINE]').count() === 1 && await p.locator('#online-off').count() === 0); await ctx.close(); }
  /* ---- admin ---- */
  { const { ctx, p } = await ctxFor(w); await p.goto('/admin.html'); await p.fill('#key', ADMINKEY); await p.click('#lf button'); await p.waitForSelector('.tiles'); await p.waitForTimeout(500);
    await shot(p, '40-admin-home', true); ok(w + ' admin home no overflow', await noOverflow(p)); ok(w + ' admin no gradients', await noGradient(p)); ok(w + ' admin pin nudge on home', await p.locator('a[href="#/pin"]').count() >= 1);
    await p.goto('/admin.html#/pin'); await p.waitForSelector('#set'); await shot(p, '41-admin-pin-setup', true);
    ok(w + ' PIN save disabled until 4 matching digits', await p.locator('#cgo').isDisabled()); await p.fill('#p1', '4821'); await p.fill('#p2', '4821'); ok(w + ' PIN save enabled', await p.locator('#cgo').isEnabled()); await p.click('#cgo'); await p.waitForSelector('#chg'); await shot(p, '42-admin-pin-set', true);
    await p.goto('/admin.html#/customers'); await p.waitForSelector('#ltbl'); await p.waitForTimeout(400); await shot(p, '43-admin-customers'); ok(w + ' customers no overflow', await noOverflow(p));
    await p.locator('#ltbl tbody tr').first().click(); await p.waitForSelector('.modal.drawer'); await p.waitForTimeout(300); await shot(p, '44-admin-customer-drawer');
    await p.locator('.modal [data-k=delete]').click(); await p.waitForSelector('#fm'); await p.fill('#f_reason', 'screenshot test delete'); await shot(p, '45-admin-delete-dialog');
    await p.click('#fgo'); await p.waitForSelector('#pinv'); await shot(p, '46-admin-pin-prompt'); ok(w + ' PIN prompt confirm disabled until 4 digits', await p.locator('#ping').isDisabled());
    await p.fill('#pinv', '1357'); await p.click('#ping'); await p.waitForSelector('#pinf .err'); await shot(p, '47-admin-pin-wrong'); ok(w + ' wrong PIN: clear message with tries left', (await p.locator('#pinf .err').innerText()).includes('tries left'));
    await p.fill('#pinv', '4821'); await p.click('#ping'); await p.waitForSelector('.toast:not(.hidden)'); await p.waitForTimeout(300); ok(w + ' delete succeeded after correct PIN', (await p.locator('.toast').innerText()).includes('Deleted'));
    await p.goto('/admin.html#/deleted'); await p.waitForSelector('.tbl'); await shot(p, '48-admin-recently-deleted'); ok(w + ' recently deleted lists it with restore window', (await p.locator('.tbl').innerText()).includes('to restore'));
    await p.locator('[data-do=rs]').first().click(); await p.waitForTimeout(600); ok(w + ' restore works (no PIN)', await p.locator('.empty').count() === 1 || (await p.locator('[data-do=rs]').count()) === 0);
    await p.goto('/admin.html#/testdata'); await p.waitForSelector('#tdgo'); await shot(p, '49-admin-testdata'); ok(w + ' testdata no overflow', await noOverflow(p));
    await p.goto('/admin.html#/payments'); await p.waitForSelector('#ltbl'); await p.waitForTimeout(300); await shot(p, '4a-admin-payments'); ok(w + ' payments no overflow', await noOverflow(p)); await ctx.close(); }
}
// dark spot-check
{ const { ctx, p } = await ctxFor(390, true); await login(p, 'chidi@trimslot.demo', 'Customer123!'); await p.screenshot({ path: '/workspace/trimslot/screenshots/v5/390/90-dark-home.png', fullPage: true }); ok('dark no gradients', await noGradient(p)); await ctx.close(); }
await resetState(); await db.end(); await b.close();
console.log('console/page errors:', errs.length); errs.slice(0, 8).forEach((e) => console.log('  ' + e));
console.log(fails ? `FAILED ${fails}` : 'ALL PASS'); process.exit(fails ? 1 : 0);
