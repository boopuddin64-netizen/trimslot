import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
const BASE = 'http://localhost:4102', OUT = '/workspace/trimslot/screenshots/v4/';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let fails = 0; const errs = []; const ok = (n, c) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const login = async (dark, id, pw, w = 390, h = 844) => {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: w < 500, hasTouch: w < 500, baseURL: BASE, colorScheme: dark ? 'dark' : 'light', serviceWorkers: 'allow' });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/favicon|429|Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await p.goto('/#/login'); await p.fill('[name=identifier]', id).catch(() => p.fill('input[type=text],input[type=email]', id)); await p.fill('[name=password]', pw); await p.click('button[type=submit]'); await p.waitForTimeout(1200);
  return { ctx, p };
};
const bc = async (title, body, aud = 'customers') => fetch(BASE + '/api/admin/broadcast', { method: 'POST', headers: { Authorization: 'Bearer local-admin-key-xyz', 'Content-Type': 'application/json' }, body: JSON.stringify({ audience: aud, title, body }) }).then((r) => r.status);
for (const dark of [false, true]) {
  const tag = dark ? 'dark' : 'light';
  const { ctx, p } = await login(dark, 'chidi@trimslot.demo', 'Customer123!');
  await p.waitForSelector('.hero,.bell,h1', { timeout: 8000 });
  await p.screenshot({ path: OUT + `n-home-${tag}.png` });
  ok(tag + ' bell present', await p.locator('.bell').count() > 0);
  ok(tag + ' manifest link', await p.locator('link[rel=manifest]').count() === 1);
  const sw = await p.evaluate(async () => { try { const r = await navigator.serviceWorker.getRegistration(); return !!r; } catch { return false; } });
  ok(tag + ' service worker registered', sw);
  // live banner: broadcast while the app is open
  await bc('Holiday hours', 'Most shops are closed on Friday.'); await p.waitForSelector('#banner:not(:empty)', { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(500); await p.screenshot({ path: OUT + `n-banner-${tag}.png` });
  ok(tag + ' live banner shows', (await p.locator('#banner').innerText()).includes('Holiday'));
  ok(tag + ' bell badge count', /^\d+\+?$/.test((await p.locator('.bell .dot, .bell .badge, .bell [class*=cnt]').first().innerText().catch(() => '')).trim()));
  ok(tag + ' tab title badge', /^\(\d+\)/.test(await p.title()));
  await p.goto('/#/notifications'); await p.waitForTimeout(800); await p.screenshot({ path: OUT + `n-centre-${tag}.png` });
  ok(tag + ' notification rows', await p.locator('.nitem, .notif').count() > 0);
  ok(tag + ' no overflow (centre)', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await p.goto('/#/profile'); await p.waitForTimeout(800); await p.screenshot({ path: OUT + `n-profile-${tag}.png`, fullPage: true });
  ok(tag + ' profile has notification prefs', (await p.content()).toLowerCase().includes('notification'));
  ok(tag + ' no overflow (profile)', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await ctx.close();
}
{
  const { ctx, p } = await login(false, 'mike@trimslot.demo', 'Barber123!');
  await p.waitForTimeout(1200); await p.screenshot({ path: OUT + 'n-barber-today.png', fullPage: true });
  ok('barber today no overflow', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await p.goto('/#/reviews'); await p.waitForTimeout(800); await p.screenshot({ path: OUT + 'n-barber-reviews.png' });
  await ctx.close();
}
{ const r = await fetch(BASE + '/manifest.webmanifest'); ok('manifest served', r.ok && (await r.json()).icons.length >= 2); for (const f of ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/sw.js']) ok(f + ' served', (await fetch(BASE + f)).ok); }
console.log('errors:', errs.length ? errs.slice(0, 8) : 'none'); console.log('fails', fails); await b.close();
