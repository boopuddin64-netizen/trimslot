import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'net';
import { freshDb, setNow, resetNow, WED } from './helpers';
import { createApp } from '../src/app';
import { createBooking, customerCancel, expireHolds, applyVerifiedPayment } from '../src/bookingService';
import { runSweep } from '../src/sweep';

async function withServer(fn: (base: string, ctx: Awaited<ReturnType<typeof freshDb>>) => Promise<void>) {
  setNow(`${WED}T08:00:00+01:00`);
  const ctx = await freshDb();
  const server = createApp(ctx.db).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { await fn(base, ctx); } finally { server.close(); resetNow(); }
}
const call = (base: string, p: string, cookie: string, method = 'GET') => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: method === 'GET' ? undefined : '{}' });
async function login(base: string, identifier: string, password: string) {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier, password }) });
  return r.headers.get('set-cookie')!.split(';')[0];
}
const barberNotifs = (db: any, barberId: number) => db.many(`SELECT n.type, n.booking_id FROM notifications n JOIN barbers b ON b.user_id=n.user_id WHERE b.id=$1`, [barberId]);

test('Pay-now that is never paid: customer sees "incomplete"; barber sees NOTHING (list, today, customers, detail, timeline, notifications)', async () => {
  await withServer(async (base, { db, barberId, customerIds, serviceIds }) => {
    const bk = await login(base, 'mike@trimslot.demo', 'Barber123!');
    const ck = await login(base, 'chidi@trimslot.demo', 'Customer123!');
    const held = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '10:00', payment_option: 'ONLINE' });
    const before = (await barberNotifs(db, barberId)).length;

    // 1) a live unpaid attempt does NOT hold the slot (still offered to everyone), and the barber sees nothing at all
    const free = await (await call(base, `/api/barbers/${barberId}/slots?service_id=${serviceIds[0]}&date=${WED}`, bk)).json() as any;
    assert.ok(free.slots.some((s: any) => s.time === '10:00'), 'unpaid attempt reserves nothing');
    const today = await (await call(base, '/api/barber/today', bk)).json() as any;
    assert.equal(today.pending_payment.length, 0);
    assert.doesNotMatch(JSON.stringify(today), new RegExp(`"id":${held.id}[,}]`));
    assert.equal(((await (await call(base, '/api/barber/bookings', bk)).json()) as any).bookings.length, 0);
    assert.equal(((await (await call(base, '/api/barber/customers', bk)).json()) as any).customers.length, 0);
    assert.equal((await call(base, `/api/barber/bookings/${held.id}`, bk)).status, 404, 'no detail/timeline');
    assert.equal((await call(base, `/api/barber/customers/${customerIds[0]}`, bk)).status, 404);
    assert.equal((await call(base, `/api/barber/bookings/${held.id}/mark-present`, bk, 'POST')).status, 404);
    assert.equal((await barberNotifs(db, barberId)).length, before, 'no barber notification');
    // customer still sees it (as pending)
    const mine = await (await call(base, '/api/bookings', ck)).json() as any;
    assert.equal(mine.bookings[0].status, 'PENDING_PAYMENT');

    // 2) hold expires (lazy release, then sweeper): becomes "Incomplete" for the customer only
    setNow(`${WED}T08:30:00+01:00`);
    await expireHolds(db); await runSweep(db);
    const after = await (await call(base, '/api/bookings', ck)).json() as any;
    assert.equal(after.bookings[0].incomplete, true, 'customer sees Incomplete');
    assert.equal(after.bookings[0].payment_status, 'VOID', 'no credit/refund implication');
    assert.equal((await db.one('SELECT cancelled_by FROM bookings WHERE id=$1', [held.id])).cancelled_by, 'system');
    const cn = await db.many(`SELECT type, body FROM notifications WHERE user_id=$1 AND booking_id=$2`, [customerIds[0], held.id]);
    assert.ok(cn.some((n: any) => n.type === 'BOOKING_INCOMPLETE'), 'customer is told it is incomplete (not "cancelled")');
    assert.ok(!cn.some((n: any) => /credit|refund/i.test(n.body) && !/not been charged/.test(n.body)));
    // still nothing for the barber, including the done list and counts
    const t2 = await (await call(base, '/api/barber/today', bk)).json() as any;
    assert.equal(t2.done.length, 0);
    assert.deepEqual(t2.stats, { completed: 0, earned_kobo: 0, remaining: 0 });
    assert.equal(((await (await call(base, '/api/barber/customers', bk)).json()) as any).customers.length, 0);
    assert.equal((await call(base, `/api/barber/bookings/${held.id}`, bk)).status, 404);
    assert.equal((await barberNotifs(db, barberId)).length, before);
    // slot is free again
    const rebook = await createBooking(db, customerIds[1], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' });
    assert.equal(rebook.status, 'CONFIRMED');
  });
});

