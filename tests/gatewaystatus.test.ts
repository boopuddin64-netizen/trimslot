import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { freshDb, setNow, resetNow, WED } from './helpers';
import { bootApp } from './httpHelpers';
import { createBooking, expireHolds, getBooking, applyVerifiedPayment } from '../src/bookingService';
import { initializePayment, processReference, reconcileRecentPayments, handleWebhook, computeSignature, setGatewayVerifier, parseGatewayData, isSureUnpaid } from '../src/paystack';
import { config } from '../src/config';

const verdictOf = (status: unknown) => isSureUnpaid(parseGatewayData({ status }, 'R'));

test('parseGatewayData: only success is paid; only abandoned / failed / not_found are SURE unpaid; every other status is unknown', () => {
  assert.equal(parseGatewayData({ status: 'success' }, 'R').ok, true);
  for (const s of ['abandoned', 'failed', 'not_found', 'ABANDONED', ' Failed ']) assert.equal(verdictOf(s), true, s);
  for (const s of ['pending', 'ongoing', 'processing', 'queued', 'reversed', 'partial_debit', '', 'something_new']) { assert.equal(parseGatewayData({ status: s }, 'R').ok, false, s); assert.equal(verdictOf(s), false, `${s} must not count as not paid`); }
  assert.equal(parseGatewayData({}, 'R').ok, false); assert.equal(isSureUnpaid(parseGatewayData({}, 'R')), false, 'an answer with no status is unknown');
  assert.equal(isSureUnpaid(parseGatewayData(undefined, 'R')), false);
  assert.equal(isSureUnpaid(parseGatewayData({ status: 'success' }, 'R')), false, 'paid is never "unpaid"');
});

async function setup() {
  const s = await freshDb(); setNow(`${WED}T08:00:00+01:00`);
  await s.db.query('UPDATE barbers SET paystack_subaccount=$2 WHERE id=$1', [s.barberId, 'ACCT_test']);
  return s;
}
const mkOnline = (s: any, time: string) => createBooking(s.db, s.customerIds[0], { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time, payment_option: 'ONLINE' });
const bodies = async (db: any, uid: number) => (await db.many('SELECT body FROM notifications WHERE user_id=$1 AND type=$2', [uid, 'BOOKING_INCOMPLETE'])).map((n: any) => n.body).join(' | ');

test('processReference: abandoned/failed -> not_paid; pending/processing/reversed/unknown -> unverified (payment stays open)', async () => {
  const s = await setup();
  try {
    const b = await mkOnline(s, '10:00'); const p = await initializePayment(s.db, b.id, null);
    for (const [status, want] of [['abandoned', 'not_paid'], ['failed', 'not_paid'], ['pending', 'unverified'], ['ongoing', 'unverified'], ['processing', 'unverified'], ['reversed', 'unverified']] as const) {
      setGatewayVerifier(async (_d, ref) => parseGatewayData({ status }, ref));
      assert.equal((await processReference(s.db, p.reference)).result, want, status);
    }
    assert.equal((await s.db.one('SELECT status FROM payments WHERE reference=$1', [p.reference])).status, 'INITIATED');
  } finally { setGatewayVerifier(null); resetNow(); }
});

for (const status of ['pending', 'ongoing', 'processing', 'reversed']) {
  test(`hold closing: Paystack says "${status}" -> never "not charged"; kept open for an hour, then closed with the honest "could not check" text`, async () => {
    const s = await setup();
    try {
      const b = await mkOnline(s, '10:00'); await initializePayment(s.db, b.id, null);
      setGatewayVerifier(async (_d, ref) => parseGatewayData({ status }, ref));
      setNow(`${WED}T08:30:00+01:00`);   // 15 min past the hold
      assert.equal(await expireHolds(s.db), 0);
      assert.equal((await getBooking(s.db, b.id))!.status, 'PENDING_PAYMENT', 'kept open');
      assert.equal(await bodies(s.db, s.customerIds[0]), '');
      setNow(`${WED}T09:30:00+01:00`);   // more than an hour past the hold: closed, honestly
      assert.equal(await expireHolds(s.db), 1);
      const txt = await bodies(s.db, s.customerIds[0]);
      assert.doesNotMatch(txt, /not charged/i); assert.match(txt, /could not check your payment/);
    } finally { setGatewayVerifier(null); resetNow(); }
  });
}

test('hold closing: a later "success" after "pending" still confirms the booking', async () => {
  const s = await setup();
  try {
    const b = await mkOnline(s, '10:00'); const p = await initializePayment(s.db, b.id, null);
    setGatewayVerifier(async (_d, ref) => parseGatewayData({ status: 'pending' }, ref));
    setNow(`${WED}T08:30:00+01:00`); await expireHolds(s.db);
    setGatewayVerifier(async (_d, ref) => parseGatewayData({ status: 'success', amount: p.amount_kobo, requested_amount: p.amount_kobo, currency: 'NGN' }, ref));
    setNow(`${WED}T08:33:00+01:00`);   // next 2-minute window
    assert.equal(await expireHolds(s.db), 0);
    assert.equal((await getBooking(s.db, b.id))!.status, 'CONFIRMED');
  } finally { setGatewayVerifier(null); resetNow(); }
});

