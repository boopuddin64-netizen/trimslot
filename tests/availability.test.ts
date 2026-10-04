import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'net';
import { DEMO_SHARE_CODE } from '../src/seed';
import { ensureShareCode } from '../src/shareLinks';
import { freshDb, setNow, resetNow, WED } from './helpers';
import { createApp } from '../src/app';
import { createBooking } from '../src/bookingService';

const THU = '2026-10-01';
async function withServer(fn: (base: string, ctx: Awaited<ReturnType<typeof freshDb>>) => Promise<void>) {
  setNow('2026-09-29T08:00:00+01:00'); // Tuesday morning
  const ctx = await freshDb();
  const server = createApp(ctx.db).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { await fn(base, ctx); } finally { server.close(); resetNow(); }
}
const call = (base: string, method: string, p: string, body?: unknown, cookie?: string) =>
  fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
async function barberCookie(base: string) {
  const r = await call(base, 'POST', '/api/auth/login', { identifier: 'mike@trimslot.demo', password: 'Barber123!' });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie')!.split(';')[0];
}
const week = (over: Record<number, any> = {}) => ({ days: Array.from({ length: 7 }, (_, wd) => ({ weekday: wd, is_working: wd >= 1 && wd <= 6, start: '09:00', end: '18:00', break_start: '13:00', break_end: '14:00', ...(over[wd] || {}) })) });
const notifs = (db: any, uid: number) => db.many(`SELECT type, title, body, booking_id FROM notifications WHERE user_id=$1 AND type='AVAILABILITY_CHANGED'`, [uid]);

test('weekly-hours change that strands a booking needs confirmation, then notifies the customer (nothing cancelled)', async () => {
  await withServer(async (base, { db, barberId, customerIds, serviceIds }) => {
    const ck = await barberCookie(base);
    const a = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '17:00', payment_option: 'ON_ARRIVAL' });
    const b = await createBooking(db, customerIds[1], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' });
    const shorter = week({ 3: { end: '16:00' } });      // Wed now closes at 16:00 -> a (17:00) is stranded, b (10:00) is fine
    const r1 = await call(base, 'PUT', '/api/barber/schedule', shorter, ck);
    assert.equal(r1.status, 409);
    const j1 = await r1.json() as any;
    assert.equal(j1.error.code, 'AVAILABILITY_CONFLICT');
    assert.equal(j1.error.details.count, 1);
    assert.equal((await db.one(`SELECT end_min FROM barber_schedule WHERE barber_id=$1 AND weekday=3`, [barberId])).end_min, 1080, 'nothing saved without confirmation');
    assert.equal((await notifs(db, customerIds[0])).length, 0);
    const r2 = await call(base, 'PUT', '/api/barber/schedule', { ...shorter, confirm: true }, ck);
    assert.equal(r2.status, 200);
    assert.equal((await r2.json() as any).notified_bookings, 1);
    assert.equal((await db.one(`SELECT end_min FROM barber_schedule WHERE barber_id=$1 AND weekday=3`, [barberId])).end_min, 960);
    const n = await notifs(db, customerIds[0]);
    assert.equal(n.length, 1);
    assert.match(n[0].body, /Mike's Barbershop/);
    assert.match(n[0].body, /Wed 30 Sep, 5:00 PM/);
    assert.equal(n[0].booking_id, a.id);
    assert.equal((await notifs(db, customerIds[1])).length, 0, 'unaffected customer is not notified');
    assert.equal((await db.one('SELECT status FROM bookings WHERE id=$1', [a.id])).status, 'CONFIRMED', 'no auto-cancel');
    assert.equal((await db.one('SELECT status FROM bookings WHERE id=$1', [b.id])).status, 'CONFIRMED');
    // public barber page shows an "Availability updated" note
    const pub = await (await call(base, 'GET', '/api/b/' + DEMO_SHARE_CODE)).json() as any;
    assert.ok(pub.notices.some((x: any) => x.type === 'HOURS_UPDATED' && x.title === 'Open times changed'));
    // a harmless edit (nothing stranded) saves without confirmation and notifies nobody
    const r3 = await call(base, 'PUT', '/api/barber/schedule', week({ 3: { end: '16:00' }, 4: { start: '08:00' } }), ck);
    assert.equal(r3.status, 200);
    assert.equal((await notifs(db, customerIds[0])).length, 1);
  });
});

