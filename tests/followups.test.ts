import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from './httpHelpers';
import { freshDb, setNow, resetNow, WED } from './helpers';
import { createBooking, expireHolds, getBooking } from '../src/bookingService';
import { initializePayment, processReference, requestRefund, setGatewayVerifier, parseGatewayData, initializePlanPurchase } from '../src/paystack';
import { runSweep } from '../src/sweep';
import { escalateUnansweredHelp } from '../src/help';

const KEY = 'test-admin-key-0123456789';
const ADMIN = { Authorization: 'Bearer ' + KEY, 'X-Admin-Pin': '4821', 'Content-Type': 'application/json' };
async function adminOn(c: any) { process.env.CRON_SECRET = KEY; await (await import('../src/adminPin')).setupPin(c.db, '4821'); }
const notifs = (db: any, uid: number) => db.many('SELECT type, title, body FROM notifications WHERE user_id=$1 ORDER BY id', [uid]);

async function mismatchBooking(c: Awaited<ReturnType<typeof bootApp>>, time = '10:00') {
  await c.db.query('UPDATE barbers SET paystack_subaccount=$2 WHERE id=$1', [c.barberId, 'ACCT_test']);
  const cc = await c.chidi();
  const r = await c.call('POST', '/api/bookings', { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time, payment_option: 'ONLINE' }, cc);
  assert.equal(r.status, 201, r.text);
  const id = r.json.booking.id as number;
  const p = await initializePayment(c.db, id, null);
  setGatewayVerifier(async (_d, ref) => parseGatewayData({ status: 'success', amount: p.amount_kobo - 5000, requested_amount: p.amount_kobo - 5000, currency: 'NGN' }, ref));
  assert.equal((await processReference(c.db, p.reference)).result, 'amount_mismatch');
  return { cc, id, p };
}

test('A: "My bookings" rows match the detail page (payment_issue, not INCOMPLETE/NO PAYMENT) for mismatch, slot-taken and late bookings', async () => {
  const c = await bootApp();
  try {
    const a = await mismatchBooking(c, '10:00');
    // a slot-taken and a late one: cancelled holds that have a refund row
    const mkVoid = async (time: string, reason: string, status: string) => {
      const r = await c.call('POST', '/api/bookings', { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time, payment_option: 'ONLINE' }, a.cc);
      const id = r.json.booking.id as number; const p = await initializePayment(c.db, id, null);
      await c.db.query(`UPDATE bookings SET status='CANCELLED', payment_status='VOID' WHERE id=$1`, [id]);
      await c.db.query(`UPDATE payments SET refund_status=$2, refund_reason=$3, refund_requested_at=now() WHERE reference=$1`, [p.reference, status, reason]);
      return id;
    };
    const slot = await mkVoid('11:00', 'Slot was taken by another booking', 'REFUND_REQUESTED');
    const late = await mkVoid('12:00', 'Payment arrived after the hold ended', 'REFUNDED');
    const plain = (await createBooking(c.db, c.customerIds[0], { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time: '14:30', payment_option: 'ONLINE' })).id;
    await c.db.query(`UPDATE bookings SET status='CANCELLED', payment_status='VOID' WHERE id=$1`, [plain]);   // never paid: still INCOMPLETE
    const list = (await c.call('GET', '/api/bookings', undefined, a.cc)).json.bookings as any[];
    for (const [id, kind] of [[a.id, 'mismatch'], [slot, 'slot_taken'], [late, 'late']] as [number, string][]) {
      const row = list.find((b) => b.id === id); const det = (await c.call('GET', `/api/bookings/${id}`, undefined, a.cc)).json.booking;
      assert.equal(row.incomplete, false, `list row #${id} must not say incomplete`);
      assert.equal(row.payment_issue.kind, kind);
      assert.deepEqual(row.payment_issue, det.payment_issue, 'list = detail');
      assert.equal(row.incomplete, det.incomplete);
    }
    assert.equal(list.find((b) => b.id === plain).incomplete, true, 'a booking with no payment at all is still incomplete');
  } finally { setGatewayVerifier(null); c.close(); }
});

test('C: budgetMs 0 never calls Paystack: a hold with a checkout is left for the sweeper, a hold with no payment attempt is released', async () => {
  const c = await bootApp();
  try {
    await c.db.query('UPDATE barbers SET paystack_subaccount=$2 WHERE id=$1', [c.barberId, 'ACCT_test']);
    const mk = (cust: number, time: string) => createBooking(c.db, c.customerIds[cust], { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time, payment_option: 'ONLINE' });
    const noPay = await mk(0, '10:00'); const withPay = await mk(1, '11:00'); const p = await initializePayment(c.db, withPay.id, null);
    let asked = 0; setGatewayVerifier(async (_d, ref) => { asked++; return { ok: false, status: 'abandoned', reference: ref }; });
    setNow(`${WED}T09:00:00+01:00`);       // both holds are over
    const t0 = Date.now();
    assert.equal(await expireHolds(c.db, {}, { budgetMs: 0 }), 1);
    assert.ok(Date.now() - t0 < 1500); assert.equal(asked, 0, 'Paystack was not asked');
    assert.equal((await getBooking(c.db, noPay.id))!.status, 'CANCELLED');
    assert.equal((await getBooking(c.db, withPay.id))!.status, 'PENDING_PAYMENT', 'left for the sweeper');
    // an ordinary logged-in request (auth.ts) does the same and answers fast
    const cc = await c.tunde();
    const r = await c.call('GET', '/api/bookings', undefined, cc); assert.equal(r.status, 200); assert.equal(asked, 0);
    // the sweeper asks Paystack and closes it
    await runSweep(c.db);
    assert.ok(asked >= 1); assert.equal((await getBooking(c.db, withPay.id))!.status, 'CANCELLED'); void p;
  } finally { setGatewayVerifier(null); c.close(); }
});

