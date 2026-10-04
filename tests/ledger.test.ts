import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'net';
import { setupPin } from '../src/adminPin';
import { DEMO_SHARE_CODE } from '../src/seed';
import { ensureShareCode } from '../src/shareLinks';
import { freshDb, setNow, resetNow, WED } from './helpers';
import { createApp } from '../src/app';
import { barberAction, createBooking } from '../src/bookingService';
import { initializePayment, initializePlanPurchase, mockMarkPaid, processReference, requestRefund } from '../src/paystack';
import { savePlan, planSchema, updateSettings, getSettings } from '../src/plans';
import { platformChargeKobo as inAppFeeKobo } from '../src/fees';
import { commissionKobo, nettableKobo, outstandingKobo, applyNettingForPayment, reverseNettingForPayment, accrueCommission, ledgerBlocked, sendLedgerReminders } from '../src/ledger';

const KEY = 'test-admin-key-0123456789';
const NOW = `${WED}T08:00:00+01:00`;
const S = { charge_flat_kobo: 0, charge_percent: 10, charge_min_kobo: 0, commission_factor: 0.5 };

async function boot() {
  const s = await freshDb(); setNow(NOW); process.env.CRON_SECRET = KEY; await setupPin(s.db, '4821');
  const uid = (await s.db.one('SELECT user_id FROM barbers WHERE id=$1', [s.barberId])).user_id;
  await s.db.query(`UPDATE barbers SET paystack_subaccount='ACCT_test' WHERE id=$1`, [s.barberId]);
  await s.db.tx((t) => updateSettings(t, { charge_percent: 10, charge_flat_naira: 0, charge_min_naira: 0 }));
  const server = createApp(s.db).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const j = async (p: string, o: any = {}) => { const r = await fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }); return { status: r.status, body: (await r.json().catch(() => ({}))) as any, res: r }; };
  return { ...s, uid, server, j, A: { Authorization: 'Bearer ' + KEY, 'X-Admin-Pin': '4821' } } as any;
}
/** An off-app booking taken all the way to COMPLETED (cash). Price of service 0 is N3,000 -> in-app fee N300 -> commission N150. */
async function offApp(s: any, cust: number, time: string, svc = 0) {
  const b = await createBooking(s.db, cust, { barber_id: s.barberId, service_id: s.serviceIds[svc], date: WED, time, payment_option: 'ON_ARRIVAL' });
  for (const a of ['mark-present'] as const) await barberAction(s.db, s.uid, s.barberId, b.id, a);
  await barberAction(s.db, s.uid, s.barberId, b.id, 'start');
  await barberAction(s.db, s.uid, s.barberId, b.id, 'record-payment', { method: 'cash' });
  await barberAction(s.db, s.uid, s.barberId, b.id, 'complete');
  return b.id as number;
}
const online = async (s: any, cust: number, time: string, svc = 0) => {
  const b = await createBooking(s.db, cust, { barber_id: s.barberId, service_id: s.serviceIds[svc], date: WED, time, payment_option: 'ONLINE' });
  const i = await initializePayment(s.db, b.id, null); return { b, ...i };
};
const confirm = async (s: any, ref: string) => { await mockMarkPaid(s.db, ref); return processReference(s.db, ref); };
const pay = (s: any, ref: string) => s.db.one('SELECT * FROM payments WHERE reference=$1', [ref]);

