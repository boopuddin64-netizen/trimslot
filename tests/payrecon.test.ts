import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'net';
import { freshDb, setNow, resetNow, WED } from './helpers';
import { createApp } from '../src/app';
import { createBooking, customerCancel, expireHolds, getBooking, applyVerifiedPayment } from '../src/bookingService';
import { initializePayment, mockMarkPaid, processReference, setGatewayVerifier, parseGatewayData, amountMatches } from '../src/paystack';
import { runSweep } from '../src/sweep';

async function setup() {
  const s = await freshDb(); setNow(`${WED}T08:00:00+01:00`);
  await s.db.query('UPDATE barbers SET paystack_subaccount=$2 WHERE id=$1', [s.barberId, 'ACCT_test']);
  const mk = (cust: number, time: string) => createBooking(s.db, s.customerIds[cust], { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time, payment_option: 'ONLINE' });
  return { ...s, mk };
}
const notifs = (db: any, userId: number) => db.many('SELECT type, title, body FROM notifications WHERE user_id=$1 ORDER BY id', [userId]);

test('missed webhook + closed browser: the timed-out try is checked with Paystack first, and a paid one is confirmed instead of voided', async () => {
  const { db, mk, customerIds } = await setup();
  try {
    const b = await mk(0, '10:00'); const p = await initializePayment(db, b.id, null); await mockMarkPaid(db, p.reference);   // paid at the gateway, we never heard
    setNow(`${WED}T08:30:00+01:00`);
    assert.equal(await expireHolds(db), 0, 'nothing closed: it was paid');
    const bk = (await getBooking(db, b.id))!; assert.equal(bk.status, 'CONFIRMED'); assert.equal(bk.payment_status, 'PAID');
    assert.equal((await db.one('SELECT status FROM payments WHERE reference=$1', [p.reference])).status, 'SUCCESS');
    assert.ok(!(await notifs(db, customerIds[0])).some((n: any) => /not charged/i.test(n.body)));
  } finally { resetNow(); }
});

test('a try that was really not paid is closed and the customer is told they were not charged (only then)', async () => {
  const { db, mk, customerIds } = await setup();
  try {
    const b = await mk(0, '10:00'); await initializePayment(db, b.id, null);
    setNow(`${WED}T08:30:00+01:00`);
    assert.equal(await expireHolds(db), 1);
    assert.equal((await getBooking(db, b.id))!.status, 'CANCELLED');
    assert.ok((await notifs(db, customerIds[0])).some((n: any) => /You were not charged/.test(n.body)));
  } finally { resetNow(); }
});

test('Paystack unreachable: the try stays open for an hour, then closes WITHOUT saying "not charged"', async () => {
  const { db, mk, customerIds } = await setup();
  try {
    const b = await mk(0, '16:00'); await initializePayment(db, b.id, null);
    setGatewayVerifier(async () => { throw new Error('boom'); });
    setNow(`${WED}T08:30:00+01:00`);
    assert.equal(await expireHolds(db), 0); assert.equal((await getBooking(db, b.id))!.status, 'PENDING_PAYMENT', 'kept open, will be asked again');
    setNow(`${WED}T09:40:00+01:00`);
    assert.equal(await expireHolds(db), 1); assert.equal((await getBooking(db, b.id))!.status, 'CANCELLED');
    const n = (await notifs(db, customerIds[0])).filter((x: any) => x.type === 'BOOKING_INCOMPLETE');
    assert.equal(n.length, 1); assert.doesNotMatch(n[0].body, /not charged/i); assert.match(n[0].body, /could not check/i);
  } finally { setGatewayVerifier(null); resetNow(); }
});

