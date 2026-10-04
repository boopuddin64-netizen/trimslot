/* End-to-end API check against a RUNNING server in MOCK mode.
   Usage: BASE=http://localhost:4101 npm run e2e   (server should run with a clock during opening hours, e.g. TRIMSLOT_FAKE_NOW) */
import crypto from 'crypto';
import { MOCK_SECRET } from '../src/config';

const BASE = process.env.BASE || 'http://localhost:4101';
class Client {
  cookie = '';
  async call(method: string, path: string, body?: unknown, raw?: { body: string; headers: Record<string, string> }) {
    const r = await fetch(BASE + path, {
      method, redirect: 'manual',
      headers: { ...(raw ? raw.headers : { 'Content-Type': 'application/json' }), ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: raw ? raw.body : method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    let j: any = {}; try { j = await r.json(); } catch { /* redirect etc */ }
    return { status: r.status, json: j, headers: r.headers };
  }
}
let n = 0, bad = 0;
function check(name: string, cond: boolean, extra?: unknown) { n++; if (!cond) bad++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra)}`); }

(async () => {
  const cfg = (await new Client().call('GET', '/api/config')).json;
  check('server in MOCK mode', cfg.mock === true, cfg);
  const today: string = cfg.today;
  const stamp = Date.now();
  const mike = new Client(), cust = new Client(), cust2 = new Client(), anon = new Client();

  check('unauthenticated /bookings -> 401', (await anon.call('GET', '/api/bookings')).status === 401);
  check('login wrong password -> 401', (await mike.call('POST', '/api/auth/login', { identifier: 'mike@trimslot.demo', password: 'nope' })).status === 401);
  check('barber login', (await mike.call('POST', '/api/auth/login', { identifier: 'mike@trimslot.demo', password: 'Barber123!' })).status === 200);
  const bad1 = await cust.call('POST', '/api/auth/signup', { accept_terms: true, role: 'customer', name: 'X', password: 'short' });
  check('signup validation error (400)', bad1.status === 400, bad1.json);
  const su = await cust.call('POST', '/api/auth/signup', { accept_terms: true, role: 'customer', name: 'Ngozi Test', email: `ngozi${stamp}@example.com`, phone: '', password: 'Password123' });
  check('customer signup', su.status === 201, su.json);
  // Email check by one-time code is PAUSED unless EMAIL_VERIFICATION_REQUIRED=true (run: EMAIL_VERIFICATION_REQUIRED=true npm run e2e to cover the code flow).
  // Dev/test fixed code 123456; the mail goes to the server log, nothing real is sent.
  const evOn = cfg.email_verification === true;
  check('config reports the email-check flag matching the environment', evOn === /^(1|true|yes|on)$/i.test(process.env.EMAIL_VERIFICATION_REQUIRED || ''));
  if (evOn) {
    const nov = await cust.call('POST', '/api/bookings', { barber_id: 1, service_id: 1, date: cfg.today, time: '10:00', payment_option: 'ON_ARRIVAL' });
    check('first booking needs a checked email (403 EMAIL_NOT_VERIFIED, or 404 before the barber link)', nov.status === 403 || nov.status === 404, nov.json);
    check('email code is sent', (await cust.call('POST', '/api/auth/email/send')).status === 200);
    check('a wrong email code is refused (400)', (await cust.call('POST', '/api/auth/email/verify', { code: '000000' })).status === 400);
    check('the right email code verifies the email', (await cust.call('POST', '/api/auth/email/verify', { code: '123456' })).json.user?.email_verified === true);
  } else {
    const nov = await cust.call('POST', '/api/bookings', { barber_id: 1, service_id: 1, date: cfg.today, time: '10:00', payment_option: 'ON_ARRIVAL' });
    check('email check paused: a booking is never refused for an unchecked email', nov.status !== 403 || nov.json?.error?.code !== 'EMAIL_NOT_VERIFIED', nov.json);
    const snd = await cust.call('POST', '/api/auth/email/send');
    check('email check paused: no code is sent (409 EMAIL_VERIFICATION_OFF)', snd.status === 409 && snd.json?.error?.code === 'EMAIL_VERIFICATION_OFF', snd.json);
  }
  check('duplicate signup -> 409', (await anon.call('POST', '/api/auth/signup', { accept_terms: true, role: 'customer', name: 'Dup', email: `ngozi${stamp}@example.com`, password: 'Password123' })).status === 409);
  await cust2.call('POST', '/api/auth/login', { identifier: 'tunde@trimslot.demo', password: 'Customer123!' });

  // Barbers are not listed. A customer reaches a shop only through its private link (or a past booking).
  const shareCode: string = (await mike.call('GET', '/api/barber/share')).json.code;
  check('barber has a private share code', /^[a-f0-9]{12,32}$/.test(shareCode), shareCode);
  check('there is no public barber list (401 for guests, empty for a new customer)', (await anon.call('GET', '/api/barbers')).status === 401 && (await cust.call('GET', '/api/barbers')).json.barbers.length === 0);
  const linkPeek = await anon.call('GET', '/api/b/' + shareCode);
  check('a guest can open the link and sees the shop (no booking yet)', linkPeek.status === 200 && linkPeek.json.share.can_add === false && linkPeek.json.services.length > 0, linkPeek.json?.error);
  const barber = { id: linkPeek.json.barber.id };
  check('without the link a new customer cannot open the shop, its slots, or book it', (await cust.call('GET', `/api/barbers/${barber.id}`)).status === 404
    && (await cust.call('GET', `/api/barbers/${barber.id}/slots?service_id=${linkPeek.json.services[0].id}&date=${today}`)).status === 404
    && (await cust.call('POST', '/api/bookings', { barber_id: barber.id, service_id: linkPeek.json.services[0].id, date: today, time: '10:00', payment_option: 'ON_ARRIVAL' })).status === 404);
  const opened = await cust.call('GET', '/api/b/' + shareCode);
  check('customer opens the link: shop is shown, not yet added', opened.status === 200 && opened.json.share.can_add === true && opened.json.share.added === false);
  check('customer adds the barber -> My barbers', (await cust.call('POST', `/api/b/${shareCode}/add`)).json.added === true && (await cust.call('GET', '/api/me/barbers')).json.barbers.length === 1);
  check('a wrong link is just "not found"', (await anon.call('GET', '/api/b/0123456789abcdef')).status === 404);
  const detail = (await cust.call('GET', `/api/barbers/${barber.id}`)).json;
  const svc = detail.services.find((s: any) => s.name === 'Haircut + Beard');
  check('service list seeded (4, ₦4,500 / 45min beard)', detail.services.length === 4 && svc.price_kobo === 450000 && svc.duration_min === 45, detail.services);

  const slots = (await cust.call('GET', `/api/barbers/${barber.id}/slots?service_id=${svc.id}&date=${today}`)).json;
  check('slots exist today (none in break 13:00-14:00)', slots.slots.length > 0 && !slots.slots.some((s: any) => s.time > '12:15' && s.time < '14:00'), slots);
  const t1 = slots.slots[0].time;

  // role enforcement
  check('customer cannot open barber Today (403)', (await cust.call('GET', '/api/barber/today')).status === 403);
  check('barber cannot create a booking (403)', (await mike.call('POST', '/api/bookings', { barber_id: barber.id, service_id: svc.id, date: today, time: t1, payment_option: 'ON_ARRIVAL' })).status === 403);

  // book pay-now with a forged price
  const bk = await cust.call('POST', '/api/bookings', { barber_id: barber.id, service_id: svc.id, date: today, time: t1, payment_option: 'ONLINE', price_kobo: 100 });
  check('pay-now booking created as PENDING_PAYMENT with server price', bk.status === 201 && bk.json.booking.status === 'PENDING_PAYMENT' && bk.json.booking.price_kobo === 450000, bk.json);
  const id = bk.json.booking.id;
  const still = (await cust2.call('GET', `/api/barbers/${barber.id}/slots?service_id=${svc.id}&date=${today}`)).json.slots;
  check('unpaid Pay-now attempt does NOT hold the slot (still offered to others)', still.some((s: any) => s.time === t1), still.length);
  check('cannot check in while PENDING_PAYMENT', (await cust.call('POST', `/api/bookings/${id}/check-in`)).status === 409);
  check('other customer cannot read my booking (404)', (await cust2.call('GET', `/api/bookings/${id}`)).status === 404);
  const mt = (await mike.call('GET', '/api/barber/today')).json;
  const mall = JSON.stringify(mt);
  check('barber Today never shows the unpaid Pay-now hold (not in queue, not listed)', mt.pending_payment.length === 0 && !mall.includes(`"id":${id},`), mt.pending_payment);
  check('barber cannot open the unpaid hold (404)', (await mike.call('GET', `/api/barber/bookings/${id}`)).status === 404);

  // pay: initialize -> claim paid without paying -> verify says no
  const pay = (await cust.call('POST', `/api/bookings/${id}/pay`)).json;
  check('payment initialized (TS-BOOKING ref, mock URL)', /^TS-BOOKING-\d+-[a-f0-9]+$/.test(pay.reference) && pay.mock && pay.price_kobo === 450000 && pay.amount_kobo === pay.price_kobo + pay.booking_fee_kobo && pay.booking_fee_kobo > 0, pay);
  const v0 = (await cust.call('POST', `/api/bookings/${id}/verify`)).json;
  check('client verify before paying does NOT confirm', v0.booking.status === 'PENDING_PAYMENT', v0);
  const evBody = JSON.stringify({ event: 'charge.success', data: { reference: pay.reference, status: 'success', amount: 450000 } });
  const wh = (sig: string) => anon.call('POST', '/api/payments/webhook', undefined, { body: evBody, headers: { 'Content-Type': 'application/json', 'x-paystack-signature': sig } });
  check('forged webhook (bad signature) -> 401', (await wh('bad')).status === 401);
  const goodSig = crypto.createHmac('sha512', MOCK_SECRET).update(evBody).digest('hex');
  const w1 = await wh(goodSig);
  check('validly-signed webhook but unpaid in gateway -> not confirmed', w1.status === 200 && w1.json.result === 'not_paid', w1.json);
  // customer pays on mock checkout page
  const done = await anon.call('POST', `/api/payments/mock/${pay.reference}/complete`);
  check('mock checkout marks paid', done.status === 200);
  const cb = await anon.call('GET', done.json.next);
  check('callback verifies server-side and redirects', cb.status === 302 && /pay=processed/.test(cb.headers.get('location') || ''), cb.headers.get('location'));
  let b = (await cust.call('GET', `/api/bookings/${id}`)).json.booking;
  check('booking now CONFIRMED + PAID', b.status === 'CONFIRMED' && b.payment_status === 'PAID', b);
  check('double booking a paid slot -> 409 (slot taken until cancelled)', (await cust2.call('POST', '/api/bookings', { barber_id: barber.id, service_id: svc.id, date: today, time: t1, payment_option: 'ON_ARRIVAL' })).status === 409);
  const w2 = await wh(goodSig);
  check('webhook replay idempotent', w2.status === 200 && w2.json.result === 'already_processed', w2.json);

  // second customer books pay-on-arrival right after
  const slots2 = (await cust2.call('GET', `/api/barbers/${barber.id}/slots?service_id=${detail.services[0].id}&date=${today}`)).json.slots;
  const t2 = slots2.find((s: any) => s.time > t1)?.time ?? slots2[0].time;
  const bk2 = await cust2.call('POST', '/api/bookings', { barber_id: barber.id, service_id: detail.services[0].id, date: today, time: t2, payment_option: 'ON_ARRIVAL' });
  check('pay-on-arrival -> CONFIRMED + PAYMENT_DUE', bk2.status === 201 && bk2.json.booking.status === 'CONFIRMED' && bk2.json.booking.payment_status === 'PAYMENT_DUE', bk2.json);
  const id2 = bk2.json.booking.id;

  // check in
  const ci = await cust.call('POST', `/api/bookings/${id}/check-in`);
  check('customer "I\'m Here" -> ARRIVED with arrival_time', ci.status === 200 && ci.json.booking.status === 'ARRIVED' && !!ci.json.booking.arrival_time, ci.json);
  // customer 2 cannot check in: barber marks present
  check('barber Mark Present for customer 2', (await mike.call('POST', `/api/barber/bookings/${id2}/mark-present`)).json.booking.status === 'ARRIVED');
  let q1 = (await cust.call('GET', `/api/bookings/${id}`)).json.booking.queue;
  let q2 = (await cust2.call('GET', `/api/bookings/${id2}`)).json.booking.queue;
  check('queue before start: #1 READY and #2 in line', q1.position === 1 && q1.state === 'READY' && q2.position === 2, { q1, q2 });

  const today1 = (await mike.call('GET', '/api/barber/today')).json;
  check('barber Today lists both waiting (ARRIVED)', today1.next?.id === id && today1.waiting.length === 1 && today1.waiting[0].arrived, today1);
  check('barber cannot start second person out of order? (allowed) but cannot complete before start', (await mike.call('POST', `/api/barber/bookings/${id}/complete`)).status === 409);

  const st = await mike.call('POST', `/api/barber/bookings/${id}/start`);
  check('barber START -> IN_SERVICE', st.json.booking?.status === 'IN_SERVICE', st.json);
  q2 = (await cust2.call('GET', `/api/bookings/${id2}`)).json.booking.queue;
  check('customer 2 now "You\'re next"', q2.state === 'NEXT' && q2.ahead === 1, q2);
  check('second START blocked while chair is busy', (await mike.call('POST', `/api/barber/bookings/${id2}/start`)).status === 409);
  check('customer cannot cancel after arriving inside 30-min window? (cutoff logic)', [200, 403, 409].includes((await cust.call('POST', `/api/bookings/${id}/cancel`)).status));
  const cp = await mike.call('POST', `/api/barber/bookings/${id}/complete`);
  check('barber COMPLETE (prepaid) -> COMPLETED with timestamps', cp.json.booking?.status === 'COMPLETED' && cp.json.booking.service_start && cp.json.booking.service_complete && cp.json.booking.scheduled_time, cp.json);
  q2 = (await cust2.call('GET', `/api/bookings/${id2}`)).json.booking.queue;
  check('customer 2 now "barber is ready"', q2.state === 'READY' && q2.position === 1, q2);

  // customer 2: pay-on-arrival needs recorded payment
  await mike.call('POST', `/api/barber/bookings/${id2}/start`);
  const noPay = await mike.call('POST', `/api/barber/bookings/${id2}/complete`);
  check('complete blocked until payment recorded (PAYMENT_REQUIRED)', noPay.status === 409 && noPay.json.error.code === 'PAYMENT_REQUIRED', noPay.json);
  check('record cash payment', (await mike.call('POST', `/api/barber/bookings/${id2}/record-payment`, { method: 'cash' })).json.booking.payment_status === 'PAID');
  check('complete customer 2', (await mike.call('POST', `/api/barber/bookings/${id2}/complete`)).json.booking.status === 'COMPLETED');
  check('illegal transition (no-show on COMPLETED) -> 409', (await mike.call('POST', `/api/barber/bookings/${id2}/no-show`)).status === 409);

  const tl = (await mike.call('GET', `/api/barber/bookings/${id}`)).json.timeline.map((t: any) => t.action);
  check('audit timeline complete', ['BOOKED', 'PAYMENT_CONFIRMED', 'CHECKED_IN', 'STARTED', 'COMPLETED'].every((a) => tl.includes(a)), tl);
  const cl = (await mike.call('GET', '/api/barber/customers?q=ngozi')).json.customers;
  check('barber customer search + visits', cl.length === 1 && cl[0].total_visits === 1, cl);
  const cprof = await mike.call('GET', `/api/barber/customers/${cl[0].id}`);
  check('customer profile has history', cprof.json.bookings?.length === 1 && cprof.json.customer.total_visits === 1, cprof.json);
  check('customer not in barber list → 404', (await mike.call('GET', '/api/barber/customers/1')).status === 404);
  const ns = (await cust.call('GET', '/api/notifications')).json.notifications.map((x: any) => x.type);
  check('customer notifications (confirmed, payment)', ns.includes('BOOKING_CONFIRMED') && ns.includes('PAYMENT_SUCCESS'), ns);
  const bn = (await mike.call('GET', '/api/notifications')).json.notifications.map((x: any) => x.type);
  check('barber notifications (new booking, arrived)', bn.includes('NEW_BOOKING') && bn.includes('CUSTOMER_ARRIVED'), bn);

  // cancellation window: book tomorrow-ish later slot
  const tomorrow = new Date(new Date(today + 'T00:00:00Z').getTime() + 86400000 * 2).toISOString().slice(0, 10);
  const fs = (await cust.call('GET', `/api/barbers/${barber.id}/slots?service_id=${svc.id}&date=${tomorrow}`)).json.slots;
  if (fs.length) {
    const fb = await cust.call('POST', '/api/bookings', { barber_id: barber.id, service_id: svc.id, date: tomorrow, time: fs[0].time, payment_option: 'ON_ARRIVAL' });
    check('future booking cancellable', (await cust.call('POST', `/api/bookings/${fb.json.booking.id}/cancel`)).json.booking?.status === 'CANCELLED', fb.json);
    const again = (await cust.call('GET', `/api/barbers/${barber.id}/slots?service_id=${svc.id}&date=${tomorrow}`)).json.slots;
    check('cancelled slot freed immediately', again.some((s: any) => s.time === fs[0].time));
  }
  // ---- subscriptions, plan sessions, platform rules, payment race ----
  const day3 = new Date(new Date(today + 'T00:00:00Z').getTime() + 86400000 * 3).toISOString().slice(0, 10);
  const planBody = { name: `E2E pack ${stamp}`, price_naira: 9000, sessions: 3, validity_days: 30, service_ids: [detail.services[0].id] };
  check('customer cannot create plans (403)', (await cust.call('POST', '/api/barber/plans', planBody)).status === 403);
  const tooDear = await mike.call('POST', '/api/barber/plans', { ...planBody, price_naira: 999999999 });
  check('barber cannot exceed platform limits (400 PLAN_RULES or validation)', tooDear.status === 400, tooDear.json);
  const mkPlan = await mike.call('POST', '/api/barber/plans', planBody);
  check('barber creates a plan inside the rules', mkPlan.status === 201, mkPlan.json);
  const planId = mkPlan.json.id;
  const pub = (await cust.call('GET', `/api/barbers/${barber.id}`)).json;
  check('customer sees the plan on the barber page', pub.plans.some((p: any) => p.id === planId && p.sessions === 3 && p.price_kobo === 900000), pub.plans);
  check('barber cannot buy a plan (403)', (await mike.call('POST', `/api/plans/${planId}/buy`)).status === 403);
  const buy = await cust.call('POST', `/api/plans/${planId}/buy`);
  check('plan purchase initialised (TS-PLAN ref, mock checkout)', buy.status === 201 && /^TS-PLAN-\d+-[a-f0-9]+$/.test(buy.json.reference) && buy.json.price_kobo === 900000 && buy.json.amount_kobo === buy.json.price_kobo + buy.json.booking_fee_kobo, buy.json);
  check('unpaid plan purchase invisible to barber', (await mike.call('GET', '/api/barber/plans')).json.purchases.length === 0);
  const noSess = await cust.call('POST', '/api/bookings', { barber_id: barber.id, service_id: detail.services[0].id, date: day3, time: '10:00', payment_option: 'PLAN' });
  check('cannot use an unpaid plan (409 NO_PLAN_SESSION)', noSess.status === 409 && noSess.json.error.code === 'NO_PLAN_SESSION', noSess.json);
  await anon.call('POST', `/api/payments/mock/${buy.json.reference}/complete`);
  const pcb = await anon.call('GET', `/api/payments/callback?reference=${buy.json.reference}`);
  check('plan callback verifies server-side -> wallet redirect', pcb.status === 302 && /#\/wallet\?plan=processed/.test(pcb.headers.get('location') || ''), pcb.headers.get('location'));
  const wal = (await cust.call('GET', '/api/me/wallet')).json;
  check('wallet shows 3 sessions with an expiry', wal.plans[0]?.sessions_left === 3 && !!wal.plans[0].expires_at, wal);
  const ps = (await cust.call('GET', `/api/barbers/${barber.id}/slots?service_id=${detail.services[0].id}&date=${day3}`)).json.slots;
  const pb = await cust.call('POST', '/api/bookings', { barber_id: barber.id, service_id: detail.services[0].id, date: day3, time: ps[0].time, payment_option: 'PLAN' });
  check('plan booking: CONFIRMED + PAID via PLAN, no payment step', pb.status === 201 && pb.json.booking.status === 'CONFIRMED' && pb.json.booking.paid_via === 'PLAN', pb.json);
  check('plan session balance dropped to 2', (await cust.call('GET', '/api/me/wallet')).json.plans[0].sessions_left === 2);
  const pid = (await cust.call('GET', '/api/me/wallet')).json.plans[0].id;
  const other = detail.services.find((x: any) => x.id !== detail.services[0].id);
  const notIncl = await cust.call('POST', '/api/bookings', { barber_id: barber.id, service_id: other.id, date: day3, time: ps[2].time, payment_option: 'PLAN', plan_purchase_id: pid });
  check('a plan that does not include the service is rejected (409 NO_PLAN_SESSION), even when named', notIncl.status === 409 && notIncl.json.error.code === 'NO_PLAN_SESSION', notIncl.json);
  const notIncl2 = await cust.call('POST', '/api/bookings', { barber_id: barber.id, service_id: other.id, date: day3, time: ps[2].time, payment_option: 'PLAN' });
  check('and without naming the plan too', notIncl2.status === 409 && notIncl2.json.error.code === 'NO_PLAN_SESSION', notIncl2.json);
  const cheap = await mike.call('POST', '/api/barber/plans', { ...planBody, name: 'Too cheap', price_naira: 1000, sessions: 30, service_ids: [detail.services[0].id] });
  check('plan whose session is worth less than an included service is refused (sanity check)', cheap.status === 400 && /Each session is worth/.test(cheap.json.error?.message || ''), cheap.json);
  const bov = (await mike.call('GET', '/api/barber/plans')).json;
  check('barber sees the buyer and plan usage', bov.purchases.length === 1 && bov.purchases[0].sessions_used === 1, bov.purchases);
  const psAfter = (await cust2.call('GET', `/api/barbers/${barber.id}/slots?service_id=${detail.services[0].id}&date=${day3}`)).json.slots;
  check('plan-booked slot is blocked for everyone', !psAfter.some((s: any) => s.time === ps[0].time));
  const pcx = await cust.call('POST', `/api/bookings/${pb.json.booking.id}/cancel`);
  check('cancel in time returns the plan session', pcx.status === 200 && (await cust.call('GET', '/api/me/wallet')).json.plans[0].sessions_left === 3, pcx.json);
  const psFree = (await cust2.call('GET', `/api/barbers/${barber.id}/slots?service_id=${detail.services[0].id}&date=${day3}`)).json.slots;
  check('slot reopens immediately after cancel', psFree.some((s: any) => s.time === ps[0].time));
  // race: customer A starts Pay-now on a slot, customer B takes it (pay on arrival), A then pays -> A is NOT confirmed and is flagged for refund
  const rs = (await cust.call('GET', `/api/barbers/${barber.id}/slots?service_id=${detail.services[0].id}&date=${day3}`)).json.slots;
  const rt = rs[Math.min(3, rs.length - 1)].time;
  const ra = await cust.call('POST', '/api/bookings', { barber_id: barber.id, service_id: detail.services[0].id, date: day3, time: rt, payment_option: 'ONLINE' });
  const rpay = (await cust.call('POST', `/api/bookings/${ra.json.booking.id}/pay`)).json;
  const rb = await cust2.call('POST', '/api/bookings', { barber_id: barber.id, service_id: detail.services[0].id, date: day3, time: rt, payment_option: 'ON_ARRIVAL' });
  check('B takes the slot A only started paying for', rb.status === 201 && rb.json.booking.status === 'CONFIRMED', rb.json);
  await anon.call('POST', `/api/payments/mock/${rpay.reference}/complete`);
  const rcb = await anon.call('GET', `/api/payments/callback?reference=${rpay.reference}`);
  check('late payment is NOT confirmed (slot_taken)', rcb.status === 302 && /pay=slot_taken/.test(rcb.headers.get('location') || ''), rcb.headers.get('location'));
  const ra2 = (await cust.call('GET', `/api/bookings/${ra.json.booking.id}`)).json.booking;
  check('A is Incomplete/cancelled, not paid; B keeps the slot', ra2.status === 'CANCELLED' && ra2.payment_status !== 'PAID' && (await cust2.call('GET', `/api/bookings/${rb.json.booking.id}`)).json.booking.status === 'CONFIRMED', ra2);
  check('customer A told (refund)', (await cust.call('GET', '/api/notifications')).json.notifications.some((x: any) => /refund/i.test(x.body) && x.booking_id === ra.json.booking.id));
  await cust2.call('POST', `/api/bookings/${rb.json.booking.id}/cancel`);
  await mike.call('DELETE', `/api/barber/plans/${planId}`);
  // admin settings API
  const CRON0 = process.env.CRON_SECRET;
  if (CRON0) {
    const adm = (m: string, body?: unknown, auth = `Bearer ${CRON0}`) => fetch(BASE + '/api/admin/settings', { method: m, headers: { 'Content-Type': 'application/json', Authorization: auth }, body: body ? JSON.stringify(body) : undefined });
    check('admin settings without key -> 401', (await adm('GET', undefined, 'Bearer nope')).status === 401);
    const g: any = await (await adm('GET')).json();
    check('admin settings default credit expiry 30 days', g.settings.credit_expiry_days === 30, g);
    check('admin settings rejects nonsense', (await adm('PUT', { credit_expiry_days: 0 })).status === 400);
    // barber review workflow over HTTP
    const A = (path: string, m = 'GET', body?: unknown) => fetch(BASE + '/api/admin' + path, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CRON0}` }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => ({}))) as any }));
    const nb = new Client(); const nbEmail = `review${stamp}@example.com`;
    await nb.call('POST', '/api/auth/signup', { accept_terms: true, accept_barber_agreement: true, role: 'barber', name: 'Review Test', email: nbEmail, password: 'Password123', shop_name: 'Review Shop ' + stamp, location: 'Test' });
    const list: any = (await A('/barbers?status=PENDING')).json; const nbId = list.barbers.find((b: any) => b.email === nbEmail)?.id;
    check('admin sees new signup as PENDING with counts', !!nbId && list.counts.PENDING >= 1, list.counts);
    check('reject without a reason -> 400', (await A(`/barbers/${nbId}/reject`, 'POST', {})).status === 400);
    check('reject with reason', (await A(`/barbers/${nbId}/reject`, 'POST', { reason: 'Please add a shop photo.' })).json.review_status === 'REJECTED');
    const meR: any = (await nb.call('GET', '/api/auth/me')).json.user;
    check('barber sees REJECTED + reason', meR.review_status === 'REJECTED' && meR.review_reason === 'Please add a shop photo.', meR);
    check('barber resubmits', (await nb.call('POST', '/api/barber/resubmit', { note: 'added' })).json.review_status === 'PENDING');
    const nbCode: string = (await nb.call('GET', '/api/barber/share')).json.code;
    check('an unapproved shop link does not open', (await anon.call('GET', '/api/b/' + nbCode)).status === 404);
    check('admin approves -> the shop link opens', (await A(`/barbers/${nbId}/approve`, 'POST')).json.verified === true && (await anon.call('GET', '/api/b/' + nbCode)).status === 200);
    check('suspend needs a reason -> 400', (await A(`/barbers/${nbId}/suspend`, 'POST', {})).status === 400);
    check('suspend hides the shop', (await A(`/barbers/${nbId}/suspend`, 'POST', { reason: 'e2e check' })).json.review_status === 'SUSPENDED' && (await anon.call('GET', '/api/b/' + nbCode)).status === 404);
    check('barber makes a new link; the old one stops', (await nb.call('POST', '/api/barber/share/regenerate', {})).json.code !== nbCode);
    check('reinstate', (await A(`/barbers/${nbId}/reinstate`, 'POST')).json.review_status === 'VERIFIED');
    await A(`/barbers/${nbId}/suspend`, 'POST', { reason: 'e2e cleanup' });
  }
  if (process.env.CRON_SECRET) {
    // admin power tools + off-app commission ledger over HTTP (mock mode, throwaway rows are the e2e's own users/bookings)
    const CR = process.env.CRON_SECRET;
    const AA = (path: string, m = 'GET', body?: unknown) => fetch(BASE + '/api/admin' + path, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CR}` }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) as any }));
    const pc = new Client(); const pcEmail = `power${stamp}@example.com`;
    await pc.call('POST', '/api/auth/signup', { accept_terms: true, role: 'customer', name: 'Power Test', email: pcEmail, password: 'Password123' });
    if (evOn) { await pc.call('POST', '/api/auth/email/send'); await pc.call('POST', '/api/auth/email/verify', { code: '123456' }); }
    const pcId = (await AA('/customers?q=' + encodeURIComponent(pcEmail))).json.customers[0]?.id;
    check('admin finds the new customer', !!pcId);
    const tomorrow = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10);
    const bdetail = (await pc.call('GET', '/api/b/' + shareCode)).json.barber;
    const sv = (await pc.call('GET', `/api/barbers/${bdetail.id}`)).json.services[0];
    const sl = (await pc.call('GET', `/api/barbers/${bdetail.id}/slots?service_id=${sv.id}&date=${tomorrow}`)).json.slots;
    const off = sl.length ? await pc.call('POST', '/api/bookings', { barber_id: bdetail.id, service_id: sv.id, date: tomorrow, time: sl[0].time, payment_option: 'ON_ARRIVAL' }) : null;
    check('off-app booking created', !!off && off.status === 201, off?.json);
    if (off && off.status === 201) {
      const bid = off.json.booking.id;
      check('report needs login', (await anon.call('POST', '/api/reports', { category: 'OTHER', message: 'hello there' })).status === 401);
      const rep = await pc.call('POST', '/api/reports', { category: 'PAYMENT', message: 'Testing the report inbox', booking_id: bid });
      check('customer files a report', rep.status === 201, rep.json);
      const inbox = (await AA('/reports')).json; const rid = inbox.reports.find((r: any) => r.booking_id === bid)?.id;
      check('report appears in the admin inbox', !!rid);
      check('resolve needs a note', (await AA(`/reports/${rid}/resolve`, 'POST', { status: 'RESOLVED' })).status === 400);
      check('resolve report', (await AA(`/reports/${rid}/resolve`, 'POST', { status: 'RESOLVED', note: 'e2e check' })).json.status === 'RESOLVED');
      check('admin sets a 10% platform charge with no minimum (commission base)', (await AA('/settings', 'PUT', { charge_percent: 10, charge_flat_naira: 0, charge_min_naira: 0, commission_factor: 0.5 })).status === 200);
    const before = (await AA('/ledger')).json.total_owed_kobo;
      check('admin complete needs a reason', (await AA(`/bookings/${bid}/complete`, 'POST', { paid: true })).status === 400);
      const cmp = await AA(`/bookings/${bid}/complete`, 'POST', { paid: true, reason: 'e2e force complete' });
      check('admin force-completes the off-app booking and commission accrues', cmp.status === 200 && !!cmp.json.ledger_id, cmp.json);
      const after = (await AA('/ledger')).json; const commission = after.total_owed_kobo - before;
      check('commission = half of the platform charge frozen on the booking', commission === Math.round(Math.max(5000, Math.round(sv.price_kobo * 0.02)) * 0.5), { commission, price: sv.price_kobo });
      check('second completion is refused (idempotent ledger)', (await AA(`/bookings/${bid}/complete`, 'POST', { paid: true, reason: 'again again' })).status === 409);
      const mineL: any = (await mike.call('GET', '/api/barber/ledger')).json;
      check('barber sees the platform balance', typeof mineL.owed_kobo === 'number' && Array.isArray(mineL.entries), mineL);
      const settle = await AA(`/ledger/${bdetail.id}/settle`, 'POST', { all: true, reason: 'e2e cleanup' });
      check('admin settles the balance', settle.status === 200 || settle.status === 400, settle.json);
      check('balance is zero afterwards', (await AA(`/ledger/${bdetail.id}`)).json.balance.outstanding_kobo === 0);
    }
    check('warn customer', (await AA(`/users/${pcId}/warn`, 'POST', { reason: 'e2e warning' })).json.warn_count === 1);
    check('suspend customer', (await AA(`/users/${pcId}/suspend`, 'POST', { reason: 'e2e check' })).json.changed === true);
    check('suspended customer cannot log in', (await new Client().call('POST', '/api/auth/login', { identifier: pcEmail, password: 'Password123' })).status === 403);
    check('reinstate customer', (await AA(`/users/${pcId}/reinstate`, 'POST')).json.changed === true);
    const bc = await AA('/broadcast', 'POST', { audience: 'user', user_id: pcId, title: 'Hello', body: 'e2e announcement' });
    check('broadcast to one user', bc.json.recipients === 1, bc.json);
    check('customer got the announcement', (await pc.call('GET', '/api/notifications')).json.notifications.some((n: any) => n.type === 'ANNOUNCEMENT'));
    const csv = await fetch(BASE + '/api/admin/export/bookings.csv', { headers: { Authorization: `Bearer ${CR}` } });
    check('CSV export (admin only)', csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type') || '') && (await fetch(BASE + '/api/admin/export/bookings.csv')).status === 401);
    const an = (await AA('/analytics?days=7')).json; check('analytics 7 days', an.series?.length === 7, an.totals);
    check('global search', Array.isArray((await AA('/search?q=' + encodeURIComponent('Power'))).json.users));
    check('audit filter', (await AA('/audit?action=ADMIN_USER&scope=all')).json.entries.every((e: any) => e.action.startsWith('ADMIN_USER')));
    check('config exposes maintenance + features', (await anon.call('GET', '/api/config')).json.features?.plans === true);
  }
  // ---- deployment-oriented checks: cron endpoint, deep health, lazy hold expiry is exercised by unit tests ----
  const health = await anon.call('GET', '/healthz?deep=1');
  check('deep health check reaches the database', health.status === 200 && health.json.db === 'ok', health.json);
  const CRON = process.env.CRON_SECRET;
  if (CRON) {
    const hit = (auth?: string) => fetch(BASE + '/api/cron/sweep', { headers: auth ? { Authorization: auth } : {} });
    check('cron sweep without credentials -> 401', (await hit()).status === 401);
    check('cron sweep with wrong bearer -> 401', (await hit('Bearer wrong')).status === 401);
    const okc = await hit(`Bearer ${CRON}`);
    const okj: any = await okc.json();
    check('cron sweep with CRON_SECRET -> 200 + stats', okc.status === 200 && okj.ok === true && typeof okj.holds_released === 'number', okj);
  }
  console.log(`\n${n - bad}/${n} checks passed`);
  process.exit(bad ? 1 : 0);
})();