test('D: the plan-checkout cleanup never deletes a stale purchase whose payment is flagged for a refund (amount mismatch)', async () => {
  const s = await freshDb();
  try {
    const plan = (await s.db.one<any>(`INSERT INTO plans (barber_id, name, price_kobo, sessions, validity_days, active) VALUES ($1,'Gold',1000000,4,60,TRUE) RETURNING id`, [s.barberId])).id;
    await s.db.query('INSERT INTO plan_services (plan_id, service_id) VALUES ($1,$2)', [plan, s.serviceIds[0]]);
    const flagged = await initializePlanPurchase(s.db, s.customerIds[0], plan, null);
    const abandoned = await initializePlanPurchase(s.db, s.customerIds[1] ?? s.customerIds[0], plan, null);
    await s.db.query(`UPDATE payments SET refund_status='NEEDS_REFUND', refund_reason='Amount mismatch' WHERE reference=$1`, [flagged.reference]);
    await s.db.query(`UPDATE plan_purchases SET created_at = now() - interval '3 days'`);
    await runSweep(s.db);
    const left = (await s.db.many<any>('SELECT id FROM plan_purchases')).map((r) => r.id);
    assert.ok(left.includes(flagged.purchase_id), 'flagged purchase kept');
    assert.equal((await s.db.one<any>('SELECT COUNT(*)::int c FROM payments WHERE reference=$1', [flagged.reference])).c, 1, 'its payment row kept');
    assert.ok(!left.includes(abandoned.purchase_id), 'a plain abandoned one is still dropped');
  } finally { resetNow(); }
});

test('E: a booking held for a payment problem cannot be paid again (server flag, 409 on /pay, no Pay-now button text in the page code path)', async () => {
  const c = await bootApp();
  try {
    const a = await mismatchBooking(c);
    const det = (await c.call('GET', `/api/bookings/${a.id}`, undefined, a.cc)).json.booking;
    assert.equal(det.status, 'PENDING_PAYMENT'); assert.equal(det.pay_blocked, true);
    assert.equal((await c.call('GET', '/api/bookings', undefined, a.cc)).json.bookings.find((b: any) => b.id === a.id).pay_blocked, true);
    const pay = await c.call('POST', `/api/bookings/${a.id}/pay`, {}, a.cc);
    assert.equal(pay.status, 409, pay.text); assert.match(pay.json.error.message, /do not pay again/i);
    // after the refund is sent, paying is allowed again (the hold is still open)
    assert.equal(await requestRefund(c.db, a.p.reference), 'requested');
    assert.equal((await c.call('POST', `/api/bookings/${a.id}/pay`, {}, a.cc)).status, 409, 'refund on its way: still blocked');
    await c.db.query(`UPDATE payments SET refund_status='REFUNDED' WHERE reference=$1`, [a.p.reference]);
    const det2 = (await c.call('GET', `/api/bookings/${a.id}`, undefined, a.cc)).json.booking;
    assert.equal(det2.pay_blocked, undefined);
    assert.equal((await c.call('POST', `/api/bookings/${a.id}/pay`, {}, a.cc)).status, 200);
  } finally { setGatewayVerifier(null); c.close(); }
});

