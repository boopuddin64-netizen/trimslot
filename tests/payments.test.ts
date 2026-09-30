import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, setNow, resetNow, WED } from './helpers';
import { computeSignature, verifySignature, handleWebhook, initializePayment, mockMarkPaid, processReference, bookingIdFromReference } from '../src/paystack';
import { createBooking, expireHolds, getBooking } from '../src/bookingService';
import { MOCK_SECRET } from '../src/config';

async function setup() {
  const s = await freshDb();
  setNow(`${WED}T08:00:00+01:00`);
  const b = await createBooking(s.db, s.customerIds[0], { barber_id: s.barberId, service_id: s.serviceIds[1], date: WED, time: '10:00', payment_option: 'ONLINE' });
  return { ...s, b };
}
const body = (ref: string, event = 'charge.success') => Buffer.from(JSON.stringify({ event, data: { reference: ref, status: 'success', amount: 450000 } }));

test('signature: valid HMAC-SHA512 accepted; tampered/missing/wrong-key rejected', () => {
  const raw = Buffer.from('{"event":"charge.success"}');
  const sig = computeSignature(raw, 'sk_test_abc');
  assert.equal(sig.length, 128);
  assert.equal(verifySignature(raw, sig, 'sk_test_abc'), true);
  assert.equal(verifySignature(Buffer.from('{"event":"charge.success "}'), sig, 'sk_test_abc'), false);
  assert.equal(verifySignature(raw, sig, 'sk_test_other'), false);
  assert.equal(verifySignature(raw, undefined, 'sk_test_abc'), false);
  assert.equal(verifySignature(raw, 'deadbeef', 'sk_test_abc'), false);
});

test('initialize: unique reference TS-BOOKING-<id>-<rand>, kobo amount from snapshot, subaccount stored', async () => {
  const { db, b, barberId } = await setup();
  try {
    await db.query('UPDATE barbers SET paystack_subaccount=$1 WHERE id=$2', ['ACCT_test123', barberId]);
    const r1 = await initializePayment(db, b.id, 'c@x.com');
    assert.match(r1.reference, /^TS-BOOKING-\d+-[a-f0-9]{10}$/);
    assert.equal(bookingIdFromReference(r1.reference), b.id);
    assert.equal(r1.amount_kobo, 450000);
    assert.equal(r1.mock, true);
    const row = await db.one('SELECT * FROM payments WHERE reference=$1', [r1.reference]);
    assert.equal(row.subaccount, 'ACCT_test123');
    assert.notEqual(r1.reference, (await initializePayment(db, b.id, 'c@x.com')).reference);
    await assert.rejects(db.query(`INSERT INTO payments (booking_id, reference, provider, amount_kobo) VALUES ($1,$2,'MOCK',1)`, [b.id, r1.reference]), (e: any) => e.code === '23505'); // reference is UNIQUE
  } finally { resetNow(); }
});

test('webhook: bad signature rejected & logged; no state change', async () => {
  const { db, b } = await setup();
  try {
    const { reference } = await initializePayment(db, b.id, null);
    await mockMarkPaid(db, reference);
    const res = await handleWebhook(db, body(reference), 'not-a-real-signature');
    assert.equal(res.status, 401);
    assert.equal((await getBooking(db, b.id))!.status, 'PENDING_PAYMENT');
    const ev = await db.many('SELECT * FROM payment_events');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].signature_valid, false);
    assert.equal(ev[0].result, 'rejected_bad_signature');
  } finally { resetNow(); }
});

test('webhook: valid signature but gateway says NOT paid => stays PENDING (never trust the payload)', async () => {
  const { db, b } = await setup();
  try {
    const { reference } = await initializePayment(db, b.id, null);
    const raw = body(reference);
    const res = await handleWebhook(db, raw, computeSignature(raw, MOCK_SECRET));
    assert.equal(res.status, 200);
    assert.equal(res.body.result, 'not_paid');
    assert.equal((await getBooking(db, b.id))!.status, 'PENDING_PAYMENT');
  } finally { resetNow(); }
});

test('webhook: valid + verified => CONFIRMED/PAID; replays are idempotent; events stored once with a delivery count', async () => {
  const { db, b } = await setup();
  try {
    const { reference } = await initializePayment(db, b.id, null);
    await mockMarkPaid(db, reference);
    const raw = body(reference);
    const sig = computeSignature(raw, MOCK_SECRET);
    assert.equal((await handleWebhook(db, raw, sig)).body.result, 'processed');
    let bk = (await getBooking(db, b.id))!;
    assert.equal(bk.status, 'CONFIRMED');
    assert.equal(bk.payment_status, 'PAID');
    const notifCount = async () => (await db.one(`SELECT COUNT(*) c FROM notifications WHERE booking_id=$1`, [b.id])).c;
    const auditCount = async () => (await db.one(`SELECT COUNT(*) c FROM audit_log WHERE booking_id=$1 AND action='PAYMENT_CONFIRMED'`, [b.id])).c;
    const n1 = await notifCount();
    assert.equal((await handleWebhook(db, raw, sig)).body.result, 'already_processed');
    assert.equal((await processReference(db, reference)).result, 'already_processed');   // callback racing the webhook
    assert.equal(await notifCount(), n1);
    assert.equal(await auditCount(), 1);
    const ev = await db.many(`SELECT * FROM payment_events WHERE source='WEBHOOK'`);
    assert.equal(ev.length, 1);                                  // identical deliveries collapse into ONE row...
    assert.equal(ev[0].delivery_count, 2);                       // ...with the count recorded
    assert.equal(ev[0].result, 'processed');                     // first outcome preserved
    assert.equal(ev[0].last_result, 'already_processed');
    bk = (await getBooking(db, b.id))!;
    assert.equal(bk.status, 'CONFIRMED');
  } finally { resetNow(); }
});

