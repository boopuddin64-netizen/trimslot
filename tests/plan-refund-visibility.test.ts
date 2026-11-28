import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { AddressInfo } from 'net';
import { freshDb, resetNow } from './helpers';
import { createApp } from '../src/app';
import { listPlanBalanceRefunds, requestPlanBalanceRefund } from '../src/planRefunds';

const KEY = 'test-admin-key-0123456789';

/** A plan the customer paid online: 10,000 naira, 5 sessions, 2 used (same shape as planRefunds.test.ts). */
async function paidPlan(db: any, barberId: number, customerId: number, serviceId: number, ref = 'TS-PLAN-VISIBLE-1') {
  const plan = (await db.one(`INSERT INTO plans (barber_id, name, price_kobo, sessions, validity_days) VALUES ($1,'Ten',1000000,5,60) RETURNING id`, [barberId])).id;
  const pp = (await db.one(`INSERT INTO plan_purchases (plan_id, customer_id, barber_id, plan_name, price_kobo, sessions_total, sessions_used, validity_days, service_ids, status, created_at, expires_at)
    VALUES ($1,$2,$3,'Ten',1000000,5,2,60,$4,'ACTIVE',now(),now() + interval '30 days') RETURNING id`, [plan, customerId, barberId, [serviceId]])).id;
  await db.query(`INSERT INTO payments (plan_purchase_id, reference, provider, amount_kobo, status, mock_paid) VALUES ($1,$2,'MOCK',1000000,'SUCCESS',TRUE)`, [pp, ref]);
  return pp as number;
}

test('an admin can see a new plan refund request: the list query returns it with the plan and customer', async () => {
  const c = await freshDb();
  const pid = await paidPlan(c.db, c.barberId, c.customerIds[0], c.serviceIds[0]);
  const asked = await requestPlanBalanceRefund(c.db, pid, { userId: c.customerIds[0], role: 'CUSTOMER' });
  const open = await listPlanBalanceRefunds(c.db, 'OPEN');
  const row = open.find((r: any) => r.id === asked.id);
  assert.ok(row, 'the new request is in the admin OPEN list');
  assert.equal(row.plan_name, 'Ten');
  assert.equal(row.amount_kobo, 600000);
  assert.ok(row.customer_name, 'the admin sees who asked');
});

test('the admin home counts plan refunds that need a decision, so they are not missed', async () => {
  const c = await freshDb();
  const pid = await paidPlan(c.db, c.barberId, c.customerIds[0], c.serviceIds[0], 'TS-PLAN-VISIBLE-2');
  await requestPlanBalanceRefund(c.db, pid, { userId: c.customerIds[0], role: 'CUSTOMER' });
  process.env.CRON_SECRET = KEY; process.env.ADMIN_KEY = KEY;
  const server = createApp(c.db).listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const r = await fetch(base + '/api/admin/home', { headers: { Authorization: 'Bearer ' + KEY } });
    assert.equal(r.status, 200);
    const j: any = await r.json();
    const item = j.attention.find((a: any) => a.key === 'reports');
    assert.ok(item, 'home has a reports item');
    assert.equal(item.n, 1, 'the open plan refund request is counted');
    assert.equal(j.attention.length, 5, 'home stays at five items');
  } finally {
    server.close();
    resetNow();
  }
});

test('the Reports screen is the one that draws the plan refund card (no later override of the route)', () => {
  const root = path.join(__dirname, '..', 'public');
  const admin3 = fs.readFileSync(path.join(root, 'admin3.js'), 'utf8');
  const admin2 = fs.readFileSync(path.join(root, 'admin2.js'), 'utf8');
  assert.ok(!/^\s*reports:\s*listPage\(/m.test(admin3), 'admin3.js must not replace the reports route with the generic list');
  assert.ok(/Object\.assign\(ROUTES,\s*\{[^}]*\breports\b/.test(admin2), 'admin2.js registers the Reports route');
  assert.ok(/planRefundsCard\(\);/.test(admin2), 'the Reports screen draws the plan refund card');
});
