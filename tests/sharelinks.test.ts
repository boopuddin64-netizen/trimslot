import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'net';
import { DEMO_SHARE_CODE } from '../src/seed';
import { CODE_RE, canUseBarber, ensureShareCode, myBarbers, newShareCode, regenerateShareCode, removeBarber, rememberBarber } from '../src/shareLinks';
import { freshDb, setNow, resetNow, WED } from './helpers';
import { createApp } from '../src/app';
import { createBooking } from '../src/bookingService';
import { setupPin } from '../src/adminPin';

const KEY = 'test-admin-key-0123456789';
async function boot() {
  setNow(`${WED}T08:00:00+01:00`); process.env.CRON_SECRET = KEY;
  const s = await freshDb(); await setupPin(s.db, '4821');
  const server = createApp(s.db).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, body?: any, cookie?: string) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* svg etc. */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  let n = 0;
  const newCustomer = async () => {
    const email = `fresh${++n}-${Date.now()}@example.com`;
    const r = await call('POST', '/api/auth/signup', { accept_terms: true, role: 'customer', name: 'Fresh Customer', email, password: 'Password123' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return { cookie: r.headers.get('set-cookie')!.split(';')[0], id: r.json.user.id as number };
  };
  const barberCookie = async () => {
    const r = await call('POST', '/api/auth/login', { identifier: 'mike@trimslot.demo', password: 'Barber123!' });
    return r.headers.get('set-cookie')!.split(';')[0];
  };
  return { ...s, server, base, call, newCustomer, barberCookie };
}
type Ctx = Awaited<ReturnType<typeof boot>>;
const done = (c: Ctx) => { c.server.close(); resetNow(); };

test('share codes: random, unguessable, stable until regenerated; regenerating is audited and kills the old code', async () => {
  const c = await boot();
  try {
    const a = newShareCode(), b = newShareCode();
    assert.notEqual(a, b); assert.match(a, CODE_RE); assert.ok(a.length >= 16);
    const code = await ensureShareCode(c.db, c.barberId);
    assert.equal(code, DEMO_SHARE_CODE); assert.equal(await ensureShareCode(c.db, c.barberId), code, 'stable');
    await c.db.query('UPDATE barbers SET share_code=NULL WHERE id=$1', [c.barberId]);
    const made = await ensureShareCode(c.db, c.barberId); assert.match(made, CODE_RE);
    const fresh = await c.db.tx((t) => regenerateShareCode(t, c.barberId, { id: 1, role: 'barber' }));
    assert.notEqual(fresh, made);
    assert.equal((await c.call('GET', '/api/b/' + made)).status, 404, 'the old link stops working');
    assert.equal((await c.call('GET', '/api/b/' + fresh)).status, 200);
    assert.equal((await c.db.one(`SELECT COUNT(*)::int n FROM audit_log WHERE action='SHARE_CODE_ROTATED'`)).n, 1);
    for (const bad of ['abc', 'ZZZZZZZZZZZZZZZZ', '../etc/passwd', 'a'.repeat(40)]) assert.equal((await c.call('GET', '/api/b/' + encodeURIComponent(bad))).status, 404, bad);
  } finally { done(c); }
});

test('customers cannot see or book a barber they have no link to; the link opens the profile; Add puts them in My barbers', async () => {
  const c = await boot();
  try {
    const cu = await c.newCustomer(); const id = c.barberId; const svc = c.serviceIds[0];
    // no list of barbers; every barber-specific route says "not found"
    assert.deepEqual((await c.call('GET', '/api/barbers', undefined, cu.cookie)).json.barbers, []);
    assert.equal((await c.call('GET', '/api/barbers')).status, 401, 'no public list');
    for (const [m, p, body] of [['GET', `/api/barbers/${id}`], ['GET', `/api/barbers/${id}/slots?service_id=${svc}&date=${WED}`], ['GET', `/api/barbers/${id}/reviews`], ['POST', `/api/barbers/${id}/favourite`, { on: true }],
      ['POST', '/api/bookings', { barber_id: id, service_id: svc, date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' }], ['POST', '/api/waitlist', { barber_id: id, service_id: svc, date: WED }], ['GET', `/api/barbers/${id}/photo`]] as any[]) {
      const r = await c.call(m, p, body, cu.cookie); assert.equal(r.status, 404, `${m} ${p} -> ${r.status}`);
    }
    assert.equal((await c.db.one('SELECT COUNT(*)::int n FROM bookings WHERE customer_id=$1', [cu.id])).n, 0);
    // anonymous visitors: only the link
    const anon = await c.call('GET', '/api/b/' + DEMO_SHARE_CODE);
    assert.equal(anon.status, 200); assert.equal(anon.json.share.logged_in, false); assert.equal(anon.json.share.can_add, false);
    assert.ok(anon.json.services.length >= 1 && anon.json.schedule.length === 7 && anon.json.barber.shop_name, 'profile has shop, services and hours');
    assert.match(anon.headers.get('cache-control') || '', /no-store/); assert.match(anon.headers.get('x-robots-tag') || '', /noindex/);
    assert.equal((await c.call('GET', `/api/barbers/${id}`)).status, 404, 'anonymous: not by id');
    // opening the link as a customer grants access (but does not add)
    const opened = await c.call('GET', '/api/b/' + DEMO_SHARE_CODE, undefined, cu.cookie);
    assert.equal(opened.status, 200); assert.equal(opened.json.share.added, false); assert.equal(opened.json.share.can_add, true);
    assert.equal((await c.call('GET', `/api/barbers/${id}`, undefined, cu.cookie)).status, 200, 'opened link => profile by id works');
    assert.deepEqual((await c.call('GET', '/api/me/barbers', undefined, cu.cookie)).json.barbers, [], 'opened is not added');
    assert.equal((await c.call('POST', `/api/b/${DEMO_SHARE_CODE}/add`, undefined, cu.cookie)).json.added, true);
    const mine = (await c.call('GET', '/api/me/barbers', undefined, cu.cookie)).json.barbers;
    assert.equal(mine.length, 1); assert.equal(mine[0].id, id);
    assert.equal((await c.call('POST', `/api/b/${DEMO_SHARE_CODE}/add`, undefined)).status, 401, 'adding needs a login');
    // booking now works
    const bk = await c.call('POST', '/api/bookings', { barber_id: id, service_id: svc, date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' }, cu.cookie);
    assert.equal(bk.status, 201, JSON.stringify(bk.json));
    // someone else with no link is still locked out
    const other = await c.newCustomer();
    assert.equal((await c.call('POST', '/api/bookings', { barber_id: id, service_id: svc, date: WED, time: '11:00', payment_option: 'ON_ARRIVAL' }, other.cookie)).status, 404);
    // another barber cannot browse this shop either
    assert.equal((await c.call('GET', `/api/barbers/${id}`, undefined, await (async () => { const r = await c.call('POST', '/api/auth/signup', { accept_terms: true, accept_barber_agreement: true, role: 'barber', name: 'Other B', email: `ob${Date.now()}@example.com`, password: 'Password123', shop_name: 'Other' }); return r.headers.get('set-cookie')!.split(';')[0]; })())).status, 404);
    // the shop owner can still read their own profile
    assert.equal((await c.call('GET', `/api/barbers/${id}`, undefined, await c.barberCookie())).status, 200);
  } finally { done(c); }
});

test('removing a barber: without bookings access ends; with bookings they stay reachable but leave My barbers; a booking re-adds', async () => {
  const c = await boot();
  try {
    const cu = await c.newCustomer(); const id = c.barberId;
    await c.call('POST', `/api/b/${DEMO_SHARE_CODE}/add`, undefined, cu.cookie);
    assert.equal((await c.call('DELETE', `/api/me/barbers/${id}`, undefined, cu.cookie)).status, 200);
    assert.equal((await c.call('GET', `/api/barbers/${id}`, undefined, cu.cookie)).status, 404, 'no booking history: needs the link again');
    await c.call('GET', '/api/b/' + DEMO_SHARE_CODE, undefined, cu.cookie);
    await c.call('POST', `/api/b/${DEMO_SHARE_CODE}/add`, undefined, cu.cookie);
    await createBooking(c.db, cu.id, { barber_id: id, service_id: c.serviceIds[0], date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' });
    await c.call('DELETE', `/api/me/barbers/${id}`, undefined, cu.cookie);
    assert.deepEqual((await myBarbers(c.db, cu.id)).map((b: any) => b.id), [], 'gone from My barbers');
    assert.equal((await c.call('GET', `/api/barbers/${id}`, undefined, cu.cookie)).status, 200, 'but a past booking keeps access');
    await createBooking(c.db, cu.id, { barber_id: id, service_id: c.serviceIds[0], date: WED, time: '12:00', payment_option: 'ON_ARRIVAL' });
    assert.equal((await myBarbers(c.db, cu.id)).length, 1, 'booking again puts them back');
    // favourite also adds
    const c2 = await c.newCustomer(); await c.call('GET', '/api/b/' + DEMO_SHARE_CODE, undefined, c2.cookie);
    await c.call('POST', `/api/barbers/${id}/favourite`, { on: true }, c2.cookie);
    assert.equal((await myBarbers(c.db, c2.id))[0].favourite, true);
    // service-level helpers
    assert.equal(await canUseBarber(c.db, { id: c2.id, role: 'customer' }, id), true);
    assert.equal(await canUseBarber(c.db, undefined, id), false);
    assert.equal(await canUseBarber(c.db, { id: 999, role: 'barber', barberId: id + 1 }, id), false);
    await removeBarber(c.db, c2.id, id); await rememberBarber(c.db, c2.id, id, 'link', false);
  } finally { done(c); }
});

test('barber side: share card data + QR, regenerate revokes link but keeps customers who already added the shop; admin still sees all barbers', async () => {
  const c = await boot();
  try {
    const bc = await c.barberCookie();
    const sh = (await c.call('GET', '/api/barber/share', undefined, bc)).json;
    assert.equal(sh.code, DEMO_SHARE_CODE); assert.match(sh.url, /\/b\/de30c0de5a1e0001$/); assert.equal(sh.active, true);
    const qr = await c.call('GET', '/api/barber/share/qr.svg', undefined, bc);
    assert.equal(qr.status, 200); assert.match(qr.headers.get('content-type') || '', /image\/svg\+xml/); assert.match(qr.text, /^<svg/);
    assert.equal((await c.call('GET', '/api/barber/share')).status, 401);
    const cu = await c.newCustomer(); await c.call('POST', `/api/b/${DEMO_SHARE_CODE}/add`, undefined, cu.cookie);
    const re = (await c.call('POST', '/api/barber/share/regenerate', {}, bc)).json;
    assert.notEqual(re.code, DEMO_SHARE_CODE);
    assert.equal((await c.call('GET', '/api/b/' + DEMO_SHARE_CODE)).status, 404, 'old link dead');
    assert.equal((await c.call('GET', '/api/b/' + re.code)).status, 200, 'new link live');
    assert.equal((await c.call('GET', `/api/barbers/${c.barberId}`, undefined, cu.cookie)).status, 200, 'customers who already added the shop keep it');
    const other = await c.newCustomer();
    assert.equal((await c.call('POST', '/api/bookings', { barber_id: c.barberId, service_id: c.serviceIds[0], date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' }, other.cookie)).status, 404, 'people with only the old link are locked out');
    const adm = await fetch(c.base + '/api/admin/barbers', { headers: { Authorization: 'Bearer ' + KEY, 'X-Admin-Pin': '4821' } });
    assert.equal(adm.status, 200); assert.equal(((await adm.json()) as any).barbers.length, 1, 'admin still lists every barber');
    // the short link redirects into the app and keeps the code out of Referer
    const rd = await fetch(c.base + '/b/' + re.code, { redirect: 'manual' });
    assert.equal(rd.status, 302); assert.equal(rd.headers.get('location'), '/#/b/' + re.code); assert.equal(rd.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await fetch(c.base + '/b/not-a-code', { redirect: 'manual' })).headers.get('location'), '/');
  } finally { done(c); }
});

test('new barbers get a code at sign-up; customers who booked before keep their barber (existing data)', async () => {
  const c = await boot();
  try {
    const r = await c.call('POST', '/api/auth/signup', { accept_terms: true, accept_barber_agreement: true, role: 'barber', name: 'New B', email: `nb${Date.now()}@example.com`, password: 'Password123', shop_name: 'New shop' });
    assert.equal(r.status, 201);
    const code = (await c.call('GET', '/api/barber/share', undefined, r.headers.get('set-cookie')!.split(';')[0])).json;
    assert.match(code.code, CODE_RE); assert.equal(code.active, false, 'not verified yet: the link does not resolve');
    assert.equal((await c.call('GET', '/api/b/' + code.code)).status, 404);
    // a customer with a booking but no customer_barbers row (e.g. data from before this feature) still has access
    const cu = await c.newCustomer();
    await c.db.query(`INSERT INTO bookings (customer_id, barber_id, service_id, scheduled_at, ends_at, service_name, price_kobo, duration_min, status, payment_option, payment_status, created_at)
      SELECT $1, $2, s.id, now(), now() + interval '30 minutes', s.name, s.price_kobo, 30, 'COMPLETED', 'ON_ARRIVAL', 'PAID', now() FROM services s WHERE s.barber_id=$2 LIMIT 1`, [cu.id, c.barberId]);
    assert.equal((await c.call('GET', `/api/barbers/${c.barberId}`, undefined, cu.cookie)).status, 200);
  } finally { done(c); }
});