test('closing a day / removing a working day: CONFIRMED bookings are notified; unpaid Pay-now attempts (they hold nothing), cancelled and past ones are not', async () => {
  await withServer(async (base, { db, barberId, customerIds, serviceIds }) => {
    const ck = await barberCookie(base);
    const conf = await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: THU, time: '10:00', payment_option: 'ON_ARRIVAL' });
    const pend = await createBooking(db, customerIds[1], { barber_id: barberId, service_id: serviceIds[0], date: THU, time: '11:00', payment_option: 'ONLINE' });
    assert.equal(pend.status, 'PENDING_PAYMENT');
    const third = (await db.one(`INSERT INTO users (role, name, email, password_hash) VALUES ('customer','Third','third@x.com','x') RETURNING id`)).id;
    const dead = await createBooking(db, third, { barber_id: barberId, service_id: serviceIds[0], date: THU, time: '15:00', payment_option: 'ON_ARRIVAL' });
    await db.query(`UPDATE bookings SET status='CANCELLED' WHERE id=$1`, [dead.id]);
    const r1 = await call(base, 'POST', '/api/barber/days-off', { date: THU, reason: 'Wedding' }, ck);
    assert.equal(r1.status, 409);
    assert.equal(((await r1.json()) as any).error.details.count, 1, 'only the complete booking counts');
    assert.equal((await db.many('SELECT * FROM days_off')).length, 0);
    const r2 = await call(base, 'POST', '/api/barber/days-off', { date: THU, reason: 'Wedding', confirm: true }, ck);
    assert.equal(r2.status, 201);
    assert.equal(((await r2.json()) as any).notified_bookings, 1);
    assert.equal((await notifs(db, customerIds[1])).length, 0, 'an unpaid attempt holds no slot, so nothing is "affected"');
    for (const [cid, bid] of [[customerIds[0], conf.id]] as const) {
      const n = await notifs(db, cid);
      assert.equal(n.length, 1);
      assert.match(n[0].body, /closed on Thu 1 Oct \(Wedding\)/);
      assert.equal(n[0].booking_id, bid);
    }
    assert.equal((await notifs(db, third)).length, 0);
    assert.deepEqual((await db.many('SELECT status FROM bookings WHERE id IN ($1,$2) ORDER BY id', [conf.id, pend.id])).map((r: any) => r.status), ['CONFIRMED', 'PENDING_PAYMENT']);
    const pub = await (await call(base, 'GET', '/api/b/' + DEMO_SHARE_CODE)).json() as any;
    const closed = pub.notices.find((x: any) => x.type === 'CLOSED');
    assert.equal(closed.title, 'Closed on Thu 1 Oct');
    assert.equal(closed.date, THU);
    // duplicate day off still 409 DUPLICATE
    const dup = await call(base, 'POST', '/api/barber/days-off', { date: THU, confirm: true }, ck);
    assert.equal(dup.status, 409);
    assert.equal(((await dup.json()) as any).error.code, 'DUPLICATE');
    // day off with no bookings is silent
    const quiet = await call(base, 'POST', '/api/barber/days-off', { date: '2026-10-05' }, ck);
    assert.equal(quiet.status, 201);
    assert.equal(((await quiet.json()) as any).notified_bookings, 0);
  });
});

test('turning a working day off strands its bookings (confirm + notify); unaffected other days stay silent', async () => {
  await withServer(async (base, { db, barberId, customerIds, serviceIds }) => {
    const ck = await barberCookie(base);
    await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' });
    await createBooking(db, customerIds[1], { barber_id: barberId, service_id: serviceIds[0], date: THU, time: '10:00', payment_option: 'ON_ARRIVAL' });
    const noWed = week({ 3: { is_working: false } });
    assert.equal((await call(base, 'PUT', '/api/barber/schedule', noWed, ck)).status, 409);
    assert.equal((await call(base, 'PUT', '/api/barber/schedule', { ...noWed, confirm: true }, ck)).status, 200);
    assert.equal((await notifs(db, customerIds[0])).length, 1);
    assert.equal((await notifs(db, customerIds[1])).length, 0);
  });
});