test('sweep: a payment that shows up AFTER the try was closed is found within 24 h (time free -> confirmed; time taken -> refund)', async () => {
  const { db, mk, barberId, customerIds, serviceIds } = await setup();
  try {
    const a = await mk(0, '10:00'); const pa = await initializePayment(db, a.id, null);
    const c = await mk(1, '12:00'); const pc = await initializePayment(db, c.id, null);
    setNow(`${WED}T08:30:00+01:00`); await expireHolds(db);
    assert.equal((await getBooking(db, a.id))!.status, 'CANCELLED');
    // both customers' money reaches the gateway later, no webhook; meanwhile someone else books c's time (a pending try reserves nothing)
    await mockMarkPaid(db, pa.reference); await mockMarkPaid(db, pc.reference);
    const other = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '12:00', payment_option: 'ON_ARRIVAL' });
    assert.equal(other.status, 'CONFIRMED');
    setNow(`${WED}T08:45:00+01:00`);
    const sw = await runSweep(db);
    assert.equal(sw.payments_reconciled.checked, 2); assert.equal(sw.payments_reconciled.confirmed, 1); assert.equal(sw.payments_reconciled.refunds, 1);
    assert.equal((await getBooking(db, a.id))!.status, 'CONFIRMED', 'time was free: confirmed');
    const pcRow = await db.one('SELECT status, refund_status FROM payments WHERE reference=$1', [pc.reference]);
    assert.equal(pcRow.status, 'SUCCESS'); assert.ok(pcRow.refund_status, 'time taken: flagged for refund');
    assert.equal((await getBooking(db, c.id))!.status, 'CANCELLED');
    // asked again within 10 minutes? no (throttled)
    const sw2 = await runSweep(db); assert.equal(sw2.payments_reconciled.checked, 0);
  } finally { resetNow(); }
});

test('each outcome has its own result: duplicate, late, slot taken (and they stay the same when asked again)', async () => {
  const { db, mk, customerIds } = await setup();
  try {
    // duplicate: a second paid reference for a booking that is already confirmed
    const b = await mk(0, '10:00'); const p1 = await initializePayment(db, b.id, null); await mockMarkPaid(db, p1.reference);
    assert.equal((await processReference(db, p1.reference)).result, 'processed');
    await db.query(`INSERT INTO payments (booking_id, reference, provider, amount_kobo, status, created_at, barber_id) VALUES ($1,'TS-BOOKING-${b.id}-dup','MOCK',$2,'INITIATED',now(),$3)`, [b.id, p1.amount_kobo, b.barber_id]);
    await db.query(`UPDATE payments SET mock_paid=TRUE WHERE reference=$1`, [`TS-BOOKING-${b.id}-dup`]);
    const d1 = await processReference(db, `TS-BOOKING-${b.id}-dup`); assert.equal(d1.result, 'duplicate_refund');
    assert.equal((await processReference(db, `TS-BOOKING-${b.id}-dup`)).result, 'duplicate_refund', 'asked again: same answer, not "confirmed"');
    assert.ok((await notifs(db, customerIds[0])).some((n: any) => /second payment/i.test(n.title)));
    // late: the customer cancelled the try, then money arrives
    const c = await mk(1, '12:00'); const pc = await initializePayment(db, c.id, null); await customerCancel(db, customerIds[1], c.id); await mockMarkPaid(db, pc.reference);
    assert.equal((await processReference(db, pc.reference)).result, 'late_refund');
    assert.equal((await processReference(db, pc.reference)).result, 'late_refund');
    // slot taken: another customer got that time confirmed (a pending try reserves nothing), then the first customer's money arrives
    const e = await mk(0, '14:00'); const pe = await initializePayment(db, e.id, null);
    const f = await createBooking(db, customerIds[1], { barber_id: b.barber_id, service_id: e.service_id, date: WED, time: '14:00', payment_option: 'ON_ARRIVAL' });
    assert.equal(f.status, 'CONFIRMED');
    await mockMarkPaid(db, pe.reference);
    assert.equal((await processReference(db, pe.reference)).result, 'slot_taken');
    assert.equal((await processReference(db, pe.reference)).result, 'slot_taken', 'asked again: still slot_taken, never "confirmed"');
    assert.equal((await getBooking(db, e.id))!.status, 'CANCELLED');
  } finally { resetNow(); }
});

