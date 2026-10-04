/* UI smoke for: email code screen, contact barber, locked box + emergency help, reschedule, barber urgent card.
   Needs a dev server started with TRIMSLOT_FAKE_NOW='2026-09-30T09:50:00+01:00' (demo seed, mock payments).
   Usage: BASE=http://localhost:4231 node scripts/contact-ui.mjs   -> exit 1 on any failure */
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:4231';
fs.mkdirSync('screenshots/contact', { recursive: true });
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let fails = 0, total = 0; const errs = [];
const ok = (c, n, x = '') => { total++; if (!c) { fails++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } else if (process.env.VERBOSE) console.log('PASS ' + n); };
const mk = async (w = 390) => { const ctx = await b.newContext({ viewport: { width: w, height: 800 }, baseURL: BASE }); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); return { ctx, p }; };
const api = (p, method, path, body) => p.evaluate(async ([m, u, bd]) => { const r = await fetch('/api' + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: bd ? JSON.stringify(bd) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; }, [method, path, body]);
const login = async (p, id, pw) => { await p.goto('/#/login'); await p.waitForSelector('[name=identifier]'); await p.fill('[name=identifier]', id); await p.fill('[name=password]', pw); await p.click('button[type=submit]'); await p.waitForFunction(() => !location.hash.includes('login'), null, { timeout: 8000 }); };
const stamp = Date.now();

// 1) new customer: sign-up leads to the email code screen
{ const { ctx, p } = await mk();
  await p.goto('/#/signup?role=customer'); await p.waitForSelector('[name=accept_terms]');
  await p.fill('[name=name]', 'Code Tester'); await p.fill('[name=email]', `code${stamp}@example.com`); await p.fill('[name=password]', 'Password123'); await p.check('[name=accept_terms]'); await p.click('button[type=submit]');
  await p.waitForSelector('#sendcode', { timeout: 8000 });
  ok(/Test mode: the code is/.test(await p.innerText('#app, main, body')), 'test-mode hint shows the dev code');
  await p.click('#sendcode'); await p.waitForSelector('#vf');
  await p.fill('#vf [name=code]', '000000'); await p.click('#vf button'); await p.waitForSelector('.err[role=alert]');
  ok(/tries left/.test(await p.innerText('.err[role=alert]')), 'wrong code shows tries left');
  await p.fill('#vf [name=code]', '123456'); await p.click('#vf button'); await p.waitForFunction(() => !location.hash.includes('verify-email'), null, { timeout: 8000 });
  ok(await p.locator('#emailban').count() === 0, 'no email banner after verifying');
  await p.screenshot({ path: 'screenshots/contact/after-verify.png' }); await ctx.close(); }

// 2) Chidi: paid upcoming booking -> contact box + Change time; locked paid booking -> urgent box + help
const { ctx, p } = await mk();
await login(p, 'chidi@trimslot.demo', 'Customer123!');
const pay = async (id) => { const r = await api(p, 'POST', `/bookings/${id}/pay`); await api(p, 'POST', `/payments/mock/${r.json.reference}/complete`); await api(p, 'GET', `/payments/callback?reference=${r.json.reference}`); };
const bk = async (time) => { const r = await api(p, 'POST', '/bookings', { barber_id: 1, service_id: 1, date: '2026-09-30', time, payment_option: 'ONLINE' }); await pay(r.json.booking.id); return r.json.booking.id; };
const later = await bk('15:00'), soon = await bk('10:00');
await p.goto('/#/booking/' + later); await p.waitForSelector('#contactbox');
ok(await p.locator('#contactbox a[href^="tel:"]').count() === 1 && await p.locator('#contactbox a[href^="https://wa.me/234"]').count() === 1, 'contact box has call + WhatsApp');
ok(await p.locator('#move').count() === 1, 'Change time button shows while cancelling is allowed');
await p.screenshot({ path: 'screenshots/contact/contact.png' });
await p.click('#move'); await p.waitForSelector('[data-t]'); await p.click('[data-t="16:00"]'); await p.click('#save');
await p.waitForSelector('#contactbox'); ok(/4:00 PM/.test(await p.innerText('body')), 'booking moved to 4:00 PM');
await p.goto('/#/booking/' + soon); await p.waitForSelector('#lockedbox');
ok(/Something urgent\? Call or WhatsApp your barber/.test(await p.innerText('#lockedbox')) && await p.locator('#lockedbox a[href^="tel:"]').count() === 1, 'locked box offers call + WhatsApp');
ok(await p.locator('#move').count() === 0 && await p.locator('#cancel').count() === 0, 'no move/cancel once locked');
await p.fill('#helpnote', 'Child is sick, please wait for me'); await p.click('#helpsend'); await p.waitForSelector('#helpstatus');
ok(/We told your barber/.test(await p.innerText('#helpstatus')), 'customer sees help status');
await p.screenshot({ path: 'screenshots/contact/help-sent.png' });

// 3) barber: urgent banner on Today, urgent card with call buttons, answer "Come later"
const bar = await mk(); await login(bar.p, 'mike@trimslot.demo', 'Barber123!');
await bar.p.goto('/#/today'); await bar.p.waitForSelector('a[href^="#/b/"][role=alert]');
await bar.p.goto('/#/b/' + soon); await bar.p.waitForSelector('#helpcard');
ok(await bar.p.locator('#helpcard a[href^="tel:"]').count() === 1 && await bar.p.locator('#helpcard a[href^="https://wa.me/"]').count() === 1, 'barber urgent card has call + WhatsApp');
await bar.p.screenshot({ path: 'screenshots/contact/barber-help.png' });
await bar.p.click('#helplater'); await bar.p.waitForFunction(() => !document.querySelector('#helpcard'), null, { timeout: 8000 });
await p.reload(); await p.waitForSelector('#helpstatus');
ok(/will wait for you/.test(await p.innerText('#helpstatus')), 'customer sees "your barber will wait"');
ok(errs.length === 0, 'no page errors', errs.join(' | '));
await b.close();
console.log(`${total - fails}/${total} UI checks passed`); process.exit(fails ? 1 : 0);
