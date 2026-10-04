import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'net';
import { setupPin } from '../src/adminPin';
import { freshDb, setNow, resetNow, WED } from './helpers';
import { createApp } from '../src/app';
import { barberAction, createBooking, customerCancel, getBooking } from '../src/bookingService';
import { initializePayment, mockMarkPaid, processReference } from '../src/paystack';

const KEY = 'test-admin-key-0123456789';
const NOW = `${WED}T08:00:00+01:00`;

async function boot() {
  const s = await freshDb(); setNow(NOW);
  process.env.CRON_SECRET = KEY; await setupPin(s.db, '4821');
  const server = createApp(s.db).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const j = async (p: string, o: any = {}) => { const r = await fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }); return { status: r.status, body: (await r.json().catch(() => ({}))) as any }; };
  const A = { Authorization: 'Bearer ' + KEY, 'X-Admin-Pin': '4821' };
  return { ...s, server, j, A, base } as any;
}
const paid = async (s: any, cust: number, time: string) => {
  const b = await createBooking(s.db, cust, { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time, payment_option: 'ONLINE' });
  const i = await initializePayment(s.db, b.id, null); await mockMarkPaid(s.db, i.reference); await processReference(s.db, i.reference);
  return { b, ref: i.reference };
};

test('admin API: every route needs the admin key; wrong keys are rejected and eventually rate limited; the portal page is static and holds no secret', async () => {
  const s = await boot();
  try {
    for (const p of ['/overview', '/barbers', '/bookings', '/payments', '/cancellations', '/plans', '/credits', '/audit', '/settings', '/refunds'])
      assert.equal((await s.j('/api/admin' + p)).status, 401, p + ' without key');
    assert.equal((await s.j('/api/admin' + '/overview', { headers: { Authorization: 'Bearer nope' } })).status, 401);
    const cookie = (await fetch(`http://127.0.0.1:${(s.server.address() as AddressInfo).port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'mike@trimslot.demo', password: 'Barber123!' }) })).headers.get('set-cookie')!.split(';')[0];
    assert.equal((await s.j('/api/admin/overview', { headers: { Cookie: cookie } })).status, 401, 'a logged-in barber is not an admin');
    assert.equal((await s.j('/api/admin/login', { method: 'POST', headers: s.A, body: {} })).status, 200);
    const html = await (await fetch(`http://127.0.0.1:${(s.server.address() as AddressInfo).port}/admin.html`)).text().catch(() => '');
    assert.ok(!html.includes(KEY));
  } finally { s.server.close(); resetNow(); }
});

test('admin overview + lists reflect real data; verify / suspend a barber is audited, notifies the owner and hides the shop', async () => {
  const s = await boot();
  try {
    await paid(s, s.customerIds[0], '10:00');
    const o = (await s.j('/api/admin/overview', { headers: s.A })).body;
    assert.equal(o.barbers_verified, 1); assert.equal(o.customers, s.customerIds.length); assert.equal(o.bookings_today, 1); assert.ok(o.revenue_kobo > 0);
    const bl = (await s.j('/api/admin/barbers', { headers: s.A })).body.barbers; assert.equal(bl.length, 1); assert.ok(['SET', 'MISSING'].includes(bl[0].subaccount_status));
    const sus = await s.j(`/api/admin/barbers/${s.barberId}/suspend`, { method: 'POST', headers: s.A, body: { reason: 'Test suspension', bookings: 'keep' } }); assert.equal(sus.body.changed, true);
    assert.equal((await s.j('/api/barbers')).body.barbers.length, 0, 'suspended shop is hidden from customers');
    assert.equal((await s.j(`/api/admin/barbers/${s.barberId}/suspend`, { method: 'POST', headers: s.A, body: { reason: 'Test suspension', bookings: 'keep' } })).body.changed, false, 'idempotent');
    assert.equal((await s.j(`/api/admin/barbers/${s.barberId}/verify`, { method: 'POST', headers: s.A, body: {} })).body.changed, true);
    assert.equal((await s.j('/api/barbers')).body.barbers.length, 1);
    assert.equal((await s.j('/api/admin/barbers/9999/verify', { method: 'POST', headers: s.A, body: {} })).status, 404);
    const audit = (await s.j('/api/admin/audit', { headers: s.A })).body.entries.map((e: any) => e.action);
    assert.ok(audit.includes('ADMIN_BARBER_SUSPENDED') && audit.includes('ADMIN_BARBER_REINSTATED'));
    const bk = (await s.j(`/api/admin/bookings?date=${WED}&barber_id=${s.barberId}&status=CONFIRMED`, { headers: s.A })).body.bookings; assert.equal(bk.length, 1);
    assert.equal((await s.j(`/api/admin/bookings?status=CANCELLED`, { headers: s.A })).body.bookings.length, 0);
    const pays = (await s.j('/api/admin/payments?filter=paid', { headers: s.A })).body; assert.equal(pays.payments.length, 1); assert.equal(pays.summary.paid, 1);
  } finally { s.server.close(); resetNow(); }
});

test('admin refunds: a flagged payment can be retried (mock gateway) or marked refunded; states are idempotent and audited', async () => {
  const s = await boot();
  try {
    const p = await paid(s, s.customerIds[0], '10:00');
    await s.db.query(`UPDATE payments SET refund_status='NEEDS_REFUND', refund_reason='test' WHERE reference=$1`, [p.ref]);
    const list = (await s.j('/api/admin/payments?filter=needs_refund', { headers: s.A })).body; assert.equal(list.payments.length, 1); assert.equal(list.summary.open_refunds, 1);
    const retry = await s.j(`/api/admin/payments/${p.ref}/retry-refund`, { method: 'POST', headers: s.A, body: {} }); assert.equal(retry.body.refund_status, 'REFUND_REQUESTED');
    assert.equal((await s.j(`/api/admin/payments/${p.ref}/retry-refund`, { method: 'POST', headers: s.A, body: {} })).status, 409, 'already requested');
    const mark = await s.j(`/api/admin/payments/${p.ref}/mark-refunded`, { method: 'POST', headers: s.A, body: { note: 'paid by transfer' } }); assert.equal(mark.body.refund_status, 'REFUNDED');
    assert.equal((await s.j(`/api/admin/payments/${p.ref}/mark-refunded`, { method: 'POST', headers: s.A, body: {} })).body.refund_status, 'REFUNDED');
    assert.equal((await s.j('/api/admin/payments?filter=needs_refund', { headers: s.A })).body.summary.open_refunds, 0);
    assert.equal((await s.j(`/api/admin/payments/TS-NOPE/mark-refunded`, { method: 'POST', headers: s.A, body: {} })).status, 404);
    await s.db.query(`UPDATE payments SET refund_status=NULL WHERE reference=$1`, [p.ref]);
    assert.equal((await s.j(`/api/admin/payments/${p.ref}/mark-refunded`, { method: 'POST', headers: s.A, body: {} })).status, 409, 'not flagged');
    const acts = (await s.j('/api/admin/audit', { headers: s.A })).body.entries.map((e: any) => e.action);
    assert.ok(acts.includes('ADMIN_REFUND_RETRIED') && acts.includes('ADMIN_MARKED_REFUNDED'));
  } finally { s.server.close(); resetNow(); }
});

test('legacy cancellation decisions: CREDIT_PENDING converts to a same-barber credit or a refund exactly once', async () => {
  const s = await boot();
  try {
    const a = await paid(s, s.customerIds[0], '10:00'); const b = await paid(s, s.customerIds[1], '11:00');
    await customerCancel(s.db, s.customerIds[0], a.b.id); await customerCancel(s.db, s.customerIds[1], b.b.id);
    // rows created before the refund flow existed: seed them in the legacy CREDIT_PENDING shape
    await s.db.query(`UPDATE bookings SET payment_status='CREDIT_PENDING' WHERE id = ANY($1)`, [[a.b.id, b.b.id]]);
    await s.db.query(`UPDATE payments SET refund_status=NULL, refund_due_at=NULL WHERE booking_id = ANY($1)`, [[a.b.id, b.b.id]]);
    const q = (await s.j('/api/admin/cancellations', { headers: s.A })).body; assert.equal(q.bookings.length, 2);
    assert.equal((await s.j('/api/admin/bookings/' + a.b.id + '/resolve', { method: 'POST', headers: s.A, body: { action: 'nonsense' } })).status, 400);
    const cr = await s.j(`/api/admin/bookings/${a.b.id}/resolve`, { method: 'POST', headers: s.A, body: { action: 'credit' } }); assert.equal(cr.status, 200); assert.ok(cr.body.credit.id);
    assert.equal((await getBooking(s.db, a.b.id))!.payment_status, 'CREDITED');
    assert.equal((await s.j(`/api/admin/bookings/${a.b.id}/resolve`, { method: 'POST', headers: s.A, body: { action: 'credit' } })).status, 409, 'cannot decide twice');
    const rf = await s.j(`/api/admin/bookings/${b.b.id}/resolve`, { method: 'POST', headers: s.A, body: { action: 'refund' } }); assert.equal(rf.status, 200); assert.equal(rf.body.refund, 'requested');
    assert.equal((await getBooking(s.db, b.b.id))!.payment_status, 'VOID');
    assert.equal((await s.db.one(`SELECT refund_status FROM payments WHERE reference=$1`, [b.ref])).refund_status, 'REFUND_REQUESTED');
    assert.equal((await s.db.many(`SELECT 1 FROM notifications WHERE user_id=$1 AND type='REFUND_APPROVED'`, [s.customerIds[1]])).length, 1);
    assert.equal((await s.j('/api/admin/cancellations', { headers: s.A })).body.bookings.length, 0);
    const cl = (await s.j('/api/admin/credits', { headers: s.A })).body.credits; assert.equal(cl.length, 1); assert.equal(cl[0].reason, 'EARLY_CANCEL');
    assert.equal((await s.j('/api/admin/plans', { headers: s.A })).status, 200);
  } finally { s.server.close(); resetNow(); }
});

test('admin login brute force: repeated wrong keys are locked out (429) even for the right key afterwards', async () => {
  const s = await boot();
  try {
    process.env.NODE_ENV = 'development'; // limiter is disabled under NODE_ENV=test
    for (let i = 0; i < 8; i++) assert.equal((await s.j('/api/admin/login', { method: 'POST', headers: { Authorization: 'Bearer wrong' + i }, body: {} })).status, 401);
    assert.equal((await s.j('/api/admin/login', { method: 'POST', headers: s.A, body: {} })).status, 429);
  } finally { process.env.NODE_ENV = 'test'; s.server.close(); resetNow(); }
});

test('ADMIN_KEY works for admin (not for cron), CRON_SECRET still works for both; short ADMIN_KEY is ignored', async () => {
  const s = await boot(); const AK = 'separate-admin-key-abcdef123456';
  try {
    process.env.ADMIN_KEY = AK;
    const H = (k: string) => ({ Authorization: 'Bearer ' + k });
    assert.equal((await s.j('/api/admin/overview', { headers: H(AK) })).status, 200, 'ADMIN_KEY opens admin');
    assert.equal((await s.j('/api/admin/overview', { headers: H(KEY) })).status, 200, 'CRON_SECRET fallback opens admin');
    assert.equal((await s.j('/api/admin/overview', { headers: H(AK + 'x') })).status, 401);
    assert.equal((await s.j('/api/admin/overview')).status, 401);
    assert.equal((await s.j('/api/cron/sweep', { headers: H(AK) })).status, 401, 'ADMIN_KEY must not run the cron sweep');
    assert.equal((await s.j('/api/cron/sweep', { headers: H(KEY) })).status, 200, 'CRON_SECRET still runs the sweep');
    process.env.ADMIN_KEY = 'short';
    assert.equal((await s.j('/api/admin/overview', { headers: H('short') })).status, 401, 'too-short ADMIN_KEY is ignored');
    process.env.ADMIN_KEY = AK;
    process.env.NODE_ENV = 'development';
    for (let i = 0; i < 8; i++) assert.equal((await s.j('/api/admin/overview', { headers: H('wrong' + i) })).status, 401);
    assert.equal((await s.j('/api/admin/overview', { headers: H(AK) })).status, 429, 'lockout applies to ADMIN_KEY too');
  } finally { delete process.env.ADMIN_KEY; process.env.NODE_ENV = 'test'; s.server.close(); resetNow(); }
});

async function newPendingBarber(s: any, tag = 'p') {
  const r = await fetch(s.base + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accept_terms: true, accept_barber_agreement: true, role: 'barber', name: 'New Barber', email: `nb-${tag}@x.test`, password: 'Barber123!', shop_name: 'New Shop ' + tag, location: 'Lekki' }) });
  const cookie = r.headers.get('set-cookie')!.split(';')[0];
  const row = await s.db.one(`SELECT b.id, b.user_id FROM barbers b JOIN users u ON u.id=b.user_id WHERE u.email=$1`, [`nb-${tag}@x.test`]);
  return { id: row.id as number, uid: row.user_id as number, cookie, me: async () => (await (await fetch(s.base + '/api/auth/me', { headers: { Cookie: cookie } })).json() as any).user };
}

