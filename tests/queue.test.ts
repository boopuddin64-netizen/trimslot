import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, setNow, resetNow, WED, userIdOfBarber } from './helpers';
import { barberAction, createBooking, customerCheckIn, queueInfo, getBooking } from '../src/bookingService';

test('queue: positions, early arrival served immediately, updates after start/complete, notifications', async () => {
  setNow(`${WED}T09:00:00+01:00`);
  try {
    const { db, barberId, customerIds, serviceIds } = await freshDb();
    const uid = await userIdOfBarber(db, barberId);
    const a = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '09:30', payment_option: 'ON_ARRIVAL' });
    const b = await createBooking(db, customerIds[1], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' });
    const qi = async (id: number) => queueInfo(db, (await getBooking(db, id))!);
    assert.equal((await qi(a.id)).position, 1);
    assert.equal((await qi(b.id)).position, 2);
    await customerCheckIn(db, customerIds[1], b.id);                    // b arrives first
    assert.equal((await qi(b.id)).state, 'READY');
    assert.equal((await qi(a.id)).position, 2);
    await customerCheckIn(db, customerIds[0], a.id);
    assert.equal((await qi(a.id)).position, 1);                          // both present: scheduled-time order
    assert.equal((await qi(b.id)).position, 2);
    await barberAction(db, uid, barberId, b.id, 'start');                // barber may serve the early arrival; scheduled times untouched
    assert.equal((await qi(b.id)).state, 'BEING_SERVED');
    const qa = await qi(a.id);
    assert.equal(qa.state, 'NEXT');
    assert.equal(qa.ahead, 1);
    await barberAction(db, uid, barberId, b.id, 'record-payment', { method: 'transfer' });
    await barberAction(db, uid, barberId, b.id, 'complete');
    assert.equal((await qi(a.id)).state, 'READY');
    const types = (await db.many('SELECT type FROM notifications WHERE user_id=$1', [customerIds[0]])).map((r) => r.type);
    assert.ok(types.includes('BOOKING_CONFIRMED') && types.includes('YOURE_NEXT') && types.includes('YOUR_TURN'));
  } finally { resetNow(); }
});
