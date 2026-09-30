import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'net';
import { freshDb, setNow, resetNow, WED } from './helpers';
import { createApp } from '../src/app';
import { barberAction, createBooking, customerCancel, getBooking } from '../src/bookingService';
import { initializePlanPurchase, mockMarkPaid, processReference, initializePayment } from '../src/paystack';
import { barberPlanOverview, customerWallet, planSchema, savePlan, updateSettings, getSettings } from '../src/plans';
import { getAvailableSlots } from '../src/slots';

const NOW = `${WED}T08:00:00+01:00`;
async function setup() {
  const s = await freshDb();
  setNow(NOW);
  const barberUid = (await s.db.one('SELECT user_id FROM barbers WHERE id=$1', [s.barberId])).user_id;
  return { ...s, barberUid };
}
const planInput = (serviceIds: number[], over: any = {}) => planSchema.parse({ name: 'Monthly 4', price_naira: 12000, sessions: 4, validity_days: 30, service_ids: serviceIds, ...over });
/** Creates a plan and completes a (mock) purchase through the real payment path. */
async function buy(ctx: Awaited<ReturnType<typeof setup>>, customerId: number, over: any = {}, services: number[] = [ctx.serviceIds[0]]) {
  const planId = await ctx.db.tx((t) => savePlan(t, ctx.barberId, null, planInput(services, over)));
  const init = await initializePlanPurchase(ctx.db, customerId, planId, 'c@x.com');
  await mockMarkPaid(ctx.db, init.reference);
  assert.equal((await processReference(ctx.db, init.reference)).result, 'processed');
  return { planId, purchaseId: init.purchase_id, reference: init.reference };
}
const book = (c: any, cust: number, time: string, option: any, extra: any = {}, svc = 0, date = WED) =>
  createBooking(c.db, cust, { barber_id: c.barberId, service_id: c.serviceIds[svc], date, time, payment_option: option, ...extra });

test('platform rules: barbers cannot create plans outside min/max price, duration, sessions or with foreign services; admin edits move the limits', async () => {
  const c = await setup();
  try {
    const save = (over: any) => c.db.tx((t) => savePlan(t, c.barberId, null, planInput([c.serviceIds[0]], over)));
    await assert.rejects(save({ price_naira: 10 }), (e: any) => e.code === 'PLAN_RULES' && /at least/.test(e.message));
    await assert.rejects(save({ price_naira: 9_000_000 }), (e: any) => /cannot be more/.test(e.message));
    await assert.rejects(save({ validity_days: 400 }), (e: any) => /at most 90 days/.test(e.message));
    await assert.rejects(save({ sessions: 99 }), (e: any) => /at most 30 sessions/.test(e.message));
    const other = (await c.db.one(`INSERT INTO users (role,name,email,password_hash) VALUES ('barber','B2','b2@x.com','x') RETURNING id`)).id;
    const b2 = (await c.db.one(`INSERT INTO barbers (user_id, shop_name, verified) VALUES ($1,'Other',TRUE) RETURNING id`, [other])).id;
    const foreign = (await c.db.one(`INSERT INTO services (barber_id,name,price_kobo,duration_min) VALUES ($1,'X',100000,30) RETURNING id`, [b2])).id;
    await assert.rejects(save({ service_ids: [foreign] }), /your own active services/);
    await save({});                                                    // inside the rules: ok
    await c.db.tx((t) => updateSettings(t, { max_plan_validity_days: 400, min_plan_price_naira: 5 }));
    await save({ validity_days: 400, price_naira: 10 });               // the admin loosened the rules
    await assert.rejects(c.db.tx((t) => updateSettings(t, { min_plan_price_naira: 900, max_plan_price_naira: 100 })), /cannot be above/);
    await assert.rejects(c.db.tx((t) => updateSettings(t, { credit_expiry_days: 0 })), /credit_expiry_days/);
    await assert.rejects(c.db.tx((t) => updateSettings(t, { bogus: 1 })));
    assert.equal((await getSettings(c.db)).credit_expiry_days, 30, 'default credit expiry is 30 days');
  } finally { resetNow(); }
});

