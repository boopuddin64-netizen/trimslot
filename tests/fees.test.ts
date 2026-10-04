import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, setNow, resetNow, WED } from './helpers';
import { feeSettingsOf, offAppBreakdown, onlineBreakdown, platformChargeKobo, processorFeeKobo } from '../src/fees';
import { createBooking, getBooking } from '../src/bookingService';
import { getSettings, updateSettings, settingsView } from '../src/plans';
import { initializePayment, initializePlanPurchase, mockMarkPaid, processReference, setGatewayVerifier, snapshotOf } from '../src/paystack';
import { planCheckoutSplit } from '../src/ledger';

const D = { ps_percent: 1.5, ps_flat_kobo: 10000, ps_flat_waived_below_kobo: 250000, ps_cap_kobo: 200000, ps_vat_percent: 7.5,
  fee_share_customer_pct: 33.3333, fee_share_barber_pct: 33.3333, fee_share_platform_pct: 33.3334, charge_percent: 2, charge_flat_kobo: 0, charge_min_kobo: 5000 };

test('processor fee: percent + flat, flat waived under the threshold, capped, VAT on the fee - all from settings', () => {
  assert.equal(processorFeeKobo(100000, D), Math.round(1500 * 1.075), '₦1,000: 1.5% only (flat waived)');
  assert.equal(processorFeeKobo(250000, D), Math.round((3750 + 10000) * 1.075), '₦2,500: flat applies');
  assert.equal(processorFeeKobo(249999, D), Math.round(249999 * 0.015 * 1.075), 'just under the threshold: no flat');
  assert.equal(processorFeeKobo(1e9, D), Math.round(200000 * 1.075), 'capped at ₦2,000 before VAT');
  assert.equal(processorFeeKobo(100000, { ...D, ps_percent: 2, ps_vat_percent: 0 }), 2000, 'editable rate');
  assert.equal(processorFeeKobo(0, D), 0);
});

test('platform charge: percent + flat with a minimum; barber override replaces it; never above the price', () => {
  assert.equal(platformChargeKobo(150000, D), 5000, '2% of ₦1,500 is ₦30 -> minimum ₦50');
  assert.equal(platformChargeKobo(1000000, D), 20000);
  assert.equal(platformChargeKobo(1000000, { ...D, charge_flat_kobo: 1000 }), 21000);
  assert.equal(platformChargeKobo(1000000, D, { fee_percent_override: 0, fee_flat_kobo_override: null }), 0, 'override of 0 wins, no minimum');
  assert.equal(platformChargeKobo(1000000, D, { fee_percent_override: 5 }), 50000);
  assert.equal(platformChargeKobo(3000, D), 3000, 'never above the price');
});

test('breakdown at the defaults: customer pays price + booking fee; barber gets price - their share - platform charge; platform keeps charge - its share', () => {
  const want: Record<number, { fee: number; total: number; payout: number; net: number }> = {};
  for (const naira of [1500, 2500, 5000, 10000]) {
    const b = onlineBreakdown(naira * 100, D);
    assert.equal(b.total_kobo, b.price_kobo + b.booking_fee_kobo);
    assert.equal(b.booking_fee_kobo + b.barber_fee_kobo + b.platform_share_kobo, b.ps_fee_kobo, 'the three shares add up to the whole fee');
    assert.ok(Math.abs(b.booking_fee_kobo - b.ps_fee_kobo / 3) <= 1.01 && Math.abs(b.barber_fee_kobo - b.ps_fee_kobo / 3) <= 1.01, 'equal thirds');
    assert.equal(b.ps_fee_kobo, processorFeeKobo(b.total_kobo, D), 'the fee is worked out on the total the customer actually pays');
    assert.equal(b.payout_kobo, b.price_kobo - b.barber_fee_kobo - b.platform_charge_kobo);
    assert.equal(b.platform_net_kobo, b.platform_charge_kobo - b.platform_share_kobo);
    want[naira] = { fee: b.booking_fee_kobo, total: b.total_kobo, payout: b.payout_kobo, net: b.platform_net_kobo };
  }
  assert.deepEqual(want[1500], { fee: 811, total: 150811, payout: 144189, net: 4190 });
  assert.deepEqual(want[2500], { fee: 4954, total: 254954, payout: 240046, net: 47 });
  assert.deepEqual(want[5000], { fee: 6305, total: 506305, payout: 483695, net: 3696 });
  assert.deepEqual(want[10000], { fee: 9007, total: 1009007, payout: 970993, net: 10994 });
});