test('ledger math: commission = factor x in-app fee; overrides win; netting never exceeds debt nor leaves the barber below the minimum payout', () => {
  assert.equal(inAppFeeKobo(300000, S), 30000);
  assert.equal(commissionKobo(300000, S), 15000, 'half of the in-app fee');
  assert.equal(commissionKobo(300000, { ...S, commission_factor: 0.25 }), 7500);
  assert.equal(commissionKobo(300000, { ...S, commission_factor: 0 }), 0);
  assert.equal(commissionKobo(300000, { charge_flat_kobo: 5000, charge_percent: 10, charge_min_kobo: 0, commission_factor: 0.5 }), 17500, 'flat + percent');
  assert.equal(inAppFeeKobo(300000, S, { fee_percent_override: 0, fee_flat_kobo_override: null }), 0, 'override of 0 wins');
  assert.equal(commissionKobo(300000, S, { fee_percent_override: 20 }), 30000);
  assert.equal(commissionKobo(1, S), 0, 'sub-kobo amounts round to nothing');
  assert.equal(inAppFeeKobo(100, { charge_flat_kobo: 99999, charge_percent: 0, charge_min_kobo: 0 }), 100, 'fee never exceeds the price');
  const n = (o: Partial<Parameters<typeof nettableKobo>[0]>) => nettableKobo({ amountKobo: 300000, feeKobo: 30000, outstandingKobo: 10000, minPayoutPercent: 50, ...o });
  assert.equal(n({}), 10000, 'debt below the room: net it all');
  assert.equal(n({ outstandingKobo: 999999 }), 120000, 'capped: price 3000 - fee 300 - min payout 1500 = 1200');
  assert.equal(n({ outstandingKobo: 0 }), 0);
  assert.equal(n({ minPayoutPercent: 100 }), 0, 'minimum payout 100% = never net');
  assert.equal(n({ minPayoutPercent: 0, outstandingKobo: 999999 }), 270000);
  assert.equal(n({ feeKobo: 290000, outstandingKobo: 999999 }), 0, 'no negative room');
});

test('accrual: only completed pay-on-arrival bookings accrue, once; in-app bookings do not; factor and commission switch are honoured', async () => {
  const s = await boot();
  try {
    const off = await offApp(s, s.customerIds[0 % s.customerIds.length], '10:00');
    assert.equal(await outstandingKobo(s.db, s.barberId), 15000);
    const row = await s.db.one('SELECT * FROM commission_ledger WHERE booking_id=$1', [off]); assert.equal(row.status, 'ACCRUED'); assert.equal(row.kind, 'COMMISSION'); assert.equal(Number(row.amount_kobo), 15000);
    const b = await s.db.one('SELECT b.*, b.service_name FROM bookings b WHERE id=$1', [off]);
    assert.equal(await s.db.tx((t: any) => accrueCommission(t, b)), null, 'second accrual for the same booking is a no-op');
    assert.equal(await outstandingKobo(s.db, s.barberId), 15000);
    const on = await online(s, s.customerIds[1 % s.customerIds.length], '11:00'); await confirm(s, on.reference);
    await barberAction(s.db, s.uid, s.barberId, on.b.id, 'mark-present'); await barberAction(s.db, s.uid, s.barberId, on.b.id, 'start'); await barberAction(s.db, s.uid, s.barberId, on.b.id, 'complete');
    assert.equal(await outstandingKobo(s.db, s.barberId), 0, 'the in-app payment netted the debt and the completion added nothing');
    assert.equal((await s.db.one('SELECT COUNT(*)::int c FROM commission_ledger')).c, 1);
    // no-show on pay-on-arrival: nothing to owe
    const ns = await createBooking(s.db, s.customerIds[2 % s.customerIds.length], { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '09:00', payment_option: 'ON_ARRIVAL' });
    setNow(`${WED}T09:30:00+01:00`); await barberAction(s.db, s.uid, s.barberId, ns.id, 'no-show');
    assert.equal(await outstandingKobo(s.db, s.barberId), 0, 'no-show accrues nothing');
    // factor + switch
    await s.db.tx((t: any) => updateSettings(t, { commission_factor: 0.2 }));
    setNow(NOW); const off2 = await offApp(s, s.customerIds[3 % s.customerIds.length], '15:00');
    assert.equal(Number((await s.db.one('SELECT amount_kobo FROM commission_ledger WHERE booking_id=$1', [off2])).amount_kobo), 6000);
    await s.db.tx((t: any) => updateSettings(t, { commission_enabled: false }));
    const off3 = await offApp(s, s.customerIds[0 % s.customerIds.length], '16:00', 2);
    assert.ok(!(await s.db.maybeOne('SELECT 1 FROM commission_ledger WHERE booking_id=$1', [off3])), 'commission switched off');
    assert.ok((await s.db.one(`SELECT COUNT(*)::int c FROM audit_log WHERE action='COMMISSION_ACCRUED'`)).c === 2);
  } finally { s.server.close(); resetNow(); }
});

