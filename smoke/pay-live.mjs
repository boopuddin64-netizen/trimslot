// LIVE end-to-end payment check against Paystack TEST mode (real initialize + real hosted checkout driven headlessly with Paystack's public test card).
// Needs CRON_SECRET (admin key) in env; never printed. Throwaway smoketest+pay-*@example.com accounts only.
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
const B = process.env.BASE || 'https://trimslot-eight.vercel.app', KEY = process.env.CRON_SECRET; if (!KEY) throw new Error('CRON_SECRET missing');
const tag = Date.now().toString(36);
const call = async (p, o = {}, ck) => { const r = await fetch(B + '/api' + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(ck ? { Cookie: ck } : {}), ...(o.auth ? { Authorization: 'Bearer ' + KEY } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }); let j = {}; try { j = await r.json(); } catch { /* */ } return { s: r.status, j, r }; };
let bad = 0; const ck = (ok, m) => { if (!ok) bad++; console.log((ok ? 'ok   ' : 'FAIL ') + m); };
const bE = `smoketest+pay-b-${tag}@example.com`, cE = `smoketest+pay-c-${tag}@example.com`;
const sb = await call('/auth/signup', { method: 'POST', body: { role: 'barber', name: 'Pay Smoke Barber', email: bE, password: 'Smoke12345!', shop_name: 'Pay Smoke Shop', location: 'Test' } });
const sc = await call('/auth/signup', { method: 'POST', body: { role: 'customer', name: 'Pay Smoke Cust', email: cE, password: 'Smoke12345!' } });
const bck = sb.r.headers.get('set-cookie').split(';')[0], cck = sc.r.headers.get('set-cookie').split(';')[0];
const bl = await call('/admin/barbers', { auth: true }); const bid = bl.j.barbers.find((x) => x.email === bE).id; if ([2, 9].includes(bid)) throw new Error('refusing');
await call(`/admin/barbers/${bid}/approve`, { method: 'POST', auth: true, body: {} });
const svc = await call('/barber/services', { method: 'POST', body: { name: 'Pay cut', price_naira: 1000, duration_min: 30 } }, bck); const sid = svc.j.id ?? svc.j.service?.id;
// payout setup through the real in-app flow (bank list -> resolve -> subaccount). Paystack TEST mode may not resolve names; then the typed name is used.
const banks = await call('/barber/payout/banks', {}, bck); ck(banks.s === 200 && banks.j.banks.length > 5, 'live bank list loads (' + (banks.j.banks || []).length + ' banks)');
const bankCode = process.env.BANK_CODE || (banks.j.banks.find((x) => /zenith/i.test(x.name)) || banks.j.banks[0]).code, acctNo = process.env.ACCT || '0000000000';
const blocked = await call('/bookings', { method: 'POST', body: { barber_id: bid, service_id: sid, date: new Date(Date.now() + 2 * 86400000 + 3600000).toISOString().slice(0, 10), time: '10:00', payment_option: 'ONLINE' } }, cck); ck(blocked.s === 409 && blocked.j.error?.code === 'PAYOUT_NOT_SETUP', 'online booking blocked before payouts are set up (' + blocked.s + ')');
const rs = await call('/barber/payout/resolve', { method: 'POST', body: { bank_code: bankCode, account_number: acctNo } }, bck); console.log('resolve:', rs.s, rs.j.account_name || rs.j.error?.code || '');
const po = await call('/barber/payout', { method: 'POST', body: { bank_code: bankCode, account_number: acctNo, account_name: 'Pay Smoke Barber' } }, bck); ck(po.s === 200 && po.j.status === 'ACTIVE', 'payout saved -> Payouts active (' + po.s + ' ' + (po.j.error?.message || po.j.account_last4 || '') + ')');
if (po.s !== 200) { console.log(JSON.stringify(po.j).slice(0, 300)); }
const d = new Date(Date.now() + 2 * 86400000 + 3600000).toISOString().slice(0, 10);
const bk = await call('/bookings', { method: 'POST', body: { barber_id: bid, service_id: sid, date: d, time: '11:00', payment_option: 'ONLINE' } }, cck); ck(bk.s === 201, 'booking created (pending) ' + bk.s + ' ' + (bk.j.error?.message || ''));
const bkid = bk.j.booking?.id;
const pay = await call(`/bookings/${bkid}/pay`, { method: 'POST', body: {} }, cck); ck(pay.s === 200 && /^https:\/\/checkout\.paystack\.com\//.test(pay.j.authorization_url || ''), 'real Paystack initialize returned a checkout URL ' + pay.s + ' ' + (pay.j.error?.message || ''));
if (pay.s !== 200) { console.log(JSON.stringify(pay.j).slice(0, 300)); process.exit(1); }
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
await ctx.addCookies([{ name: cck.split('=')[0], value: cck.split('=').slice(1).join('='), url: B }]);
const p = await ctx.newPage(); const nav = []; p.on('framenavigated', (f) => { if (f === p.mainFrame()) nav.push(f.url().replace(/reference=[^&]+/, 'reference=…').replace(/trxref=[^&]+/, 'trxref=…').slice(0, 120)); });
await p.goto(pay.j.authorization_url, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(6000);
await p.screenshot({ path: '/workspace/trimslot/screenshots/pay-1-checkout.png' });
console.log('checkout title:', await p.title());
// pick card if a channel chooser is shown, then fill the public test card
try { await p.getByText(/pay with card|card/i).first().click({ timeout: 4000 }); } catch { /* maybe already on card form */ }
await p.waitForTimeout(1500);
const fillAny = async (sels, v) => { for (const s of sels) { const l = p.locator(s).first(); if (await l.count()) { await l.click().catch(() => {}); await l.fill(v).catch(async () => { await p.keyboard.type(v); }); return true; } } return false; };
ck(await fillAny(['#card-number', 'input[name=cardnumber]', 'input[placeholder*="0000"]', 'input[autocomplete="cc-number"]'], '4084084084084081'), 'card number field found');
await fillAny(['#expiry', 'input[name=expiry]', 'input[placeholder*="MM"]', 'input[autocomplete="cc-exp"]'], '1230');
await fillAny(['#cvv', 'input[name=cvv]', 'input[placeholder*="123"]', 'input[autocomplete="cc-csc"]'], '408');
await p.screenshot({ path: '/workspace/trimslot/screenshots/pay-2-card.png' });
await p.getByRole('button', { name: /pay/i }).first().click().catch(() => {});
await p.waitForTimeout(8000); await p.screenshot({ path: '/workspace/trimslot/screenshots/pay-3-after.png' });
// OTP / PIN steps if shown
for (let i = 0; i < 4; i++) {
  const txt = (await p.locator('body').innerText().catch(() => '')).slice(0, 400).replace(/\s+/g, ' '); console.log('step', i, txt.slice(0, 140));
  if (new URL(p.url()).host === new URL(B).host) break;
  if (/otp|enter the code|token/i.test(txt)) { await fillAny(['input[type=tel]', 'input[type=text]', 'input'], '123456'); await p.getByRole('button', { name: /authorize|submit|pay|continue/i }).first().click().catch(() => {}); }
  else if (/pin/i.test(txt)) { await fillAny(['input[type=password]', 'input[type=tel]', 'input'], '1234'); await p.getByRole('button', { name: /authorize|submit|pay|continue/i }).first().click().catch(() => {}); }
  await p.waitForTimeout(7000);
}
await p.waitForTimeout(5000);
console.log('navigation chain:', nav.join(' -> '));
ck(new URL(p.url()).host === new URL(B).host, 'returned to the app after paying (' + p.url().replace(/reference=[^&]+/, 'reference=…').slice(0, 100) + ')');
await p.waitForTimeout(3000); await p.screenshot({ path: '/workspace/trimslot/screenshots/pay-4-return.png' });
console.log('app text:', (await p.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 260));
const after = await call('/bookings/' + bkid, {}, cck); ck(after.j.booking?.status === 'CONFIRMED' && after.j.booking?.payment_status === 'PAID', 'booking CONFIRMED + PAID (status=' + after.j.booking?.status + ', pay=' + after.j.booking?.payment_status + ')');
const ver = await call(`/bookings/${bkid}/verify`, { method: 'POST', body: {} }, cck); console.log('verify fallback result:', ver.j.result);
await browser.close();
console.log(bad ? `${bad} FAILED` : 'ALL OK'); console.log('throwaway:', bE, cE);
