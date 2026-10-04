/* Plan-fit UI check against the local dev server (demo seed, mock payments).
   A plan lists the services it covers; the booking wizard offers plan sessions only for those services.
   Usage: node scripts/plans-ui.mjs   (env BASE) -> exit 1 on any failure */
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:4112';
fs.mkdirSync('screenshots/plans', { recursive: true });
const call = async (p, o = {}, ck) => { const r = await fetch(BASE + '/api' + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(ck ? { Cookie: ck } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }); let j = null; try { j = await r.json(); } catch { /* none */ } return { r, j }; };
const login = async (i, pw) => (await call('/auth/login', { method: 'POST', body: { identifier: i, password: pw } })).r.headers.get('set-cookie').split(';')[0];
let fails = 0, total = 0; const ok = (c, n, x = '') => { total++; if (!c) { fails++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } else if (process.env.VERBOSE) console.log('PASS ' + n); };
const mike = await login('mike@trimslot.demo', 'Barber123!');
const stamp = Date.now();
const email = `planfit${stamp}@example.com`;
const su = await call('/auth/signup', { method: 'POST', body: { role: 'customer', name: 'Plan Fit', email, password: 'Password123', accept_terms: true } });
const cust = (await login(email, 'Password123'));

const barberId = 1;
const svcs = (await call('/barbers/' + barberId, {}, cust)).j.services;
const byName = (n) => svcs.find((s) => s.name === n);
const kids = byName('Kids Haircut'), reg = byName('Regular Haircut'), beard = byName('Haircut + Beard');
const mk = async (name, ids, price = 40000) => { const r = await call('/barber/plans', { method: 'POST', body: { name, price_naira: price, sessions: 4, validity_days: 30, service_ids: ids } }, mike); if (r.r.status !== 201) console.log('plan create failed', JSON.stringify(r.j)); return r.j.id; };
const buyPlan = async (planId) => { const b = await call(`/plans/${planId}/buy`, { method: 'POST' }, cust); await call(`/payments/mock/${b.j.reference}/complete`, { method: 'POST' }); await fetch(`${BASE}/api/payments/callback?reference=${b.j.reference}`, { redirect: 'manual' }); };
const pKids = await mk('Kids pack ' + stamp, [kids.id]);
await buyPlan(pKids);
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const errs = [];
const go = async (w, dark, svc) => {
  const ctx = await b.newContext({ viewport: { width: w, height: 844 }, colorScheme: dark ? 'dark' : 'light', baseURL: BASE });
  await ctx.addCookies([{ name: cust.split('=')[0], value: cust.split('=').slice(1).join('='), url: BASE }]);
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`/#/book/${barberId}`); await p.waitForSelector(`[data-s="${svc.id}"]`);
  return { ctx, p };
};
const toPay = async (p, svc) => { await p.click(`[data-s="${svc.id}"]`); await p.click('#next'); await p.waitForSelector('[data-t]'); await p.click('[data-t]'); await p.click('#next'); await p.waitForSelector('#confirm'); await p.waitForTimeout(200); };
for (const w of [390, 1280]) for (const dark of [false, true]) {
  const tag = `${w}${dark ? 'd' : 'l'}`;
  // one plan covers Kids only: Kids → plan preselected; Regular → plan not offered, with a reason
  { const { ctx, p } = await go(w, dark, kids); await toPay(p, kids);
    ok(await p.locator('[data-p="PLAN"]').count() === 1, tag + ' kids cut: one plan session option');
    ok(await p.locator('[data-p="PLAN"].on').count() === 1, tag + ' kids cut: the only matching plan is preselected');
    ok(/Kids pack/.test(await p.locator('[data-p="PLAN"]').innerText()), tag + ' option names the plan');
    ok(await p.locator('[data-p="ONLINE"]').count() === 1, tag + ' "pay normally" is still offered');
    await p.screenshot({ path: `screenshots/plans/${tag}-kids.png`, fullPage: true }); await ctx.close(); }
  { const { ctx, p } = await go(w, dark, reg); await toPay(p, reg);
    ok(await p.locator('[data-p="PLAN"]').count() === 0, tag + ' regular cut: no plan option (not included)');
    ok(await p.locator('#plan-nofit').count() === 1 && /Kids Haircut/.test(await p.locator('#plan-nofit').innerText()), tag + ' regular cut: tells which services the plan covers');
    await p.screenshot({ path: `screenshots/plans/${tag}-regular.png`, fullPage: true }); await ctx.close(); }
}
// two matching plans: no preselect, the customer picks one and the booking names it
const pFam = await mk('Family pack ' + stamp, [kids.id, reg.id], 60000); await buyPlan(pFam);
{ const { ctx, p } = await go(390, false, kids); await toPay(p, kids);
  ok(await p.locator('[data-p="PLAN"]').count() === 2, 'two matching plans are both offered');
  ok(await p.locator('[data-p="PLAN"].on').count() === 0, 'with two matching plans nothing is preselected');
  await p.locator('[data-p="PLAN"]', { hasText: 'Family pack' }).click(); await p.waitForTimeout(200);
  ok(/Family pack/.test(await p.locator('[data-p="PLAN"].on').innerText()), 'customer picks the Family pack');
  let sent = null; p.on('request', (r) => { if (r.method() === 'POST' && /\/api\/bookings$/.test(r.url())) sent = r.postDataJSON(); });
  await p.click('#confirm'); await p.waitForTimeout(1200);
  ok(sent && sent.payment_option === 'PLAN' && sent.plan_purchase_id, 'booking request names the chosen plan purchase', JSON.stringify(sent));
  const w2 = (await call('/me/wallet', {}, cust)).j.plans;
  ok(w2.find((x) => /Family/.test(x.plan_name))?.sessions_used === 1 && w2.find((x) => /Kids pack/.test(x.plan_name))?.sessions_used === 0, 'the chosen plan was charged, not the other one');
  ok(/Covers: .*Kids Haircut/.test(await (async () => { await p.goto('/#/wallet'); await p.waitForSelector('.plan, .card'); await p.waitForTimeout(500); return p.evaluate(() => document.querySelector('#app').innerText); })()), 'wallet shows what each plan covers');
  await ctx.close(); }
// plan not listing the service can't be forced through the API either
const forced = await call('/bookings', { method: 'POST', body: { barber_id: barberId, service_id: beard.id, date: (await call('/config')).j.today, time: '16:00', payment_option: 'PLAN', plan_purchase_id: (await call('/me/wallet', {}, cust)).j.plans[0].id } }, cust);
ok(forced.r.status === 409, 'server refuses a plan session for a service the plan does not include', forced.r.status + JSON.stringify(forced.j));
// barber view: included services are listed
{ const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, baseURL: BASE }); await ctx.addCookies([{ name: mike.split('=')[0], value: mike.split('=').slice(1).join('='), url: BASE }]);
  const p = await ctx.newPage(); await p.goto('/#/plans'); await p.waitForSelector('.plnline'); const t = await p.evaluate(() => document.querySelector('#app').innerText);
  ok(/Includes .*Kids Haircut/.test(t), 'barber plan list shows included services'); ok(/only book the services you tick/.test(t), 'barber form explains the explicit list');
  await p.screenshot({ path: 'screenshots/plans/barber-plans.png', fullPage: true }); await ctx.close(); }
ok(errs.length === 0, 'no page errors', errs.join(' | '));
await b.close();
console.log(`${total - fails}/${total} plan-fit UI checks passed`); process.exit(fails ? 1 : 0);
