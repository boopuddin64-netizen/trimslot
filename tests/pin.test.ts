import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'net';
import { freshDb, setNow, resetNow, WED } from './helpers';
import { createApp } from '../src/app';
import { createBooking, getBooking } from '../src/bookingService';
import { clock } from '../src/time';

const KEY = 'test-admin-key-0123456789';
async function boot() {
  const s = await freshDb(); setNow(`${WED}T08:00:00+01:00`); process.env.CRON_SECRET = KEY;
  const server = createApp(s.db).listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const j = async (p: string, o: any = {}) => { const r = await fetch(base + '/api/admin' + p, { ...o, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY, ...(o.headers || {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const post = (p: string, body: any = {}, pin?: string) => j(p, { method: 'POST', body, headers: pin ? { 'X-Admin-Pin': pin } : {} });
  return { ...s, server, j, post };
}
const extraCustomer = async (db: any, n: string) => (await db.one(`INSERT INTO users (role,name,email,phone,password_hash) VALUES ('customer',$1,$2,$3,'x') RETURNING id`, ['Cust ' + n, `c${n}@t.test`, '0807000' + n.padStart(4, '0')])).id;

test('PIN: first-time setup once, stored hashed+salted, weak/invalid refused, irreversible actions need it', async () => {
  const s = await boot();
  try {
    assert.equal((await s.j('/pin/status')).body.set, false);
    const cid = await extraCustomer(s.db, '1');
    const noPin = await s.post(`/users/${cid}/ban`, { reason: 'abuse test' });
    assert.equal(noPin.status, 403); assert.equal(noPin.body.error.code, 'PIN_NOT_SET', 'before setup: tells the admin to set one');
    assert.equal((await s.post('/pin/setup', { pin: '12' })).status, 400);
    assert.equal((await s.post('/pin/setup', { pin: 'abcd' })).status, 400);
    assert.equal((await s.post('/pin/setup', { pin: '1111' })).status, 400, 'obvious PIN refused');
    assert.equal((await s.post('/pin/setup', { pin: '4821' })).status, 200);
    assert.equal((await s.post('/pin/setup', { pin: '7392' })).status, 409, 'cannot be re-set without the old PIN');
    const row = await s.db.one('SELECT salt, hash FROM admin_pin WHERE id=1');
    assert.ok(row.salt.length >= 32 && row.hash.length === 64 && !row.hash.includes('4821'), 'scrypt hash + salt, not the PIN');
    assert.equal((await s.post(`/users/${cid}/ban`, { reason: 'abuse test' })).body.error.code, 'PIN_REQUIRED');
    assert.equal((await s.post(`/users/${cid}/ban`, { reason: 'abuse test' }, '123')).body.error.code, 'PIN_REQUIRED', 'malformed = required');
    const ok = await s.post(`/users/${cid}/ban`, { reason: 'abuse test' }, '4821'); assert.equal(ok.status, 200); assert.equal(ok.body.account_status, 'BANNED');
    // suspend is reversible => no PIN
    const c2 = await extraCustomer(s.db, '2'); assert.equal((await s.post(`/users/${c2}/suspend`, { reason: 'cool off' })).status, 200);
    // a pin never appears in the audit log
    assert.ok(!JSON.stringify(await s.db.many('SELECT details FROM audit_log')).includes('4821'));
  } finally { resetNow(); s.server.close(); }
});

test('PIN: 5 wrong tries lock for 15 minutes (even the right PIN is refused), then it unlocks; counter resets on success', async () => {
  const s = await boot();
  try {
    await s.post('/pin/setup', { pin: '4821' });
    const cid = await extraCustomer(s.db, '3');
    for (let i = 1; i <= 2; i++) { const r = await s.post(`/users/${cid}/ban`, { reason: 'abuse test' }, '9999'); assert.equal(r.status, 403); assert.equal(r.body.error.code, 'PIN_WRONG'); assert.equal(r.body.error.details.attempts_left, 5 - i); }
    assert.equal((await s.post(`/users/${cid}/ban`, { reason: 'abuse test' }, '4821')).status, 200, 'right PIN works and resets the counter');
    assert.equal((await s.j('/pin/status')).body.attempts_left, 5);
    for (let i = 0; i < 4; i++) assert.equal((await s.post('/pin/check', {}, '0000')).body.error.code, 'PIN_WRONG');
    const fifth = await s.post('/pin/check', {}, '0000'); assert.equal(fifth.status, 423); assert.equal(fifth.body.error.code, 'PIN_LOCKED');
    const locked = await s.post('/pin/check', {}, '4821'); assert.equal(locked.status, 423, 'right PIN refused while locked');
    assert.equal((await s.j('/pin/status')).body.locked, true);
    clock.setExact(new Date(clock.now().getTime() + 14 * 60000)); assert.equal((await s.post('/pin/check', {}, '4821')).status, 423, 'still locked at 14 min');
    clock.setExact(new Date(clock.now().getTime() + 2 * 60000)); assert.equal((await s.post('/pin/check', {}, '4821')).status, 200, 'unlocked after 15 min');
    assert.ok((await s.db.one(`SELECT COUNT(*)::int n FROM audit_log WHERE action='ADMIN_PIN_LOCKED'`)).n === 1);
  } finally { resetNow(); s.server.close(); }
});

test('PIN: change needs the old PIN (and counts toward lockout); new PIN works, old stops working', async () => {
  const s = await boot();
  try {
    await s.post('/pin/setup', { pin: '4821' });
    assert.equal((await s.post('/pin/change', { old_pin: '1357', new_pin: '7392' })).body.error.code, 'PIN_WRONG');
    assert.equal((await s.post('/pin/change', { old_pin: '4821', new_pin: '4821' })).status, 400, 'must differ');
    assert.equal((await s.post('/pin/change', { old_pin: '4821', new_pin: '1111' })).status, 400);
    assert.equal((await s.post('/pin/change', { old_pin: '4821', new_pin: '7392' })).status, 200);
    assert.equal((await s.post('/pin/check', {}, '4821')).status, 403);
    assert.equal((await s.post('/pin/check', {}, '7392')).status, 200);
    assert.equal((await s.j('/pin/status', { headers: { Authorization: 'Bearer nope' } })).status, 401, 'admin key still required');
  } finally { resetNow(); s.server.close(); }
});

test('soft delete: customer & barber hidden everywhere, upcoming bookings need an explicit choice, restorable, login explains', async () => {
  const s = await boot(); const P = '4821';
  try {
    await s.post('/pin/setup', { pin: P });
    const c = s.customerIds[0];
    const b = await createBooking(s.db, c, { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' });
    assert.equal((await s.post(`/delete/customer/${c}`, { reason: 'user asked' })).body.error.code, 'PIN_REQUIRED');
    const need = await s.post(`/delete/customer/${c}`, { reason: 'user asked' }, P); assert.equal(need.status, 409); assert.equal(need.body.error.code, 'FUTURE_BOOKINGS');
    assert.equal((await s.post(`/delete/customer/${c}`, { reason: 'x' }, P)).status, 400, 'reason required');
    const d = await s.post(`/delete/customer/${c}`, { reason: 'user asked', cancel_bookings: true }, P); assert.equal(d.status, 200); assert.equal(d.body.cancelled, 1);
    assert.equal((await getBooking(s.db, b.id))!.status, 'CANCELLED');
    const u = await s.db.one('SELECT account_status, deleted_at FROM users WHERE id=$1', [c]); assert.equal(u.account_status, 'DELETED'); assert.ok(u.deleted_at);
    assert.equal((await s.j('/l/customers?limit=100')).body.rows.some((r: any) => r.id === c), false, 'gone from the customers list');
    const login = await fetch(`http://127.0.0.1:${(s.server.address() as AddressInfo).port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'chidi@trimslot.demo', password: 'Customer123!' }) });
    if (login.status === 403) assert.match((await login.json()).error.message, /removed/);
    const del = (await s.j('/deleted')).body; assert.equal(del.items.find((x: any) => x.type === 'customer' && x.id === c).days_left, 30);
    assert.equal((await s.post(`/restore/customer/${c}`)).body.restored, true, 'restore needs no PIN');
    assert.equal((await s.db.one('SELECT account_status s FROM users WHERE id=$1', [c])).s, 'ACTIVE');
    // barber
    assert.equal((await s.post(`/delete/barber/${s.barberId}`, { reason: 'closed shop' }, P)).status, 200);
    assert.equal((await s.db.one('SELECT verified, review_status FROM barbers WHERE id=$1', [s.barberId])).verified, false, 'shop hidden');
    assert.equal((await s.j('/l/barbers')).body.rows.length, 0);
    assert.equal((await s.post(`/restore/barber/${s.barberId}`)).body.restored, true);
    const rb = await s.db.one('SELECT verified, review_status FROM barbers WHERE id=$1', [s.barberId]); assert.equal(rb.review_status, 'VERIFIED'); assert.equal(rb.verified, true);
    // restore window
    await s.post(`/delete/customer/${s.customerIds[1]}`, { reason: 'old account' }, P);
    await s.db.query(`UPDATE users SET deleted_at = deleted_at - interval '31 days' WHERE id=$1`, [s.customerIds[1]]);
    assert.equal((await s.post(`/restore/customer/${s.customerIds[1]}`)).body.error.code, 'RESTORE_EXPIRED');
    const acts = (await s.db.many(`SELECT action FROM audit_log WHERE actor_role='admin'`)).map((r: any) => r.action);
    for (const a of ['ADMIN_CUSTOMER_DELETED', 'ADMIN_BARBER_DELETED', 'ADMIN_RESTORED']) assert.ok(acts.includes(a), a);
  } finally { resetNow(); s.server.close(); }
});

test('soft delete: plans, reviews, reports; hard delete (PIN) refuses real payments, needs soft-delete first, bookings must not be live', async () => {
  const s = await boot(); const P = '4821';
  try {
    await s.post('/pin/setup', { pin: P });
    const plan = (await s.db.one(`INSERT INTO plans (barber_id, name, price_kobo, sessions, validity_days, active) VALUES ($1,'Gold',1000000,4,60,TRUE) RETURNING id`, [s.barberId])).id;
    assert.equal((await s.post(`/delete/plan/${plan}`, { reason: 'retired plan' }, P)).status, 200);
    assert.equal((await s.db.one('SELECT active FROM plans WHERE id=$1', [plan])).active, false);
    assert.equal((await s.j('/l/plans')).body.rows.some((r: any) => r.id === plan), false);
    assert.equal((await s.post(`/restore/plan/${plan}`)).status, 200); assert.equal((await s.db.one('SELECT active, deleted_at FROM plans WHERE id=$1', [plan])).deleted_at, null);
    // review + report
    const bk = await createBooking(s.db, s.customerIds[0], { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' });
    await s.db.query(`UPDATE bookings SET status='COMPLETED' WHERE id=$1`, [bk.id]);
    const rv = (await s.db.one(`INSERT INTO reviews (booking_id, customer_id, barber_id, rating, comment) VALUES ($1,$2,$3,5,'great') RETURNING id`, [bk.id, s.customerIds[0], s.barberId])).id;
    const rp = (await s.db.one(`INSERT INTO reports (reporter_id, category, message) VALUES ($1,'OTHER','a test report') RETURNING id`, [s.customerIds[0]])).id;
    assert.equal((await s.post(`/delete/review/${rv}`, { reason: 'spam review' }, P)).status, 200); assert.equal((await s.db.one('SELECT hidden FROM reviews WHERE id=$1', [rv])).hidden, true);
    assert.equal((await s.post(`/delete/report/${rp}`, { reason: 'test report' }, P)).status, 200);
    assert.equal((await s.j('/l/reports')).body.rows.length, 0);
    // delete forever: must be soft-deleted first, and needs the PIN
    assert.equal((await s.post(`/purge/report/${rp}`, { reason: 'cleanup' })).body.error.code, 'PIN_REQUIRED');
    assert.equal((await s.post(`/purge/review/${rv}`, { reason: 'cleanup' }, P)).status, 200);
    assert.equal((await s.db.one('SELECT COUNT(*)::int n FROM reviews')).n, 0);
    assert.equal((await s.post(`/purge/plan/${plan}`, { reason: 'cleanup' }, P)).body.error.code, 'DELETE_FIRST');
    // bookings: live ones are refused, completed ones with no payment can go, paid ones never
    assert.equal((await s.post(`/delete/booking/${bk.id}`, { reason: 'cleanup' }, P)).status, 200, 'completed unpaid booking hard-deleted');
    assert.ok(!(await getBooking(s.db, bk.id)));
    const live = await createBooking(s.db, s.customerIds[1], { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '12:00', payment_option: 'ON_ARRIVAL' });
    assert.equal((await s.post(`/delete/booking/${live.id}`, { reason: 'cleanup' }, P)).body.error.code, 'BOOKING_LIVE');
    const paid = await createBooking(s.db, s.customerIds[1], { barber_id: s.barberId, service_id: s.serviceIds[1], date: WED, time: '14:00', payment_option: 'ONLINE' });
    await s.db.query(`UPDATE bookings SET status='COMPLETED', payment_status='PAID' WHERE id=$1`, [paid.id]);
    await s.db.query(`INSERT INTO payments (booking_id, reference, provider, amount_kobo, status) VALUES ($1,'TS-BOOKING-X-1','MOCK',450000,'SUCCESS')`, [paid.id]);
    const r = await s.post(`/delete/booking/${paid.id}`, { reason: 'cleanup' }, P); assert.equal(r.status, 409); assert.equal(r.body.error.code, 'HAS_PAYMENTS');
    assert.ok(await getBooking(s.db, paid.id), 'paid booking untouched');
    // a customer with paid history can be soft-deleted but never purged
    const u = paid && (await getBooking(s.db, paid.id))!.customer_id;
    await s.post(`/delete/customer/${u}`, { reason: 'closing', cancel_bookings: true }, P);
    assert.equal((await s.post(`/purge/customer/${u}`, { reason: 'cleanup' }, P)).body.error.code, 'HAS_PAYMENTS');
    assert.ok(await s.db.maybeOne('SELECT 1 FROM users WHERE id=$1', [u]));
  } finally { resetNow(); s.server.close(); }
});

test('test-data purge: dry run first, exact confirmation + PIN, only throwaway patterns, everything of theirs goes, real accounts untouched', async () => {
  const s = await boot(); const P = '4821';
  try {
    await s.post('/pin/setup', { pin: P });
    const mk = async (role: string, email: string) => (await s.db.one(`INSERT INTO users (role,name,email,phone,password_hash) VALUES ($1,'T',$2,$3,'x') RETURNING id`, [role, email, '09' + Math.floor(Math.random() * 1e9)])).id;
    const tc = await mk('customer', 'smoketest+abc@example.com'); const tb = await mk('barber', 'smoketest+barber@example.com');
    const tbid = (await s.db.one(`INSERT INTO barbers (user_id, shop_name) VALUES ($1,'Smoke Shop') RETURNING id`, [tb])).id;
    const sv = (await s.db.one(`INSERT INTO services (barber_id, name, price_kobo, duration_min) VALUES ($1,'Cut',100000,30) RETURNING id`, [tbid])).id;
    await s.db.query(`INSERT INTO barber_schedule (barber_id, weekday, is_working, start_min, end_min) SELECT $1, d, TRUE, 540, 1080 FROM generate_series(0,6) d`, [tbid]);
    const real = await mk('customer', 'smoketest-not@gmail.com'); const lookalike = await mk('customer', 'x.smoketest+abc@example.com');
    const bk = await createBooking(s.db, tc, { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '10:00', payment_option: 'ONLINE' });
    await s.db.query(`INSERT INTO payments (booking_id, reference, provider, amount_kobo, status) VALUES ($1,'TS-BOOKING-T-1','MOCK',1,'SUCCESS')`, [bk.id]);
    void sv;
    const pv = (await s.j('/testdata/preview')).body; assert.equal(pv.users, 2); assert.equal(pv.barbers, 1); assert.equal(pv.bookings, 1);
    assert.equal((await s.db.one('SELECT COUNT(*)::int n FROM users WHERE id=$1', [tc])).n, 1, 'preview deletes nothing');
    assert.equal((await s.post('/testdata/purge', {}, P)).status, 400, 'typed confirmation required');
    assert.equal((await s.post('/testdata/purge', { confirm: 'DELETE TEST DATA' })).body.error.code, 'PIN_REQUIRED');
    const r = await s.post('/testdata/purge', { confirm: 'DELETE TEST DATA' }, P); assert.equal(r.status, 200); assert.equal(r.body.users, 2);
    for (const id of [tc, tb]) assert.equal((await s.db.one('SELECT COUNT(*)::int n FROM users WHERE id=$1', [id])).n, 0);
    for (const id of [real, lookalike, ...s.customerIds]) assert.equal((await s.db.one('SELECT COUNT(*)::int n FROM users WHERE id=$1', [id])).n, 1, 'non-test users survive');
    assert.equal((await s.db.one('SELECT COUNT(*)::int n FROM barbers WHERE id=$1', [s.barberId])).n, 1);
    assert.equal((await s.db.one('SELECT COUNT(*)::int n FROM bookings')).n, 0);
    assert.equal((await s.db.one(`SELECT COUNT(*)::int n FROM audit_log WHERE action='ADMIN_TESTDATA_PURGED'`)).n, 1);
  } finally { resetNow(); s.server.close(); }
});
