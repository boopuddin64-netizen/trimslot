import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers';
import { onlineBreakdown, offAppBreakdown, FeeSettings } from '../src/fees';
import { addAdjustment, outstandingKobo, manualSettle } from '../src/ledger';

// Settings used by the money audit. Realistic rates; the fee sweep below covers many prices so rounding is tested to the kobo.
const S: FeeSettings = {
  ps_percent: 1.5, ps_flat_kobo: 10000, ps_flat_waived_below_kobo: 250000, ps_cap_kobo: 200000, ps_vat_percent: 0,
  fee_share_customer_pct: 33.33, fee_share_barber_pct: 33.33, fee_share_platform_pct: 33.34,
  charge_percent: 10, charge_flat_kobo: 0, charge_min_kobo: 0,
};

test('money identity: for every price, customer total = barber payout + barber fee + platform charge + booking fee (to the kobo)', () => {
  for (let price = 100; price <= 5_000_000; price += 997) {
    const b = onlineBreakdown(price, S);
    assert.equal(b.payout_kobo + b.barber_fee_kobo + b.platform_charge_kobo + b.booking_fee_kobo, b.total_kobo, `price ${price}`);
    assert.equal(b.total_kobo, price + b.booking_fee_kobo, `total ${price}`);
    assert.ok(b.payout_kobo >= 0 && b.barber_fee_kobo >= 0 && b.platform_charge_kobo >= 0 && b.booking_fee_kobo >= 0, `no negative part at ${price}`);
    assert.ok(b.platform_charge_kobo <= price - b.barber_fee_kobo, `platform charge never exceeds what the barber keeps at ${price}`);
    assert.ok(Number.isInteger(b.total_kobo) && Number.isInteger(b.payout_kobo), `whole kobo at ${price}`);
  }
});

test('money identity: off-app breakdown never moves money through Paystack and keeps the price whole', () => {
  for (const price of [100, 3000, 250000, 1234567]) {
    const b = offAppBreakdown(price, S);
    assert.equal(b.total_kobo, price);
    assert.equal(b.ps_fee_kobo, 0);
    assert.equal(b.booking_fee_kobo, 0);
  }
});

test('ledger: the database refuses a negative adjustment, so a barber can never be owed a balance through the ledger', async () => {
  const s = await freshDb();
  // The ledger only holds debts owed BY the barber. A negative amount would be consumed by FIFO netting as if it were debt,
  // so the commission_ledger CHECK constraint must reject it.
  await assert.rejects(
    s.db.tx((t) => addAdjustment(t, s.barberId, -30_000, 'test credit to barber')),
    (e: any) => e?.code === '23514',
  );
  // And a positive debt still works and is what outstanding reports.
  await s.db.tx((t) => addAdjustment(t, s.barberId, 100_000, 'test debt'));
  assert.equal(await s.db.tx((t) => outstandingKobo(t, s.barberId)), 100_000);
  // Settling more than is owed applies only what is owed.
  const applied = await s.db.tx((t) => manualSettle(t, s.barberId, 150_000, 'test settle'));
  assert.equal(applied, 100_000);
  assert.equal(await s.db.tx((t) => outstandingKobo(t, s.barberId)), 0);
});