test('CONCURRENCY: 12 simultaneous webhook + callback deliveries of one reference confirm the booking exactly once', async () => {
  const { db, b } = await setup();
  try {
    const { reference } = await initializePayment(db, b.id, null);
    await mockMarkPaid(db, reference);
    const raw = body(reference);
    const sig = computeSignature(raw, MOCK_SECRET);
    const results = await Promise.all([
      ...Array.from({ length: 8 }, () => handleWebhook(db, raw, sig).then((r) => r.body.result)),
      ...Array.from({ length: 4 }, () => processReference(db, reference).then((r) => r.result)),
    ]);
    assert.equal(results.filter((r) => r === 'processed').length, 1, JSON.stringify(results));
    assert.equal(results.filter((r) => r === 'already_processed').length, 11, JSON.stringify(results));
    assert.equal((await db.one(`SELECT COUNT(*) c FROM audit_log WHERE booking_id=$1 AND action='PAYMENT_CONFIRMED'`, [b.id])).c, 1);
    assert.equal((await db.one(`SELECT COUNT(*) c FROM notifications WHERE booking_id=$1 AND type='PAYMENT_SUCCESS'`, [b.id])).c, 1);
    assert.equal((await getBooking(db, b.id))!.payment_status, 'PAID');
  } finally { resetNow(); }
});

test('webhook: unknown reference, non-charge events and junk are handled safely', async () => {
  const { db } = await setup();
  try {
    const raw = body('TS-BOOKING-999-abcdef1234');
    assert.equal((await handleWebhook(db, raw, computeSignature(raw, MOCK_SECRET))).body.result, 'unknown_reference');
    const raw2 = body('x', 'transfer.success');
    assert.equal((await handleWebhook(db, raw2, computeSignature(raw2, MOCK_SECRET))).body.ignored, true);
    const junk = Buffer.from('not json');
    assert.equal((await handleWebhook(db, junk, computeSignature(junk, MOCK_SECRET))).status, 400);
  } finally { resetNow(); }
});

test('RACE: someone completes a booking for the slot first; the late payment is NOT confirmed, is flagged NEEDS_REFUND, customer is told', async () => {
  const { db, b, customerIds, barberId, serviceIds } = await setup();
  try {
    const { reference } = await initializePayment(db, b.id, null);
    // the unpaid attempt reserved nothing, so another customer can take the very same slot
    const other = await createBooking(db, customerIds[1], { barber_id: barberId, service_id: serviceIds[1], date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' });
    assert.equal(other.status, 'CONFIRMED');
    await mockMarkPaid(db, reference);
    const r = await processReference(db, reference);
    assert.equal(r.result, 'slot_taken');
    const bk = (await getBooking(db, b.id))!;
    assert.equal(bk.status, 'CANCELLED');
    assert.equal(bk.payment_status, 'VOID');
    assert.equal((await getBooking(db, other.id))!.status, 'CONFIRMED', 'the other customer keeps the slot');
    const p = await db.one('SELECT status, refund_status, refund_reason FROM payments WHERE reference=$1', [reference]);
    assert.equal(p.status, 'SUCCESS');
    assert.ok(['NEEDS_REFUND', 'REFUND_REQUESTED'].includes(p.refund_status), 'money flagged for refund, never lost');
    assert.match(p.refund_reason, /Slot was taken/);
    const n = await db.many(`SELECT type, body FROM notifications WHERE user_id=$1 AND booking_id=$2`, [customerIds[0], b.id]);
    assert.ok(n.some((x: any) => /refund/i.test(x.body) && /not confirmed/i.test(x.body)));
    assert.equal((await db.many(`SELECT 1 FROM notifications n JOIN barbers br ON br.user_id=n.user_id WHERE br.id=$1 AND n.booking_id=$2`, [barberId, b.id])).length, 0, 'barber never hears about the failed attempt');
    assert.equal((await processReference(db, reference)).result, 'already_processed');
  } finally { resetNow(); }
});

test('payment arriving after the attempt was already closed (expired + swept) is never confirmed and is flagged for refund', async () => {
  const { db, b } = await setup();
  try {
    const { reference } = await initializePayment(db, b.id, null);
    setNow(`${WED}T08:40:00+01:00`);
    await expireHolds(db);
    assert.equal((await getBooking(db, b.id))!.status, 'CANCELLED');
    await mockMarkPaid(db, reference);
    assert.equal((await processReference(db, reference)).result, 'refund_due');
    const bk = (await getBooking(db, b.id))!;
    assert.equal(bk.status, 'CANCELLED');
    assert.notEqual(bk.payment_status, 'PAID');
    assert.ok(['NEEDS_REFUND', 'REFUND_REQUESTED'].includes((await db.one('SELECT refund_status FROM payments WHERE reference=$1', [reference])).refund_status));
  } finally { resetNow(); }
});

test('an expired-but-unreleased hold still lets the paying customer keep their slot (nobody else took it)', async () => {
  const { db, b } = await setup();
  try {
    const { reference } = await initializePayment(db, b.id, null);
    setNow(`${WED}T08:40:00+01:00`);
    await mockMarkPaid(db, reference);
    assert.equal((await processReference(db, reference)).result, 'processed');
    assert.equal((await getBooking(db, b.id))!.status, 'CONFIRMED');
  } finally { resetNow(); }
});