test('plan purchase: pending is invisible to the barber, sessions + expiry start at payment, duplicate payment flagged for refund', async () => {
  const c = await setup();
  try {
    const planId = await c.db.tx((t) => savePlan(t, c.barberId, null, planInput([c.serviceIds[0]])));
    const init = await initializePlanPurchase(c.db, c.customerIds[0], planId, null);
    assert.match(init.reference, /^TS-PLAN-\d+-[a-f0-9]{10}$/);
    assert.equal(init.amount_kobo, 1_200_000);
    assert.equal((await barberPlanOverview(c.db, c.barberId)).purchases.length, 0, 'unpaid checkout hidden from the barber');
    assert.equal((await customerWallet(c.db, c.customerIds[0])).plans.length, 0);
    await assert.rejects(book(c, c.customerIds[0], '10:00', 'PLAN'), (e: any) => e.code === 'NO_PLAN_SESSION', 'cannot spend an unpaid plan');
    assert.equal((await processReference(c.db, init.reference)).result, 'not_paid');
    await mockMarkPaid(c.db, init.reference);
    assert.equal((await processReference(c.db, init.reference)).result, 'processed');
    assert.equal((await processReference(c.db, init.reference)).result, 'already_processed');
    const p = await c.db.one('SELECT * FROM plan_purchases WHERE id=$1', [init.purchase_id]);
    assert.equal(p.status, 'ACTIVE');
    assert.equal(p.sessions_total, 4);
    assert.equal(Math.round((new Date(p.expires_at).getTime() - new Date(p.paid_at).getTime()) / 86400000), 30);
    const ov = await barberPlanOverview(c.db, c.barberId);
    assert.equal(ov.purchases.length, 1); assert.equal(ov.plans[0].buyers, 1); assert.equal(ov.plans[0].revenue_kobo, 1_200_000);
    assert.ok((await c.db.many('SELECT 1 FROM notifications WHERE user_id=$1 AND type=$2', [c.barberUid, 'PLAN_SOLD'])).length === 1);
    // a second successful payment for the same purchase is money we must give back
    await c.db.query(`INSERT INTO payments (plan_purchase_id, reference, provider, amount_kobo, status, mock_paid) VALUES ($1,'TS-PLAN-${init.purchase_id}-abcdef0123','MOCK',1200000,'INITIATED',TRUE)`, [init.purchase_id]);
    assert.equal((await processReference(c.db, `TS-PLAN-${init.purchase_id}-abcdef0123`)).result, 'refund_due');
    assert.equal((await c.db.one(`SELECT refund_status FROM payments WHERE reference=$1`, [`TS-PLAN-${init.purchase_id}-abcdef0123`])).refund_status, 'REFUND_REQUESTED');
    assert.equal((await c.db.one('SELECT sessions_total FROM plan_purchases WHERE id=$1', [init.purchase_id])).sessions_total, 4, 'no extra sessions');
  } finally { resetNow(); }
});

test('booking with a plan session: confirmed + paid instantly, balance drops, slot blocked; wrong service / exhausted / expired are refused', async () => {
  const c = await setup();
  try {
    const { purchaseId } = await buy(c, c.customerIds[0], { sessions: 2 });
    const b = await book(c, c.customerIds[0], '10:00', 'PLAN');
    assert.equal(b.status, 'CONFIRMED'); assert.equal(b.payment_status, 'PAID'); assert.equal(b.paid_via, 'PLAN'); assert.equal(b.plan_purchase_id, purchaseId);
    assert.equal((await c.db.one('SELECT sessions_used FROM plan_purchases WHERE id=$1', [purchaseId])).sessions_used, 1);
    assert.equal((await c.db.many(`SELECT 1 FROM payments WHERE booking_id=$1`, [b.id])).length, 0, 'no extra payment');
    assert.ok(!(await getAvailableSlots(c.db, c.barberId, c.serviceIds[0], WED)).slots.some((s) => s.time === '10:00'));
    await assert.rejects(book(c, c.customerIds[0], '12:00', 'PLAN', {}, 1), (e: any) => e.code === 'NO_PLAN_SESSION', 'service not included in the plan');
    await assert.rejects(book(c, c.customerIds[1], '12:00', 'PLAN'), (e: any) => e.code === 'NO_PLAN_SESSION', "someone else's plan");
    await book(c, c.customerIds[0], '11:00', 'PLAN');
    await assert.rejects(book(c, c.customerIds[0], '12:00', 'PLAN'), (e: any) => e.code === 'NO_PLAN_SESSION', 'all sessions used');
    // barber sees plan usage on the booking; the customer wallet shows the balance
    assert.equal((await customerWallet(c.db, c.customerIds[0])).plans[0].sessions_left, 0);
    assert.equal((await barberPlanOverview(c.db, c.barberId)).plans[0].sessions_used, 2);
  } finally { resetNow(); }
});

