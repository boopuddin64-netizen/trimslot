import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'net';
import { setupPin } from '../src/adminPin';
import { freshDb, setNow, resetNow, WED } from './helpers';
import { createApp } from '../src/app';
import { createBooking, customerCancel } from '../src/bookingService';
import { initializePayment, mockMarkPaid, processReference } from '../src/paystack';
import { runRetention, runRetentionIfDue } from '../src/retention';
import { runSweep } from '../src/sweep';

const KEY = 'test-admin-key-0123456789';
async function boot() {
  const s = await freshDb(); setNow(`${WED}T08:00:00+01:00`); process.env.CRON_SECRET = KEY; await setupPin(s.db, '4821');
  const server = createApp(s.db).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const j = async (p: string, o: any = {}) => {
    const r = await fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) }, body: o.body === undefined ? undefined : (Buffer.isBuffer(o.body) ? o.body : JSON.stringify(o.body)) });
    const text = await r.text(); let body: any = null; try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, body, text, headers: r.headers };
  };
  const A = { Authorization: 'Bearer ' + KEY, 'X-Admin-Pin': '4821' };
  const signup = async (body: any) => { const r = await j('/api/auth/signup', { method: 'POST', body }); return { ...r, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }; };
  return { ...s, server, j, A, base, signup } as any;
}
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF'), Buffer.alloc(200, 7)]);

test('sign-up needs the acceptance tick-boxes (customers: terms+privacy; barbers: + barber agreement) and logs them with version, time and ip/user-agent', async () => {
  const s = await boot();
  try {
    const c = { role: 'customer', name: 'New Cust', email: 'nc@x.com', password: 'Password123' };
    assert.equal((await s.signup(c)).status, 400, 'no tick');
    assert.equal((await s.signup({ ...c, accept_terms: false })).status, 400);
    const ok = await s.signup({ ...c, accept_terms: true }); assert.equal(ok.status, 201);
    const rows = await s.db.many('SELECT document, version, ip, user_agent, source FROM consent_log WHERE user_id=$1 ORDER BY document', [ok.body.user.id]);
    assert.deepEqual(rows.map((r: any) => r.document), ['privacy', 'terms']); assert.ok(rows.every((r: any) => r.version === '1' && r.source === 'signup'));
    assert.equal(ok.body.user.consent_required.length, 0);
    const b = { role: 'barber', name: 'New B', email: 'nb@x.com', password: 'Password123', shop_name: 'NB Cuts', location: 'Yaba', accept_terms: true };
    assert.equal((await s.signup(b)).status, 400, 'barber must also accept the agreement');
    const okb = await s.signup({ ...b, accept_barber_agreement: true }); assert.equal(okb.status, 201);
    assert.equal((await s.db.many('SELECT 1 FROM consent_log WHERE user_id=$1', [okb.body.user.id])).length, 3);
  } finally { s.server.close(); resetNow(); }
});

test('bumping a document version asks everyone to re-accept; accepting logs the new version; admin sees the history in the user record', async () => {
  const s = await boot();
  try {
    const u = await s.signup({ role: 'customer', name: 'Re Accept', email: 'ra@x.com', password: 'Password123', accept_terms: true });
    const H = { Cookie: u.cookie };
    assert.equal((await s.j('/api/auth/me', { headers: H })).body.user.consent_required.length, 0);
    assert.equal((await s.j('/api/admin/settings', { method: 'PUT', headers: s.A, body: { terms_version: '2' } })).status, 200);
    const me = (await s.j('/api/auth/me', { headers: H })).body.user;
    assert.deepEqual(me.consent_required.map((c: any) => c.document), ['terms']);
    assert.equal((await s.j('/api/me/consent', { method: 'POST', headers: H, body: { accept: false } })).status, 400);
    assert.equal((await s.j('/api/me/consent', { method: 'POST', headers: H, body: { accept: true } })).status, 200);
    assert.equal((await s.j('/api/auth/me', { headers: H })).body.user.consent_required.length, 0);
    const det = (await s.j('/api/admin/users/' + u.body.user.id, { headers: s.A })).body;
    assert.ok(det.consents.some((c: any) => c.document === 'terms' && c.version === '2' && c.source === 'reaccept'));
    assert.ok(det.consents.some((c: any) => c.document === 'terms' && c.version === '1'));
  } finally { s.server.close(); resetNow(); }
});

