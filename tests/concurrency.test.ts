import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, setNow, resetNow, WED, userIdOfBarber } from './helpers';
import { barberAction, createBooking, customerCancel, customerCheckIn, getBooking } from '../src/bookingService';
import { getAvailableSlots } from '../src/slots';

test('CONCURRENCY: 15 customers race for the SAME slot -> exactly one wins, the rest get SLOT_UNAVAILABLE', async () => {
  setNow('2026-09-29T08:00:00+01:00');
  try {
    const { db, barberId, serviceIds } = await freshDb({ poolMax: 20 });
    // create 15 extra customers
    const ids: number[] = [];
    for (let i = 0; i < 15; i++) ids.push((await db.one(`INSERT INTO users (role,name,email,password_hash) VALUES ('customer',$1,$2,'x') RETURNING id`, [`C${i}`, `c${i}@x.com`])).id);
    const res = await Promise.allSettled(ids.map((cid) => createBooking(db, cid, { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' })));
    const ok = res.filter((r) => r.status === 'fulfilled');
    const bad = res.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(ok.length, 1);
    assert.equal(bad.length, 14);
    assert.ok(bad.every((r) => r.reason?.code === 'SLOT_UNAVAILABLE'), bad.map((r) => r.reason?.message).join(' | '));
    assert.equal((await db.one(`SELECT COUNT(*) c FROM bookings WHERE status='CONFIRMED'`)).c, 1);
  } finally { resetNow(); }
});

test('CONCURRENCY: racing OVERLAPPING starts (10:00 vs 10:15 vs 10:30, 45-min service) -> only one overlap-free set survives', async () => {
  setNow('2026-09-29T08:00:00+01:00');
  try {
    const { db, barberId, serviceIds } = await freshDb({ poolMax: 20 });
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) ids.push((await db.one(`INSERT INTO users (role,name,email,password_hash) VALUES ('customer',$1,$2,'x') RETURNING id`, [`C${i}`, `c${i}@x.com`])).id);
    const times = ['10:00', '10:15', '10:30', '10:00', '10:15', '10:30'];
    await Promise.allSettled(ids.map((cid, i) => createBooking(db, cid, { barber_id: barberId, service_id: serviceIds[1], date: WED, time: times[i], payment_option: 'ON_ARRIVAL' })));
    const rows = await db.many(`SELECT start_min, end_min FROM bookings WHERE status='CONFIRMED' ORDER BY start_min`);
    assert.ok(rows.length >= 1);
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i].start_min >= rows[i - 1].end_min, 'bookings must not overlap: ' + JSON.stringify(rows));
    assert.equal(rows.length, 1); // 45-minute service, starts 15 min apart: any two of these overlap
  } finally { resetNow(); }
});

test('CONCURRENCY: cancel racing check-in on the same booking never leaves it in a mixed state', async () => {
  setNow(`${WED}T08:00:00+01:00`);
  try {
    const { db, barberId, customerIds, serviceIds } = await freshDb({ poolMax: 10 });
    const b = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '12:00', payment_option: 'ON_ARRIVAL' });
    const r = await Promise.allSettled([customerCancel(db, customerIds[0], b.id), customerCheckIn(db, customerIds[0], b.id)]);
    const final = (await getBooking(db, b.id))!;
    assert.ok(['CANCELLED', 'ARRIVED'].includes(final.status));
    // ARRIVED can still be cancelled afterwards (in window), so both orders are legal - but never both "won" inconsistently:
    if (final.status === 'CANCELLED') assert.ok(final.cancelled_at); else assert.ok(final.arrival_time && !final.cancelled_at);
    assert.ok(r.some((x) => x.status === 'fulfilled'));
  } finally { resetNow(); }
});

test('CONCURRENCY: double START taps on two ready customers -> one IN_SERVICE only', async () => {
  setNow(`${WED}T09:00:00+01:00`);
  try {
    const { db, barberId, customerIds, serviceIds } = await freshDb({ poolMax: 10 });
    const uid = await userIdOfBarber(db, barberId);
    const a = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '09:30', payment_option: 'ON_ARRIVAL' });
    const b = await createBooking(db, customerIds[1], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' });
    await barberAction(db, uid, barberId, a.id, 'mark-present'); await barberAction(db, uid, barberId, b.id, 'mark-present');
    const r = await Promise.allSettled([barberAction(db, uid, barberId, a.id, 'start'), barberAction(db, uid, barberId, b.id, 'start')]);
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal((await db.one(`SELECT COUNT(*) c FROM bookings WHERE status='IN_SERVICE'`)).c, 1);
  } finally { resetNow(); }
});

test('unpaid attempt never blocks the slot (no timer, no cron involved)', async () => {
  setNow('2026-09-29T08:00:00+01:00');
  try {
    const { db, barberId, customerIds, serviceIds } = await freshDb();
    const b = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '10:00', payment_option: 'ONLINE' });
    assert.ok((await getAvailableSlots(db, barberId, serviceIds[0], WED)).slots.some((s) => s.time === '10:00'), 'free straight away');
    setNow('2026-09-29T08:16:00+01:00');
    assert.ok((await getAvailableSlots(db, barberId, serviceIds[0], WED)).slots.some((s) => s.time === '10:00'));
    assert.equal((await getBooking(db, b.id))!.status, 'PENDING_PAYMENT');   // not yet swept, availability is already correct
  } finally { resetNow(); }
});
