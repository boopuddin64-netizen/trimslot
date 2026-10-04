import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { freshDb, setNow, resetNow, WED } from './helpers';
import { createBooking, customerCancel } from '../src/bookingService';
import { initializePayment, initializePlanPurchase, mockMarkPaid, processReference, setGatewayVerifier, parseGatewayData } from '../src/paystack';
import { planSchema, savePlan } from '../src/plans';
import { anonymiseUser, buildExport } from '../src/accountData';
import { runRetention } from '../src/retention';

const NOW = `${WED}T08:00:00+01:00`;
const notifs = (db: any, userId: number) => db.many('SELECT type, title, body FROM notifications WHERE user_id=$1 ORDER BY id', [userId]);
async function setup() {
  const s = await freshDb(); setNow(NOW);
  await s.db.query('UPDATE barbers SET paystack_subaccount=$2 WHERE id=$1', [s.barberId, 'ACCT_test']);
  return s;
}
const mkPlan = (s: any) => s.db.tx((t: any) => savePlan(t, s.barberId, null, planSchema.parse({ name: 'Monthly 4', price_naira: 12000, sessions: 4, validity_days: 30, service_ids: [s.serviceIds[0]] })));

test('plan payments get the same notices as bookings: a duplicate payment and a mismatched payment each tell the buyer (mismatch only once)', async () => {
  const s = await setup();
  try {
    const planId = await mkPlan(s);
    const init = await initializePlanPurchase(s.db, s.customerIds[0], planId, null);
    await mockMarkPaid(s.db, init.reference); await processReference(s.db, init.reference);
    // duplicate
    const dupRef = `TS-PLAN-${init.purchase_id}-abcdef0123`;
    await s.db.query(`INSERT INTO payments (plan_purchase_id, reference, provider, amount_kobo, status, mock_paid) VALUES ($1,$2,'MOCK',$3,'INITIATED',TRUE)`, [init.purchase_id, dupRef, init.amount_kobo]);
    assert.equal((await processReference(s.db, dupRef)).result, 'refund_due');
    const dup = (await notifs(s.db, s.customerIds[0])).filter((n: any) => /second payment/i.test(n.title));
    assert.equal(dup.length, 1); assert.match(dup[0].body, /Monthly 4/); assert.match(dup[0].body, /already active/);
    // mismatch on a second plan purchase
    const init2 = await initializePlanPurchase(s.db, s.customerIds[1], planId, null);
    setGatewayVerifier(async (_d, ref) => parseGatewayData({ status: 'success', amount: init2.amount_kobo, requested_amount: init2.amount_kobo, currency: 'USD' }, ref));
    assert.equal((await processReference(s.db, init2.reference)).result, 'amount_mismatch');
    assert.equal((await processReference(s.db, init2.reference)).result, 'amount_mismatch');
    const mm = (await notifs(s.db, s.customerIds[1])).filter((n: any) => n.type === 'PAYMENT_PROBLEM');
    assert.equal(mm.length, 1, 'told once'); assert.match(mm[0].body, /plan "Monthly 4"/); assert.match(mm[0].body, /did not start the plan/);
    assert.equal((await s.db.one(`SELECT status FROM plan_purchases WHERE id=$1`, [init2.purchase_id])).status, 'PENDING', 'plan not started');
    assert.equal((await s.db.one(`SELECT COUNT(*)::int c FROM admin_notifications WHERE event='PAYMENT_MISMATCH'`)).c, 1);
  } finally { setGatewayVerifier(null); resetNow(); }
});

test('customer-facing texts: no refund hours promised, no "not charged" when we never asked Paystack, no commission percentage in the app', async () => {
  const s = await setup();
  try {
    const b = await createBooking(s.db, s.customerIds[0], { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '10:00', payment_option: 'ONLINE' });
    await customerCancel(s.db, s.customerIds[0], b.id);   // walked away from an unpaid try
    const n1 = (await notifs(s.db, s.customerIds[0])).find((n: any) => n.type === 'BOOKING_INCOMPLETE')!;
    assert.doesNotMatch(n1.body, /not charged/i); assert.match(n1.body, /If any money left your account, it will be returned/);
    const b2 = await createBooking(s.db, s.customerIds[0], { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '11:00', payment_option: 'ONLINE' });
    const i2 = await initializePayment(s.db, b2.id, null); await mockMarkPaid(s.db, i2.reference); await processReference(s.db, i2.reference);
    const c2 = await customerCancel(s.db, s.customerIds[0], b2.id);
    const bodies = (await notifs(s.db, s.customerIds[0])).map((n: any) => n.body).join(' | ');
    assert.doesNotMatch(bodies, /within \d+ hours?/i); assert.match(bodies, /We will approve it soon/);
    assert.equal(c2.payment_status, 'REFUND_PENDING');
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), /of the usual in-app fee/);
  } finally { resetNow(); }
});