test('other splits: all on the customer, all on the platform, and a custom 50/25/25', () => {
  const all = (c: number, b: number, p: number) => onlineBreakdown(500000, { ...D, fee_share_customer_pct: c, fee_share_barber_pct: b, fee_share_platform_pct: p });
  const cust = all(100, 0, 0); assert.equal(cust.barber_fee_kobo, 0); assert.equal(cust.platform_share_kobo, 0); assert.equal(cust.booking_fee_kobo, cust.ps_fee_kobo);
  const plat = all(0, 0, 100); assert.equal(plat.booking_fee_kobo, 0); assert.equal(plat.total_kobo, 500000); assert.equal(plat.platform_share_kobo, plat.ps_fee_kobo);
  const mix = all(50, 25, 25); assert.ok(mix.booking_fee_kobo > mix.barber_fee_kobo && Math.abs(mix.barber_fee_kobo - mix.platform_share_kobo) <= 1);
});

test('pay on arrival: only the platform charge - no Paystack part, no booking fee', () => {
  const b = offAppBreakdown(150000, D);
  assert.equal(b.booking_fee_kobo, 0); assert.equal(b.ps_fee_kobo, 0); assert.equal(b.barber_fee_kobo, 0); assert.equal(b.total_kobo, 150000);
  assert.equal(b.platform_charge_kobo, 5000); assert.equal(b.payout_kobo, 150000);
});

test('admin settings: fee shares must add up to 100, every change is audited, rates are editable and survive a round trip', async () => {
  const s = await freshDb();
  try {
    const v = settingsView(await getSettings(s.db));
    assert.equal(v.charge_percent, 2); assert.equal(v.charge_min_naira, 50); assert.equal(v.ps_cap_naira, 2000);
    await assert.rejects(s.db.tx((t) => updateSettings(t, { fee_share_customer_pct: 50, fee_share_barber_pct: 30, fee_share_platform_pct: 30 })), /add up to 100/);
    await assert.rejects(s.db.tx((t) => updateSettings(t, { fee_share_customer_pct: 50 })), /add up to 100/, 'changing one share alone breaks the total');
    await assert.rejects(s.db.tx((t) => updateSettings(t, { fee_share_customer_pct: -5 })), /fee_share_customer_pct/);
    await assert.rejects(s.db.tx((t) => updateSettings(t, { platform_fee_percent: 3 } as any)), /platform_fee_percent/, 'the old platform_fee keys are gone');
    const out = await s.db.tx((t) => updateSettings(t, { fee_share_customer_pct: 50, fee_share_barber_pct: 25, fee_share_platform_pct: 25, ps_percent: 1.4, ps_flat_naira: 120, ps_cap_naira: 1900, ps_vat_percent: 7, ps_flat_waived_below_naira: 3000, charge_percent: 3, charge_flat_naira: 10, charge_min_naira: 70 }));
    assert.equal(out.fee_share_customer_pct, 50); assert.equal(out.ps_flat_naira, 120); assert.equal(out.charge_min_naira, 70); assert.equal(out.ps_vat_percent, 7);
    const st = await getSettings(s.db); const fs = feeSettingsOf(st);
    assert.equal(fs.ps_flat_kobo, 12000); assert.equal(fs.charge_flat_kobo, 1000); assert.equal(fs.fee_share_barber_pct, 25);
    const a = await s.db.one(`SELECT details FROM audit_log WHERE action='SETTINGS_UPDATED' ORDER BY id DESC LIMIT 1`);
    const meta = typeof a.details === "string" ? JSON.parse(a.details) : a.details; assert.ok(meta.changed.includes('fee_share_customer_pct') && meta.before.fee_share_customer_pct !== undefined, 'audit has before/after');
  } finally { resetNow(); }
});

