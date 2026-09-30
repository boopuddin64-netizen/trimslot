import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
const BASE = 'http://localhost:4102', OUT = '/workspace/trimslot/screenshots/v4/';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const errs = []; let fails = 0; const ok = (n, c) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
async function run(w, h, dark, tag) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, baseURL: BASE, colorScheme: dark ? 'dark' : 'light' }); const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(tag + ' ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/favicon|429/.test(m.text())) errs.push(tag + ' console ' + m.text()); });
  await p.goto('/admin.html'); await p.fill('#key', 'local-admin-key-xyz'); await p.click('#lf button'); await p.waitForSelector('.tiles');
  await p.waitForTimeout(400); await p.screenshot({ path: OUT + `admin-home-${tag}.png` });
  ok(tag + ' home has attention cards', await p.locator('.acard').count() > 0);
  ok(tag + ' no horizontal overflow (home)', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await p.goto('/admin.html#/customers'); await p.waitForSelector('#ltbl'); await p.waitForTimeout(300);
  await p.screenshot({ path: OUT + `admin-customers-${tag}.png` });
  ok(tag + ' customers list rows', await p.locator('#ltbl tbody tr').count() === 25);
  await p.click('#lmoreb'); await p.waitForFunction(() => document.querySelectorAll('#ltbl tbody tr').length === 50); ok(tag + ' load more -> 50 rows', true);
  await p.fill('#lq', 'Okafor 12'); await p.waitForTimeout(700); ok(tag + ' search narrows', await p.locator('#ltbl tbody tr').count() < 50);
  await p.fill('#lq', 'zzzzqq'); await p.waitForSelector('.empty'); await p.screenshot({ path: OUT + `admin-empty-${tag}.png` }); ok(tag + ' empty state', true);
  await p.fill('#lq', 'perf7'); await p.waitForSelector('#ltbl');
  await p.locator('[data-sel]').nth(0).check(); await p.locator('[data-sel]').nth(1).check(); await p.waitForSelector('.bulkbar:not(.hidden)');
  await p.screenshot({ path: OUT + `admin-bulk-${tag}.png` }); ok(tag + ' bulk bar', await p.locator('.bulkbar b').innerText() === '2 selected');
  await p.click('[data-bulk="1"]'); await p.waitForSelector('#fm'); await p.screenshot({ path: OUT + `admin-bulkconfirm-${tag}.png` }); ok(tag + ' bulk confirm shows count', (await p.locator('#fm .note').innerText()).includes('2 customer'));
  await p.keyboard.press('Escape'); await p.click('#fm [data-close]').catch(() => {});
  await p.goto('/admin.html#/bookings'); await p.waitForSelector('#ltbl'); await p.locator('#ltbl tbody tr').first().click(); await p.waitForSelector('.modal.drawer'); await p.waitForTimeout(400);
  await p.screenshot({ path: OUT + `admin-drawer-${tag}.png` }); ok(tag + ' drawer opens', true); await p.keyboard.press('Escape');
  await p.keyboard.press('Control+k'); await p.waitForSelector('.pal'); await p.fill('#palq', 'chidi'); await p.waitForSelector('.pali'); await p.waitForTimeout(500);
  await p.screenshot({ path: OUT + `admin-palette-${tag}.png` }); ok(tag + ' palette results', await p.locator('.pali').count() > 1);
  await p.keyboard.press('ArrowDown'); await p.keyboard.press('Escape'); ok(tag + ' palette closes', await p.locator('.pal').count() === 0);
  await p.goto('/admin.html#/controls'); await p.waitForSelector('#cf'); await p.screenshot({ path: OUT + `admin-controls-${tag}.png`, fullPage: true }); ok(tag + ' controls has push toggle', await p.locator('[name=feature_push]').count() === 1);
  await p.click('#cf button[type=submit]'); await p.waitForSelector('.toast:not(.hidden)'); ok(tag + ' controls save ok', !(await p.locator('.toast').getAttribute('class')).includes('bad'));
  await p.goto('/admin.html#/payments'); await p.waitForSelector('.lbar'); await p.click('#lpills [data-v=paid]'); await p.waitForSelector('#ltbl'); await p.locator('#ltbl tbody tr').first().click(); await p.waitForSelector('.modal.drawer'); await p.screenshot({ path: OUT + `admin-payment-${tag}.png` }); await p.keyboard.press('Escape');
  for (const r of ['barbers', 'reviews', 'waitlist', 'reports', 'ledger', 'plans', 'credits', 'audit', 'analytics', 'earnings', 'decisions', 'broadcast', 'rules']) {
    await p.goto('/admin.html#/' + r); await p.waitForTimeout(600); const bad = await p.locator('#app .err').count(); ok(tag + ' route ' + r + ' renders', bad === 0);
    ok(tag + ' ' + r + ' no overflow', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  await p.goto('/admin.html#/reviews'); await p.waitForTimeout(600); await p.screenshot({ path: OUT + `admin-reviews-${tag}.png` });
  await ctx.close();
}
await run(1280, 800, false, 'desk'); await run(1280, 800, true, 'desk-dark'); await run(390, 844, false, 'phone');
console.log('errors:', errs.length ? errs : 'none'); console.log('fails', fails); await b.close();
