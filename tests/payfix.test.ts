import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'net';
import { freshDb, setNow, resetNow, WED } from './helpers';
import { createApp } from '../src/app';
import { createBooking, getBooking } from '../src/bookingService';
import { initializePayment, processReference, setGatewayVerifier, parseGatewayData, amountMatches } from '../src/paystack';
import { setPayoutGateway } from '../src/payouts';
import { AppError } from '../src/errors';

test('parseGatewayData / amountMatches: Paystack fee pass-through is accepted, real mismatches are not', () => {
  // exactly what production sent: price 2,500.00 requested, customer paid 2,639.60 incl. fee
  const v = parseGatewayData({ status: 'success', amount: 263960, requested_amount: 250000, fees: 13960 }, 'R');
  assert.equal(v.ok, true); assert.deepEqual(amountMatches(v, 250000), { fee_kobo: 13960, paid_kobo: 263960 });
  assert.deepEqual(amountMatches(parseGatewayData({ status: 'success', amount: 250000, requested_amount: 250000 }, 'R'), 250000), { fee_kobo: 0, paid_kobo: 250000 });
  assert.deepEqual(amountMatches(parseGatewayData({ status: 'success', amount: 250000 }, 'R'), 250000), { fee_kobo: 0, paid_kobo: 250000 }, 'no requested_amount: exact match');
  assert.equal(amountMatches(parseGatewayData({ status: 'success', amount: 263960 }, 'R'), 250000), null, 'no requested_amount and not exact => reject');
  assert.equal(amountMatches(parseGatewayData({ status: 'success', amount: 100000, requested_amount: 100000 }, 'R'), 250000), null, 'wrong price');
  assert.equal(amountMatches(parseGatewayData({ status: 'success', amount: 200000, requested_amount: 250000 }, 'R'), 250000), null, 'underpaid');
  assert.equal(amountMatches(parseGatewayData({ status: 'success', amount: 500000, requested_amount: 250000 }, 'R'), 250000), null, 'absurd "fee"');
  assert.equal(parseGatewayData({ status: 'abandoned' }, 'R').ok, false);
});

test('payment with Paystack fee on top confirms the booking (regression: amount_mismatch left paid customers unconfirmed)', async () => {
  const { db, barberId, customerIds, serviceIds } = await freshDb();
  setNow(`${WED}T08:00:00+01:00`);
  try {
    const b = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[1], date: WED, time: '10:00', payment_option: 'ONLINE' });
    const { reference, amount_kobo } = await initializePayment(db, b.id, 'c@x.com');
    setGatewayVerifier(async (_d, ref) => parseGatewayData({ status: 'success', amount: Math.round((amount_kobo + 10000) / 0.985), requested_amount: amount_kobo, fees: 5000 }, ref));
    const r = await processReference(db, reference);
    assert.equal(r.result, 'processed');
    const bk = (await getBooking(db, b.id))!; assert.equal(bk.status, 'CONFIRMED'); assert.equal(bk.payment_status, 'PAID');
    const p = await db.one('SELECT status, amount_kobo, paid_kobo, gateway_fee_kobo FROM payments WHERE reference=$1', [reference]);
    assert.equal(p.status, 'SUCCESS'); assert.equal(p.amount_kobo, amount_kobo); assert.ok(p.paid_kobo > amount_kobo); assert.equal(p.gateway_fee_kobo, p.paid_kobo - amount_kobo);
    assert.equal((await processReference(db, reference)).result, 'already_processed', 'idempotent');
    // a genuinely wrong amount is still refused
    const b2 = await createBooking(db, customerIds[1], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '12:00', payment_option: 'ONLINE' });
    const p2 = await initializePayment(db, b2.id, 'd@x.com');
    setGatewayVerifier(async (_d, ref) => parseGatewayData({ status: 'success', amount: 1000, requested_amount: 1000 }, ref));
    assert.equal((await processReference(db, p2.reference)).result, 'amount_mismatch');
    assert.equal((await getBooking(db, b2.id))!.status, 'PENDING_PAYMENT');
  } finally { setGatewayVerifier(null); resetNow(); }
});

