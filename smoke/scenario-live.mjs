// LIVE multi-customer scenario against production (Paystack TEST mode). Throwaway smoketest+scn-*@example.com accounts only.
// Needs: CRON_SECRET (admin key), SMOKE_PIN (a 4-digit admin PIN already set), maintenance OFF, DISPLAY (headed Chrome for the Paystack checkout).
// Covers: signup, barber payout setup, slot races, pay-now (real checkout) incl. fee pass-through + ledger netting, pay on arrival + queue + commission ledger,
// plan purchase + use + cancel, credits (admin + real no-show), cancel inside/outside the window, availability-change notifications, push subscribe, admin actions with PIN.
import { chromium } from '/workspace/pw-tools/node_modules/playwright-core/index.mjs';
const B = process.env.BASE || 'https://trimslot-eight.vercel.app', KEY = process.env.CRON_SECRET, PIN = process.env.SMOKE_PIN;
if (!KEY || !PIN) throw new Error('CRON_SECRET and SMOKE_PIN needed');
const tag = Date.now().toString(36); const PW = 'Smoke12345!';
let bad = 0; const fails = []; const ck = (ok, m) => { if (!ok) { bad++; fails.push(m); } console.log((ok ? 'ok   ' : 'FAIL ') + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class U { constructor(n) { this.n = n; this.cookie = ''; this.email = `smoketest+scn-${n}-${tag}@example.com`; }
  async call(path, o = {}) { const r = await fetch(B + '/api' + path, { method: o.method || 'GET', redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}), ...(o.admin ? { Authorization: 'Bearer ' + KEY, ...(o.pin ? { 'X-Admin-Pin': PIN } : {}) } : {}) }, body: o.body ? JSON.stringify(o.body) : (o.method && o.method !== 'GET' ? '{}' : undefined) }); let j = {}; try { j = await r.json(); } catch { /* redirect */ } const sc = r.headers.get('set-cookie'); if (sc && /^[^=]+=/.test(sc)) this.cookie = sc.split(';')[0]; return { s: r.status, j, code: j?.error?.code, loc: r.headers.get('location') || '' }; } }
