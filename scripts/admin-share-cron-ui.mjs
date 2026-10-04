/* Admin: barber sheet shows the private share link + QR + Copy (from the list and from search), and Controls shows "Cron last ran X ago"
   (amber when never / older than 3 minutes). Usage: node scripts/admin-share-cron-ui.mjs   (env BASE, ADMINKEY, CRON_SECRET) -> exit 1 on any failure */
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
const BASE = process.env.BASE || 'http://localhost:4112', KEY = process.env.ADMINKEY || 'local-admin-key-xyz';
let fails = 0, total = 0; const ok = (c, n, x = '') => { total++; if (!c) { fails++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } else if (process.env.VERBOSE) console.log('PASS ' + n); };
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const errs = [];
for (const w of [360, 1280]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 800 }, baseURL: BASE, permissions: ['clipboard-read', 'clipboard-write'] });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto('/admin.html'); await p.fill('#key', KEY); await p.click('#lf button[type=submit]'); await p.waitForSelector('#shell:not(.hidden)');
  await p.goto('/admin.html#/barbers'); await p.waitForTimeout(1800);
  await p.locator('#app #ltbl tbody tr, #app .crow').first().click({ position: { x: 60, y: 8 } });
  await p.waitForSelector('.sheet #adminShare', { timeout: 8000 }).catch(() => {});
  const has = await p.locator('.sheet #adminShare').count();
  ok(has === 1, w + ' barber sheet has the share link card');
  if (has) {
    const url = (await p.locator('#adminShareUrl').innerText()).trim();
    ok(/\/b\/[a-f0-9]{12,32}$/.test(url), w + ' link looks right', url);
    const img = await p.locator('#adminShare img.qr').evaluate((i) => ({ ok: i.complete && i.naturalWidth > 0, w: i.naturalWidth }));
    ok(img.ok, w + ' QR image renders');
    await p.click('#adminShareCopy'); await p.waitForTimeout(300);
    const clip = await p.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    ok(clip === url, w + ' Copy puts the link on the clipboard', clip);
    const box = await p.locator('#adminShare').boundingBox(); ok(box && box.x >= 0 && box.x + box.width <= w + 1, w + ' card fits the screen', JSON.stringify(box));
    ok(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), w + ' no sideways scroll');
    if (w === 360) await p.screenshot({ path: '/tmp/admin-share-360.png' });
  }
  await p.keyboard.press('Escape');
  // Controls: heartbeat card
  await p.goto('/admin.html#/controls'); await p.waitForSelector('#cronCard', { timeout: 8000 }).catch(() => {});
  const card = p.locator('#cronCard'); ok(await card.count() === 1, w + ' controls has the cron card');
  if (await card.count()) { const st = await card.getAttribute('data-cron'); const tx = (await card.innerText()).replace(/\s+/g, ' '); ok(['ok', 'late', 'never', 'error'].includes(st), w + ' status ' + st); ok(/Cron (last ran|has never run)/.test(tx), w + ' text', tx.slice(0, 120)); if (w === 360) await p.screenshot({ path: '/tmp/admin-cron-360.png' }); }
  await ctx.close();
}
await b.close();
ok(errs.length === 0, 'no page errors', errs.join(' | ').slice(0, 200));
console.log(fails ? `${fails} FAILED of ${total}` : `admin share + cron UI: ${total} checks passed`); process.exit(fails ? 1 : 0);