test('netting: debt is added to the platform charge at initialization, marked settled only after the payment is confirmed, exactly once, remainder carries forward', async () => {
  const s = await boot();
  try {
    await offApp(s, s.customerIds[0 % s.customerIds.length], '09:00'); await offApp(s, s.customerIds[1 % s.customerIds.length], '09:30');     // 2 x N150 = N300 owed
    assert.equal(await outstandingKobo(s.db, s.barberId), 30000);
    const o = await online(s, s.customerIds[2 % s.customerIds.length], '11:00');          // N3,000: fee 300 + netted 300
    const p = await pay(s, o.reference);
    assert.equal(Number(p.fee_kobo), 30000); assert.equal(Number(p.debt_netted_kobo), 30000);
    assert.equal(await outstandingKobo(s.db, s.barberId), 30000, 'NOT settled at initialization');
    assert.equal((await s.db.one(`SELECT COUNT(*)::int c FROM ledger_applications`)).c, 0);
    assert.equal((await confirm(s, o.reference)).result, 'processed');
    assert.equal(await outstandingKobo(s.db, s.barberId), 0);
    assert.equal((await s.db.many(`SELECT status FROM commission_ledger`)).every((r: any) => r.status === 'SETTLED'), true);
    // idempotent: re-processing / direct re-apply changes nothing
    assert.equal((await processReference(s.db, o.reference)).result, 'already_processed');
    assert.equal(await s.db.tx((t: any) => applyNettingForPayment(t, p.id)), 0);
    assert.equal((await s.db.one(`SELECT COUNT(*)::int c FROM ledger_applications WHERE kind='NETTED'`)).c, 2);
    // nothing owed now -> no extra charge on the next checkout
    const o2 = await online(s, s.customerIds[3 % s.customerIds.length], '12:00'); assert.equal(Number((await pay(s, o2.reference)).debt_netted_kobo), 0);
  } finally { s.server.close(); resetNow(); }
});

test('netting caps: the barber keeps at least the minimum payout; the rest of the debt carries forward to the next transactions', async () => {
  const s = await boot();
  try {
    await s.db.query(`INSERT INTO commission_ledger (barber_id, kind, amount_kobo, remaining_kobo, note, created_at) VALUES ($1,'ADJUSTMENT',500000,500000,'big debt',now())`, [s.barberId]);
    const o = await online(s, s.customerIds[0 % s.customerIds.length], '10:00');          // room = price 3000 - platform charge 300 - barber's fee share - minimum payout 1500
    const p = await pay(s, o.reference); const room = 300000 - 30000 - Number(p.barber_fee_kobo) - 150000; assert.ok(Number(p.barber_fee_kobo) > 0);
    assert.equal(Number(p.debt_netted_kobo), room);
    assert.ok(Number(p.barber_fee_kobo) + Number(p.fee_kobo) + Number(p.debt_netted_kobo) <= 300000 - 150000, 'charges leave the barber >= 50%');
    await confirm(s, o.reference);
    assert.equal(await outstandingKobo(s.db, s.barberId), 500000 - room);
    const row = await s.db.one(`SELECT * FROM commission_ledger`); assert.equal(row.status, 'ACCRUED'); assert.equal(Number(row.remaining_kobo), 500000 - room, 'partially applied entry stays ACCRUED');
    await s.db.tx((t: any) => updateSettings(t, { min_barber_payout_percent: 100 }));
    const o2 = await online(s, s.customerIds[1 % s.customerIds.length], '11:00'); assert.equal(Number((await pay(s, o2.reference)).debt_netted_kobo), 0, '100% minimum payout disables netting');
    await s.db.tx((t: any) => updateSettings(t, { min_barber_payout_percent: 50, commission_enabled: false }));
    const o3 = await online(s, s.customerIds[2 % s.customerIds.length], '12:00'); assert.equal(Number((await pay(s, o3.reference)).debt_netted_kobo), 0, 'switch off = no netting');
  } finally { s.server.close(); resetNow(); }
});