test('help-request text: in the data export, blanked (with the staff report that repeated it) when the account is deleted, and by retention when old; old email-code hashes are cleared', async () => {
  const s = await setup();
  try {
    const b = await createBooking(s.db, s.customerIds[0], { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '10:00', payment_option: 'ONLINE' });
    const bUid = (await s.db.one('SELECT user_id FROM barbers WHERE id=$1', [s.barberId])).user_id;
    const mkHelp = async (note: string, bookingId: number, at: string) => {
      const r = await s.db.one(`INSERT INTO reports (reporter_id, target_user_id, booking_id, category, message, created_at) VALUES ($1,$2,$3,'OTHER',$4,$5) RETURNING id`, [s.customerIds[0], bUid, bookingId, `URGENT ... Customer note: "${note}"`, at]);
      await s.db.query(`INSERT INTO help_requests (booking_id, customer_id, note, status, created_at, escalated_at, report_id) VALUES ($1,$2,$3,'CLOSED',$4,$4,$5)`, [bookingId, s.customerIds[0], note, at, r.id]);
    };
    await mkHelp('my car broke down on the bridge', b.id, new Date().toISOString());
    const ex = await buildExport(s.db, { id: s.customerIds[0], role: 'customer' });
    assert.equal(ex.help_requests.length, 1); assert.equal(ex.help_requests[0].note, 'my car broke down on the bridge');
    assert.ok('email_verified_at' in ex.account); assert.ok(!JSON.stringify(ex).includes('otp_hash'));
    const bx = await buildExport(s.db, { id: bUid, role: 'barber' });
    assert.equal(bx.help_requests_received.length, 1);
    // retention: a fresh note stays, an old one goes; same for the repeated text in the staff report
    const old = await createBooking(s.db, s.customerIds[0], { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '14:00', payment_option: 'ON_ARRIVAL' });
    await mkHelp('old secret message', old.id, '2025-01-01T10:00:00Z');
    await s.db.query(`UPDATE users SET otp_hash='abc', otp_expires_at='2025-01-01T10:10:00Z', otp_attempts=2 WHERE id=$1`, [s.customerIds[1]]);
    const r = await runRetention(s.db);
    assert.ok(r.help_notes_removed >= 2 && r.stale_email_codes === 1);
    const rows = await s.db.many('SELECT note FROM help_requests ORDER BY id');
    assert.deepEqual(rows.map((x: any) => x.note), ['my car broke down on the bridge', 'Removed']);
    assert.equal((await s.db.one(`SELECT COUNT(*)::int c FROM reports WHERE message LIKE '%old secret%'`)).c, 0);
    assert.equal((await s.db.one('SELECT otp_hash FROM users WHERE id=$1', [s.customerIds[1]])).otp_hash, null);
    // deleting the account blanks the rest
    await s.db.tx((t) => anonymiseUser(t, s.customerIds[0], 'test'));
    assert.deepEqual((await s.db.many('SELECT note FROM help_requests ORDER BY id')).map((x: any) => x.note), ['Removed', 'Removed']);
    assert.equal((await s.db.one(`SELECT COUNT(*)::int c FROM reports WHERE message LIKE '%car broke%'`)).c, 0);
  } finally { resetNow(); }
});

test('public legal pages (generated): no drafting notes, stray list stars, fee formulas, split/commission/margin words, auto-approve hours or business numbers', () => {
  const dir = path.join(__dirname, '..', 'public');
  const BAD: [RegExp, string][] = [
    [/\[PROPOSED|\[LAWYER|\[OWNER|\[CHECK|gap found/i, 'drafting note'], [/subaccount|\bsplit(s|ting)?\b|(cash|off-app|platform) commission|commission (factor|rate|percent)|three ways|netting|\bmargins?\b/i, 'internal mechanic'],
    [/payout\s*=|keeps or covers|covers the difference|processing fees?\b/i, 'formula / who pays processing'], [/\[VERSION\]/, 'placeholder'],
    [/1,000|500,000|\b90 days|every \d+(th)? (completed )?visits|7 days old|every three days/i, 'plan/loyalty/reminder numbers'], [/approv\w*[^.<]{0,60}\b\d+ hours?/i, 'auto-approve hours'],
  ];
  for (const f of ['terms', 'privacy', 'refunds', 'plan-terms', 'cookies', 'barber-agreement']) {
    const text = fs.readFileSync(path.join(dir, f + '.html'), 'utf8').replace(/<(style|script)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ');
    for (const [re, what] of BAD) { const m = re.exec(text); assert.ok(!m, `${f}.html shows ${what}: ${m && text.slice(Math.max(0, m.index - 40), m.index + 60)}`); }
    assert.ok(!/(^|\s)\*(\s|$)/.test(text), `${f}.html has a stray *`);
  }
  assert.match(fs.readFileSync(path.join(dir, 'cookies.html'), 'utf8'), /Turn on alerts/);
  assert.match(fs.readFileSync(path.join(dir, 'cookies.html'), 'utf8'), /adm_sf_barbers/);
});

test('legal build guard self-test (needs the legal python venv; skipped where it is not installed)', (t) => {
  const py = ['/workspace/.venv-legal/bin/python', 'python3'].find((p) => spawnSync(p, ['-c', 'import markdown']).status === 0);
  if (!py) return void t.skip('python markdown is not installed');
  const r = spawnSync(py, [path.join(__dirname, '..', 'legal', 'test_guard.py')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