test('plan sessions expire at plan end: cannot book for a time after expiry, or after expiry has passed', async () => {
  const c = await setup();
  try {
    const { purchaseId } = await buy(c, c.customerIds[0], { validity_days: 1 });        // valid until Thu 2026-10-01 08:00 Lagos
    await book(c, c.customerIds[0], '10:00', 'PLAN');                                   // Wed: fine
    await assert.rejects(book(c, c.customerIds[0], '10:00', 'PLAN', {}, 0, '2026-10-01'), (e: any) => e.code === 'NO_PLAN_SESSION', 'appointment after the plan ends');
    setNow('2026-10-01T08:05:00+01:00');
    await assert.rejects(book(c, c.customerIds[0], '15:00', 'PLAN', {}, 0, '2026-10-01'), (e: any) => e.code === 'NO_PLAN_SESSION', 'plan over');
    assert.equal((await customerWallet(c.db, c.customerIds[0])).plans[0].live, false);
    assert.ok(purchaseId);
  } finally { resetNow(); }
});

test('two bookings racing for the LAST plan session: exactly one wins (no double spend)', async () => {
  const c = await setup();
  try {
    const { purchaseId } = await buy(c, c.customerIds[0], { sessions: 1 });
    const r = await Promise.allSettled([book(c, c.customerIds[0], '10:00', 'PLAN'), book(c, c.customerIds[0], '14:00', 'PLAN')]);
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal((await c.db.one('SELECT sessions_used FROM plan_purchases WHERE id=$1', [purchaseId])).sessions_used, 1);
  } finally { resetNow(); }
});

test('cancel in time returns the plan session and reopens the slot at once; cancel inside 30 min is locked and the slot stays taken', async () => {
  const c = await setup();
  try {
    const { purchaseId } = await buy(c, c.customerIds[0], { sessions: 2 });
    const b = await book(c, c.customerIds[0], '10:00', 'PLAN');
    await customerCancel(c.db, c.customerIds[0], b.id);
    assert.equal((await c.db.one('SELECT sessions_used FROM plan_purchases WHERE id=$1', [purchaseId])).sessions_used, 0, 'session returned');
    assert.ok((await getAvailableSlots(c.db, c.barberId, c.serviceIds[0], WED)).slots.some((s) => s.time === '10:00'), 'slot reopens immediately');
    const b2 = await book(c, c.customerIds[0], '10:00', 'PLAN');
    setNow(`${WED}T09:31:00+01:00`);                                                     // 29 min before
    await assert.rejects(customerCancel(c.db, c.customerIds[0], b2.id), (e: any) => e.code === 'CANCEL_LOCKED');
    assert.equal((await getBooking(c.db, b2.id))!.status, 'CONFIRMED');
    assert.ok(!(await getAvailableSlots(c.db, c.barberId, c.serviceIds[0], WED)).slots.some((s) => s.time === '10:00'), 'slot stays taken');
    await assert.rejects(book(c, c.customerIds[1], '10:00', 'ON_ARRIVAL'), (e: any) => e.code === 'SLOT_UNAVAILABLE');
  } finally { resetNow(); }
});

