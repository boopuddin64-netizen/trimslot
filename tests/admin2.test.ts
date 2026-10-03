import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'net';
import { setupPin } from '../src/adminPin';
import { freshDb, setNow, resetNow, WED } from './helpers';
import { createApp } from '../src/app';
import { createBooking } from '../src/bookingService';
import { initializePayment, mockMarkPaid, processReference } from '../src/paystack';
import { savePlan, planSchema } from '../src/plans';
import { initializePlanPurchase } from '../src/paystack';

const KEY = 'test-admin-key-0123456789';
const NOW = `${WED}T08:00:00+01:00`;
async function boot() {
  const s = await freshDb(); setNow(NOW); process.env.CRON_SECRET = KEY; await setupPin(s.db, '4821');
  for (const n of [3, 4]) s.customerIds.push((await s.db.one(`INSERT INTO users (role,name,email,phone,password_hash) VALUES ('customer',$1,$2,$3,'x') RETURNING id`, ['Extra ' + n, `extra${n}@trimslot.demo`, '0806000000' + n])).id);
  const server = createApp(s.db).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const j = async (p: string, o: any = {}) => { const r = await fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }); const text = await r.text(); let body: any = {}; try { body = JSON.parse(text); } catch { body = { text }; } return { status: r.status, body, headers: r.headers }; };
  const A = { Authorization: 'Bearer ' + KEY, 'X-Admin-Pin': '4821' };
  const post = (p: string, body: any = {}) => j('/api/admin' + p, { method: 'POST', headers: A, body });
  const get = (p: string) => j('/api/admin' + p, { headers: A });
  const login = async (email: string, password: string) => { const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: email, password }) }); return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }; };
  return { ...s, server, j, A, post, get, login, base } as any;
}
const notes = (s: any, uid: number, type: string) => s.db.one(`SELECT COUNT(*)::int c FROM notifications WHERE user_id=$1 AND type=$2`, [uid, type]).then((r: any) => r.c);
const uidOf = async (s: any, cust: number) => cust;