test('double click / two tabs reuse the open checkout (one reference), and starting to pay extends the try', async () => {
  const { db, mk } = await setup();
  try {
    const b = await mk(0, '10:00');
    const h0 = (await getBooking(db, b.id))!.hold_expires_at!;
    setNow(`${WED}T08:10:00+01:00`);
    const p1 = await initializePayment(db, b.id, null);
    const h1 = (await getBooking(db, b.id))!.hold_expires_at!;
    assert.ok(new Date(h1).getTime() > new Date(h0).getTime(), 'hold extended on initialize');
    const p2 = await initializePayment(db, b.id, null);
    assert.equal(p2.reference, p1.reference, 'same reference reused');
    assert.equal((await db.one('SELECT COUNT(*)::int c FROM payments WHERE booking_id=$1', [b.id])).c, 1);
    // the extension is capped: never later than 4 x the normal time after the try was made (08:00 + 60 min)
    for (let m = 24; m <= 58; m += 14) { setNow(`${WED}T08:${String(m).padStart(2, '0')}:00+01:00`); await initializePayment(db, b.id, null); }
    assert.ok(new Date((await getBooking(db, b.id))!.hold_expires_at!).getTime() <= Date.parse(`${WED}T09:00:00+01:00`) + 1000, 'capped');
  } finally { resetNow(); }
});

test('amount or currency that does not fit is never confirmed and is NOT silent (audit, customer note, admin alert - once)', async () => {
  const { db, mk, customerIds } = await setup();
  try {
    const b = await mk(0, '10:00'); const p = await initializePayment(db, b.id, null);
    setGatewayVerifier(async (_d, ref) => parseGatewayData({ status: 'success', amount: p.amount_kobo, requested_amount: p.amount_kobo, currency: 'USD' }, ref));
    assert.equal((await processReference(db, p.reference)).result, 'amount_mismatch');
    assert.equal((await processReference(db, p.reference)).result, 'amount_mismatch');
    assert.equal((await getBooking(db, b.id))!.status, 'PENDING_PAYMENT');
    assert.equal((await db.one(`SELECT COUNT(*)::int c FROM audit_log WHERE booking_id=$1 AND action='PAYMENT_AMOUNT_MISMATCH'`, [b.id])).c, 1);
    assert.equal((await notifs(db, customerIds[0])).filter((n: any) => n.type === 'PAYMENT_PROBLEM').length, 1);
    assert.equal((await db.one(`SELECT COUNT(*)::int c FROM admin_notifications WHERE event='PAYMENT_MISMATCH'`)).c, 1);
    assert.equal(amountMatches(parseGatewayData({ status: 'success', amount: 250000, requested_amount: 250000, currency: 'ngn' }, 'R'), 250000)?.paid_kobo, 250000, 'NGN in any case is fine');
    assert.equal(amountMatches(parseGatewayData({ status: 'success', amount: 250000, requested_amount: 250000, currency: 'GHS' }, 'R'), 250000), null);
  } finally { setGatewayVerifier(null); resetNow(); }
});

test('GET /payments/callback never shows a bare error: Paystack trouble -> booking page with pay=checked; unknown reference -> My bookings', async () => {
  const { db, mk } = await setup();
  const server = createApp(db).listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const b = await mk(0, '10:00'); const p = await initializePayment(db, b.id, null);
    setGatewayVerifier(async () => { throw new Error('paystack down'); });
    const r = await fetch(`${base}/api/payments/callback?reference=${p.reference}`, { redirect: 'manual' });
    assert.equal(r.status, 302); assert.equal(r.headers.get('location'), `/#/booking/${b.id}?pay=checked`);
    setGatewayVerifier(null);
    const u = await fetch(`${base}/api/payments/callback?reference=nonsense`, { redirect: 'manual' });
    assert.equal(u.status, 302); assert.equal(u.headers.get('location'), '/#/bookings');
    const n = await fetch(`${base}/api/payments/callback`, { redirect: 'manual' });
    assert.equal(n.headers.get('location'), '/#/bookings');
  } finally { server.close(); setGatewayVerifier(null); resetNow(); }
});

/* ---------- second round ---------- */
import { requestRefund, verifyBeforeClosing, reconcileRecentPayments } from '../src/paystack';