test('two open checkouts never net the same debt twice; abandoned checkouts settle nothing', async () => {
  const s = await boot();
  try {
    await s.db.query(`INSERT INTO commission_ledger (barber_id, kind, amount_kobo, remaining_kobo, note, created_at) VALUES ($1,'ADJUSTMENT',50000,50000,'debt',now())`, [s.barberId]);
    const a = await online(s, s.customerIds[0 % s.customerIds.length], '10:00'); const b = await online(s, s.customerIds[1 % s.customerIds.length], '11:00');
    assert.equal(Number((await pay(s, a.reference)).debt_netted_kobo), 50000);
    assert.equal(Number((await pay(s, b.reference)).debt_netted_kobo), 0, 'the same debt is already earmarked');
    await confirm(s, b.reference); assert.equal(await outstandingKobo(s.db, s.barberId), 50000, 'the un-netted payment settles nothing');
    await confirm(s, a.reference); assert.equal(await outstandingKobo(s.db, s.barberId), 0);
  } finally { s.server.close(); resetNow(); }
});

test('waived mid-checkout: nothing is double-counted (over-netting is audited), the ledger never goes negative', async () => {
  const s = await boot();
  try {
    await s.db.query(`INSERT INTO commission_ledger (barber_id, kind, amount_kobo, remaining_kobo, note, created_at) VALUES ($1,'ADJUSTMENT',50000,50000,'debt',now())`, [s.barberId]);
    const a = await online(s, s.customerIds[0 % s.customerIds.length], '10:00');
    await s.j(`/api/admin/ledger/${s.barberId}/waive`, { method: 'POST', headers: s.A, body: { all: true, reason: 'goodwill' } });
    await confirm(s, a.reference);
    assert.equal(await outstandingKobo(s.db, s.barberId), 0);
    assert.ok((await s.db.one(`SELECT COUNT(*)::int c FROM audit_log WHERE action='LEDGER_OVERNETTED'`)).c === 1);
    assert.equal((await s.db.one(`SELECT COUNT(*)::int c FROM commission_ledger WHERE remaining_kobo < 0`)).c, 0);
  } finally { s.server.close(); resetNow(); }
});

test('refund reverses netting (once); plan purchases net too', async () => {
  const s = await boot();
  try {
    await s.db.query(`INSERT INTO commission_ledger (barber_id, kind, amount_kobo, remaining_kobo, note, created_at) VALUES ($1,'ADJUSTMENT',40000,40000,'debt',now())`, [s.barberId]);
    const planId = await s.db.tx((t: any) => savePlan(t, s.barberId, null, planSchema.parse({ name: 'P4', price_naira: 12000, sessions: 4, validity_days: 30, service_ids: [s.serviceIds[0]] })));
    const init = await initializePlanPurchase(s.db, s.customerIds[0 % s.customerIds.length], planId, null);
    const p = await pay(s, init.reference); assert.equal(Number(p.debt_netted_kobo), 40000); assert.equal(Number(p.fee_kobo), 120000);
    await confirm(s, init.reference); assert.equal(await outstandingKobo(s.db, s.barberId), 0, 'plan purchase settled the debt');
    await s.db.query(`UPDATE payments SET refund_status='NEEDS_REFUND', refund_reason='t' WHERE reference=$1`, [init.reference]);
    assert.equal(await requestRefund(s.db, init.reference), 'requested');
    assert.equal(await outstandingKobo(s.db, s.barberId), 40000, 'refund gives the debt back');
    assert.equal(await s.db.tx((t: any) => reverseNettingForPayment(t, p.id)), 0, 'reversal is idempotent');
    assert.equal(await outstandingKobo(s.db, s.barberId), 40000);
    assert.equal((await s.db.one(`SELECT status FROM commission_ledger`)).status, 'ACCRUED');
  } finally { s.server.close(); resetNow(); }
});