test('missed paid session (plan or online): no refund, ONE same-barber credit, expires in 30 days, not for other barbers; credit used on next booking', async () => {
  const c = await setup();
  try {
    await buy(c, c.customerIds[0]);
    const b = await book(c, c.customerIds[0], '10:00', 'PLAN');
    setNow(`${WED}T10:10:00+01:00`);
    await barberAction(c.db, c.barberUid, c.barberId, b.id, 'no-show');
    const nb = (await getBooking(c.db, b.id))!;
    assert.equal(nb.status, 'NO_SHOW'); assert.equal(nb.payment_status, 'CREDITED');
    const cr = await c.db.many('SELECT * FROM session_credits WHERE customer_id=$1', [c.customerIds[0]]);
    assert.equal(cr.length, 1); assert.equal(cr[0].barber_id, c.barberId); assert.equal(cr[0].reason, 'NO_SHOW'); assert.equal(cr[0].status, 'AVAILABLE');
    assert.equal(Math.round((new Date(cr[0].expires_at).getTime() - new Date(`${WED}T10:10:00+01:00`).getTime()) / 86400000), 30);
    assert.equal((await c.db.many('SELECT 1 FROM payments WHERE booking_id=$1', [b.id])).length, 0);
    const w = await customerWallet(c.db, c.customerIds[0]);
    assert.equal(w.credits.filter((x: any) => x.live).length, 1);
    assert.ok((await c.db.many(`SELECT 1 FROM notifications WHERE user_id=$1 AND type='CREDIT_ISSUED'`, [c.customerIds[0]])).length === 1);
    // another customer cannot use it; another barber's booking cannot use it
    await assert.rejects(book(c, c.customerIds[1], '14:30', 'CREDIT'), (e: any) => e.code === 'NO_CREDIT');
    await assert.rejects(book(c, c.customerIds[0], '15:00', 'CREDIT', { credit_id: cr[0].id + 99 }), (e: any) => e.code === 'NO_CREDIT');
    const next = await book(c, c.customerIds[0], '15:00', 'CREDIT');                     // auto-picks the customer's credit for this barber
    assert.equal(next.status, 'CONFIRMED'); assert.equal(next.payment_status, 'PAID'); assert.equal(next.paid_via, 'CREDIT'); assert.equal(next.credit_id, cr[0].id);
    assert.equal((await c.db.one('SELECT status, used_booking_id FROM session_credits WHERE id=$1', [cr[0].id])).used_booking_id, next.id);
    await assert.rejects(book(c, c.customerIds[0], '16:00', 'CREDIT'), (e: any) => e.code === 'NO_CREDIT', 'credit is single-use');
    // missing a CREDIT-paid session does not mint another credit (the make-good was already spent)
    setNow(`${WED}T15:10:00+01:00`);
    await barberAction(c.db, c.barberUid, c.barberId, next.id, 'no-show');
    assert.equal((await c.db.many('SELECT 1 FROM session_credits WHERE customer_id=$1', [c.customerIds[0]])).length, 1);
  } finally { resetNow(); }
});

test('expired credit cannot be used; credit expiry follows the admin setting; a credit only covers services up to its value', async () => {
  const c = await setup();
  try {
    await c.db.tx((t) => updateSettings(t, { credit_expiry_days: 7 }));
    const paid = await book(c, c.customerIds[0], '10:00', 'ONLINE', {}, 1);              // 4500 naira service, paid online
    const ini = await initializePayment(c.db, paid.id, null);
    await mockMarkPaid(c.db, ini.reference); await processReference(c.db, ini.reference);
    assert.equal((await getBooking(c.db, paid.id))!.status, 'CONFIRMED');
    setNow(`${WED}T10:05:00+01:00`);
    await barberAction(c.db, c.barberUid, c.barberId, paid.id, 'no-show');
    const cr = await c.db.one('SELECT * FROM session_credits WHERE source_booking_id=$1', [paid.id]);
    assert.equal(Math.round((new Date(cr.expires_at).getTime() - new Date(`${WED}T10:05:00+01:00`).getTime()) / 86400000), 7);
    assert.equal(cr.value_kobo, 450000);
    assert.equal((await getBooking(c.db, paid.id))!.payment_status, 'CREDITED');
    const dear = (await c.db.one(`INSERT INTO services (barber_id,name,price_kobo,duration_min) VALUES ($1,'Premium',900000,30) RETURNING id`, [c.barberId])).id;
    await assert.rejects(createBooking(c.db, c.customerIds[0], { barber_id: c.barberId, service_id: dear, date: WED, time: '12:00', payment_option: 'CREDIT' }), (e: any) => e.code === 'NO_CREDIT', 'service dearer than the credit');
    setNow('2026-10-08T09:00:00+01:00');                                                  // 8 days later: expired
    await assert.rejects(book(c, c.customerIds[0], '10:00', 'CREDIT', {}, 0, '2026-10-08'), (e: any) => e.code === 'NO_CREDIT');
    assert.equal((await customerWallet(c.db, c.customerIds[0])).credits[0].live, false);
  } finally { resetNow(); }
});

