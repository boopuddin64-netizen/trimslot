import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'net';
import { freshDb, setNow, resetNow, WED } from './helpers';
import { createApp } from '../src/app';
import { createBooking } from '../src/bookingService';

const KEY = 'test-admin-key-0123456789';
async function boot() {
  const s = await freshDb(); setNow(`${WED}T08:00:00+01:00`); process.env.CRON_SECRET = KEY;
  for (let i = 0; i < 60; i++) await s.db.query(`INSERT INTO users (role,name,email,phone,password_hash) VALUES ('customer',$1,$2,$3,'x')`, [`Bulk Person ${String(i).padStart(2, '0')}`, `bulk${i}@t.test`, `0800000${String(i).padStart(4, '0')}`]);
  const server = createApp(s.db).listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const j = async (p: string, o: any = {}) => { const r = await fetch(base + '/api/admin' + p, { ...o, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY, ...(o.headers || {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  return { ...s, server, get: (p: string) => j(p), post: (p: string, body: any = {}) => j(p, { method: 'POST', body }), base } as any;
}

test('lists: keyset pagination walks every row exactly once, in every sort direction; search + filters; lean rows', async () => {
  const s = await boot();
  try {
    for (const [sort, dir] of [['newest', 'desc'], ['newest', 'asc'], ['name', 'asc'], ['name', 'desc']]) {
      const seen: number[] = []; let cursor = ''; let pages = 0;
      do {
        const r = (await s.get(`/l/customers?limit=20&sort=${sort}&dir=${dir}${cursor ? '&cursor=' + cursor : ''}`)).body;
        assert.ok(r.rows.length <= 20); seen.push(...r.rows.map((x: any) => x.id)); cursor = r.next || ''; pages++;
        if (pages === 1) assert.ok(r.total >= 60, 'total on first page');
        else assert.equal(r.total, undefined, 'no count on later pages');
      } while (cursor && pages < 20);
      assert.equal(new Set(seen).size, seen.length, `${sort}/${dir} no duplicates`);
      const all = (await s.db.one(`SELECT COUNT(*)::int c FROM users WHERE role='customer'`)).c; assert.equal(seen.length, all, `${sort}/${dir} complete`);
    }
    const q = (await s.get('/l/customers?q=' + encodeURIComponent('Bulk Person 07'))).body; assert.equal(q.rows.length, 1); assert.ok(!('password_hash' in q.rows[0]));
    assert.equal((await s.get('/l/customers?q=' + encodeURIComponent("%' OR 1=1 --"))).body.rows.length, 0);
    assert.equal((await s.get('/l/customers?status=BANNED')).body.rows.length, 0);
    assert.equal((await s.get('/l/nope')).status, 404);
    assert.equal((await s.get('/l/customers?limit=100000')).body.rows.length <= 100, true, 'limit capped');
    assert.equal((await s.get('/l/customers?cursor=garbage')).status, 200, 'bad cursor is ignored, not a 500');
    for (const l of ['barbers', 'bookings', 'payments', 'purchases', 'plans', 'credits', 'reports', 'reviews', 'waitlist', 'broadcasts', 'ledger']) {
      const r = await s.get('/l/' + l); assert.equal(r.status, 200, l); assert.ok(Array.isArray(r.body.rows), l);
    }
    assert.equal((await fetch(s.base + '/api/admin/l/customers')).status, 401);
  } finally { s.server.close(); resetNow(); }
});

test('bookings list: filters, sorting, cursor over a date sort', async () => {
  const s = await boot();
  try {
    let n = 0; for (const t of ['09:00', '09:30', '10:00', '10:30', '11:00']) { await createBooking(s.db, s.customerIds[n++ % 2], { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: t, payment_option: 'ON_ARRIVAL' }); }
    const first = (await s.get('/l/bookings?limit=5&sort=date&dir=desc')).body; assert.equal(first.rows.length, 5);
    assert.equal((await s.get('/l/bookings?status=CANCELLED')).body.rows.length, 0);
    assert.equal((await s.get('/l/bookings?status=CONFIRMED&barber_id=' + s.barberId)).body.total, 5);
    const p1 = (await s.get('/l/bookings?limit=5&sort=price&dir=asc')).body.rows.map((r: any) => r.price_kobo); assert.deepEqual([...p1].sort((a, b) => a - b), p1);
    const pg = (await s.get('/l/bookings?limit=5&sort=date&dir=desc&count=0')).body; assert.equal(pg.total, undefined);
    const one = (await s.get('/l/bookings?q=%23' + first.rows[0].id)).body; assert.equal(one.rows.length, 1);
  } finally { s.server.close(); resetNow(); }
});

test('home is lean; palette is bounded; bulk actions are audited, capped, idempotent and only touch eligible rows', async () => {
  const s = await boot();
  try {
    const h = (await s.get('/home')).body; assert.ok(h.numbers.customers >= 60); assert.equal(h.attention.length, 5);
    assert.ok(JSON.stringify(h).length < 2000, 'home payload is tiny');
    const pal = (await s.get('/palette?q=Bulk')).body; assert.ok(pal.users.length <= 5);
    assert.equal((await s.get('/palette?q=a')).body.users.length, 0);
    const ids = (await s.get('/l/customers?limit=10')).body.rows.map((r: any) => r.id);
    assert.equal((await s.post('/bulk/customers/suspend', { ids })).status, 400, 'reason required');
    const r1 = (await s.post('/bulk/customers/suspend', { ids, reason: 'Testing bulk' })).body; assert.equal(r1.changed, 10);
    const r2 = (await s.post('/bulk/customers/suspend', { ids, reason: 'Testing bulk' })).body; assert.equal(r2.changed, 0, 'idempotent');
    assert.equal((await s.db.one(`SELECT COUNT(*)::int c FROM notifications WHERE type='ACCOUNT_SUSPENDED'`)).c, 10);
    assert.equal((await s.db.one(`SELECT COUNT(*)::int c FROM audit_log WHERE action='ADMIN_BULK_SUSPEND'`)).c, 2);
    assert.equal((await s.post('/bulk/customers/reinstate', { ids })).body.changed, 10);
    const barberUser = (await s.db.one('SELECT user_id FROM barbers WHERE id=$1', [s.barberId])).user_id;
    const rb = (await s.post('/bulk/customers/warn', { ids: [barberUser], reason: 'nope' })).body; assert.equal(rb.changed, 0, 'a barber id is never warned as a customer');
    assert.equal((await s.post('/bulk/notify', { ids: Array.from({ length: 201 }, (_, i) => i + 1), title: 'x1', body: 'hello there' })).status, 400, 'max 200');
    assert.equal((await s.post('/bulk/notify', { ids: ids.slice(0, 3), title: 'Hi', body: 'hello there' })).body.sent, 3);
    // reports bulk
    const cid = s.customerIds[0];
    for (let i = 0; i < 3; i++) await s.db.query(`INSERT INTO reports (reporter_id, category, message) VALUES ($1,'OTHER','x')`, [cid]);
    const rep = (await s.get('/l/reports?status=OPEN')).body.rows.map((r: any) => r.id);
    assert.equal((await s.post('/bulk/reports/resolve', { ids: rep, status: 'DISMISSED', note: 'Not actionable' })).body.changed, 3);
    assert.equal((await s.post('/bulk/reports/resolve', { ids: rep, status: 'DISMISSED', note: 'Not actionable' })).body.changed, 0);
    assert.equal((await s.get('/counts/reports')).body.DISMISSED, 3);
    // review moderation
    const b = await createBooking(s.db, cid, { barber_id: s.barberId, service_id: s.serviceIds[0], date: WED, time: '09:00', payment_option: 'ON_ARRIVAL' });
    await s.db.query(`UPDATE bookings SET status='COMPLETED' WHERE id=$1`, [b.id]);
    await s.db.query(`INSERT INTO reviews (booking_id, customer_id, barber_id, rating, comment) VALUES ($1,$2,$3,1,'rude')`, [b.id, cid, s.barberId]);
    const rv = (await s.get('/l/reviews')).body.rows[0];
    assert.equal((await s.post(`/reviews/${rv.id}/hide`, { hidden: true })).status, 400);
    assert.equal((await s.post(`/reviews/${rv.id}/hide`, { hidden: true, reason: 'Abusive language' })).body.hidden, true);
    assert.equal((await s.db.one('SELECT hidden FROM reviews')).hidden, true);
  } finally { s.server.close(); resetNow(); }
});

test('admin can switch every smart feature off/on from settings and /config reflects it', async () => {
  const s = await boot();
  try {
    const put = (b: any) => s.j ? null : fetch(s.base + '/api/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY }, body: JSON.stringify(b) });
    const r = await put({ feature_reviews: false, feature_waitlist: false, feature_loyalty: true, loyalty_every_n: 5, loyalty_credit_naira: 750 }); assert.equal(r!.status, 200);
    const cfg = await (await fetch(s.base + '/api/config')).json();
    assert.equal(cfg.features.reviews, false); assert.equal(cfg.features.waitlist, false); assert.equal(cfg.features.loyalty, true); assert.deepEqual(cfg.loyalty, { every_n: 5, reward_kobo: 75000 });
    assert.equal((await put({ feature_nonsense: true }))!.status, 400);
    assert.equal((await put({ loyalty_every_n: 1 }))!.status, 400);
  } finally { s.server.close(); resetNow(); }
});