test('a refunded duplicate / slot-taken payment never settles debt', async () => {
  const s = await boot();
  try {
    await s.db.query(`INSERT INTO commission_ledger (barber_id, kind, amount_kobo, remaining_kobo, note, created_at) VALUES ($1,'ADJUSTMENT',40000,40000,'debt',now())`, [s.barberId]);
    const a = await online(s, s.customerIds[0 % s.customerIds.length], '10:00');
    await s.db.query(`UPDATE bookings SET status='CANCELLED', payment_status='VOID' WHERE id=$1`, [a.b.id]);   // booking died before payment landed
    const r = await confirm(s, a.reference); assert.notEqual(r.result, 'processed');
    assert.equal(await outstandingKobo(s.db, s.barberId), 40000, 'debt untouched; payment is being refunded');
  } finally { s.server.close(); resetNow(); }
});

test('debt limits disable pay-on-arrival until settled; maintenance, barber pause and feature switches gate bookings', async () => {
  const s = await boot();
  try {
    const book = (cust: number, time: string, opt: any = 'ON_ARRIVAL') => createBooking(s.db, cust, { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time, payment_option: opt });
    await s.db.query(`INSERT INTO commission_ledger (barber_id, kind, amount_kobo, remaining_kobo, note, created_at) VALUES ($1,'ADJUSTMENT',20000,20000,'debt',now())`, [s.barberId]);
    await book(s.customerIds[0 % s.customerIds.length], '09:00');                                                     // limits off: fine
    await s.db.tx((t: any) => updateSettings(t, { ledger_max_debt_naira: 100 }));              // N100 limit < N200 owed
    assert.equal((await ledgerBlocked(s.db, s.barberId)).blocked, true);
    await assert.rejects(book(s.customerIds[1 % s.customerIds.length], '10:00'), (e: any) => e.code === 'PAY_ON_ARRIVAL_OFF');
    const okOnline = await book(s.customerIds[1 % s.customerIds.length], '10:00', 'ONLINE'); assert.equal(okOnline.status, 'PENDING_PAYMENT');
    const cfg = await s.j('/api/b/' + DEMO_SHARE_CODE); assert.equal(cfg.body.booking.pay_on_arrival, false);
    await s.j(`/api/admin/ledger/${s.barberId}/settle`, { method: 'POST', headers: s.A, body: { all: true, reason: 'paid by transfer' } });
    await book(s.customerIds[2 % s.customerIds.length], '11:00');                                                     // settled: pay on arrival is back
    // age limit
    await s.db.tx((t: any) => updateSettings(t, { ledger_max_debt_naira: 0, ledger_max_age_days: 5 }));
    await s.db.query(`INSERT INTO commission_ledger (barber_id, kind, amount_kobo, remaining_kobo, note, created_at) VALUES ($1,'ADJUSTMENT',100,100,'old',$2::timestamptz - interval '6 days')`, [s.barberId, NOW]);
    assert.equal((await ledgerBlocked(s.db, s.barberId)).blocked, true);
    await assert.rejects(book(s.customerIds[3 % s.customerIds.length], '12:00'), (e: any) => e.code === 'PAY_ON_ARRIVAL_OFF');
    await s.db.query(`DELETE FROM ledger_applications`); await s.db.query(`DELETE FROM commission_ledger`); await s.db.tx((t: any) => updateSettings(t, { ledger_max_age_days: 0 }));
    // barber pause
    await s.j(`/api/admin/barbers/${s.barberId}/pause`, { method: 'POST', headers: s.A, body: { paused: true, reason: 'audit' } });
    await assert.rejects(book(s.customerIds[3 % s.customerIds.length], '12:00', 'ONLINE'), (e: any) => e.code === 'BARBER_PAUSED');
    await s.j(`/api/admin/barbers/${s.barberId}/pause`, { method: 'POST', headers: s.A, body: { paused: false } });
    // feature toggle
    await s.db.tx((t: any) => updateSettings(t, { feature_pay_on_arrival: false }));
    await assert.rejects(book(s.customerIds[3 % s.customerIds.length], '12:00'), (e: any) => e.code === 'PAY_ON_ARRIVAL_OFF');
    await s.db.tx((t: any) => updateSettings(t, { feature_pay_on_arrival: true, feature_plans: false }));
    const planId = await s.db.tx((t: any) => savePlan(t, s.barberId, null, planSchema.parse({ name: 'P4', price_naira: 12000, sessions: 4, validity_days: 30, service_ids: [s.serviceIds[0]] })));
    await assert.rejects(initializePlanPurchase(s.db, s.customerIds[0 % s.customerIds.length], planId, null), (e: any) => e.code === 'FEATURE_OFF');
    assert.equal((await s.j('/api/config')).body.features.plans, false);
    // maintenance
    await s.db.tx((t: any) => updateSettings(t, { feature_plans: true, maintenance_mode: true, maintenance_message: 'Back at 3pm' }));
    await assert.rejects(book(s.customerIds[3 % s.customerIds.length], '12:00', 'ONLINE'), (e: any) => e.code === 'MAINTENANCE' && /3pm/.test(e.message));
    assert.equal((await s.j('/api/config')).body.maintenance, 'Back at 3pm');
    await s.db.tx((t: any) => updateSettings(t, { maintenance_mode: false }));
    await book(s.customerIds[3 % s.customerIds.length], '12:00', 'ONLINE');
  } finally { s.server.close(); resetNow(); }
});

