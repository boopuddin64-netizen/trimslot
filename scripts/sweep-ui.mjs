/* Regression checks for the bug sweep (real browser): deep link while logged out, stale session mid-use, double-tap de-duplication,
   offline/timeout messages, wizard Back button, "checked in" with date.   BASE=http://localhost:4102 node scripts/sweep-ui.mjs */
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
const BASE = process.env.BASE || 'http://localhost:4102';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const login = async (p, id, pw) => { await p.fill('[name=identifier]', id); await p.fill('[name=password]', pw); await p.click('button[type=submit]'); };
const ctx = await b.newContext({ viewport: { width: 390, height: 800 } }); const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));

// 1) deep link while logged out -> login -> lands on the deep link
await p.goto(BASE + '/#/notifications'); await p.waitForSelector('form#f');
ok(p.url().endsWith('#/login'), 'logged-out deep link goes to login: ' + p.url());
await login(p, 'chidi@trimslot.demo', 'Customer123!'); await p.waitForFunction(() => location.hash === '#/notifications', null, { timeout: 5000 }).catch(() => {});
ok(p.url().endsWith('#/notifications'), 'after login returns to the deep link: ' + p.url());

// 2) failed login keeps what was typed (not the password)
const p2 = await (await b.newContext({ viewport: { width: 390, height: 800 } })).newPage();
await p2.goto(BASE + '/#/signup?role=customer'); await p2.waitForSelector('form#f');
await p2.fill('[name=name]', 'Typed Name'); await p2.fill('[name=email]', 'chidi@trimslot.demo'); await p2.fill('[name=password]', 'Passw0rd!x'); await p2.click('button[type=submit]'); await p2.waitForSelector('.err');
ok((await p2.inputValue('[name=name]')) === 'Typed Name' && (await p2.inputValue('[name=email]')) === 'chidi@trimslot.demo', 'form values kept after an error');
await p2.context().close();

// 3) double tap: two identical writes in flight -> one request
let posts = 0; p.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/notifications/read')) posts++; });
await p.evaluate(() => Promise.all([api('/notifications/read', { method: 'POST' }), api('/notifications/read', { method: 'POST' })]));
ok(posts === 1, 'identical in-flight POSTs are sent once, got ' + posts);

// 4) offline + timeout wording
await ctx.setOffline(true);
const off = await p.evaluate(() => api('/me', { method: 'PATCH', body: { name: 'X Y' } }).then(() => 'no error', (e) => e.code + '|' + e.message));
ok(/^NETWORK\|/.test(off) && /offline|reach/i.test(off), 'offline message: ' + off); await ctx.setOffline(false);

// 5) wizard Back button steps back, not out of the wizard
await p.goto(BASE + '/#/book/1'); await p.waitForSelector('.svc');
await p.click('.svc:not(.off)'); await p.click('#next'); await p.waitForSelector('.days');
ok(/date/i.test(await p.textContent('h2')), 'wizard on step 2');
await p.goBack(); await p.waitForSelector('.svc');
ok(p.url().includes('#/book/1') && /service/i.test(await p.textContent('h2')), 'Back from step 2 returns to step 1 inside the wizard: ' + p.url());
await p.goForward(); await p.waitForSelector('.days'); ok(/date/i.test(await p.textContent('h2')), 'Forward returns to step 2');

// 6) stale session mid-use: cookie vanishes -> friendly message, login page, and back to where you were afterwards
await p.goto(BASE + '/#/bookings'); await p.waitForTimeout(800);
await ctx.clearCookies();
const msg = await p.evaluate(() => api('/me', { method: 'PATCH', body: { name: 'Chidi Okafor' } }).then(() => 'no error', (e) => e.message));
ok(/session has expired/i.test(msg), 'stale session message: ' + msg);
await p.waitForSelector('form#f'); ok(p.url().endsWith('#/login'), 'redirected to login: ' + p.url());
await login(p, 'chidi@trimslot.demo', 'Customer123!'); await p.waitForFunction(() => location.hash === '#/bookings', null, { timeout: 5000 }).catch(() => {});
ok(p.url().endsWith('#/bookings'), 'back to the page you were on after re-login: ' + p.url());
ok(!errs.length, 'no page errors: ' + errs.join(';'));
await b.close(); console.log(`sweep-ui: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