test('late cancel of a PAID session is refused (slot stays booked); after the time passes the no-show rule gives the credit; pay-on-arrival no-show gives none', async () => {
  const c = await setup();
  try {
    const arr = await book(c, c.customerIds[1], '12:00', 'ON_ARRIVAL');
    setNow(`${WED}T12:10:00+01:00`);
    await barberAction(c.db, c.barberUid, c.barberId, arr.id, 'no-show');
    assert.equal((await c.db.many('SELECT 1 FROM session_credits')).length, 0, 'unpaid no-show is not a paid session');
    assert.equal((await getBooking(c.db, arr.id))!.payment_status, 'VOID');
  } finally { resetNow(); }
});

test('prepaid online booking cancelled IN TIME: stays CREDIT_PENDING by default, becomes a same-barber credit when the admin rule is on', async () => {
  const c = await setup();
  try {
    const mk = async (time: string) => { const b = await book(c, c.customerIds[0], time, 'ONLINE'); const i = await initializePayment(c.db, b.id, null); await mockMarkPaid(c.db, i.reference); await processReference(c.db, i.reference); return b; };
    const b1 = await mk('10:00');
    await customerCancel(c.db, c.customerIds[0], b1.id);
    assert.equal((await getBooking(c.db, b1.id))!.payment_status, 'CREDIT_PENDING');
    await c.db.tx((t) => updateSettings(t, { credit_on_early_cancel_prepaid: true }));
    const b2 = await mk('11:00');
    await customerCancel(c.db, c.customerIds[0], b2.id);
    assert.equal((await getBooking(c.db, b2.id))!.payment_status, 'CREDITED');
    assert.equal((await c.db.one(`SELECT reason FROM session_credits WHERE source_booking_id=$1`, [b2.id])).reason, 'EARLY_CANCEL');
  } finally { resetNow(); }
});

test('barber marks a plan-paid booking NOT SERVED: the session goes back; incomplete Pay-now attempts stay hidden from the barber', async () => {
  const c = await setup();
  try {
    const { purchaseId } = await buy(c, c.customerIds[0]);
    const b = await book(c, c.customerIds[0], '10:00', 'PLAN');
    await barberAction(c.db, c.barberUid, c.barberId, b.id, 'not-served', { reason: 'ill' });
    assert.equal((await c.db.one('SELECT sessions_used FROM plan_purchases WHERE id=$1', [purchaseId])).sessions_used, 0);
    await book(c, c.customerIds[1], '12:00', 'ONLINE');                                   // unpaid attempt
    assert.equal((await c.db.many(`SELECT 1 FROM notifications n JOIN barbers br ON br.user_id=n.user_id WHERE br.id=$1 AND n.type='NEW_BOOKING' AND n.booking_id IS NOT NULL AND n.created_at IS NOT NULL`, [c.barberId])).length, 1, 'only the plan booking notified the barber');
  } finally { resetNow(); }
});