test('customer abandons a Pay-now hold by cancelling: "Incomplete", barber not notified; a PAID booking cancelled still notifies the barber', async () => {
  await withServer(async (base, { db, barberId, customerIds, serviceIds }) => {
    const bk = await login(base, 'mike@trimslot.demo', 'Barber123!');
    const ck = await login(base, 'chidi@trimslot.demo', 'Customer123!');
    const a = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: '2026-10-02', time: '10:00', payment_option: 'ONLINE' });
    await customerCancel(db, customerIds[0], a.id);
    const mine = await (await call(base, '/api/bookings', ck)).json() as any;
    assert.equal(mine.bookings[0].incomplete, true);
    assert.equal(mine.bookings[0].payment_status, 'VOID');
    assert.equal((await barberNotifs(db, barberId)).length, 0);
    assert.equal(((await (await call(base, '/api/barber/bookings', bk)).json()) as any).bookings.length, 0);

    // paid online booking: barber sees it and IS told when it's cancelled (normal cancellation, credit pending)
    const p = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: '2026-10-02', time: '11:00', payment_option: 'ONLINE' });
    await db.tx((t) => applyVerifiedPayment(t, p.id, 'TEST'));
    const seen = await (await call(base, '/api/barber/bookings', bk)).json() as any;
    assert.deepEqual(seen.bookings.map((b: any) => b.id), [p.id]);
    assert.equal(((await (await call(base, '/api/barber/customers', bk)).json()) as any).customers.length, 1);
    await customerCancel(db, customerIds[0], p.id);
    const types = (await barberNotifs(db, barberId)).map((n: any) => n.type);
    assert.ok(types.includes('NEW_BOOKING') && types.includes('BOOKING_CANCELLED'));
    const after = await (await call(base, '/api/bookings', ck)).json() as any;
    const cancelled = after.bookings.find((b: any) => b.id === p.id);
    assert.equal(cancelled.incomplete, false, 'paid+cancelled is a normal cancellation, not Incomplete');
    assert.equal(cancelled.payment_status, 'REFUND_PENDING');
    // pay-on-arrival cancelled is a normal cancellation too
    const c = await createBooking(db, customerIds[1], { barber_id: barberId, service_id: serviceIds[0], date: '2026-10-02', time: '12:00', payment_option: 'ON_ARRIVAL' });
    await customerCancel(db, customerIds[1], c.id);
    assert.ok((await barberNotifs(db, barberId)).filter((n: any) => n.booking_id === c.id).some((n: any) => n.type === 'BOOKING_CANCELLED'));
  });
});

test('payment confirmed AFTER the try timed out: the booking is confirmed when the time is still free, refunded when it is not (same result whether or not a sweep ran first)', async () => {
  const { initializePayment, mockMarkPaid, processReference } = await import('../src/paystack');
  await withServer(async (_base, { db, barberId, customerIds, serviceIds }) => {
    await db.query(`UPDATE barbers SET paystack_subaccount='ACCT_test' WHERE id=$1`, [barberId]);
    const mk = async (cust: number, time: string) => {
      const b = await createBooking(db, cust, { barber_id: barberId, service_id: serviceIds[0], date: WED, time, payment_option: 'ONLINE' });
      const pay = await initializePayment(db, b.id, null); await mockMarkPaid(db, pay.reference); return { b, ref: pay.reference };
    };
    // A: time still free after the try closed
    const a = await mk(customerIds[0], '10:00');
    setNow(`${WED}T08:30:00+01:00`); await expireHolds(db);
    assert.equal((await db.one('SELECT status FROM bookings WHERE id=$1', [a.b.id])).status, 'CANCELLED', 'try closed first');
    assert.equal((await processReference(db, a.ref)).result, 'processed');
    const ra = await db.one('SELECT status, payment_status, cancelled_by FROM bookings WHERE id=$1', [a.b.id]);
    assert.deepEqual([ra.status, ra.payment_status, ra.cancelled_by], ['CONFIRMED', 'PAID', null], 'paid late, time free: confirmed');
    assert.equal((await db.one(`SELECT refund_status FROM payments WHERE reference=$1`, [a.ref])).refund_status, null, 'no refund needed');
    // B: someone else took the time first -> refund, not confirmed
    setNow(`${WED}T08:00:00+01:00`);
    const bb = await mk(customerIds[1], '12:00');
    setNow(`${WED}T08:30:00+01:00`); await expireHolds(db);
    await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '12:00', payment_option: 'ON_ARRIVAL' });
    await processReference(db, bb.ref);
    assert.equal((await db.one('SELECT status FROM bookings WHERE id=$1', [bb.b.id])).status, 'CANCELLED');
    assert.equal((await db.one(`SELECT refund_status FROM payments WHERE reference=$1`, [bb.ref])).refund_status !== null, true, 'time gone: flagged for refund');
    // C: the customer cancelled the attempt themselves -> never revived
    setNow(`${WED}T08:00:00+01:00`);
    const c3 = await mk(customerIds[1], '15:00');
    await customerCancel(db, customerIds[1], c3.b.id);
    await processReference(db, c3.ref);
    assert.equal((await db.one('SELECT status FROM bookings WHERE id=$1', [c3.b.id])).status, 'CANCELLED');
  });
});