test('data export is a JSON download of my own data only, with no password hash', async () => {
  const s = await boot();
  try {
    const login = await s.j('/api/auth/login', { method: 'POST', body: { identifier: 'chidi@trimslot.demo', password: 'Customer123!' } });
    const H = { Cookie: (login.headers.get('set-cookie') || '').split(';')[0] };
    const r = await s.j('/api/me/export', { headers: H });
    assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition')!, /attachment; filename="trimslot-my-data-/);
    assert.equal(r.body.account.email, 'chidi@trimslot.demo'); assert.ok(Array.isArray(r.body.bookings));
    assert.ok(!/password|\$2[aby]\$/i.test(JSON.stringify(r.body).replace(/Passwords and security keys/, '')));
    assert.equal((await s.j('/api/me/export')).status, 401);
  } finally { s.server.close(); resetNow(); }
});

test('customer deletion: password + DELETE needed; upcoming bookings block; unused credits need an OK; financial records are kept, personal data is anonymised', async () => {
  const s = await boot();
  try {
    const u = await s.signup({ role: 'customer', name: 'Del Me', email: 'del@x.com', phone: '08031112222', password: 'Password123', accept_terms: true });
    const H = { Cookie: u.cookie }; const id = u.body.user.id;
    const b = await createBooking(s.db, id, { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '12:00', payment_option: 'ONLINE' });
    const i = await initializePayment(s.db, b.id, null); await mockMarkPaid(s.db, i.reference); await processReference(s.db, i.reference);
    const del = (body: any) => s.j('/api/me/delete', { method: 'POST', headers: H, body });
    assert.equal((await del({ password: 'Password123' })).status, 400, 'must type DELETE');
    assert.equal((await del({ password: 'Wrong-pass1', confirm: 'DELETE' })).status, 403);
    const blocked = await del({ password: 'Password123', confirm: 'DELETE' });
    assert.equal(blocked.status, 409); assert.equal(blocked.body.error?.code ?? blocked.body.code, 'CANNOT_DELETE_YET');
    await customerCancel(s.db, id, b.id);                       // pending refund, no longer upcoming
    await s.db.query(`INSERT INTO session_credits (customer_id, barber_id, reason, value_kobo, expires_at, created_at) VALUES ($1,$2,'NO_SHOW',100000,$3,$4)`, [id, s.barberId, '2026-12-01T00:00:00Z', '2026-09-01T00:00:00Z']);
    const forfeit = await del({ password: 'Password123', confirm: 'DELETE' });
    assert.equal(forfeit.status, 409); assert.equal(forfeit.body.error?.code ?? forfeit.body.code, 'FORFEIT_NEEDS_OK');
    const done = await del({ password: 'Password123', confirm: 'DELETE', acknowledge_forfeit: true });
    assert.equal(done.status, 200); assert.equal(done.body.deleted, true);
    const row = await s.db.one('SELECT name, email, phone, account_status, anonymised_at, avatar_url FROM users WHERE id=$1', [id]);
    assert.ok(row.anonymised_at); assert.notEqual(row.name, 'Del Me'); assert.ok(!/del@x\.com/.test(row.email)); assert.equal(row.phone, null);
    assert.equal((await s.db.one('SELECT COUNT(*)::int c FROM payments WHERE reference=$1', [i.reference])).c, 1, 'payment record kept');
    assert.equal((await s.db.one('SELECT COUNT(*)::int c FROM bookings WHERE id=$1', [b.id])).c, 1, 'booking record kept');
    assert.equal((await s.j('/api/auth/login', { method: 'POST', body: { identifier: 'del@x.com', password: 'Password123' } })).status >= 400, true, 'cannot sign in again');
    assert.equal((await s.j('/api/auth/me', { headers: H })).body?.user ?? null, null);
  } finally { s.server.close(); resetNow(); }
});