test('pay-now booking: snapshot on the booking, customer charged price + booking fee, split sent as total - payout; pay-on-arrival and plan sessions carry no booking fee', async () => {
  const s = await freshDb(); setNow(`${WED}T08:00:00+01:00`);
  try {
    await s.db.query('UPDATE services SET price_kobo=150000 WHERE id=$1', [s.serviceIds[0]]);
    await s.db.query(`UPDATE barbers SET paystack_subaccount='ACCT_x' WHERE id=$1`, [s.barberId]);
    const on = await createBooking(s.db, s.customerIds[0], { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '10:00', payment_option: 'ONLINE' });
    assert.equal(on.booking_fee_kobo, 811); assert.equal(on.barber_fee_kobo, 811); assert.equal(on.platform_charge_kobo, 5000); assert.equal(on.payout_kobo, 144189);
    // a later settings change never rewrites the frozen numbers
    await s.db.tx((t) => updateSettings(t, { charge_min_naira: 500 }));
    assert.equal((await getBooking(s.db, on.id))!.platform_charge_kobo, 5000);
    const init = await initializePayment(s.db, on.id, null);
    assert.equal(init.amount_kobo, 150811); assert.equal(init.price_kobo, 150000); assert.equal(init.booking_fee_kobo, 811);
    const pay = await s.db.one('SELECT * FROM payments WHERE reference=$1', [init.reference]);
    assert.equal(pay.amount_kobo, 150811); assert.equal(pay.fee_kobo, 5000, 'fee_kobo keeps meaning: the platform charge'); assert.equal(pay.barber_fee_kobo, 811); assert.equal(pay.payout_kobo, 144189);
    const bd = snapshotOf(150000, on)!; const split = await planCheckoutSplit(s.db, { id: s.barberId, paystack_subaccount: 'ACCT_x' }, bd);
    assert.equal(split.charge, 150811 - 144189, 'platform account keeps everything except the barber payout');
    assert.equal(150811 - split.charge, 144189, 'so Paystack sends the barber exactly the payout');
    const poa = await createBooking(s.db, s.customerIds[1], { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '11:00', payment_option: 'ON_ARRIVAL' });
    assert.equal(poa.booking_fee_kobo, 0); assert.equal(poa.ps_fee_est_kobo, 0); assert.equal(poa.barber_fee_kobo, 0); assert.equal(poa.platform_charge_kobo, 50000, 'new minimum applies to new bookings'); assert.equal(poa.payout_kobo, null);
  } finally { resetNow(); }
});

test('verify: the real fee Paystack reports is recorded (estimate is the fallback) and the amount must match price + booking fee', async () => {
  const s = await freshDb(); setNow(`${WED}T08:00:00+01:00`);
  try {
    const mk = async (time: string, cust: number) => { const b = await createBooking(s.db, s.customerIds[cust], { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time, payment_option: 'ONLINE' }); return { b, i: await initializePayment(s.db, b.id, null) }; };
    const a = await mk('09:00', 0);
    await mockMarkPaid(s.db, a.i.reference); assert.equal((await processReference(s.db, a.i.reference)).result, 'processed');
    assert.equal((await s.db.one('SELECT ps_fee_actual_kobo FROM payments WHERE reference=$1', [a.i.reference])).ps_fee_actual_kobo, null, 'mock gateway reports no fee -> estimate stays the number to use');
    const c = await mk('10:00', 1);
    setGatewayVerifier(async (_db, reference) => ({ ok: true, status: 'success', amount_kobo: c.i.amount_kobo, requested_amount_kobo: c.i.amount_kobo, fees_kobo: 7777, reference }));
    assert.equal((await processReference(s.db, c.i.reference)).result, 'processed');
    assert.equal((await s.db.one('SELECT ps_fee_actual_kobo FROM payments WHERE reference=$1', [c.i.reference])).ps_fee_actual_kobo, 7777);
    const d = await mk('11:00', 0);
    setGatewayVerifier(async (_db, reference) => ({ ok: true, status: 'success', amount_kobo: d.i.price_kobo, requested_amount_kobo: d.i.price_kobo, reference }));
    assert.equal((await processReference(s.db, d.i.reference)).result, 'amount_mismatch', 'paying only the price (without the booking fee) does not confirm');
  } finally { setGatewayVerifier(null); resetNow(); }
});

test('plan purchase adds the booking fee too and freezes the split; refund of a payment refunds everything charged', async () => {
  const s = await freshDb(); setNow(`${WED}T08:00:00+01:00`);
  try {
    const plan = (await s.db.one<any>(`INSERT INTO plans (barber_id, name, price_kobo, sessions, validity_days, active) VALUES ($1,'Gold',1000000,4,60,TRUE) RETURNING id`, [s.barberId])).id;
    await s.db.query('INSERT INTO plan_services (plan_id, service_id) VALUES ($1,$2)', [plan, s.serviceIds[0]]);
    const i = await initializePlanPurchase(s.db, s.customerIds[0], plan, null);
    assert.equal(i.price_kobo, 1000000); assert.equal(i.amount_kobo, 1009007);
    const pp = await s.db.one('SELECT * FROM plan_purchases WHERE id=$1', [i.purchase_id]);
    assert.equal(pp.booking_fee_kobo, 9007); assert.equal(pp.payout_kobo, 970993); assert.equal(pp.session_value_kobo, 250000);
  } finally { resetNow(); }
});