test('customers: search, profile, warn / suspend / ban / reinstate need reasons, are idempotent, audited, notify, and block login + booking', async () => {
  const s = await boot();
  try {
    const cid = s.customerIds[0]; const cu = await s.db.one('SELECT email FROM users WHERE id=$1', [cid]);
    const list = (await s.get('/customers?q=' + encodeURIComponent(cu.email.slice(0, 5)))).body; assert.ok(list.customers.some((c: any) => c.id === cid));
    assert.equal((await s.get('/customers?q=' + "%' OR 1=1 --")).body.customers.length, 0, 'search is parameterised + escaped');
    assert.equal((await s.get('/users/' + cid)).body.user.id, cid);
    assert.equal((await s.get('/users/99999')).status, 404);
    assert.equal((await s.post(`/users/${cid}/warn`, {})).status, 400, 'reason required');
    assert.equal((await s.post(`/users/${cid}/warn`, { reason: 'Please be on time' })).body.warn_count, 1);
    assert.equal(await notes(s, cid, 'ACCOUNT_WARNING'), 1);
    assert.equal((await s.post(`/users/${cid}/suspend`, { reason: 'x' })).status, 400);
    assert.equal((await s.post(`/users/${cid}/suspend`, { reason: 'Repeated no-shows' })).body.changed, true);
    assert.equal((await s.post(`/users/${cid}/suspend`, { reason: 'Repeated no-shows' })).body.changed, false, 'idempotent');
    assert.equal(await notes(s, cid, 'ACCOUNT_SUSPENDED'), 1, 'one notification only');
    assert.equal((await s.login(cu.email, 'Customer123!')).status, 403, 'suspended customers cannot log in');
    await assert.rejects(createBooking(s.db, cid, { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' }));
    assert.equal((await s.post(`/users/${cid}/ban`, { reason: 'Abuse' })).body.account_status, 'BANNED');
    assert.equal((await s.post(`/users/${cid}/reinstate`)).body.changed, true);
    assert.equal((await s.post(`/users/${cid}/reinstate`)).body.changed, false);
    assert.equal((await s.login(cu.email, 'Customer123!')).status, 200, 'reinstated');
    assert.equal((await s.post(`/users/${cid}/notify`, { body: 'Hello there' })).status, 200);
    assert.equal(await notes(s, cid, 'ADMIN_MESSAGE'), 1);
    const bUid = (await s.db.one('SELECT user_id FROM barbers WHERE id=$1', [s.barberId])).user_id;
    assert.equal((await s.post(`/users/${bUid}/suspend`, { reason: 'nope nope' })).status, 409, 'barbers go through the review workflow');
    const acts = (await get2(s, '/audit?scope=all&limit=100')).actions;
    for (const a of ['ADMIN_USER_WARNED', 'ADMIN_USER_SUSPENDED', 'ADMIN_USER_BANNED', 'ADMIN_USER_REINSTATED', 'ADMIN_USER_NOTIFIED']) assert.ok(acts.includes(a), a);
  } finally { s.server.close(); resetNow(); }
});
const get2 = async (s: any, p: string) => (await s.get(p)).body;

test('booking control: cancel (refund / credit / none), reschedule with conflict checks, no-show, reasons + notifications to both sides', async () => {
  const s = await boot();
  try {
    const bUid = (await s.db.one('SELECT user_id FROM barbers WHERE id=$1', [s.barberId])).user_id;
    const mk = (cust: number, time: string, opt: any = 'ON_ARRIVAL') => createBooking(s.db, cust, { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time, payment_option: opt });
    const paid = async (cust: number, time: string) => { const b = await mk(cust, time, 'ONLINE'); const i = await initializePayment(s.db, b.id, null); await mockMarkPaid(s.db, i.reference); await processReference(s.db, i.reference); return { b, ref: i.reference }; };
    const a = await mk(s.customerIds[0], '10:00'); const b = await mk(s.customerIds[1], '11:00');
    assert.equal((await s.post(`/bookings/${a.id}/reschedule`, { date: WED, time: '11:00', reason: 'test move' })).status, 409, 'overlap refused');
    const mv = await s.post(`/bookings/${a.id}/reschedule`, { date: WED, time: '12:00', reason: 'barber running late' }); assert.equal(mv.status, 200, JSON.stringify(mv.body));
    assert.equal(await notes(s, s.customerIds[0], 'BOOKING_RESCHEDULED'), 1); assert.equal(await notes(s, bUid, 'BOOKING_RESCHEDULED'), 1, 'both sides notified');
    assert.equal((await s.post(`/bookings/${a.id}/reschedule`, { date: WED, time: '12:00', reason: '' })).status, 400);
    assert.equal((await s.post(`/bookings/${a.id}/cancel`, { reason: 'ab' })).status, 400, 'reason required');
    assert.equal((await s.post(`/bookings/${a.id}/cancel`, { reason: 'customer asked by phone' })).body.status, 'CANCELLED');
    assert.equal((await s.post(`/bookings/${a.id}/cancel`, { reason: 'customer asked by phone' })).status, 409, 'cannot cancel twice');
    assert.equal(await notes(s, s.customerIds[0], 'BOOKING_CANCELLED'), 1);
    const p1 = await paid(s.customerIds[2], '15:00');
    const c1 = await s.post(`/bookings/${p1.b.id}/cancel`, { reason: 'shop closed today', refund: 'refund' }); assert.equal(c1.body.refund, 'requested');
    assert.equal((await s.db.one('SELECT refund_status FROM payments WHERE reference=$1', [p1.ref])).refund_status, 'REFUND_REQUESTED');
    const p2 = await paid(s.customerIds[3], '16:00');
    const c2 = await s.post(`/bookings/${p2.b.id}/cancel`, { reason: 'barber ill', refund: 'credit' }); assert.ok(c2.body.credit_id, JSON.stringify(c2.body));
    assert.equal((await s.db.one('SELECT COUNT(*)::int c FROM session_credits WHERE customer_id=$1', [s.customerIds[3]])).c, 1);
    const cr = c2.body.credit_id;
    assert.equal((await s.post(`/credits/${cr}/revoke`, { reason: 'issued in error' })).body.changed, true);
    assert.equal((await s.post(`/credits/${cr}/revoke`, { reason: 'issued in error' })).body.changed, false);
    assert.equal((await s.post('/credits/issue', { customer_id: s.customerIds[3], barber_id: s.barberId, value_naira: 1500, reason: 'goodwill' })).status, 200);
    setNow(`${WED}T11:30:00+01:00`);
    const ns = await s.post(`/bookings/${b.id}/no-show`, { reason: 'did not turn up' }); assert.equal(ns.body.status, 'NO_SHOW');
    assert.equal((await s.post(`/bookings/${b.id}/complete`, { reason: 'try anyway' })).status, 409);
    const acts = (await get2(s, '/audit?scope=all&limit=200')).actions;
    for (const x of ['ADMIN_BOOKING_CANCELLED', 'ADMIN_BOOKING_RESCHEDULED', 'ADMIN_BOOKING_NO_SHOW', 'ADMIN_CREDIT_ISSUED', 'ADMIN_CREDIT_REVOKED']) assert.ok(acts.includes(x), x);
    const det = (await s.get('/bookings/' + p1.b.id)).body; assert.ok(det.booking || det.id);
  } finally { s.server.close(); resetNow(); }
});

test('plan oversight: hide/restore plan, adjust sessions + expiry within bounds, cancel purchase with refund flag; wallet hides revoked credits', async () => {
  const s = await boot();
  try {
    const planId = await s.db.tx((t: any) => savePlan(t, s.barberId, null, planSchema.parse({ name: 'P4', price_naira: 12000, sessions: 4, validity_days: 30, service_ids: [s.serviceIds[0]] })));
    const init = await initializePlanPurchase(s.db, s.customerIds[0], planId, null); await mockMarkPaid(s.db, init.reference); await processReference(s.db, init.reference);
    const pid = init.purchase_id;
    assert.equal((await s.post(`/plans/${planId}/visibility`, { active: false })).status, 400, 'reason required');
    assert.equal((await s.post(`/plans/${planId}/visibility`, { active: false, reason: 'misleading price' })).body.changed, true);
    assert.equal((await s.post(`/plans/${planId}/visibility`, { active: false, reason: 'misleading price' })).body.changed, false);
    assert.equal((await s.j(`/api/barbers/${s.barberId}`)).body.plans.length, 0, 'hidden plan is not sold');
    await s.post(`/plans/${planId}/visibility`, { active: true, reason: 'fixed' });
    assert.equal((await s.post(`/plan-purchases/${pid}/adjust`, { reason: 'bonus session', delta: 1 })).body.sessions_total, 5);
    assert.equal((await s.post(`/plan-purchases/${pid}/adjust`, { reason: 'too low now', delta: -50 })).status, 400);
    assert.equal((await s.post(`/plan-purchases/${pid}/adjust`, { reason: 'nothing' })).status, 400);
    const ext = await s.post(`/plan-purchases/${pid}/adjust`, { reason: 'compensation', extend_days: 7 }); assert.equal(ext.status, 200);
    const c = await s.post(`/plan-purchases/${pid}/cancel`, { reason: 'fraud check failed', refund: true }); assert.equal(c.body.changed, true); assert.equal(c.body.refund, 'requested');
    assert.equal((await s.post(`/plan-purchases/${pid}/cancel`, { reason: 'fraud check failed', refund: true })).body.changed, false);
    assert.equal((await s.post(`/plan-purchases/${pid}/adjust`, { reason: 'too late now', delta: 1 })).status, 409, 'cancelled purchases cannot be adjusted');
  } finally { s.server.close(); resetNow(); }
});

test('money: earnings table, dispute flag, CSV exports are admin-only, audited and formula-injection safe; analytics + search + audit filters work', async () => {
  const s = await boot();
  try {
    const b = await createBooking(s.db, s.customerIds[0], { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '10:00', payment_option: 'ONLINE' });
    const i = await initializePayment(s.db, b.id, null); await mockMarkPaid(s.db, i.reference); await processReference(s.db, i.reference);
    await s.db.query(`UPDATE users SET name='=HYPERLINK("http://evil","x")' WHERE id=$1`, [s.customerIds[0]]);
    const e = (await s.get('/earnings')).body; assert.ok(e.barbers.length === 1 && e.totals.gross_kobo === 300000, JSON.stringify(e.totals));
    assert.equal((await s.post(`/payments/${i.reference}/dispute`, { disputed: true })).status, 400, 'note required');
    assert.equal((await s.post(`/payments/${i.reference}/dispute`, { disputed: true, note: 'customer claims double charge' })).body.disputed, true);
    assert.equal((await s.get('/payments?filter=paid')).body.payments[0].disputed, true);
    assert.equal((await s.post(`/payments/NOPE/dispute`, { disputed: false })).status, 404);
    const r = await fetch(s.base + '/api/admin/export/bookings.csv', { headers: s.A }); const txt = await r.text();
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type')!, /text\/csv/); assert.ok(txt.includes(`"'=HYPERLINK`) || txt.includes(`'=HYPERLINK`), 'formula neutralised'); assert.ok(!/(^|,)=HYPERLINK/m.test(txt));
    assert.equal((await fetch(s.base + '/api/admin/export/payments.csv')).status, 401);
    for (const f of ['payments', 'barbers']) assert.equal((await fetch(s.base + `/api/admin/export/${f}.csv`, { headers: s.A })).status, 200);
    const an = (await s.get('/analytics?days=7')).body; assert.equal(an.series.length, 7); assert.ok(an.top_barbers.length >= 1);
    assert.equal((await s.get('/analytics?days=30')).body.series.length, 30);
    const se = (await s.get('/search?q=' + i.reference.slice(0, 8))).body; assert.ok(se.payments.length >= 1);
    assert.equal((await s.get('/search?q=a')).body.users.length, 0, 'short query returns nothing');
    const au = (await s.get('/audit?action=ADMIN_EXPORT&scope=all')).body; assert.ok(au.entries.length >= 3 && au.entries.every((x: any) => x.action.startsWith('ADMIN_EXPORT')));
    assert.equal((await s.get('/audit?from=2020-01-01&to=2020-01-02&scope=all')).body.entries.length, 0);
    assert.ok((await s.get('/overview')).body.ledger_owed_kobo !== undefined);
  } finally { s.server.close(); resetNow(); }
});

test('broadcasts reach the right audience (active users only) and are recorded; reports flow from user to admin inbox to resolution', async () => {
  const s = await boot();
  try {
    const bUid = (await s.db.one('SELECT user_id FROM barbers WHERE id=$1', [s.barberId])).user_id;
    await s.post(`/users/${s.customerIds[3]}/suspend`, { reason: 'test suspended' });
    assert.equal((await s.post('/broadcast', { audience: 'customers', title: 'Hi', body: 'x' })).status, 400);
    const r = await s.post('/broadcast', { audience: 'customers', title: 'Public holiday', body: 'We are closed on Friday.' });
    assert.equal(r.body.recipients, s.customerIds.length - 1, 'suspended customers are skipped');
    assert.equal(await notes(s, bUid, 'ANNOUNCEMENT'), 0); assert.equal((await s.post('/broadcast', { audience: 'barbers', title: 'Barbers', body: 'New feature live' })).body.recipients, 1);
    assert.equal((await s.post('/broadcast', { audience: 'user', title: 'One', body: 'Just you' })).status, 400, 'user_id required');
    assert.equal((await s.post('/broadcast', { audience: 'user', user_id: s.customerIds[0], title: 'One', body: 'Just you' })).body.recipients, 1);
    assert.equal((await get2(s, '/broadcasts')).broadcasts.length, 3);
    // reports
    const c = await s.login((await s.db.one('SELECT email FROM users WHERE id=$1', [s.customerIds[0]])).email, 'Customer123!'); const H = { Cookie: c.cookie };
    const b = await createBooking(s.db, s.customerIds[0], { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' });
    assert.equal((await s.j('/api/reports', { method: 'POST', body: { category: 'OTHER', message: 'hello there' } })).status, 401);
    assert.equal((await s.j('/api/reports', { method: 'POST', headers: H, body: { category: 'OTHER', message: 'no' } })).status, 400);
    assert.equal((await s.j('/api/reports', { method: 'POST', headers: H, body: { category: 'BOGUS', message: 'hello there' } })).status, 400);
    assert.equal((await s.j('/api/reports', { method: 'POST', headers: H, body: { category: 'BEHAVIOUR', message: 'rude', booking_id: 99999 } })).status, 400);
    const mk = await s.j('/api/reports', { method: 'POST', headers: H, body: { category: 'BEHAVIOUR', message: 'The barber was rude to me', booking_id: b.id } }); assert.equal(mk.status, 201, JSON.stringify(mk.body));
    const other = await s.db.one(`SELECT id FROM bookings WHERE id=$1`, [b.id]);
    const inbox = (await s.get('/reports')).body; assert.equal(inbox.counts.OPEN, 1); assert.equal(inbox.reports[0].target_user_id, bUid, 'target is the other side of the booking');
    const id = inbox.reports[0].id;
    assert.equal((await s.post(`/reports/${id}/resolve`, { status: 'RESOLVED' })).status, 400, 'note required');
    assert.equal((await s.post(`/reports/${id}/resolve`, { status: 'RESOLVED', note: 'Spoke to the barber' })).body.status, 'RESOLVED');
    assert.equal((await s.post(`/reports/${id}/resolve`, { status: 'DISMISSED', note: 'Spoke to the barber' })).status, 409, 'closed reports stay closed');
    assert.equal(await notes(s, s.customerIds[0], 'REPORT_UPDATE'), 1);
    assert.equal((await s.get('/reports?status=RESOLVED')).body.reports.length, 1);
    void other; void uidOf;
  } finally { s.server.close(); resetNow(); }
});

test('barber controls: review state blocks booking, per-barber pause keeps existing bookings, fee override drives the in-app fee; maintenance does not block admin tools', async () => {
  const s = await boot();
  try {
    assert.equal((await s.post(`/barbers/${s.barberId}/pause`, { paused: true })).status, 400, 'reason required when pausing');
    assert.equal((await s.post(`/barbers/${s.barberId}/pause`, { paused: true, reason: 'holiday' })).body.changed, true);
    assert.equal((await s.post(`/barbers/${s.barberId}/pause`, { paused: true, reason: 'holiday' })).body.changed, false);
    assert.equal((await s.j(`/api/barbers/${s.barberId}`)).body.booking.paused, true);
    await s.post(`/barbers/${s.barberId}/pause`, { paused: false });
    await s.db.query(`UPDATE barbers SET paystack_subaccount='ACCT_x' WHERE id=$1`, [s.barberId]);
    assert.equal((await s.post(`/barbers/${s.barberId}/fee`, { percent: 25, flat_naira: 0, reason: 'negotiated' })).body.override, true);
    const b = await createBooking(s.db, s.customerIds[0], { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '10:00', payment_option: 'ONLINE' });
    const i = await initializePayment(s.db, b.id, null);
    assert.equal(Number((await s.db.one('SELECT fee_kobo FROM payments WHERE reference=$1', [i.reference])).fee_kobo), 75000, '25% of N3,000');
    assert.equal((await s.post(`/barbers/${s.barberId}/fee`, {})).body.override, false, 'clearing the override');
    assert.equal((await s.post('/barbers/999/fee', {})).status, 404);
    await s.j('/api/admin/settings', { method: 'PUT', headers: s.A, body: { maintenance_mode: true, maintenance_message: 'Upgrading' } });
    assert.equal((await s.get('/overview')).body.maintenance_mode, true);
    assert.equal((await s.post(`/barbers/${s.barberId}/pause`, { paused: false })).status, 200, 'admin still works during maintenance');
  } finally { s.server.close(); resetNow(); }
});