async function boot() {
  const s = await freshDb(); setNow(`${WED}T08:00:00+01:00`); process.env.REQUIRE_PAYOUT = '1';
  const server = createApp(s.db).listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (id: string, pw: string) => (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: id, password: pw }) })).headers.get('set-cookie')!.split(';')[0];
  const mike = await login('mike@trimslot.demo', 'Barber123!'); const chidi = await login('chidi@trimslot.demo', 'Customer123!');
  const call = (cookie: string) => async (p: string, o: any = {}) => { const r = await fetch(base + '/api' + p, { ...o, headers: { 'Content-Type': 'application/json', cookie }, body: o.body ? JSON.stringify(o.body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  return { ...s, server, base, B: call(mike), C: call(chidi) };
}

test('payouts: online payment is blocked until the barber sets up a payout account; setup flow resolves + saves; account number never stored', async () => {
  const s = await boot();
  try {
    setPayoutGateway({ resolve: async (bank, acct) => { if (acct === '0000000000') throw new AppError(400, 'BAD_ACCOUNT', 'Could not find that account.'); return 'MIKE ADEBAYO OWOLABI'; }, subaccount: async () => 'ACCT_testpayout1' });
    const st0 = (await s.B('/barber/payout')).body; assert.equal(st0.status, 'NONE'); assert.equal(st0.required, true);
    const page = (await s.C(`/barbers/${s.barberId}`)).body; assert.equal(page.booking.online_payments, false, 'customers are told online payments are unavailable');
    const blocked = await s.C('/bookings', { method: 'POST', body: { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '10:00', payment_option: 'ONLINE' } });
    assert.equal(blocked.status, 409); assert.equal(blocked.body.error.code, 'PAYOUT_NOT_SETUP'); assert.match(blocked.body.error.message, /Pay on arrival/);
    assert.equal((await s.db.one(`SELECT COUNT(*)::int c FROM bookings`)).c, 0, 'no half-made booking left behind');
    const poa = await s.C('/bookings', { method: 'POST', body: { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' } });
    assert.equal(poa.status, 201, 'pay on arrival still works');
    assert.equal((await s.C(`/plans/${(await s.db.one('SELECT id FROM plans LIMIT 1').catch(() => ({ id: 1 }))).id}/buy`, { method: 'POST' })).status >= 400, true, 'plan purchase blocked too');
    // banks + validation
    const banks = (await s.B('/barber/payout/banks')).body.banks; assert.ok(banks.length > 3); const code = banks[0].code;
    assert.equal((await s.B('/barber/payout/resolve', { method: 'POST', body: { bank_code: code, account_number: '12345' } })).status, 400, 'account number must be 10 digits');
    assert.equal((await s.B('/barber/payout/resolve', { method: 'POST', body: { bank_code: code, account_number: '0000000000' } })).status, 400, 'unknown account -> clear 400');
    assert.equal((await s.B('/barber/payout/resolve', { method: 'POST', body: { bank_code: code, account_number: '0123456789' } })).body.account_name, 'MIKE ADEBAYO OWOLABI');
    assert.equal((await s.B('/barber/payout', { method: 'POST', body: { bank_code: '999', account_number: '0123456789' } })).status, 400, 'bank must be in the list');
    assert.equal((await s.C('/barber/payout')).status, 403, 'customers cannot use payout routes');
    const saved = await s.B('/barber/payout', { method: 'POST', body: { bank_code: code, account_number: '0123456789', account_name: 'IGNORED CLIENT NAME' } });
    assert.equal(saved.status, 200); assert.equal(saved.body.status, 'ACTIVE'); assert.equal(saved.body.account_last4, '6789'); assert.equal(saved.body.account_name, 'MIKE ADEBAYO OWOLABI');
    const row = await s.db.one('SELECT * FROM barbers WHERE id=$1', [s.barberId]); assert.equal(row.paystack_subaccount, 'ACCT_testpayout1');
    assert.ok(!JSON.stringify(row).includes('0123456789'), 'full account number is never stored');
    assert.equal((await s.C(`/barbers/${s.barberId}`)).body.booking.online_payments, true);
    const ok = await s.C('/bookings', { method: 'POST', body: { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '11:00', payment_option: 'ONLINE' } });
    assert.equal(ok.status, 201, 'online booking allowed once payouts are active');
    assert.equal((await s.C(`/bookings/${ok.body.booking.id}/pay`, { method: 'POST', body: {} })).status, 200);
    // the barber cannot overwrite the subaccount with an arbitrary code through the profile form
    await s.B('/barber/profile', { method: 'PUT', body: { shop_name: 'Mikes', paystack_subaccount: 'ACCT_evil' } });
    assert.equal((await s.db.one('SELECT paystack_subaccount s FROM barbers WHERE id=$1', [s.barberId])).s, 'ACCT_testpayout1');
    assert.equal((await s.B('/barber/profile')).body.profile.payout.status, 'ACTIVE');
  } finally { setPayoutGateway({}); delete process.env.REQUIRE_PAYOUT; s.server.close(); resetNow(); }
});

test('callback return URL: fee-inclusive payment redirects into the hash route as processed; verify-by-reference works when the webhook is late; admin re-verify recovers an INITIATED payment', async () => {
  const s = await boot(); delete process.env.REQUIRE_PAYOUT; process.env.CRON_SECRET = 'test-admin-key-0123456789';
  try {
    const noFollow = (p: string, o: any = {}) => fetch(s.base + p, { redirect: 'manual', ...o });
    const login = await fetch(s.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'chidi@trimslot.demo', password: 'Customer123!' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const mk = async (time: string) => { const b = await createBooking(s.db, s.customerIds[0], { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time, payment_option: 'ONLINE' }); const p = await initializePayment(s.db, b.id, 'c@x.com'); return { b, p }; };
    const feeGateway = (amount: number) => async (_d: any, ref: string) => parseGatewayData({ status: 'success', amount: Math.round(amount * 1.0545), requested_amount: amount }, ref);
    // 1) the redirect from Paystack (webhook has NOT arrived yet) confirms by reference
    const a = await mk('10:00'); setGatewayVerifier(feeGateway(a.p.amount_kobo));
    const cb = await noFollow(`/api/payments/callback?reference=${a.p.reference}&trxref=${a.p.reference}`);
    assert.equal(cb.status, 302); assert.equal(cb.headers.get('location'), `/#/booking/${a.b.id}?pay=processed`);
    assert.equal((await getBooking(s.db, a.b.id))!.status, 'CONFIRMED');
    // 2) callback arrives before Paystack has the payment => not_paid; the app then calls verify, which succeeds once Paystack has it
    const b = await mk('12:00'); setGatewayVerifier(async (_d, ref) => parseGatewayData({ status: 'abandoned' }, ref));
    const cb2 = await noFollow(`/api/payments/callback?reference=${b.p.reference}`); assert.equal(cb2.headers.get('location'), `/#/booking/${b.b.id}?pay=not_paid`);
    assert.equal((await getBooking(s.db, b.b.id))!.status, 'PENDING_PAYMENT');
    setGatewayVerifier(feeGateway(b.p.amount_kobo));
    const v = await fetch(s.base + `/api/bookings/${b.b.id}/verify`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json());
    assert.equal(v.result, 'processed'); assert.equal(v.booking.status, 'CONFIRMED');
    // 3) admin re-verify (old failed attempt that never confirmed)
    const c = await mk('14:00'); setGatewayVerifier(async (_d, ref) => parseGatewayData({ status: 'success', amount: c.p.amount_kobo + 5000, requested_amount: c.p.amount_kobo }, ref));
    const rv = await fetch(s.base + `/api/admin/payments/${c.p.reference}/reverify`, { method: 'POST', headers: { Authorization: 'Bearer test-admin-key-0123456789', 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json());
    assert.equal(rv.result, 'processed'); assert.equal(rv.payment.status, 'SUCCESS');
    assert.equal((await fetch(s.base + `/api/admin/payments/${c.p.reference}/reverify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  } finally { setGatewayVerifier(null); s.server.close(); resetNow(); }
});

test('sweep: stale unpaid plan checkouts are dropped, but one with a signed gateway charge on record is KEPT (regression: paid-but-unconfirmed plan purchases vanished after 2 days)', async () => {
  const { runSweep } = await import('../src/sweep');
  const { initializePlanPurchase } = await import('../src/paystack');
  const s = await freshDb();
  const plan = (await s.db.one<any>(`INSERT INTO plans (barber_id, name, price_kobo, sessions, validity_days, active) VALUES ($1,'Gold',1000000,4,60,TRUE) RETURNING id`, [s.barberId])).id;
  const a = await initializePlanPurchase(s.db, s.customerIds[0], plan, null);   // abandoned: no gateway event
  const b = await initializePlanPurchase(s.db, s.customerIds[1] ?? s.customerIds[0], plan, null);   // charged at the gateway (signed webhook recorded) but never confirmed
  await s.db.query(`INSERT INTO payment_events (source, event_key, event_type, reference, signature_valid, payload, result, last_result) VALUES ('WEBHOOK','k-${b.reference}','charge.success',$1,TRUE,'{}','amount_mismatch','amount_mismatch')`, [b.reference]);
  await s.db.query(`UPDATE plan_purchases SET created_at = now() - interval '3 days'`);
  await runSweep(s.db);
  const left = (await s.db.many<any>('SELECT id FROM plan_purchases')).map((r) => r.id);
  assert.ok(!left.includes(a.purchase_id), 'abandoned purchase removed');
  assert.ok(left.includes(b.purchase_id), 'purchase with a signed charge kept');
  assert.equal((await s.db.one<any>('SELECT COUNT(*)::int c FROM payments WHERE reference=$1', [b.reference])).c, 1, 'its payment row kept too');
});