test('barber deletion: immediate when nothing is pending; otherwise a request the admin is alerted about (and can withdraw)', async () => {
  const s = await boot();
  try {
    const login = await s.j('/api/auth/login', { method: 'POST', body: { identifier: 'mike@trimslot.demo', password: 'Barber123!' } });
    const H = { Cookie: (login.headers.get('set-cookie') || '').split(';')[0] };
    await createBooking(s.db, s.customerIds[0], { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '12:00', payment_option: 'ON_ARRIVAL' });
    const r = await s.j('/api/me/delete', { method: 'POST', headers: H, body: { password: 'Barber123!', confirm: 'DELETE' } });
    assert.equal(r.status, 202); assert.equal(r.body.requested, true);
    assert.ok((await s.db.one('SELECT deletion_requested_at FROM users WHERE email=$1', ['mike@trimslot.demo'])).deletion_requested_at);
    assert.equal((await s.db.one(`SELECT COUNT(*)::int c FROM admin_notifications WHERE event='DELETION_REQUEST'`)).c, 1);
    assert.equal((await s.j('/api/me/delete/cancel', { method: 'POST', headers: H, body: {} })).status, 200);
    assert.equal((await s.db.one('SELECT deletion_requested_at FROM users WHERE email=$1', ['mike@trimslot.demo'])).deletion_requested_at, null);
  } finally { s.server.close(); resetNow(); }
});