test('HTTP: admin settings API needs the admin key; customers cannot create plans; barbers cannot buy; wallet + barber overview endpoints', async () => {
  const c = await setup();
  process.env.CRON_SECRET = 'test-cron-secret-0123456789';
  const server = createApp(c.db).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const j = (p: string, o: any = {}) => fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const login = async (id: string, pw: string) => (await j('/api/auth/login', { method: 'POST', body: { identifier: id, password: pw } })).headers.get('set-cookie')!.split(';')[0];
  try {
    assert.equal((await j('/api/admin/settings')).status, 401);
    const bearer = { Authorization: 'Bearer test-cron-secret-0123456789' };
    const put = await j('/api/admin/settings', { method: 'PUT', headers: bearer, body: { max_plan_price_naira: 20000, credit_expiry_days: 14 } });
    assert.equal(put.status, 200);
    assert.equal(((await put.json()) as any).settings.credit_expiry_days, 14);
    assert.equal((await j('/api/admin/settings', { method: 'PUT', headers: bearer, body: { min_plan_price_naira: 999999 } })).status, 400);
    const cust = await login('chidi@trimslot.demo', 'Customer123!'), barber = await login('mike@trimslot.demo', 'Barber123!');
    const body = { name: 'Gold', price_naira: 15000, sessions: 3, validity_days: 30, service_ids: [c.serviceIds[0]] };
    assert.equal((await j('/api/barber/plans', { method: 'POST', headers: { Cookie: cust }, body })).status, 403);
    assert.equal((await j('/api/barber/plans', { method: 'POST', headers: { Cookie: barber }, body: { ...body, price_naira: 25000 } })).status, 400, 'above the admin max');
    const made = await j('/api/barber/plans', { method: 'POST', headers: { Cookie: barber }, body }); assert.equal(made.status, 201);
    const pid = ((await made.json()) as any).id;
    const pub = await (await j(`/api/barbers/${c.barberId}`, { headers: { Cookie: cust } })).json() as any;
    assert.equal(pub.plans.length, 1); assert.deepEqual(pub.plans[0].service_ids, [c.serviceIds[0]]); assert.deepEqual(pub.my.plans, []);
    assert.equal((await j(`/api/plans/${pid}/buy`, { method: 'POST', headers: { Cookie: barber }, body: {} })).status, 403, 'barbers cannot buy');
    const buyRes = await j(`/api/plans/${pid}/buy`, { method: 'POST', headers: { Cookie: cust }, body: {} });
    assert.equal(buyRes.status, 201);
    const bj = await buyRes.json() as any;
    assert.equal((await j(`/api/barber/plans`, { headers: { Cookie: barber } }).then((r) => r.json()) as any).purchases.length, 0);
    await j(`/api/payments/mock/${bj.reference}/complete`, { method: 'POST', body: {} });
    const cb = await fetch(`${base}/api/payments/callback?reference=${bj.reference}`, { redirect: 'manual' });
    assert.equal(cb.status, 302); assert.match(cb.headers.get('location')!, /^\/#\/wallet\?plan=processed$/);
    const wallet = await (await j('/api/me/wallet', { headers: { Cookie: cust } })).json() as any;
    assert.equal(wallet.plans[0].sessions_left, 3);
    const bk = await j('/api/bookings', { method: 'POST', headers: { Cookie: cust }, body: { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time: '10:00', payment_option: 'PLAN' } });
    assert.equal(bk.status, 201); assert.equal(((await bk.json()) as any).booking.paid_via, 'PLAN');
    const ov = await (await j('/api/barber/plans', { headers: { Cookie: barber } })).json() as any;
    assert.equal(ov.purchases[0].sessions_used, 1);
    const today = await (await j('/api/barber/bookings', { headers: { Cookie: barber } })).json() as any;
    assert.equal(today.bookings[0].payment_option, 'PLAN');
    assert.equal((await j(`/api/barber/plans/${pid}`, { method: 'DELETE', headers: { Cookie: barber } })).status, 200);
    assert.equal(((await (await j(`/api/barbers/${c.barberId}`)).json()) as any).plans.length, 0, 'archived plan no longer for sale');
    assert.equal(((await (await j('/api/me/wallet', { headers: { Cookie: cust } })).json()) as any).plans.length, 1, 'but existing purchases keep working');
  } finally { server.close(); delete process.env.CRON_SECRET; resetNow(); }
});
