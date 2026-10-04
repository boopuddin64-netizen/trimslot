import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { emptyDatabase } from './helpers';
import { migrate } from '../src/db';

test('migration 012 on a database that already has live-like data: additive, links old plans to cheap-enough services and flags them, keeps customers\' barbers, gives every barber a unique code', async () => {
  const { db } = await emptyDatabase();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  for (const f of fs.readdirSync('migrations').filter((f) => /^0(0\d|10|11)_/.test(f))) fs.copyFileSync(path.join('migrations', f), path.join(dir, f));
  assert.ok(fs.readdirSync(dir).length === 11);
  await migrate(db, dir);
  const u = async (role: string, name: string, email: string) => (await db.one<any>(`INSERT INTO users (role, name, email, password_hash) VALUES ($1,$2,$3,'x') RETURNING id`, [role, name, email])).id;
  const [bu1, bu2, c1, c2, c3] = [await u('barber', 'B1', 'b1@x.t'), await u('barber', 'B2', 'b2@x.t'), await u('customer', 'C1', 'c1@x.t'), await u('customer', 'C2', 'c2@x.t'), await u('customer', 'C3', 'c3@x.t')];
  const b1 = (await db.one<any>(`INSERT INTO barbers (user_id, shop_name, verified) VALUES ($1,'S1',TRUE) RETURNING id`, [bu1])).id;
  const b2 = (await db.one<any>(`INSERT INTO barbers (user_id, shop_name, verified) VALUES ($1,'S2',TRUE) RETURNING id`, [bu2])).id;
  const svc = async (barber: number, name: string, price: number, active = true) => (await db.one<any>(`INSERT INTO services (barber_id, name, price_kobo, duration_min, active) VALUES ($1,$2,$3,30,$4) RETURNING id`, [barber, name, price, active])).id;
  const s15 = await svc(b1, 'Kids', 150000), s25 = await svc(b1, 'Adult', 250000), s50 = await svc(b1, 'Premium', 500000), sOff = await svc(b1, 'Old', 100000, false), sOther = await svc(b2, 'Other', 100000);
  const plan = async (barber: number, name: string) => (await db.one<any>(`INSERT INTO plans (barber_id, name, price_kobo, sessions, validity_days) VALUES ($1,$2,1000000,4,60) RETURNING id`, [barber, name])).id;
  const unlinked = await plan(b1, 'Unlinked'), linked = await plan(b1, 'Linked');
  await db.query('INSERT INTO plan_services (plan_id, service_id) VALUES ($1,$2)', [linked, s50]);
  const pur = async (planId: number, ids: number[]) => (await db.one<any>(`INSERT INTO plan_purchases (plan_id, customer_id, barber_id, plan_name, price_kobo, sessions_total, validity_days, service_ids, status, paid_at, expires_at)
    VALUES ($1,$2,$3,'P',1000000,4,60,$4,'ACTIVE',now(),now() + interval '30 days') RETURNING id`, [planId, c1, b1, ids])).id;
  const pEmpty = await pur(unlinked, []), pSet = await pur(linked, [s50]);
  await db.query(`INSERT INTO bookings (customer_id, barber_id, service_id, scheduled_at, ends_at, service_name, price_kobo, duration_min, status, payment_option, payment_status)
    VALUES ($1,$2,$3, now(), now() + interval '30 minutes','Kids',150000,30,'COMPLETED','ON_ARRIVAL','PAID')`, [c2, b2, sOther]);
  await db.query('INSERT INTO favourites (customer_id, barber_id) VALUES ($1,$2)', [c3, b1]);
  const before = (await db.one<any>(`SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM bookings) b, (SELECT count(*) FROM plans) p, (SELECT count(*) FROM plan_purchases) pp, (SELECT count(*) FROM services) s`));

  assert.deepEqual(await migrate(db), ['012_fee_split_plan_fit_share_links.sql'], 'only 012 is applied');

  const after = (await db.one<any>(`SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM bookings) b, (SELECT count(*) FROM plans) p, (SELECT count(*) FROM plan_purchases) pp, (SELECT count(*) FROM services) s`));
  assert.deepEqual(after, before, 'no existing row added or removed');
  const links = async (id: number) => (await db.many<any>('SELECT service_id FROM plan_services WHERE plan_id=$1 ORDER BY service_id', [id])).map((r) => r.service_id);
  assert.deepEqual(await links(unlinked), [s15, s25], 'unlinked plan: active services of that barber priced at or below the per-session value (₦2,500), nothing else');
  assert.deepEqual(await links(linked), [s50], 'an already-linked plan is untouched');
  assert.equal((await db.one<any>('SELECT needs_review FROM plans WHERE id=$1', [unlinked])).needs_review, true);
  assert.equal((await db.one<any>('SELECT needs_review FROM plans WHERE id=$1', [linked])).needs_review, false);
  assert.deepEqual((await db.one<any>('SELECT service_ids FROM plan_purchases WHERE id=$1', [pEmpty])).service_ids, [s15, s25], 'a purchase that had no services can now be used');
  assert.deepEqual((await db.one<any>('SELECT service_ids FROM plan_purchases WHERE id=$1', [pSet])).service_ids, [s50], 'a purchase with services is untouched');
  const codes = await db.many<any>('SELECT share_code FROM barbers'); assert.equal(new Set(codes.map((c) => c.share_code)).size, 2); assert.ok(codes.every((c) => /^[0-9a-f]{12}$/.test(c.share_code)));
  const cb = await db.many<any>('SELECT customer_id, barber_id, added, source FROM customer_barbers ORDER BY customer_id');
  assert.deepEqual(cb.map((r) => [r.customer_id, r.barber_id, r.added, r.source]), [[c2, b2, true, 'booking'], [c3, b1, true, 'favourite']], 'existing relationships are kept');
  assert.deepEqual(await migrate(db), [], 'running again does nothing');
  fs.rmSync(dir, { recursive: true, force: true });
});
