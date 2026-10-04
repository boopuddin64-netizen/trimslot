import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, setNow, resetNow, WED } from './helpers';
import { canCustomerCancel, createBooking, customerCancel, getBooking, applyVerifiedPayment } from '../src/bookingService';
import { getAvailableSlots } from '../src/slots';

test('canCustomerCancel: allowed until exactly 30 min before, locked after', () => {
  const sched = new Date('2026-09-30T10:00:00+01:00').toISOString();
  assert.equal(canCustomerCancel(sched, new Date('2026-09-30T09:29:59+01:00')), true);
  assert.equal(canCustomerCancel(sched, new Date('2026-09-30T09:30:00+01:00')), true);
  assert.equal(canCustomerCancel(sched, new Date('2026-09-30T09:30:01+01:00')), false);
  assert.equal(canCustomerCancel(sched, new Date('2026-09-30T10:05:00+01:00')), false);
});

test('customer cancel before cutoff frees slot immediately; after cutoff is locked', async () => {
  const { db, barberId, customerIds, serviceIds } = await freshDb();
  setNow(`${WED}T08:00:00+01:00`);
  try {
    const b = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' });
    assert.ok(!(await getAvailableSlots(db, barberId, serviceIds[0], WED)).slots.some((s) => s.time === '10:00'));
    await assert.rejects(customerCancel(db, customerIds[1], b.id), /not found/i);
    await customerCancel(db, customerIds[0], b.id);
    assert.equal((await getBooking(db, b.id))!.status, 'CANCELLED');
    assert.equal((await getBooking(db, b.id))!.payment_status, 'VOID');
    assert.ok((await getAvailableSlots(db, barberId, serviceIds[0], WED)).slots.some((s) => s.time === '10:00')); // slot freed
    assert.ok(await getBooking(db, b.id));                                                                         // row kept

    const b2 = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '11:00', payment_option: 'ON_ARRIVAL' });
    setNow(`${WED}T10:31:00+01:00`); // 29 min before
    await assert.rejects(customerCancel(db, customerIds[0], b2.id), (e: any) => e.code === 'CANCEL_LOCKED' && e.status === 403);
    assert.equal((await getBooking(db, b2.id))!.status, 'CONFIRMED');
  } finally { resetNow(); }
});

test('cancelling a PAID online booking in time opens a pending refund (never a credit): payment_status -> REFUND_PENDING', async () => {
  const { db, barberId, customerIds, serviceIds } = await freshDb();
  setNow(`${WED}T08:00:00+01:00`);
  try {
    const b = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '12:00', payment_option: 'ONLINE' });
    assert.equal(await db.tx((t) => applyVerifiedPayment(t, b.id, 'PAYSTACK')), 'confirmed');
    assert.equal((await getBooking(db, b.id))!.payment_status, 'PAID');
    await customerCancel(db, customerIds[0], b.id);
    const after = (await getBooking(db, b.id))!;
    assert.equal(after.status, 'CANCELLED');
    assert.equal(after.payment_status, 'REFUND_PENDING');
    assert.equal((await db.many('SELECT 1 FROM session_credits')).length, 0, 'refund path never creates a credit');
    const log = await db.one(`SELECT details FROM audit_log WHERE booking_id=$1 AND action='CANCELLED'`, [b.id]);
    assert.match(JSON.stringify(log.details), /refund/i);
  } finally { resetNow(); }
});