test('removing a day off never notifies; break moved over a booking is detected', async () => {
  await withServer(async (base, { db, barberId, customerIds, serviceIds }) => {
    const ck = await barberCookie(base);
    await createBooking(db, customerIds[0], { barber_id: barberId, service_id: serviceIds[0], date: WED, time: '10:00', payment_option: 'ON_ARRIVAL' });
    const r = await call(base, 'PUT', '/api/barber/schedule', week({ 3: { break_start: '10:00', break_end: '11:00' } }), ck);
    assert.equal(r.status, 409);
    const off = await call(base, 'POST', '/api/barber/days-off', { date: '2026-10-05' }, ck);
    const id = (await db.one('SELECT id FROM days_off')).id;
    assert.equal(off.status, 201);
    assert.equal((await call(base, 'DELETE', `/api/barber/days-off/${id}`, undefined, ck)).status, 200);
    assert.equal((await notifs(db, customerIds[0])).length, 0);
  });
});

/* ---------- shop photo ---------- */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);
const put = (base: string, body: Buffer, type: string, cookie?: string) => fetch(base + '/api/barber/photo', { method: 'PUT', headers: { 'Content-Type': type, ...(cookie ? { Cookie: cookie } : {}) }, body: new Uint8Array(body) });

test('photo upload: type sniffed, size capped, auth required; served with caching; barber card keeps working', async () => {
  await withServer(async (base, { db, barberId }) => {
    const ck = await barberCookie(base);
    assert.equal((await put(base, JPEG, 'image/jpeg')).status, 401, 'anonymous');
    assert.equal((await put(base, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml', ck)).status, 400, 'svg refused');
    assert.equal((await put(base, Buffer.from('GIF89a' + 'x'.repeat(50)), 'image/gif', ck)).status, 400, 'gif refused');
    assert.equal((await put(base, Buffer.from('not an image at all, just text'), 'image/jpeg', ck)).status, 400, 'lying content-type refused');
    assert.equal((await put(base, JPEG, 'image/png', ck)).status, 400, 'declared type must match real type');
    assert.equal((await put(base, Buffer.concat([JPEG.subarray(0, 6), Buffer.alloc(310 * 1024)]), 'image/jpeg', ck)).status, 413, 'too big');
    const ok = await put(base, JPEG, 'image/jpeg', ck);
    assert.equal(ok.status, 200);
    const url = ((await ok.json()) as any).photo_url as string;
    assert.match(url, /^\/api\/barbers\/\d+\/photo\?v=/);
    const img = await fetch(base + url, { headers: { Cookie: ck } });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.match(img.headers.get('cache-control') || '', /max-age=31536000/);
    assert.equal(Buffer.from(await img.arrayBuffer()).equals(JPEG), true);
    const mine = (await (await call(base, 'GET', '/api/b/' + DEMO_SHARE_CODE)).json() as any).barber;
    assert.ok(mine.photo_url.startsWith(url), 'the barber card keeps the photo (link visitors get the code on the photo URL)');
    assert.equal((await fetch(base + url)).status, 404, 'anonymous visitors cannot fetch a photo by guessing its id');
    assert.equal((await fetch(base + mine.photo_url)).status, 200, 'the share link lets them see it');
    // profile save that echoes the internal photo path back is accepted; external https URLs (legacy data) still work
    assert.equal((await call(base, 'PUT', '/api/barber/profile', { photo_url: url, about: 'hi' }, ck)).status, 200);
    assert.equal((await call(base, 'PUT', '/api/barber/profile', { photo_url: 'https://example.com/a.jpg' }, ck)).status, 200);
    assert.equal((await call(base, 'PUT', '/api/barber/profile', { photo_url: 'javascript:alert(1)' }, ck)).status, 400);
    assert.equal((await call(base, 'DELETE', '/api/barber/photo', undefined, ck)).status, 200);
    assert.equal((await fetch(base + `/api/barbers/${barberId}/photo`)).status, 404);
    assert.equal((await db.one('SELECT photo_url FROM barbers WHERE id=$1', [barberId])).photo_url, null);
  });
});