test('reconcile: a "pending" answer is not recorded as an answer and the payment is asked about again later', async () => {
  const s = await setup();
  try {
    const b = await mkOnline(s, '10:00'); const p = await initializePayment(s.db, b.id, null);
    await s.db.query(`UPDATE bookings SET status='CANCELLED', payment_status='VOID', cancelled_by='system' WHERE id=$1`, [b.id]);
    let calls = 0; setGatewayVerifier(async (_d, ref) => { calls++; return parseGatewayData({ status: 'pending' }, ref); });
    setNow(`${WED}T08:30:00+01:00`);
    assert.deepEqual(await reconcileRecentPayments(s.db), { checked: 1, confirmed: 0, refunds: 0 });
    assert.equal((await s.db.one(`SELECT COUNT(*)::int c FROM rate_limits WHERE key=$1`, [`reconok:${p.reference}`])).c, 0, 'no "answered" marker');
    assert.equal((await s.db.one('SELECT status FROM payments WHERE reference=$1', [p.reference])).status, 'INITIATED');
    setNow(`${WED}T08:45:00+01:00`);   // next 10-minute window
    await reconcileRecentPayments(s.db); assert.equal(calls, 2);
    // and a sure "abandoned" is recorded as answered
    setGatewayVerifier(async (_d, ref) => parseGatewayData({ status: 'abandoned' }, ref));
    setNow(`${WED}T09:00:00+01:00`); await reconcileRecentPayments(s.db);
    assert.equal((await s.db.one(`SELECT COUNT(*)::int c FROM rate_limits WHERE key=$1`, [`reconok:${p.reference}`])).c, 1);
  } finally { setGatewayVerifier(null); resetNow(); }
});

test('webhook: charge.success but Paystack verify says "pending" -> 500 so Paystack retries; "abandoned" -> 200 (nothing to retry)', async () => {
  const s = await setup();
  try {
    const b = await mkOnline(s, '10:00'); const p = await initializePayment(s.db, b.id, null);
    const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: p.reference } }));
    const sig = computeSignature(raw, config.webhookSecret);
    setGatewayVerifier(async (_d, ref) => parseGatewayData({ status: 'pending' }, ref));
    assert.equal((await handleWebhook(s.db, raw, sig)).status, 500);
    setGatewayVerifier(async (_d, ref) => parseGatewayData({ status: 'abandoned' }, ref));
    const r = await handleWebhook(s.db, raw, sig); assert.equal(r.status, 200); assert.equal(r.body.result, 'not_paid');
  } finally { setGatewayVerifier(null); resetNow(); }
});

test('HTTP: return page and "Check payment" say "not told us yet" (checked) for pending, and "did not go through" only for abandoned', async () => {
  const c = await bootApp();
  try {
    const cc = await c.chidi();
    const bk = await c.call('POST', '/api/bookings', { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time: '10:00', payment_option: 'ONLINE' }, cc);
    const pay = await c.call('POST', `/api/bookings/${bk.json.booking.id}/pay`, {}, cc);
    const ref = pay.json.reference;
    setGatewayVerifier(async (_d, r) => parseGatewayData({ status: 'processing' }, r));
    const v = await c.call('POST', `/api/bookings/${bk.json.booking.id}/verify`, {}, cc);
    assert.equal(v.json.result, 'unverified');
    const cb = await fetch(c.base + `/api/payments/callback?reference=${ref}`, { redirect: 'manual' });
    assert.match(cb.headers.get('location')!, /pay=checked$/);
    setGatewayVerifier(async (_d, r) => parseGatewayData({ status: 'abandoned' }, r));
    const cb2 = await fetch(c.base + `/api/payments/callback?reference=${ref}`, { redirect: 'manual' });
    assert.match(cb2.headers.get('location')!, /pay=not_paid$/);
  } finally { setGatewayVerifier(null); c.close(); }
});

test('the customer is never sent the refund approval deadline and the page does not show it', async () => {
  const c = await bootApp();
  try {
    const cc = await c.chidi();
    const bk = await c.call('POST', '/api/bookings', { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time: '15:00', payment_option: 'ONLINE' }, cc);
    await c.db.tx((t: any) => applyVerifiedPayment(t, bk.json.booking.id, 'PAYSTACK'));
    const can = await c.call('POST', `/api/bookings/${bk.json.booking.id}/cancel`, {}, cc);
    assert.equal(can.status, 200, can.text);
    for (const url of [`/api/bookings/${bk.json.booking.id}`, '/api/bookings']) {
      const r = await c.call('GET', url, undefined, cc);
      assert.match(r.text, /REFUND_PENDING/);
      assert.doesNotMatch(r.text, /due_at/);
    }
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.doesNotMatch(js, /We approve it by|at the latest/);
    assert.match(js, /We are checking it\. You will get a message soon\./);
  } finally { c.close(); }
});