test('a mismatched payment is flagged NEEDS_REFUND ("Amount mismatch"), the sweeper leaves it for staff, the booking is not closed as "not charged", and staff can refund it or confirm it anyway', async () => {
  const { db, mk, customerIds } = await setup();
  try {
    const b = await mk(0, '10:00'); const p = await initializePayment(db, b.id, null);
    setGatewayVerifier(async (_d, ref) => parseGatewayData({ status: 'success', amount: p.amount_kobo - 5000, requested_amount: p.amount_kobo - 5000, currency: 'NGN' }, ref));
    assert.equal((await processReference(db, p.reference)).result, 'amount_mismatch');
    const row = await db.one('SELECT status, refund_status, refund_reason FROM payments WHERE reference=$1', [p.reference]);
    assert.deepEqual([row.status, row.refund_status, row.refund_reason], ['INITIATED', 'NEEDS_REFUND', 'Amount mismatch']);
    await runSweep(db);
    assert.equal((await db.one('SELECT refund_status FROM payments WHERE reference=$1', [p.reference])).refund_status, 'NEEDS_REFUND', 'the sweeper does not refund it by itself');
    // the try ends while staff have not decided: kept open for an hour, then closed with the honest text (never "not charged")
    setNow(`${WED}T08:30:00+01:00`);
    assert.equal(await expireHolds(db), 0); assert.equal((await getBooking(db, b.id))!.status, 'PENDING_PAYMENT');
    setNow(`${WED}T09:40:00+01:00`);
    assert.equal(await expireHolds(db), 1);
    const n = (await notifs(db, customerIds[0])).filter((x: any) => x.type === 'BOOKING_INCOMPLETE');
    assert.equal(n.length, 1); assert.doesNotMatch(n[0].body, /not charged/i); assert.match(n[0].body, /did not match/i);
    // staff: confirm anyway -> booking confirmed (the time is free), the flag is cleared
    const o = await processReference(db, p.reference, { force: true });
    assert.equal(o.result, 'processed');
    const after = await db.one('SELECT status, refund_status, refund_reason, paid_kobo FROM payments WHERE reference=$1', [p.reference]);
    assert.deepEqual([after.status, after.refund_status, after.refund_reason, after.paid_kobo], ['SUCCESS', null, null, p.amount_kobo - 5000]);
    assert.equal((await getBooking(db, b.id))!.status, 'CONFIRMED');
  } finally { setGatewayVerifier(null); resetNow(); }
});

test('a mismatched payment can be refunded from the NEEDS_REFUND flag, and a refunded one cannot be forced', async () => {
  const { db, mk } = await setup();
  try {
    const b = await mk(0, '11:00'); const p = await initializePayment(db, b.id, null);
    setGatewayVerifier(async (_d, ref) => parseGatewayData({ status: 'success', amount: p.amount_kobo + 90000, requested_amount: p.amount_kobo + 90000, currency: 'NGN' }, ref));
    await processReference(db, p.reference);
    assert.equal(await requestRefund(db, p.reference), 'requested');
    assert.equal((await db.one('SELECT refund_status FROM payments WHERE reference=$1', [p.reference])).refund_status, 'REFUND_REQUESTED');
    assert.equal(await requestRefund(db, p.reference), 'not_needed', 'asking again does nothing');
  } finally { setGatewayVerifier(null); resetNow(); }
});

test('two refund requests at the same time send ONE refund', async () => {
  const { db, mk } = await setup();
  try {
    const b = await mk(0, '10:00'); const p = await initializePayment(db, b.id, null); await mockMarkPaid(db, p.reference);
    const b2 = await mk(1, '10:00'); const p2 = await initializePayment(db, b2.id, null); await mockMarkPaid(db, p2.reference);
    await processReference(db, p.reference);
    assert.equal((await processReference(db, p2.reference)).result, 'slot_taken');   // flagged NEEDS_REFUND; the refund call already ran once inside processReference
    await db.query(`UPDATE payments SET refund_status='NEEDS_REFUND' WHERE reference=$1`, [p2.reference]);
    const r = await Promise.all([requestRefund(db, p2.reference), requestRefund(db, p2.reference), requestRefund(db, p2.reference)]);
    assert.equal(r.filter((x) => x === 'requested').length, 1, JSON.stringify(r));
  } finally { resetNow(); }
});

