import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUSES, canTransition, assertTransition } from '../src/stateMachine';
import { freshDb, setNow, resetNow, WED, userIdOfBarber } from './helpers';
import { barberAction, createBooking, customerCheckIn, getBooking } from '../src/bookingService';

test('legal transitions are exactly the specified graph', () => {
  const legal: [string, string][] = [
    ['PENDING_PAYMENT', 'CONFIRMED'], ['PENDING_PAYMENT', 'CANCELLED'],
    ['CONFIRMED', 'ARRIVED'], ['ARRIVED', 'IN_SERVICE'], ['IN_SERVICE', 'COMPLETED'],
    ['CONFIRMED', 'CANCELLED'], ['ARRIVED', 'CANCELLED'], ['CONFIRMED', 'NO_SHOW'], ['ARRIVED', 'NO_SHOW'],
    ['CONFIRMED', 'NOT_SERVED'], ['ARRIVED', 'NOT_SERVED'],
  ];
  for (const from of STATUSES) for (const to of STATUSES) {
    assert.equal(canTransition(from, to), legal.some(([a, b]) => a === from && b === to), `${from} -> ${to}`);
  }
});

test('illegal transitions throw ILLEGAL_TRANSITION (409)', () => {
  for (const [a, b] of [['PENDING_PAYMENT', 'ARRIVED'], ['CONFIRMED', 'COMPLETED'], ['COMPLETED', 'CANCELLED'], ['CANCELLED', 'CONFIRMED'], ['IN_SERVICE', 'CANCELLED'], ['NO_SHOW', 'ARRIVED']] as const) {
    assert.throws(() => assertTransition(a, b), (e: any) => e.status === 409 && e.code === 'ILLEGAL_TRANSITION');
  }
});

test('full happy path via services + enforcement of guards', async () => {
  setNow(`${WED}T09:00:00+01:00`);
  try {
    const { db, barberId, customerIds, serviceIds } = await freshDb();
    const uid = await userIdOfBarber(db, barberId);
    const b = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '09:30', payment_option: 'ON_ARRIVAL' });
    await assert.rejects(barberAction(db, uid, barberId, b.id, 'start'), /not arrived/i);
    await assert.rejects(barberAction(db, uid, barberId, b.id, 'complete'), /Cannot complete/i);
    await customerCheckIn(db, customerIds[0], b.id);
    const arrived = (await getBooking(db, b.id))!;
    assert.equal(arrived.status, 'ARRIVED');
    assert.ok(arrived.arrival_time);
    const scheduled = arrived.scheduled_at;
    await barberAction(db, uid, barberId, b.id, 'start');
    const inSvc = (await getBooking(db, b.id))!;
    assert.equal(inSvc.status, 'IN_SERVICE');
    assert.equal(inSvc.scheduled_at, scheduled);       // never rewritten
    assert.ok(inSvc.service_start);
    await assert.rejects(barberAction(db, uid, barberId, b.id, 'complete'), (e: any) => e.code === 'PAYMENT_REQUIRED');
    await barberAction(db, uid, barberId, b.id, 'record-payment', { method: 'cash' });
    await barberAction(db, uid, barberId, b.id, 'complete');
    const done = (await getBooking(db, b.id))!;
    assert.equal(done.status, 'COMPLETED');
    assert.equal(done.payment_status, 'PAID');
    assert.equal(done.paid_via, 'CASH');
    assert.ok(done.service_complete);
    await assert.rejects(barberAction(db, uid, barberId, b.id, 'no-show'), /cannot mark/i);
    await assert.rejects(customerCheckIn(db, customerIds[0], b.id), /cannot check in/);
    const actions = (await db.many('SELECT action FROM audit_log WHERE booking_id=$1 ORDER BY id', [b.id])).map((r) => r.action);
    assert.deepEqual(actions, ['BOOKED', 'CHECKED_IN', 'STARTED', 'PAYMENT_RECORDED', 'COMPLETED', 'COMMISSION_ACCRUED']);
  } finally { resetNow(); }
});

test('check-in only on the day; no-show only after scheduled time; other people cannot act', async () => {
  setNow(`${WED}T09:00:00+01:00`);
  try {
    const { db, barberId, customerIds, serviceIds } = await freshDb();
    const uid = await userIdOfBarber(db, barberId);
    const future = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: '2026-10-01', time: '10:00', payment_option: 'ON_ARRIVAL' });
    await assert.rejects(customerCheckIn(db, customerIds[0], future.id), (e: any) => e.code === 'NOT_TODAY');
    const today = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '11:00', payment_option: 'ON_ARRIVAL' });
    await assert.rejects(barberAction(db, uid, barberId, today.id, 'no-show'), (e: any) => e.code === 'TOO_EARLY');
    await assert.rejects(customerCheckIn(db, customerIds[1], today.id), /could not find/i);
    await assert.rejects(barberAction(db, uid, barberId + 99, today.id, 'mark-present'), /could not find/i);
    setNow(`${WED}T11:20:00+01:00`);
    await barberAction(db, uid, barberId, today.id, 'no-show');
    assert.equal((await getBooking(db, today.id))!.status, 'NO_SHOW');
  } finally { resetNow(); }
});

test('only one customer IN_SERVICE at a time', async () => {
  setNow(`${WED}T09:00:00+01:00`);
  try {
    const { db, barberId, customerIds, serviceIds } = await freshDb();
    const uid = await userIdOfBarber(db, barberId);
    const a = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '09:30', payment_option: 'ON_ARRIVAL' });
    const b = await createBooking(db, customerIds[1], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' });
    await barberAction(db, uid, barberId, a.id, 'mark-present'); await barberAction(db, uid, barberId, b.id, 'mark-present');
    await barberAction(db, uid, barberId, b.id, 'start'); // early arrival served first, scheduled order untouched
    await assert.rejects(barberAction(db, uid, barberId, a.id, 'start'), (e: any) => e.code === 'ALREADY_SERVING');
    // and the DB itself refuses a second IN_SERVICE row (uq_bookings_one_in_service)
    await assert.rejects(db.query(`UPDATE bookings SET status='IN_SERVICE' WHERE id=$1`, [a.id]), (e: any) => e.code === '23505');
  } finally { resetNow(); }
});
