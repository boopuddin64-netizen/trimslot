/* Private barber share links, UI check against the local dev server (demo seed, mock payments).
   Guest opens /b/<code> -> profile -> log in/sign up -> returns to the link -> Add barber -> My barbers -> Book / Remove; barber share card with QR.
   Usage: node scripts/sharelinks-ui.mjs   (env BASE) -> exit 1 on any failure; screenshots in screenshots/share/ */
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:4112';
fs.mkdirSync('screenshots/share', { recursive: true });
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let fails = 0, total = 0; const errs = [];
const ok = (c, n, x = '') => { total++; if (!c) { fails++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } else if (process.env.VERBOSE) console.log('PASS ' + n); };
const call = async (p, o = {}, ck) => { const r = await fetch(BASE + '/api' + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(ck ? { Cookie: ck } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }); let j = null; try { j = await r.json(); } catch { /* none */ } return { r, j }; };
const login = async (i, pw) => (await call('/auth/login', { method: 'POST', body: { identifier: i, password: pw } })).r.headers.get('set-cookie').split(';')[0];
const mike = await login('mike@trimslot.demo', 'Barber123!');
const code0 = (await call('/barber/share', {}, mike)).j.code;
const stamp = Date.now();
const mk = async (w, dark) => { const ctx = await b.newContext({ viewport: { width: w, height: 844 }, colorScheme: dark ? 'dark' : 'light', baseURL: BASE, permissions: ['clipboard-read', 'clipboard-write'] }); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); }); return { ctx, p }; };
const noOverflow = async (p) => (await p.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0;

let code = code0;
for (const [w, dark] of [[390, false], [390, true], [1280, false], [1280, true]]) {
  const tag = `${w}${dark ? 'd' : 'l'}`;
  const { ctx, p } = await mk(w, dark);
  // 1. guest opens the short link
  await p.goto('/b/' + code); await p.waitForSelector('#guestbox');
  ok(p.url().endsWith('/#/b/' + code), tag + ' /b/<code> lands on the in-app profile', p.url());
  ok((await p.innerText('h1')).includes("Mike's Barbershop"), tag + ' guest sees the shop name');
  const body = await p.innerText('#app');
  ok(/Services/.test(body) && /Opening hours/.test(body) && /Regular Haircut/.test(body), tag + ' profile shows services and hours');
  ok(await p.locator('#addbtn').count() === 0 && await p.locator('#bookbtn').count() === 0, tag + ' guest cannot add or book before logging in');
  ok(await noOverflow(p), tag + ' no sideways scroll on the link page');
  await p.screenshot({ path: `screenshots/share/${tag}-guest.png`, fullPage: true });
  // 2. sign up from the link, come back to the link, add the barber
  await p.click('#signupbtn'); await p.waitForSelector('[name=accept_terms]');
  await p.fill('[name=name]', 'Link Tester'); await p.fill('[name=email]', `link${tag}${stamp}@example.com`); await p.fill('[name=password]', 'Password123'); await p.check('[name=accept_terms]'); await p.click('button[type=submit]');
  await p.waitForSelector('#addbtn', { timeout: 10000 });
  ok(p.url().endsWith('/#/b/' + code), tag + ' after sign-up the customer is back on the barber link', p.url());
  ok(await p.locator('#bookbtn').count() === 1, tag + ' customer now sees Book a session');
  await p.screenshot({ path: `screenshots/share/${tag}-customer-link.png`, fullPage: true });
  await p.click('#addbtn'); await p.waitForFunction(() => /In My barbers/.test(document.querySelector('#addbtn').textContent));
  ok(await p.locator('#addbtn').isDisabled(), tag + ' Add barber turns into "In My barbers"');
  // 3. My barbers
  await p.goto('/#/'); await p.waitForSelector('.mybarber');
  ok(await p.locator('.mybarber').count() === 1 && /Mike/.test(await p.innerText('.mybarber')), tag + ' My barbers lists the added shop');
  ok(await p.locator('.mybarber a.btn', { hasText: 'Book' }).count() === 1 && await p.locator('[data-rmb]').count() === 1, tag + ' book and remove are there');
  ok(await noOverflow(p), tag + ' no sideways scroll on My barbers');
  await p.screenshot({ path: `screenshots/share/${tag}-mybarbers.png`, fullPage: true });
  await p.click('.mybarber a.btn'); await p.waitForSelector('[data-s]'); ok(/#\/book\//.test(p.url()), tag + ' Book opens the booking wizard');
  await p.goto('/#/'); await p.waitForSelector('.mybarber');
  p.once('dialog', (d) => d.accept()); await p.click('[data-rmb]'); await p.waitForSelector('#nobarbers');
  ok(true, tag + ' removing the barber shows the empty state');
  // 4. empty state: paste a link
  ok(await p.locator('#linkin').count() === 1, tag + ' paste-link field is there');
  await p.fill('#linkin', 'nonsense'); await p.click('#addlink button'); await p.waitForSelector('#linkerr:not(.hidden)'); ok(true, tag + ' a bad paste is explained');
  await p.screenshot({ path: `screenshots/share/${tag}-empty.png`, fullPage: true });
  await p.fill('#linkin', `${BASE}/b/${code}`); await p.click('#addlink button'); await p.waitForSelector('#addbtn');
  ok(p.url().endsWith('/#/b/' + code), tag + ' pasting the full link opens the barber');
  // 5. a link that does not exist
  await p.goto('/#/b/0123456789abcdef'); await p.waitForSelector('.err'); ok(/not valid|not found/i.test(await p.innerText('.err')), tag + ' unknown link says so');
  await ctx.close();
}
// barber's share card
for (const [w, dark] of [[390, false], [390, true], [1280, true]]) {
  const tag = `${w}${dark ? 'd' : 'l'}`;
  const { ctx, p } = await mk(w, dark);
  await p.goto('/#/login'); await p.fill('[name=identifier]', 'mike@trimslot.demo'); await p.fill('[name=password]', 'Barber123!'); await p.click('button[type=submit]');
  await p.goto('/#/profile'); await p.waitForSelector('#sharecard');
  const shown = await p.innerText('#sharelink');
  ok(/\/b\/[a-f0-9]{12,32}$/.test(shown), tag + ' barber sees the full link', shown);
  await p.waitForFunction(() => { const i = document.querySelector('#sharecard img.qr'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 8000 }); ok(true, tag + ' QR code image loads');
  await p.click('#copylink'); await p.waitForTimeout(300);
  ok((await p.evaluate(() => navigator.clipboard.readText())) === shown, tag + ' Copy link puts the link on the clipboard');
  ok(await noOverflow(p), tag + ' no sideways scroll on the barber profile');
  await p.screenshot({ path: `screenshots/share/${tag}-barber.png`, fullPage: true });
  if (tag === '390l') {
    p.once('dialog', (d) => d.accept()); await p.click('#regen'); await p.waitForFunction((old) => document.querySelector('#sharelink') && document.querySelector('#sharelink').textContent !== old, shown, { timeout: 8000 });
    const fresh = await p.innerText('#sharelink'); ok(fresh !== shown, 'regenerating shows a new link');
    const oldCode = shown.split('/b/')[1]; code = fresh.split('/b/')[1];
    ok((await call('/b/' + oldCode)).r.status === 404, 'the old link stops working');
    ok((await call('/b/' + code)).r.status === 200, 'the new link works');
  }
  await ctx.close();
}
ok(errs.length === 0, 'no page errors', errs.slice(0, 3).join(' | '));
await b.close();
console.log(`${total - fails}/${total} share-link UI checks passed`); process.exit(fails ? 1 : 0);