test('retention: expired rows are purged on the admin-set periods, soft-deleted accounts past the window are anonymised when money exists, and the run is throttled to once an hour', async () => {
  const s = await boot();
  try {
    const old = new Date(Date.now() - 500 * 86400000).toISOString();
    await s.db.query(`INSERT INTO notifications (user_id, type, title, body, created_at) VALUES ($1,'X','old','old',$2),($1,'X','new','new',$3)`, [s.customerIds[0], old, new Date().toISOString()]);
    await s.db.query(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES ($1,'https://e/stale','p','a',$2)`, [s.customerIds[0], old]);
    // a soft-deleted customer with a payment trail
    const d = await s.db.one(`INSERT INTO users (role,name,email,phone,password_hash,deleted_at,account_status) VALUES ('customer','Old Gone','gone@x.com','0800','x',NULL,'ACTIVE') RETURNING id`);
    const b = await createBooking(s.db, d.id, { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '12:00', payment_option: 'ONLINE' });
    const i = await initializePayment(s.db, b.id, null); await mockMarkPaid(s.db, i.reference); await processReference(s.db, i.reference);
    await s.db.query(`UPDATE users SET deleted_at=$2, account_status='DELETED' WHERE id=$1`, [d.id, old]);
    // and one with no money trail
    const e = await s.db.one(`INSERT INTO users (role,name,email,phone,password_hash,deleted_at,account_status) VALUES ('customer','Empty Gone','empty@x.com','0801','x',$1,'DELETED') RETURNING id`, [old]);
    const r = await runRetention(s.db);
    assert.ok(r.notifications >= 1); assert.equal(r.stale_push, 1);
    assert.equal(r.deleted_users_anonymised, 1); assert.equal(r.deleted_users_erased, 1);
    assert.equal((await s.db.one('SELECT COUNT(*)::int c FROM users WHERE id=$1', [e.id])).c, 0, 'no money trail -> erased');
    assert.ok((await s.db.one('SELECT anonymised_at FROM users WHERE id=$1', [d.id])).anonymised_at, 'money trail -> anonymised, kept');
    assert.equal((await s.db.one('SELECT COUNT(*)::int c FROM payments WHERE reference=$1', [i.reference])).c, 1);
    assert.equal((await s.db.one(`SELECT COUNT(*)::int c FROM notifications WHERE title='new'`)).c, 1, 'recent rows stay');
    // admin sets a shorter window + the hourly throttle
    assert.equal((await s.j('/api/admin/settings', { method: 'PUT', headers: s.A, body: { retention_notifications_days: 1000 } })).status, 200);
    assert.equal((await s.j('/api/admin/settings', { method: 'PUT', headers: s.A, body: { retention_notifications_days: 2 } })).status, 400, 'below the allowed minimum');
    assert.ok(await runRetentionIfDue(s.db)); assert.equal(await runRetentionIfDue(s.db), null, 'throttled');
    assert.equal((await s.j('/api/admin/retention/run', { method: 'POST', headers: { Authorization: 'Bearer ' + KEY }, body: {} })).status, 403, 'manual run needs the PIN');
    assert.equal((await s.j('/api/admin/retention/run', { method: 'POST', headers: s.A, body: {} })).status, 200);
    assert.ok((await runSweep(s.db)).retention === null || typeof (await runSweep(s.db)).retention === 'object');
  } finally { s.server.close(); resetNow(); }
});

test('customer avatar: upload (JPEG only by content), shown to me and to a barber who has served me, hidden from others, admin can remove it with a reason', async () => {
  const s = await boot();
  try {
    const cl = await s.j('/api/auth/login', { method: 'POST', body: { identifier: 'chidi@trimslot.demo', password: 'Customer123!' } });
    const C = { Cookie: (cl.headers.get('set-cookie') || '').split(';')[0] };
    const bl = await s.j('/api/auth/login', { method: 'POST', body: { identifier: 'mike@trimslot.demo', password: 'Barber123!' } });
    const B = { Cookie: (bl.headers.get('set-cookie') || '').split(';')[0] };
    const put = (buf: Buffer, type = 'image/jpeg', h: any = C) => fetch(s.base + '/api/me/avatar', { method: 'PUT', headers: { ...h, 'Content-Type': type }, body: buf });
    assert.equal((await put(Buffer.from('not an image at all, just text'), 'image/jpeg')).status, 400);
    assert.equal((await put(jpeg(), 'image/png')).status, 400, 'declared type must match');
    assert.equal((await put(Buffer.alloc(130 * 1024, 1), 'image/jpeg')).status >= 400, true, 'too large');
    assert.equal((await put(jpeg(), 'image/jpeg', B)).status, 403, 'barbers use the shop photo instead');
    const ok = await put(jpeg()); assert.equal(ok.status, 200);
    const url = ((await ok.json()) as any).avatar_url as string; assert.match(url, /^\/api\/avatars\/\d+\?v=/);
    const me = (await s.j('/api/auth/me', { headers: C })).body.user; assert.equal(me.avatar_url, url);
    assert.equal((await fetch(s.base + url, { headers: C })).status, 200);
    assert.equal((await fetch(s.base + url)).status, 401, 'login needed');
    assert.equal((await fetch(s.base + url, { headers: B })).status, 404, 'a barber with no booking/waitlist link cannot see it');
    await createBooking(s.db, me.id, { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '12:00', payment_option: 'ON_ARRIVAL' });
    assert.equal((await fetch(s.base + url, { headers: B })).status, 200, 'a barber with a booking can');
    const cust = (await s.j('/api/barber/customers', { headers: B })).body.customers.find((c: any) => c.id === me.id);
    assert.equal(cust.avatar_url, url);
    assert.equal((await fetch(s.base + '/api/admin/avatars/' + me.id, { headers: s.A })).status, 200);
    assert.equal((await s.j(`/api/admin/users/${me.id}/avatar/remove`, { method: 'POST', headers: s.A, body: {} })).status, 400, 'reason needed');
    assert.equal((await s.j(`/api/admin/users/${me.id}/avatar/remove`, { method: 'POST', headers: s.A, body: { reason: 'Not a face photo' } })).status, 200);
    assert.equal((await s.j('/api/auth/me', { headers: C })).body.user.avatar_url, null);
    assert.equal((await fetch(s.base + url, { headers: C })).status, 404);
    assert.ok((await s.j('/api/admin/audit', { headers: s.A })).body.entries.some((e: any) => /AVATAR/.test(e.action)));
    assert.equal((await s.db.one(`SELECT COUNT(*)::int c FROM notifications WHERE user_id=$1 AND body ILIKE '%Not a face photo%'`, [me.id])).c, 1);
  } finally { s.server.close(); resetNow(); }
});