test('barber review workflow: pending -> needs info -> resubmit -> reject (reason required) -> resubmit -> approve; barber sees status + reason; notified; audited', async () => {
  const s = await boot(); s.base = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}`;
  try {
    const nb = await newPendingBarber(s);
    assert.equal((await nb.me()).review_status, 'PENDING'); assert.equal((await nb.me()).verified, false);
    const c = (await s.j('/api/admin/barbers', { headers: s.A })).body.counts; assert.equal(c.PENDING, 1); assert.equal(c.VERIFIED, 1); assert.equal(c.ALL, 2);
    assert.equal((await s.j('/api/admin/barbers?status=PENDING', { headers: s.A })).body.barbers.length, 1);
    const det = (await s.j(`/api/admin/barbers/${nb.id}`, { headers: s.A })).body; assert.equal(det.barber.email, 'nb-p@x.test'); assert.ok(Array.isArray(det.services) && det.schedule.length === 7); assert.equal(det.barber.subaccount_status, 'MISSING');
    const post = (path: string, body: any = {}) => s.j(`/api/admin/barbers/${nb.id}/${path}`, { method: 'POST', headers: s.A, body });
    assert.equal((await post('request-info', {})).status, 400, 'message required');
    assert.equal((await post('request-info', { message: 'Please add a service with a price.' })).body.review_status, 'NEEDS_INFO');
    let me = await nb.me(); assert.equal(me.review_status, 'NEEDS_INFO'); assert.match(me.review_reason, /add a service/);
    assert.equal(((await s.j('/api/barbers')).body.barbers as any[]).some((b) => b.id === nb.id), false);
    const rs = await s.j('/api/barber/resubmit', { method: 'POST', headers: { Cookie: nb.cookie }, body: { note: 'Added services' } }); assert.equal(rs.body.review_status, 'PENDING'); assert.equal(rs.body.review_reason, null);
    assert.equal((await post('reject', {})).status, 400, 'reason required'); assert.equal((await post('reject', { reason: '  ' })).status, 400);
    assert.equal((await post('reject', { reason: 'Shop photo is missing.' })).body.review_status, 'REJECTED');
    assert.equal((await post('reject', { reason: 'Shop photo is missing.' })).body.changed, false, 'idempotent');
    me = await nb.me(); assert.equal(me.review_status, 'REJECTED'); assert.equal(me.review_reason, 'Shop photo is missing.'); assert.equal(me.verified, false);
    assert.equal((await s.j('/api/barber/profile', { headers: { Cookie: nb.cookie } })).body.profile.review_reason, 'Shop photo is missing.');
    assert.equal((await post('request-info', { message: 'more please' })).status, 409, 'cannot ask info from a rejected shop');
    assert.equal((await s.j('/api/barber/resubmit', { method: 'POST', headers: { Cookie: nb.cookie }, body: {} })).body.review_status, 'PENDING');
    assert.equal((await post('approve')).body.review_status, 'VERIFIED');
    assert.equal(((await s.j('/api/barbers')).body.barbers as any[]).some((b) => b.id === nb.id), true);
    assert.equal((await s.j('/api/barber/resubmit', { method: 'POST', headers: { Cookie: nb.cookie }, body: {} })).status, 409, 'approved shops cannot resubmit');
    assert.equal((await post('reject', { reason: 'too late' })).status, 409, 'live shop: suspend, not reject');
    const types = (await s.db.many(`SELECT type FROM notifications WHERE user_id=$1 ORDER BY id`, [nb.uid])).map((r: any) => r.type); assert.deepEqual(types, ['BARBER_NEEDS_INFO', 'BARBER_REJECTED', 'BARBER_VERIFIED']);
    const acts = (await s.j('/api/admin/audit', { headers: s.A })).body.entries.map((e: any) => e.action);
    for (const a of ['ADMIN_BARBER_INFO_REQUESTED', 'ADMIN_BARBER_REJECTED', 'ADMIN_BARBER_VERIFIED', 'BARBER_RESUBMITTED']) assert.ok(acts.includes(a), a);
    assert.equal((await s.j('/api/admin/barbers/999999/reject', { method: 'POST', headers: s.A, body: { reason: 'nope nope' } })).status, 404);
  } finally { s.server.close(); resetNow(); }
});

test('suspend needs a reason; reinstate is reversible; suspended shop is hidden and unbookable, barber sees the reason', async () => {
  const s = await boot();
  try {
    const H = { headers: s.A, method: 'POST' };
    assert.equal((await s.j(`/api/admin/barbers/${s.barberId}/suspend`, { ...H, body: {} })).status, 400);
    const r = await s.j(`/api/admin/barbers/${s.barberId}/suspend`, { ...H, body: { reason: 'Customer complaints' } }); assert.equal(r.body.review_status, 'SUSPENDED');
    const uid = (await s.db.one('SELECT user_id FROM barbers WHERE id=$1', [s.barberId])).user_id;
    assert.equal((await s.db.one('SELECT review_reason, verified FROM barbers WHERE id=$1', [s.barberId])).review_reason, 'Customer complaints');
    assert.equal((await s.j('/api/barbers')).body.barbers.length, 0);
    await assert.rejects(createBooking(s.db, s.customerIds[0], { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' }), /not found|Barber/i);
    assert.equal((await s.j(`/api/admin/barbers/${s.barberId}/approve`, { ...H, body: {} })).status, 409, 'approve of suspended => use reinstate');
    assert.equal((await s.j(`/api/admin/barbers/${s.barberId}/reinstate`, { ...H, body: {} })).body.review_status, 'VERIFIED');
    assert.equal((await s.j(`/api/admin/barbers/${s.barberId}/reinstate`, { ...H, body: {} })).body.changed, false);
    assert.equal((await s.j('/api/barbers')).body.barbers.length, 1);
    assert.equal((await s.db.one('SELECT review_reason FROM barbers WHERE id=$1', [s.barberId])).review_reason, null);
    const types = (await s.db.many(`SELECT type FROM notifications WHERE user_id=$1 ORDER BY id`, [uid])).map((x: any) => x.type); assert.deepEqual(types, ['BARBER_SUSPENDED', 'BARBER_REINSTATED']);
    assert.equal((await s.j(`/api/admin/barbers/${s.barberId}/reinstate`, { ...H, body: {} })).body.review_status, 'VERIFIED');
  } finally { s.server.close(); resetNow(); }
});

test('suspending a barber with upcoming bookings: 409 with the count, nothing changes until the admin chooses keep or cancel; customers are always notified', async () => {
  const s = await boot();
  try {
    const p1 = await paid(s, s.customerIds[0], '10:00');            // paid online
    const b2 = await createBooking(s.db, s.customerIds[1], { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '11:00', payment_option: 'ON_ARRIVAL' });
    const sp = (body: any) => s.j(`/api/admin/barbers/${s.barberId}/suspend`, { method: 'POST', headers: s.A, body });
    const warn = await sp({ reason: 'Investigating a complaint' });
    assert.equal(warn.status, 409); assert.equal(warn.body.error.code, 'FUTURE_BOOKINGS'); assert.equal(warn.body.error.details.count, 2);
    assert.equal((await s.db.one('SELECT review_status FROM barbers WHERE id=$1', [s.barberId])).review_status, 'VERIFIED', 'unchanged after the warning');
    assert.equal((await getBooking(s.db, p1.b.id))!.status, 'CONFIRMED');
    const keep = await sp({ reason: 'Investigating a complaint', bookings: 'keep' }); assert.equal(keep.status, 200); assert.equal(keep.body.upcoming, 2); assert.equal(keep.body.cancelled, 0);
    assert.equal((await getBooking(s.db, p1.b.id))!.status, 'CONFIRMED'); assert.equal((await getBooking(s.db, b2.id))!.status, 'CONFIRMED');
    assert.equal((await s.db.many(`SELECT 1 FROM notifications WHERE type='SHOP_PAUSED' AND user_id IN ($1,$2)`, [s.customerIds[0], s.customerIds[1]])).length, 2);
    await s.j(`/api/admin/barbers/${s.barberId}/reinstate`, { method: 'POST', headers: s.A, body: {} });
    const cancel = await sp({ reason: 'Closed for good', bookings: 'cancel' }); assert.equal(cancel.body.cancelled, 2);
    assert.equal((await getBooking(s.db, p1.b.id))!.status, 'CANCELLED'); assert.equal((await getBooking(s.db, b2.id))!.status, 'CANCELLED');
    assert.equal((await s.db.one(`SELECT refund_status FROM payments WHERE reference=$1`, [p1.ref])).refund_status, 'REFUND_REQUESTED', 'paid booking refunded through the gateway');
    assert.equal((await s.db.many(`SELECT 1 FROM notifications WHERE type='BOOKING_CANCELLED' AND user_id IN ($1,$2)`, [s.customerIds[0], s.customerIds[1]])).length, 2);
    const a = (await s.j('/api/admin/audit', { headers: s.A })).body.entries.map((e: any) => e.action); assert.ok(a.includes('ADMIN_BOOKING_CANCELLED_SUSPENSION') && a.includes('ADMIN_BARBER_SUSPENDED'));
  } finally { s.server.close(); resetNow(); }
});

test('legacy paths still work: CLI-style UPDATE verified keeps review_status in sync (trigger)', async () => {
  const s = await boot();
  try {
    await s.db.query('UPDATE barbers SET verified=FALSE WHERE id=$1', [s.barberId]);
    assert.equal((await s.db.one('SELECT review_status FROM barbers WHERE id=$1', [s.barberId])).review_status, 'SUSPENDED');
    await s.db.query('UPDATE barbers SET verified=TRUE WHERE id=$1', [s.barberId]);
    assert.equal((await s.db.one('SELECT review_status FROM barbers WHERE id=$1', [s.barberId])).review_status, 'VERIFIED');
  } finally { s.server.close(); resetNow(); }
});
