import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from './httpHelpers';
import { WED, setNow } from './helpers';
import { applyVerifiedPayment, createBooking } from '../src/bookingService';
import { RESCHEDULE_MAX } from '../src/config';
import { initializePlanPurchase, mockMarkPaid, processReference } from '../src/paystack';
import { planSchema, savePlan } from '../src/plans';

test('reschedule: paid booking moves to a free slot; payment/plan state intact; barber notified; old slot freed; availability respected', async () => {
  const c = await bootApp();
  try {
    const cc = await c.chidi();
    const o = await c.call('POST', '/api/bookings', { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time: '10:00', payment_option: 'ONLINE' }, cc);
    const id = o.json.booking.id;
    await c.db.tx((t) => applyVerifiedPayment(t, id, 'PAYSTACK'));
    const before = (await c.call('GET', `/api/bookings/${id}`, undefined, cc)).json.booking;
    assert.equal(before.can_reschedule, true);
    // someone else holds 11:00
    await createBooking(c.db, c.customerIds[1], { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time: '11:00', payment_option: 'ON_ARRIVAL' });
    let r = await c.call('POST', `/api/bookings/${id}/reschedule`, { date: WED, time: '11:00' }, cc);
    assert.equal(r.status, 409); assert.equal(r.json.error.code, 'SLOT_UNAVAILABLE');
    // overlapping its own old time is fine (a 30-min cut moved by 15 min)
    r = await c.call('POST', `/api/bookings/${id}/reschedule`, { date: WED, time: '10:15' }, cc);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.booking.start_time, '10:15');
    // another day
    r = await c.call('POST', `/api/bookings/${id}/reschedule`, { date: '2026-10-01', time: '09:00' }, cc);
    assert.equal(r.status, 200, r.text);
    const b = r.json.booking;
    assert.equal(b.date, '2026-10-01'); assert.equal(b.status, 'CONFIRMED');
    assert.equal(b.payment_status, 'PAID'); assert.equal(b.payment_option, 'ONLINE'); assert.equal(b.price_kobo, before.price_kobo);
    assert.equal(b.money.total_kobo, before.money.total_kobo);
    const row = await c.db.one('SELECT * FROM bookings WHERE id=$1', [id]);
    assert.equal(row.reschedule_count, 2);
    // old slot is free again, barber was told, audit written
    const slots = await c.call('GET', `/api/barbers/${c.barberId}/slots?service_id=${c.serviceIds[0]}&date=${WED}`, undefined, cc);
    assert.ok(slots.json.slots.some((s: any) => s.time === '10:00'));
    const n = await c.db.many(`SELECT body FROM notifications WHERE type='BOOKING_RESCHEDULED'`);
    assert.equal(n.length, 4);                       // barber + customer, twice
    assert.ok(await c.db.maybeOne(`SELECT 1 FROM audit_log WHERE booking_id=$1 AND action='RESCHEDULED'`, [id]));
    // third move hits the limit
    assert.equal(RESCHEDULE_MAX, 3);
    r = await c.call('POST', `/api/bookings/${id}/reschedule`, { date: '2026-10-01', time: '09:30' }, cc); assert.equal(r.status, 200);
    r = await c.call('POST', `/api/bookings/${id}/reschedule`, { date: '2026-10-01', time: '10:00' }, cc);
    assert.equal(r.status, 409); assert.equal(r.json.error.code, 'RESCHEDULE_LIMIT');
  } finally { c.close(); }
});

test('reschedule: not after the cancel cut-off, not for other states, not someone else\'s, not into a closed day/past/too-soon', async () => {
  const c = await bootApp();
  try {
    const cc = await c.chidi();
    const oa = await c.call('POST', '/api/bookings', { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time: '12:00', payment_option: 'ON_ARRIVAL' }, cc);
    const id = oa.json.booking.id;
    assert.equal((await c.call('POST', `/api/bookings/${id}/reschedule`, { date: WED, time: '12:15' }, await c.tunde())).status, 404);
    assert.equal((await c.call('POST', `/api/bookings/${id}/reschedule`, { date: '2026-10-04', time: '10:00' }, cc)).status, 409, 'Sunday: barber off'); // 2026-10-04 is a Sunday
    assert.equal((await c.call('POST', `/api/bookings/${id}/reschedule`, { date: '2026-09-29', time: '10:00' }, cc)).status, 400, 'past');
    assert.equal((await c.call('POST', `/api/bookings/${id}/reschedule`, { date: WED, time: '08:30' }, cc)).json.error.code, 'RESCHEDULE_TOO_SOON');
    // locked: 20 min before the visit
    setNow(`${WED}T11:40:00+01:00`);
    const v = await c.call('GET', `/api/bookings/${id}`, undefined, cc);
    assert.equal(v.json.booking.can_reschedule, false);
    const r = await c.call('POST', `/api/bookings/${id}/reschedule`, { date: WED, time: '15:00' }, cc);
    assert.equal(r.status, 403); assert.equal(r.json.error.code, 'RESCHEDULE_LOCKED');
    // not once cancelled
    setNow(`${WED}T08:00:00+01:00`);
    await c.call('POST', `/api/bookings/${id}/cancel`, {}, cc);
    assert.equal((await c.call('POST', `/api/bookings/${id}/reschedule`, { date: WED, time: '15:00' }, cc)).json.error.code, 'RESCHEDULE_NOT_ALLOWED');
  } finally { c.close(); }
});

test('reschedule: a plan session stays attached and the move cannot pass the plan end', async () => {
  const c = await bootApp();
  try {
    const cc = await c.chidi();
    const cust = c.customerIds[0];
    const planId = await c.db.tx((t) => savePlan(t, c.barberId, null, planSchema.parse({ name: 'Short plan', price_naira: 12000, sessions: 4, validity_days: 3, service_ids: [c.serviceIds[0]] })));
    const init = await initializePlanPurchase(c.db, cust, planId, 'c@x.com');
    await mockMarkPaid(c.db, init.reference);
    assert.equal((await processReference(c.db, init.reference)).result, 'processed');
    const pp = { id: init.purchase_id as number };
    const o = await c.call('POST', '/api/bookings', { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time: '10:00', payment_option: 'PLAN', plan_purchase_id: pp.id }, cc);
    assert.equal(o.status, 201, o.text);
    let r = await c.call('POST', `/api/bookings/${o.json.booking.id}/reschedule`, { date: '2026-10-01', time: '10:00' }, cc);
    assert.equal(r.status, 200, r.text); assert.equal(r.json.booking.plan_purchase_id, pp.id);
    assert.equal((await c.db.one('SELECT sessions_used FROM plan_purchases WHERE id=$1', [pp.id])).sessions_used, 1);
    r = await c.call('POST', `/api/bookings/${o.json.booking.id}/reschedule`, { date: '2026-10-05', time: '10:00' }, cc);
    assert.equal(r.status, 409); assert.equal(r.json.error.code, 'AFTER_PLAN_END');
  } finally { c.close(); }
});