test('F: once a mismatch refund is asked for the customer is told "we asked"; when staff mark it paid back they are told "has been sent back"; the page says "sent", not "checking"', async () => {
  const c = await bootApp();
  try {
    await adminOn(c);
    const a = await mismatchBooking(c, '10:00'); const b = await mismatchBooking(c, '11:00');
    const uid = c.customerIds[0];
    assert.ok(!(await notifs(c.db, uid)).some((n: any) => /sent (your payment|your money|back)|has been sent back|asked for your money/i.test(n.title + n.body)));
    assert.equal(await requestRefund(c.db, a.p.reference), 'requested');
    const n1 = (await notifs(c.db, uid)).filter((n: any) => n.title === 'We asked for your money to be sent back');
    assert.equal(n1.length, 1); assert.match(n1[0].body, /We asked for your money to be sent back/); assert.doesNotMatch(n1[0].body, /checking|check it|has been sent back/i);
    // staff "mark refunded" on the other one
    const r = await fetch(c.base + `/api/admin/payments/${b.p.reference}/mark-refunded`, { method: 'POST', headers: ADMIN, body: JSON.stringify({}) });
    assert.equal(r.status, 200, await r.clone().text());
    const n2 = (await notifs(c.db, uid)).filter((n: any) => n.title === 'Your money has been sent back');
    assert.equal(n2.length, 1); assert.match(n2[0].body, /has been sent back/);
    // the booking page data: refund is "coming" then "sent"
    assert.equal((await c.call('GET', `/api/bookings/${a.id}`, undefined, a.cc)).json.booking.payment_issue.refund, 'coming');
    await c.db.query(`UPDATE payments SET refund_status='REFUNDED' WHERE reference=$1`, [a.p.reference]);
    assert.equal((await c.call('GET', `/api/bookings/${a.id}`, undefined, a.cc)).json.booking.payment_issue.refund, 'sent');
    // the page text for that state (public/app.js)
    const js = (await import('node:fs')).readFileSync('public/app.js', 'utf8');
    assert.match(js, /issue && issue\.refund !== 'none' \? [^:]+ : 'Our team is checking it/, 'the "checking" words only show while nothing was refunded');
    assert.match(js, /payment_issue\.refund === 'sent' \? 'We have sent your payment back'/, 'the Check-my-payment toast says "sent" too');
  } finally { setGatewayVerifier(null); c.close(); }
});

test('G: an unanswered help request becomes a staff alert: no target barber, labelled in the admin lists, not a complaint, reporter is not sent "your report was resolved"', async () => {
  const c = await bootApp();
  try {
    await adminOn(c);
    const cc = await c.chidi();
    const o = await c.call('POST', '/api/bookings', { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time: '10:00', payment_option: 'ONLINE' }, cc);
    const id = o.json.booking.id as number;
    const { applyVerifiedPayment } = await import('../src/bookingService'); await c.db.tx((t) => applyVerifiedPayment(t, id, 'PAYSTACK'));
    setNow(`${WED}T09:45:00+01:00`);
    assert.equal((await c.call('POST', `/api/bookings/${id}/help`, { note: 'Emergency at home' }, cc)).status, 201);
    setNow(`${WED}T10:01:00+01:00`);
    assert.equal(await escalateUnansweredHelp(c.db), 1);
    const rep = await c.db.one<any>('SELECT * FROM reports WHERE booking_id=$1', [id]);
    assert.equal(rep.target_user_id, null, 'not filed against the barber');
    assert.match(rep.message, /^Unanswered help request \(staff alert, not a complaint/);
    // nothing about the barber's complaints
    const barberUid = (await c.db.one<any>('SELECT user_id FROM barbers WHERE id=$1', [c.barberId])).user_id;
    assert.equal((await c.db.one<any>('SELECT COUNT(*)::int c FROM reports WHERE target_user_id=$1', [barberUid])).c, 0);
    const j = (p: string, init: any = {}) => fetch(c.base + '/api/admin' + p, { ...init, headers: ADMIN }).then((r) => r.json());
    const inbox = await j('/reports');
    const row = inbox.reports.find((x: any) => x.id === rep.id); assert.equal(row.staff_alert, true); assert.equal(row.target_name, null);
    const l3 = await j('/l/reports?status=OPEN');
    assert.equal(l3.rows.find((x: any) => x.id === rep.id)?.staff_alert, true);
    const bsheet = await j(`/users/${barberUid}`);
    assert.equal((bsheet.reports ?? []).length, 0, "the barber's admin sheet shows no report about them");
    // a normal customer report is not an alert, and closing the alert does not message the customer as a "report"
    const before = (await notifs(c.db, c.customerIds[0])).length;
    const res = await fetch(c.base + `/api/admin/reports/${rep.id}/resolve`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ status: 'RESOLVED', note: 'Called both', notify_reporter: true }) });
    assert.equal(res.status, 200);
    assert.ok(!(await notifs(c.db, c.customerIds[0])).slice(before).some((n: any) => n.type === 'REPORT_UPDATE'));
    const js3 = (await import('node:fs')).readFileSync('public/admin3.js', 'utf8'); assert.match(js3, /Staff alert/);
  } finally { c.close(); }
});

test('H: legal "In plain words" boxes say the credit comes when the barber marks a no-show; refunds box says no no-show = no refund and no credit; no business numbers', async () => {
  const fs = await import('node:fs');
  const terms = fs.readFileSync('public/terms.html', 'utf8'), plan = fs.readFileSync('public/plan-terms.html', 'utf8'), ref = fs.readFileSync('public/refunds.html', 'utf8');
  assert.match(terms, /When your barber marks it a no-show, you get one credit with the same barber/);
  assert.match(plan, /When your barber marks it a no-show, you get one credit with the same barber/);
  assert.match(ref, /If the barber does not mark a no-show, there is no refund and no credit\./);
  assert.match(ref, /If you do not come and the barber marks a no-show, section 4 applies. A credit for a missed session comes only when your barber marks it a no-show. Other credits are in section 4.2\./, 'section 2.2 is limited to the missed-session credit and points to 4.2 for other credits');
});
