import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { bootApp } from './httpHelpers';
import { freshDb, setNow, resetNow, WED } from './helpers';
import { customerCancel, createBooking, applyVerifiedPayment } from '../src/bookingService';
import { initializePlanPurchase, mockMarkPaid, processReference, requestRefund, setGatewayVerifier, parseGatewayData } from '../src/paystack';
import { planSchema, savePlan } from '../src/plans';

const PERMITTED = ['cancel_cutoff_min', 'credit_expiry_days', 'payment_hold_min', 'liability_cap_naira', 'retention_events_days', 'retention_bad_events_days', 'retention_notifications_days',
  'retention_push_stale_days', 'retention_deleted_days', 'retention_checkout_days', 'retention_rate_limit_hours', 'retention_admin_alerts_days', 'terms_version', 'privacy_version', 'barber_agreement_version'].sort();

test('/api/public-settings returns only the permitted tokens (no plan limits, plan refund setting or loyalty numbers)', async () => {
  const c = await bootApp();
  try {
    const r = await c.call('GET', '/api/public-settings');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json.settings).sort(), PERMITTED);
    assert.doesNotMatch(r.text, /min_plan|max_plan|plan_refund|loyalty|commission|platform_charge|subaccount|auto_approve/i);
    // the pages that read it only use these keys
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'public')).filter((x) => x.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
      for (const m of html.matchAll(/data-s="([a-z_]+)"/g)) assert.ok(PERMITTED.includes(m[1]), `${f} uses data-s="${m[1]}" which is not published`);
    }
  } finally { c.close(); }
});

test('barber booking detail: no staff audit details, no hours, no commission percentage', async () => {
  const c = await bootApp();
  try {
    const cc = await c.chidi(), mk = await c.mike();
    const bk = await c.call('POST', '/api/bookings', { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time: '10:00', payment_option: 'ONLINE' }, cc);
    assert.equal(bk.status, 201, bk.text);
    const id = bk.json.booking.id;
    await c.db.tx((t: any) => applyVerifiedPayment(t, id, 'PAYSTACK'));
    await c.db.query(`INSERT INTO audit_log (booking_id, actor_role, action, details) VALUES ($1,'system','PAYMENT_AMOUNT_MISMATCH','{"asked_kobo":500000,"reported_kobo":100}'), ($1,'system','HELP_ESCALATED','{"note":"after 5 min"}'), ($1,'customer','CANCELLED','{"note":"Refund requested; pending admin approval, auto-approves in 3 h"}'), ($1,'customer','NOT_SERVED','{"reason":"Chair broke","note":"Refund waiting for approval","amount_kobo":900000}')`, [id]);
    const r = await c.call('GET', `/api/barber/bookings/${id}`, undefined, mk);
    assert.equal(r.status, 200, r.text);
    const actions = r.json.timeline.map((t: any) => t.action);
    assert.ok(!actions.includes('PAYMENT_AMOUNT_MISMATCH') && !actions.includes('HELP_ESCALATED'), 'staff-only steps are hidden');
    assert.ok(actions.includes('NOT_SERVED') && actions.includes('BOOKED'));
    assert.doesNotMatch(JSON.stringify(r.json.timeline), /auto-approves|\d+ ?h\b|kobo|amount/i);
    assert.match(JSON.stringify(r.json.timeline), /Refund waiting for approval/);
    assert.ok(!r.text.includes('commission_percent'), 'no percentage sent to the barber');
    const oa = await c.call('POST', '/api/bookings', { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time: '12:00', payment_option: 'ON_ARRIVAL' }, cc);
    const r2 = await c.call('GET', `/api/barber/bookings/${oa.json.booking.id}`, undefined, mk);
    assert.ok(!r2.text.includes('commission_percent'));
    assert.ok(typeof r2.json.booking.money.commission_owed_kobo === 'number', 'the amount added to the balance is still shown');
    const led = await c.call('GET', '/api/barber/ledger', undefined, mk);
    assert.equal(led.status, 200, led.text);
    assert.ok(!('factor' in led.json));
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), /commission_percent|Added to your balance \(/);
  } finally { c.close(); }
});

test('the refund note kept for staff is neutral (no hours) when a paid booking is cancelled or not served', async () => {
  const s = await freshDb(); setNow(`${WED}T08:00:00+01:00`);
  try {
    await s.db.query('UPDATE barbers SET paystack_subaccount=$2 WHERE id=$1', [s.barberId, 'ACCT_test']);
    const { initializePayment } = await import('../src/paystack');
    const b = await createBooking(s.db, s.customerIds[0], { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '15:00', payment_option: 'ONLINE' });
    const i = await initializePayment(s.db, b.id, null); await mockMarkPaid(s.db, i.reference); await processReference(s.db, i.reference);
    await customerCancel(s.db, s.customerIds[0], b.id);
    const rows = await s.db.many(`SELECT details FROM audit_log WHERE booking_id=$1 AND action='CANCELLED'`, [b.id]);
    assert.match(JSON.stringify(rows), /Refund waiting for approval/);
    assert.doesNotMatch(JSON.stringify(rows), /auto-approves|\d+ h\b/);
  } finally { resetNow(); }
});

test('a mismatched plan payment: the buyer is told "we asked" when the refund is requested, and "has been sent back" when staff record it', async () => {
  const s = await freshDb(); setNow(`${WED}T08:00:00+01:00`);
  try {
    await s.db.query('UPDATE barbers SET paystack_subaccount=$2 WHERE id=$1', [s.barberId, 'ACCT_test']);
    const planId = await s.db.tx((t: any) => savePlan(t, s.barberId, null, planSchema.parse({ name: 'Monthly 4', price_naira: 12000, sessions: 4, validity_days: 30, service_ids: [s.serviceIds[0]] })));
    const init = await initializePlanPurchase(s.db, s.customerIds[0], planId, null);
    setGatewayVerifier(async (_d, ref) => parseGatewayData({ status: 'success', amount: init.amount_kobo, requested_amount: init.amount_kobo, currency: 'USD' }, ref));
    assert.equal((await processReference(s.db, init.reference)).result, 'amount_mismatch');
    assert.equal(await requestRefund(s.db, init.reference), 'requested');
    const n = await s.db.many(`SELECT title, body FROM notifications WHERE user_id=$1 AND type='PAYMENT_PROBLEM' ORDER BY id`, [s.customerIds[0]]);
    const asked = n.filter((x: any) => x.title === 'We asked for your money to be sent back');
    assert.equal(asked.length, 1); assert.match(asked[0].body, /plan "Monthly 4"/); assert.match(asked[0].body, /We asked for your money to be sent back/);
    assert.ok(!n.some((x: any) => /has been sent back/.test(x.body)), 'not claimed before staff confirm');
  } finally { setGatewayVerifier(null); resetNow(); }
});