test('only the attempts that were checked with Paystack are closed (several batches -> every one is asked first)', async () => {
  const { db, customerIds, barberId, serviceIds } = await setup();
  try {
    const asked = new Set<string>();
    setGatewayVerifier(async (_d, ref) => { asked.add(ref); return { ok: false, status: 'abandoned', reference: ref }; });
    const ids: number[] = [];
    for (let i = 0; i < 30; i++) {
      const b = await createBooking(db, customerIds[i % customerIds.length], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: `${String(9 + Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`, payment_option: 'ONLINE' }).catch(() => null);
      if (!b) continue; await initializePayment(db, b.id, null); ids.push(b.id);
    }
    setNow(`${WED}T08:30:00+01:00`);
    assert.ok(ids.length >= 12, 'got ' + ids.length);
    const closed = await expireHolds(db, {}, { batch: 5 });   // several batches of 5
    const still = await db.one(`SELECT COUNT(*)::int c FROM bookings WHERE id = ANY($1::int[]) AND status='PENDING_PAYMENT'`, [ids]);
    assert.equal(closed + still.c, ids.length);
    assert.equal(asked.size, closed, 'every closed attempt had its checkout asked about');
    // budget 0: nothing is checked, so nothing is closed
    setNow(`${WED}T09:00:00+01:00`);
    assert.equal(await expireHolds(db, {}, { budgetMs: 0 }), 0);
  } finally { setGatewayVerifier(null); resetNow(); }
});

test('a Paystack failure is not retried on every request (backs off for the 2-minute window) and a second request does not call it "not paid"', async () => {
  const { db, mk, customerIds } = await setup();
  try {
    const b = await mk(0, '10:00'); await initializePayment(db, b.id, null);
    let calls = 0; setGatewayVerifier(async () => { calls++; throw new Error('boom'); });
    setNow(`${WED}T08:30:00+01:00`);
    await expireHolds(db); await expireHolds(db); await expireHolds(db);
    assert.equal(calls, 1, 'one failed ask, then quiet until the window ends');
    assert.equal((await getBooking(db, b.id))!.status, 'PENDING_PAYMENT', 'never closed as "not charged" on a failed check');
    assert.equal((await notifs(db, customerIds[0])).filter((n: any) => n.type === 'BOOKING_INCOMPLETE').length, 0);
    // one quick answer ("not paid") is trusted by the callers that meet the same window
    setNow(`${WED}T08:35:00+01:00`);
    setGatewayVerifier(async (_d, ref) => ({ ok: false, status: 'abandoned', reference: ref }));
    assert.equal(await expireHolds(db), 1);
    assert.match((await notifs(db, customerIds[0])).find((n: any) => n.type === 'BOOKING_INCOMPLETE')!.body, /not charged/i);
  } finally { setGatewayVerifier(null); resetNow(); }
});

test('the sweep looks back 48 hours', async () => {
  const { db, mk } = await setup();
  try {
    const b = await mk(0, '10:00'); const p = await initializePayment(db, b.id, null); await mockMarkPaid(db, p.reference);
    setNow(`${WED}T08:30:00+01:00`);
    await db.query(`UPDATE payments SET created_at=$2 WHERE reference=$1`, [p.reference, new Date(new Date(`${WED}T08:30:00+01:00`).getTime() - 40 * 3600000).toISOString()]);
    await db.query(`UPDATE bookings SET status='CANCELLED', payment_status='VOID', cancelled_by='system' WHERE id=$1`, [b.id]);
    const r = await reconcileRecentPayments(db); assert.equal(r.checked, 1, 'a 40-hour-old open checkout is still asked about');
  } finally { resetNow(); }
});

test('concurrent Pay clicks make ONE checkout', async () => {
  const { db, mk } = await setup();
  try {
    const b = await mk(0, '10:00');
    const r = await Promise.all([initializePayment(db, b.id, null), initializePayment(db, b.id, null), initializePayment(db, b.id, null)]);
    assert.equal(new Set(r.map((x) => x.reference)).size, 1, JSON.stringify(r.map((x) => x.reference)));
    assert.equal((await db.one(`SELECT COUNT(*)::int c FROM payments WHERE booking_id=$1`, [b.id])).c, 1);
  } finally { resetNow(); }
});
