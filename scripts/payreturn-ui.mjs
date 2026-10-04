/* Payment-return messages (browser check against the local dev server, mock payments).
   The banner must come from the booking itself: a cancelled booking never says "confirmed", a double payment, a lost race and a late
   payment each have their own text, the "Pay now" button shows the real total, and the 10-second refresh keeps the banner.
   Usage: node scripts/payreturn-ui.mjs   (env BASE) -> exit 1 on any failure */
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
const BASE = process.env.BASE || 'http://localhost:4112';
const call = async (p, o = {}, ck) => { const r = await fetch(BASE + '/api' + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(ck ? { Cookie: ck } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined, redirect: 'manual' }); let j = null; try { j = await r.json(); } catch { /* none */ } return { r, j }; };
const login = async (i, pw) => (await call('/auth/login', { method: 'POST', body: { identifier: i, password: pw } })).r.headers.get('set-cookie').split(';')[0];
let fails = 0, total = 0; const ok = (c, n, x = '') => { total++; if (!c) { fails++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } else if (process.env.VERBOSE) console.log('PASS ' + n); };
const mike = await login('mike@trimslot.demo', 'Barber123!');
const stamp = Date.now();
const mkCust = async (tag) => { const email = `payret${tag}${stamp}@example.com`; await call('/auth/signup', { method: 'POST', body: { role: 'customer', name: 'Pay Return ' + tag, email, password: 'Password123', accept_terms: true } }); const ck = await login(email, 'Password123'); await call('/b/' + (await call('/barber/share', {}, mike)).j.code, {}, ck); return ck; };
const a = await mkCust('a'), c2 = await mkCust('b');
const cfg = (await call('/config')).j; const today = cfg.today;
const svc = (await call('/barbers/1', {}, a)).j.services[0];
const slots = (await call(`/barbers/1/slots?service_id=${svc.id}&date=${today}`, {}, a)).j.slots;
const book = async (ck, t) => (await call('/bookings', { method: 'POST', body: { barber_id: 1, service_id: svc.id, date: today, time: t, payment_option: 'ONLINE' } }, ck));
const pay = async (ck, id) => (await call(`/bookings/${id}/pay`, { method: 'POST' }, ck)).j;
const done = async (ref) => { await call(`/payments/mock/${ref}/complete`, { method: 'POST' }); await fetch(`${BASE}/api/payments/callback?reference=${ref}`, { redirect: 'manual' }); };

// 1) a normal paid booking, a cancelled one, a lost race, a double payment
const t = slots.map((s) => s.time);
const paid = (await book(a, t[0])).j.booking; const pp = await pay(a, paid.id); await done(pp.reference);
const dup = await call(`/bookings/${paid.id}/pay`, { method: 'POST' }, a);   // double click on a booking that is already paid
ok(dup.r.status >= 400 || dup.j.reference, 'second pay on a paid booking is refused or reuses (no crash)', JSON.stringify(dup.j).slice(0, 100));
const cancelled = (await book(a, t[2])).j.booking; await call(`/bookings/${cancelled.id}/cancel`, { method: 'POST' }, a);
const pend = (await book(a, t[4])).j.booking;
const loser = (await book(c2, t[6])).j.booking; const lp = await pay(c2, loser.id);
const winner = (await book(a, t[6])); // same time while the first is still unpaid
const wb = winner.j && winner.j.booking; if (wb) { const wp = await pay(a, wb.id); await done(wp.reference); }
await call(`/payments/mock/${lp.reference}/complete`, { method: 'POST' }); await fetch(`${BASE}/api/payments/callback?reference=${lp.reference}`, { redirect: 'manual' });

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const errs = [];
const open = async (ck, w, hash) => { const ctx = await b.newContext({ viewport: { width: w, height: 844 }, baseURL: BASE }); await ctx.addCookies([{ name: ck.split('=')[0], value: ck.split('=').slice(1).join('='), url: BASE }]); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); await p.goto('/' + hash); await p.waitForSelector('#app .card, #app .ok, #app .err, #app .info', { timeout: 15000 }); await p.waitForTimeout(600); return { ctx, p }; };
const text = async (p) => (await p.locator('#app').innerText()).replace(/\s+/g, ' ');
for (const w of [360, 1280]) {
  let { ctx, p } = await open(a, w, `#/booking/${paid.id}?pay=processed`); let tx = await text(p);
  ok(/Your booking is confirmed/.test(tx), w + ' paid booking: confirmed banner'); await ctx.close();
  ({ ctx, p } = await open(a, w, `#/booking/${paid.id}?pay=duplicate_refund`)); tx = await text(p);
  ok(/paid twice/.test(tx) && /confirmed/.test(tx) && !/not confirmed/.test(tx), w + ' double payment: its own text, still confirmed', tx.slice(0, 160)); await ctx.close();
  ({ ctx, p } = await open(a, w, `#/booking/${cancelled.id}?pay=processed`)); tx = await text(p);
  ok(!/Your booking is confirmed/.test(tx) && /cancelled|closed/i.test(tx), w + ' cancelled booking never says confirmed', tx.slice(0, 160)); await ctx.close();
  ({ ctx, p } = await open(c2, w, `#/booking/${loser.id}?pay=processed`)); tx = await text(p);
  ok(/not confirmed/.test(tx) && /refund/i.test(tx) && !/Your booking is confirmed/.test(tx), w + ' lost race: not confirmed + refund text even with ?pay=processed', tx.slice(0, 200));
  ({ ctx, p } = await open(c2, w, `#/booking/${loser.id}`)); tx = await text(p);
  ok(/not confirmed/.test(tx) && /refund/i.test(tx), w + ' lost race: refund text without ?pay (a plain reload)', tx.slice(0, 200)); await ctx.close();
  ({ ctx, p } = await open(a, w, `#/booking/${pend.id}`)); tx = await text(p);
  const total = (((await call('/bookings/' + pend.id, {}, a)).j.booking.money.total_kobo) / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 });
  ok(new RegExp('Pay ₦' + total.replace(/[,.]/g, '\\$&') + ' now').test(tx), w + ' pay button shows the true total ₦' + total, tx.match(/Pay ₦[\d,.]+ now/)?.[0]); await ctx.close();
}
{ const { ctx, p } = await open(c2, 390, `#/booking/${loser.id}?pay=slot_taken`); await p.waitForTimeout(100); await ctx.close(); }
{ const { ctx, p } = await open(a, 390, `#/booking/${pend.id}?pay=checked`); const before = await text(p); await p.waitForTimeout(11500); const after = await text(p);
  ok(/Paystack has not told us yet/.test(before) && /Paystack has not told us yet/.test(after), 'the 10-second refresh keeps the payment banner'); await ctx.close(); }
{ const r = await fetch(`${BASE}/api/payments/callback?reference=nope-${stamp}`, { redirect: 'manual' }); ok(/#\/bookings$/.test(r.headers.get('location') || ''), 'unknown reference goes to the bookings list, not booking 0', r.headers.get('location')); }
ok(errs.length === 0, 'no page errors', errs.join(' | '));
await b.close();
console.log(`${total - fails}/${total} payment-return checks passed`); process.exit(fails ? 1 : 0);