test('admin ledger actions: settle / waive / adjust need a reason, are capped, audited, notify the barber; reminders respect the cool-down', async () => {
  const s = await boot();
  try {
    await offApp(s, s.customerIds[0 % s.customerIds.length], '09:00'); await offApp(s, s.customerIds[1 % s.customerIds.length], '09:30');     // N300
    const act = (k: string, body: any) => s.j(`/api/admin/ledger/${s.barberId}/${k}`, { method: 'POST', headers: s.A, body });
    assert.equal((await act('settle', { amount_naira: 50 })).status, 400, 'reason required');
    assert.equal((await act('settle', { amount_naira: 5000, reason: 'too much' })).status, 400, 'cannot settle more than owed');
    const r = await act('settle', { amount_naira: 200, reason: 'bank transfer ref 123' }); assert.equal(r.body.owed_kobo, 10000);
    assert.equal((await s.db.many(`SELECT status, remaining_kobo FROM commission_ledger ORDER BY id`)).map((x: any) => x.status + ':' + x.remaining_kobo).join(), 'SETTLED:0,ACCRUED:10000');
    assert.equal((await act('waive', { all: true, reason: 'goodwill' })).body.owed_kobo, 0);
    assert.equal((await act('waive', { all: true, reason: 'again' })).status, 400, 'nothing left');
    assert.equal((await act('adjust', { amount_naira: 25, reason: 'late fee' })).body.owed_kobo, 2500);
    assert.equal((await s.j(`/api/admin/ledger/${s.barberId}/settle`, { method: 'POST', body: { all: true, reason: 'x y z' } })).status, 401);
    const led = (await s.j(`/api/admin/ledger/${s.barberId}`, { headers: s.A })).body; assert.ok(led.entries.length === 3 && led.applications.length >= 2);
    assert.ok((await s.j('/api/admin/ledger', { headers: s.A })).body.total_owed_kobo === 2500);
    const acts = (await s.j('/api/admin/audit?scope=all&limit=100', { headers: s.A })).body.actions; assert.ok(acts.includes('ADMIN_LEDGER_SETTLED') && acts.includes('ADMIN_LEDGER_WAIVED') && acts.includes('ADMIN_LEDGER_ADJUSTED'));
    const cookie = (await fetch(`http://127.0.0.1:${(s.server.address() as AddressInfo).port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'mike@trimslot.demo', password: 'Barber123!' }) })).headers.get('set-cookie')!.split(';')[0];
    const mine = (await s.j('/api/barber/ledger', { headers: { Cookie: cookie } })).body; assert.equal(mine.owed_kobo, 2500); assert.equal(mine.entries.length, 3);
    assert.ok((await s.db.one(`SELECT COUNT(*)::int c FROM notifications WHERE user_id=$1 AND type='LEDGER_UPDATE'`, [s.uid])).c >= 3);
    // reminders: only when old/blocked; admin "remind" forces; cool-down
    assert.equal(await s.db.tx((t: any) => sendLedgerReminders(t)), 0, 'small fresh debt: no nagging');
    assert.equal((await s.j('/api/admin/ledger/remind', { method: 'POST', headers: s.A, body: { barber_id: s.barberId } })).body.reminded, 1);
    await s.db.tx((t: any) => updateSettings(t, { ledger_max_debt_naira: 1 }));
    assert.equal(await s.db.tx((t: any) => sendLedgerReminders(t)), 0, 'the admin reminder just went out: cool-down');
    await s.db.query(`DELETE FROM notifications WHERE type='LEDGER_REMINDER'`);
    assert.equal(await s.db.tx((t: any) => sendLedgerReminders(t)), 1, 'over the limit: sweep reminds');
    assert.equal(await s.db.tx((t: any) => sendLedgerReminders(t)), 0, '3-day cool-down');
  } finally { s.server.close(); resetNow(); }
});

test('admin force-complete of a pay-on-arrival booking accrues commission once', async () => {
  const s = await boot();
  try {
    const b = await createBooking(s.db, s.customerIds[0 % s.customerIds.length], { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '09:00', payment_option: 'ON_ARRIVAL' });
    const r = await s.j(`/api/admin/bookings/${b.id}/complete`, { method: 'POST', headers: s.A, body: { reason: 'barber forgot to tap', paid: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(await outstandingKobo(s.db, s.barberId), 15000);
    assert.equal(((await s.db.one('SELECT arrival_time FROM bookings WHERE id=$1', [b.id])) as any).arrival_time, null, 'admin force-complete must not invent an arrival time (it showed "Arrived 2:49 PM" on a 10:00 booking)');
    await s.j(`/api/admin/bookings/${b.id}/complete`, { method: 'POST', headers: s.A, body: { reason: 'again again', paid: true } });
    assert.equal(await outstandingKobo(s.db, s.barberId), 15000);
  } finally { s.server.close(); resetNow(); }
});

test('settings: fee percent / fixed fee / half-fee factor are admin settings with validation and defaults (factor 0.5)', async () => {
  const s = await boot();
  try {
    const cur = await getSettings(s.db); assert.equal(Number(cur.commission_factor), 0.5); assert.equal(cur.commission_enabled, true); assert.equal(cur.min_barber_payout_percent, 50);
    const put = (b: any) => s.j('/api/admin/settings', { method: 'PUT', headers: s.A, body: b });
    assert.equal((await put({ commission_factor: 1.5 })).status, 400); assert.equal((await put({ commission_factor: -1 })).status, 400);
    assert.equal((await put({ min_barber_payout_percent: 101 })).status, 400);
    const ok = await put({ commission_factor: 0.25, charge_flat_naira: 50, charge_percent: 5, charge_min_naira: 0 }); assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const g = (await s.j('/api/admin/settings', { headers: s.A })).body; assert.equal(Number((g.settings || g).commission_factor), 0.25);
    assert.equal(commissionKobo(300000, await getSettings(s.db)), Math.round((5000 + 15000) * 0.25));
    const fee = await s.j(`/api/admin/barbers/${s.barberId}/fee`, { method: 'POST', headers: s.A, body: { percent: 20, flat_naira: null, reason: 'premium' } });
    assert.equal(fee.status, 200, JSON.stringify(fee.body));
    const brow = await s.db.one('SELECT fee_percent_override, fee_flat_kobo_override FROM barbers WHERE id=$1', [s.barberId]);
    assert.equal(commissionKobo(300000, await getSettings(s.db), brow), Math.round(60000 * 0.25), 'barber override feeds the commission too');
  } finally { s.server.close(); resetNow(); }
});