const anon = new U('anon'); const A = (path, o = {}) => anon.call(path, { ...o, admin: true }); const AP = (path, body) => anon.call(path, { method: 'POST', body: body || {}, admin: true, pin: true });
const barber = new U('barber'); const C = Array.from({ length: 5 }, (_, i) => new U('c' + (i + 1))); const [c1, c2, c3, c4, c5] = C;
const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const lagosMin = (iso) => { const d = new Date(Date.parse(iso) + 3600000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const notifs = async (u) => { const all = []; let before = 0; for (let i = 0; i < 10; i++) { const j = (await u.call('/notifications?limit=100' + (before ? '&before=' + before : ''))).j; all.push(...(j.notifications || [])); if (!j.next_before) break; before = j.next_before; } return all; };

/* ---------- Paystack hosted checkout (TEST simulator) in a headed browser ---------- */
let browser;
async function payAt(url, who) {
  browser ??= await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: !process.env.DISPLAY, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addCookies([{ name: who.cookie.split('=')[0], value: who.cookie.split('=').slice(1).join('='), url: B }]);
  const p = await ctx.newPage(); await p.goto(url, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(5000);
  const body = await p.locator('body').innerText().catch(() => ''); const shown = body.match(/Pay NGN [\d,.]+/)?.[0];
  const sim = p.getByText(/^\s*Success\s*$/i).first(); if (await sim.count()) await sim.click().catch(() => {});
  await p.getByRole('button', { name: /^pay/i }).first().click().catch(() => {});
  for (let i = 0; i < 20; i++) { if (new URL(p.url()).host === new URL(B).host) break; await p.waitForTimeout(1500); }
  await p.waitForTimeout(3500); const back = p.url(); const text = (await p.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  await ctx.close(); return { shown, back, text };
}

(async () => {
  /* ---- 0. preconditions ---- */
  const cfg = (await anon.call('/config')).j; ck(cfg.maintenance === null, 'maintenance is OFF for the test window');
  if (cfg.maintenance !== null) throw new Error('maintenance on');
  ck((await A('/admin/pin/status')).j.set === true, 'admin PIN is set');
  const T = (n) => hhmm(T0 + 15 * n);
  /* ---- 1. signup (barber + 5 customers) ---- */
  const sb = await barber.call('/auth/signup', { method: 'POST', body: { accept_terms: true, accept_barber_agreement: true, role: 'barber', name: 'Scn Barber', email: barber.email, password: PW, shop_name: 'Scenario Shop', location: 'Test' } });
  const sc = await Promise.all(C.map((c, i) => c.call('/auth/signup', { method: 'POST', body: { accept_terms: true, role: 'customer', name: 'Scn Cust ' + (i + 1), email: c.email, password: PW } })));
  ck(sb.s === 201 && sc.every((r) => r.s === 201), 'signup: barber + 5 customers ' + [sb.s, ...sc.map((r) => r.s)]);
  if (sb.s !== 201) throw new Error('signup failed (rate limit?)');
  const bl = await A('/admin/barbers'); const bid = bl.j.barbers.find((x) => x.email === barber.email).id; if ([2, 9].includes(bid)) throw new Error('refusing');
  ck((await A(`/admin/barbers/${bid}/approve`, { method: 'POST', body: {} })).j.verified === true, 'admin approves the new barber');
  /* ---- 2. barber setup: services, plan, hours, payouts ---- */
  const sA = (await barber.call('/barber/services', { method: 'POST', body: { name: 'Scn cut', price_naira: 3000, duration_min: 30 } })).j; const sB = (await barber.call('/barber/services', { method: 'POST', body: { name: 'Scn kids', price_naira: 1500, duration_min: 15 } })).j;
  const prof = (await barber.call('/barber/profile')).j; const svcA = prof.services.find((s) => s.name === 'Scn cut').id, svcB = prof.services.find((s) => s.name === 'Scn kids').id;
  const pl = await barber.call('/barber/plans', { method: 'POST', body: { name: 'Scn pack', price_naira: 5000, sessions: 2, validity_days: 30, service_ids: [svcA] } }); ck(pl.s === 201, 'barber creates a plan ' + pl.s); const planId = pl.j.id;
  var nowIso = (await anon.call('/config')).j.now; var T0 = Math.ceil((lagosMin(nowIso) + 4) / 15) * 15;   // first slot ~4-19 min from now (real clock)
  const today = (await anon.call('/config')).j.today, D1 = addDays(today, 1), D2 = addDays(today, 2), D3 = addDays(today, 3);
  if (T0 + 15 * 8 > 23 * 60 + 45) throw new Error('too late in the evening for the same-day steps');
  const days = Array.from({ length: 7 }, (_, wd) => ({ weekday: wd, is_working: true, start: wd === new Date(today + 'T00:00:00Z').getUTCDay() ? hhmm(T0) : '09:00', end: wd === new Date(today + 'T00:00:00Z').getUTCDay() ? '23:45' : '18:00', break_start: null, break_end: null }));
  ck((await barber.call('/barber/schedule', { method: 'PUT', body: { days, confirm: true } })).s === 200, 'barber sets hours (open all week, today from ' + hhmm(T0) + ')');
  const banks = (await barber.call('/barber/payout/banks')).j.banks || []; ck(banks.length > 5, 'bank list loads (' + banks.length + ')');
  const bcode = (banks.find((x) => /zenith/i.test(x.name)) || banks[0]).code;
  const blk = await c1.call('/bookings', { method: 'POST', body: { barber_id: bid, service_id: svcA, date: D2, time: '10:00', payment_option: 'ONLINE' } }); ck(blk.s === 409 && blk.code === 'PAYOUT_NOT_SETUP', 'pay-now blocked until payouts active (' + blk.code + ')');
  ck((await c1.call(`/barbers/${bid}`)).j.booking?.online_payments === false, 'barber page says online payments unavailable');
  const rs = await barber.call('/barber/payout/resolve', { method: 'POST', body: { bank_code: bcode, account_number: '0000000000' } }); console.log('     resolve:', rs.s, rs.j.account_name || rs.code || '');
  const po = await barber.call('/barber/payout', { method: 'POST', body: { bank_code: bcode, account_number: '0000000000', account_name: 'Scenario Barber' } }); ck(po.s === 200 && po.j.status === 'ACTIVE', 'payout saved -> Payouts active (' + po.s + ')');
  ck((await c1.call(`/barbers/${bid}`)).j.booking?.online_payments === true, 'barber page now offers pay-now');

  /* ---- 3. slot race: 5 customers, one slot ---- */
  const bookAs = (u, date, time, opt, svc = svcA, extra = {}) => u.call('/bookings', { method: 'POST', body: { barber_id: bid, service_id: svc, date, time, payment_option: opt, ...extra } });
  const race = await Promise.all(C.map((c) => bookAs(c, D2, '10:00', 'ON_ARRIVAL')));
  ck(race.filter((r) => r.s === 201).length === 1 && race.filter((r) => r.s === 409).length === 4, 'race for one slot: exactly 1 winner, 4 clean 409 (' + race.map((r) => r.s).join(',') + ')');
  const winner = C[race.findIndex((r) => r.s === 201)]; const raceBk = race.find((r) => r.s === 201).j.booking.id;
  ck((await winner.call(`/bookings/${raceBk}/cancel`, { method: 'POST' })).s === 200, 'winner cancels far ahead (outside window) -> ok');
  const re = await bookAs(c2, D2, '10:00', 'ON_ARRIVAL'); ck(re.s === 201, 'slot reopens at once and another customer books it');

  /* ---- 4. pay-now with a real Paystack test checkout (c4), fee pass-through + ledger netting ---- */
  // create commission debt first: c3 pays on arrival today, barber completes -> platform balance owed
  const t3 = await bookAs(c3, today, T(2), 'ON_ARRIVAL'); ck(t3.s === 201, 'c3 books pay-on-arrival today ' + t3.s + ' ' + (t3.j.error?.message || ''));
  const c3id = t3.j.booking?.id;
  /* plan purchase (c1) via real checkout */
  const buy = await c1.call(`/plans/${planId}/buy`, { method: 'POST' }); ck(buy.s === 201 && /checkout\.paystack\.com/.test(buy.j.authorization_url || ''), 'plan purchase initialised (real Paystack) ' + buy.s);
  const pay1 = await payAt(buy.j.authorization_url, c1); console.log('     plan checkout:', pay1.shown, '->', pay1.back.replace(/reference=[^&]+/, 'reference=…').slice(0, 110));
  ck(/#\/wallet\?plan=(processed|already_processed)/.test(pay1.back), 'plan checkout returns to #/wallet with a success result');
  const w = (await c1.call('/me/wallet')).j; ck(w.plans?.[0]?.sessions_left === 2 && w.plans[0].live, 'wallet shows the plan: 2 sessions live');
  const planToday = await bookAs(c1, today, T(0), 'PLAN'); ck(planToday.s === 201 && planToday.j.booking.payment_status === 'PAID', 'c1 books a PLAN session today (instant CONFIRMED+PAID)'); const planTodayId = planToday.j.booking?.id;
  const lock = await c1.call(`/bookings/${planTodayId}/cancel`, { method: 'POST' }); ck(lock.s === 403 && lock.code === 'CANCEL_LOCKED', 'cancel inside the 30-min window is refused (' + lock.code + ')');
  /* pay-now booking (c4) */
  const on = await bookAs(c4, D2, '12:00', 'ONLINE'); ck(on.s === 201, 'c4 creates pay-now booking ' + on.s); const onId = on.j.booking?.id;
  const pp = await c4.call(`/bookings/${onId}/pay`, { method: 'POST' }); ck(pp.s === 200 && /checkout\.paystack\.com/.test(pp.j.authorization_url || ''), 'pay-now initialised (real Paystack)');
  const pre = await c5.call(`/barbers/${bid}/slots?service_id=${svcA}&date=${D2}`); ck((pre.j.slots || []).some((s) => s.time === '12:00'), 'unpaid attempt holds no slot (c5 still sees 12:00)');
  const pay2 = await payAt(pp.j.authorization_url, c4); console.log('     booking checkout:', pay2.shown, '->', pay2.back.replace(/reference=[^&]+/, 'reference=…').slice(0, 110));
  ck(/#\/booking\/\d+\?pay=(processed|already_processed)/.test(pay2.back), 'returned to #/booking with success result');
  ck(/confirmed/i.test(pay2.text), 'success screen shown to the customer ("confirmed")');
  const after = (await c4.call(`/bookings/${onId}`)).j.booking; ck(after.status === 'CONFIRMED' && after.payment_status === 'PAID', 'booking CONFIRMED + PAID (' + after.status + '/' + after.payment_status + ')');
  const pr = (await A('/admin/payments/' + encodeURIComponent(pp.j.reference))).j.payment; ck(pr.status === 'SUCCESS' && pr.paid_kobo >= pr.amount_kobo && pr.gateway_fee_kobo === pr.paid_kobo - pr.amount_kobo, `payment SUCCESS; paid ${pr.paid_kobo} for price ${pr.amount_kobo} (fee ${pr.gateway_fee_kobo} passed through)`);
  ck((await c5.call(`/barbers/${bid}/slots?service_id=${svcA}&date=${D2}`)).j.slots.every((s) => s.time !== '12:00'), 'paid slot is taken (gone from c5 slot list)');
  const race2 = await bookAs(c5, D2, '12:00', 'ON_ARRIVAL'); ck(race2.s === 409, 'c5 cannot book the paid slot (' + race2.s + ' ' + race2.code + ')');
  ck((await notifs(barber)).some((n) => n.type === 'NEW_BOOKING' && n.booking_id === onId), 'barber notified of the paid booking'); ck((await notifs(c4)).some((n) => /BOOKING_CONFIRMED|PAYMENT/.test(n.type) && n.booking_id === onId), 'customer notified');
  const vf = await c4.call(`/bookings/${onId}/verify`, { method: 'POST' }); ck(vf.j.result === 'already_processed', 'verify-by-reference fallback is idempotent (' + vf.j.result + ')');

  /* ---- 5. queue + pay on arrival + off-app commission ledger (today) ---- */
  const t4 = await bookAs(c2, today, T(4), 'ON_ARRIVAL', svcB), t5 = await bookAs(c5, today, T(5), 'ON_ARRIVAL', svcB); ck(t4.s === 201 && t5.s === 201, 'c2, c5 book pay-on-arrival today');
  const planFar = await bookAs(c1, D2, '15:00', 'PLAN'); ck(planFar.s === 201, 'c1 books the 2nd plan session far ahead'); 
  ck((await bookAs(c1, D2, '16:00', 'PLAN')).s === 409, 'a 3rd plan session is refused (exhausted)');
  const cf = await c1.call(`/bookings/${planFar.j.booking.id}/cancel`, { method: 'POST' }); ck(cf.s === 200, 'cancel outside the window -> ok'); ck((await c1.call('/me/wallet')).j.plans[0].sessions_left === 1, 'plan session restored after in-time cancel');
  const q = async (u, id) => (await u.call(`/bookings/${id}`)).j.booking.queue;
  ck((await c5.call(`/bookings/${t5.j.booking.id}/check-in`, { method: 'POST' })).s === 200, 'c5 arrives first (booked later than c2)');
  const qa = await q(c5, t5.j.booking.id), qb = await q(c2, t4.j.booking.id); ck(qa.position === 1 && qb.position > 1, `queue: arrival beats booking order (c5 #${qa.position}, not-yet-arrived c2 #${qb.position})`);
  ck((await c2.call(`/bookings/${t4.j.booking.id}/check-in`, { method: 'POST' })).s === 200, 'c2 arrives second');
  const qc = await q(c5, t5.j.booking.id), qd = await q(c2, t4.j.booking.id); ck(qd.position === 1 && qc.position === 2, `queue: among arrived, scheduled order (c2 #${qd.position}, c5 #${qc.position})`);
  ck((await barber.call(`/barber/bookings/${t4.j.booking.id}/skip`, { method: 'POST' })).s === 200, 'barber skips c2 -> goes last'); const qe = await q(c5, t5.j.booking.id); ck(qe.position === 1, 'c5 now #1');
  ck((await barber.call(`/barber/bookings/${t5.j.booking.id}/start`, { method: 'POST' })).s === 200, 'barber starts c5');
  ck((await barber.call(`/barber/bookings/${t5.j.booking.id}/complete`, { method: 'POST' })).code === 'PAYMENT_REQUIRED', 'complete blocked until payment recorded');
  ck((await barber.call(`/barber/bookings/${t5.j.booking.id}/record-payment`, { method: 'POST', body: { method: 'cash' } })).s === 200, 'barber records cash');
  ck((await barber.call(`/barber/bookings/${t5.j.booking.id}/complete`, { method: 'POST' })).s === 200, 'barber completes -> commission accrues');
  const led = (await barber.call('/barber/ledger')).j; ck(led.owed_kobo > 0, 'off-app commission owed by barber: ' + led.owed_kobo);
  /* netting: another pay-now payment now nets the debt */
  const on2 = await bookAs(c3, D2, '14:00', 'ONLINE'); const pp2 = await c3.call(`/bookings/${on2.j.booking.id}/pay`, { method: 'POST' });
  const pr2a = (await A('/admin/payments/' + encodeURIComponent(pp2.j.reference))).j.payment; ck(pr2a.debt_netted_kobo > 0, 'next in-app payment is set to net the debt: netted ' + pr2a.debt_netted_kobo);
  const pay3 = await payAt(pp2.j.authorization_url, c3); ck(/pay=(processed|already_processed)/.test(pay3.back), 'second checkout returns to the app');
  const led2 = (await barber.call('/barber/ledger')).j; ck(led2.owed_kobo === Math.max(0, led.owed_kobo - pr2a.debt_netted_kobo), `ledger netted: owed ${led.owed_kobo} -> ${led2.owed_kobo}`);

  /* ---- 6. availability change notifications ---- */
  const a3 = await bookAs(c3, D3, '10:00', 'ON_ARRIVAL'); ck(a3.s === 201, 'c3 books D3');
  const d1 = await barber.call('/barber/days-off', { method: 'POST', body: { date: D3, reason: 'Scenario test' } }); ck(d1.s === 409 && d1.code === 'AVAILABILITY_CONFLICT', 'closing a day with a booking -> 409 AVAILABILITY_CONFLICT');
  ck((await barber.call('/barber/days-off', { method: 'POST', body: { date: D3, reason: 'Scenario test', confirm: true } })).s === 201, 'barber confirms the closure');
  ck((await notifs(c3)).some((n) => n.type === 'AVAILABILITY_CHANGED' && n.booking_id === a3.j.booking.id), 'affected customer notified (AVAILABILITY_CHANGED)');
  ck((await c3.call(`/bookings/${a3.j.booking.id}`)).j.booking.status === 'CONFIRMED', 'booking not auto-cancelled');

  /* ---- 7. push subscribe path ---- */
  const fake = { endpoint: `https://push.example.invalid/scn/${tag}`, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } };
  ck((await c1.call('/push/status')).j.available === true, 'push available server-side'); ck((await c1.call('/push/subscribe', { method: 'POST', body: { subscription: fake } })).s < 300, 'push subscribe stored'); ck((await c1.call('/push/unsubscribe', { method: 'POST', body: { endpoint: fake.endpoint } })).s < 300, 'push unsubscribe');

  /* ---- 8. credits: admin-issued credit used, then a real no-show credit ---- */
  const ci = await AP('/admin/credits/issue', { customer_id: sc[1].j.user.id, barber_id: bid, value_naira: 3000, reason: 'scenario credit' }); ck(ci.s === 200, 'admin issues a credit to c2 ' + ci.s);
  const cb = await bookAs(c2, D1, '11:00', 'CREDIT'); ck(cb.s === 201 && cb.j.booking.payment_status === 'PAID', 'c2 books with the credit (CONFIRMED+PAID via CREDIT)');
  if (!process.env.SKIP_NOSHOW) {   // SKIP_NOSHOW=1 skips the ~15 min real-time wait for the scheduled time to pass
  const nowMin = lagosMin((await anon.call('/config')).j.now); const wait = (T0 + 1 - nowMin) * 60000;
  if (wait > 0) { console.log(`     (waiting ${Math.ceil(wait / 1000)}s for ${T(0)} to pass for a real no-show)`); await sleep(wait + 20000); }
  const ns = await barber.call(`/barber/bookings/${planTodayId}/no-show`, { method: 'POST' }); ck(ns.s === 200 && ns.j.booking.payment_status === 'CREDITED', 'no-show of a plan session -> CREDITED ' + ns.s + ' ' + (ns.code || ''));
  ck((await c1.call('/me/wallet')).j.credits.filter((c) => c.live).length === 1, 'customer wallet shows exactly one live credit'); ck((await notifs(c1)).filter((n) => n.type === 'CREDIT_ISSUED').length === 1, 'customer notified once (CREDIT_ISSUED)');
  ck((await c1.call(`/bookings/${planTodayId}/cancel`, { method: 'POST' })).s === 409, 'cannot cancel a no-show');

  }

  /* ---- 9. admin actions with PIN ---- */
  const nopin = await A(`/admin/users/${sc[4].j.user.id}/ban`, { method: 'POST', body: { reason: 'scn' } }); ck(nopin.s === 403 && nopin.code === 'PIN_REQUIRED', 'ban without PIN refused');
  ck((await AP(`/admin/users/${sc[4].j.user.id}/ban`, { reason: 'scenario ban' })).j.account_status === 'BANNED', 'ban with PIN'); ck((await c5.call('/auth/login', { method: 'POST', body: { identifier: c5.email, password: PW } })).s === 403, 'banned customer cannot log in');
  ck((await AP(`/admin/users/${sc[4].j.user.id}/reinstate`, {})).s === 200, 'reinstate');
  const own = (await A('/admin/ledger/' + bid)).j.balance.outstanding_kobo; 
  const adj = await AP(`/admin/ledger/${bid}/adjust`, { amount_naira: 5, reason: 'scenario adjust' }); ck(adj.s === 200 && adj.j.owed_kobo === own + 500, 'ledger adjust needs PIN and adds ₦5');
  ck((await A(`/admin/ledger/${bid}/waive`, { method: 'POST', body: { all: true, reason: 'scenario check' } })).code === 'PIN_REQUIRED', 'ledger waive without PIN refused'); ck((await AP(`/admin/ledger/${bid}/waive`, { all: true, reason: 'scenario waive' })).j.owed_kobo === 0, 'ledger waive with PIN -> 0');
  const del = await AP(`/admin/delete/customer/${sc[2].j.user.id}`, { reason: 'scenario', cancel_bookings: true }); ck(del.s === 200, 'delete customer (soft) with PIN, bookings cancelled ' + del.s + ' ' + (del.code || ''));
  ck((await AP(`/admin/restore/customer/${sc[2].j.user.id}`, {})).s === 200, 'restore within 30 days');
  const pg = await AP(`/admin/purge/customer/${sc[2].j.user.id}`, { reason: 'scenario check' }); ck(pg.code === 'DELETE_FIRST', 'hard delete refused unless soft-deleted first');
  const myPaid = await AP(`/admin/delete/barber/${bid}`, { reason: 'scenario', cancel_bookings: true }); ck(myPaid.s === 200, 'soft-delete the scenario barber ' + myPaid.s + ' ' + (myPaid.code || ''));
  const pg2 = await AP(`/admin/purge/barber/${bid}`, { reason: 'scenario check' }); ck(pg2.code === 'HAS_PAYMENTS', 'hard delete of a barber with successful payments is refused (' + pg2.code + ')');
  ck((await AP(`/admin/restore/barber/${bid}`, {})).s === 200, 'restore the scenario barber (kept for the UI audit; removed by the test-data purge)');
  await browser?.close();
  console.log(bad ? `\n${bad} FAILED: ${fails.join(' | ')}` : '\nALL OK'); console.log('throwaway tag:', tag, 'shop id:', bid); process.exit(bad ? 1 : 0);
})().catch(async (e) => { console.log('SCRIPT ERROR', e.message); await browser?.close().catch(() => {}); process.exit(2); });
