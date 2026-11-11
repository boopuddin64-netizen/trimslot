import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, userIdOfBarber } from './helpers';
import {
  balanceOf, requestPlanBalanceRefund, forwardPlanBalanceRefund, declinePlanBalanceRefundByAdmin,
  acceptPlanBalanceRefund, declinePlanBalanceRefund, withdrawPlanBalanceRefund, authorizePlanBalanceRefund,
} from '../src/planRefunds';

/** A plan the customer paid online: 10,000 naira, 5 sessions, 2 used. */
async function paidPlan(db: any, barberId: number, customerId: number, serviceId: number, used = 2, ref = 'TS-PLAN-REFUND-1') {
  const plan = (await db.one(`INSERT INTO plans (barber_id, name, price_kobo, sessions, validity_days) VALUES ($1,'Ten',1000000,5,60) RETURNING id`, [barberId])).id;
  const pp = (await db.one(`INSERT INTO plan_purchases (plan_id, customer_id, barber_id, plan_name, price_kobo, sessions_total, sessions_used, validity_days, service_ids, status, created_at, expires_at)
    VALUES ($1,$2,$3,'Ten',1000000,5,$4,60,$5,'ACTIVE',now(),now() + interval '30 days') RETURNING id`, [plan, customerId, barberId, used, [serviceId]])).id;
  await db.query(`INSERT INTO payments (plan_purchase_id, reference, provider, amount_kobo, status, mock_paid) VALUES ($1,$2,'MOCK',1000000,'SUCCESS',TRUE)`, [pp, ref]);
  return pp as number;
}

async function setup() {
  const c = await freshDb();
  const customer = c.customerIds[0];
  const barberUser = await userIdOfBarber(c.db, c.barberId);
  const pid = await paidPlan(c.db, c.barberId, customer, c.serviceIds[0]);
  const cust = { userId: customer, role: 'CUSTOMER' as const };
  const barber = { userId: barberUser, role: 'BARBER' as const, barberId: c.barberId };
  return { c, pid, cust, barber };
}

test('the balance is the unused sessions\' share of the price, rounded down; Paystack fees are not part of it', () => {
  assert.deepEqual(balanceOf({ price_kobo: 1000000, sessions_total: 5, sessions_used: 2 }), { sessions_left: 3, amount_kobo: 600000 });
  assert.deepEqual(balanceOf({ price_kobo: 1000, sessions_total: 7, sessions_used: 3 }), { sessions_left: 4, amount_kobo: 571 });
  assert.deepEqual(balanceOf({ price_kobo: 1000000, sessions_total: 5, sessions_used: 5 }), { sessions_left: 0, amount_kobo: 0 });
});

test('the full flow: admin forwards, the other party agrees, admin authorizes; only the balance is sent and the plan ends', async () => {
  const { c, pid, cust, barber } = await setup();

  const asked = await requestPlanBalanceRefund(c.db, pid, cust);
  assert.equal(asked.status, 'OPEN', 'a new request starts with the admin, not the other party');
  assert.equal(asked.amount_kobo, 600000);
  assert.equal(asked.sessions_left, 3);
  await assert.rejects(acceptPlanBalanceRefund(c.db, asked.id, barber), (e: any) => e.code === 'NOT_FORWARDED', 'the barber cannot agree before the admin forwards it');
  await assert.rejects(authorizePlanBalanceRefund(c.db, asked.id, null), (e: any) => e.code === 'NOT_CONFIRMED', 'an admin cannot authorize before both agree');

  const fwd = await forwardPlanBalanceRefund(c.db, asked.id, null);
  assert.equal(fwd.status, 'FORWARDED');
  await assert.rejects(acceptPlanBalanceRefund(c.db, asked.id, cust), (e: any) => e.code === 'SAME_PARTY', 'the customer cannot agree to their own request');

  const agreed = await acceptPlanBalanceRefund(c.db, asked.id, barber);
  assert.equal(agreed.status, 'CONFIRMED');

  const sent = await authorizePlanBalanceRefund(c.db, asked.id, null);
  assert.equal(sent.amount_kobo, 600000);
  const plan = await c.db.one('SELECT status FROM plan_purchases WHERE id=$1', [pid]);
  assert.equal(plan.status, 'CANCELLED');
  const pay = await c.db.one('SELECT refund_amount_kobo, refund_status FROM payments WHERE reference=$1', ['TS-PLAN-REFUND-1']);
  assert.equal(pay.refund_amount_kobo, 600000, 'only the balance is refunded, not the 10,000 paid');
  assert.ok(pay.refund_status, 'the payment has a refund state');

  await assert.rejects(authorizePlanBalanceRefund(c.db, asked.id, null), (e: any) => e.code === 'NOT_CONFIRMED' || e.code === 'REFUND_ALREADY', 'a second authorize does nothing');
});

test('the admin can decline a new request before anyone else sees it; the barber can decline a forwarded one; the plan stays as it was', async () => {
  const { c, pid, cust, barber } = await setup();

  const first = await requestPlanBalanceRefund(c.db, pid, cust);
  const declined = await declinePlanBalanceRefundByAdmin(c.db, first.id, null, 'Still in use this month');
  assert.equal(declined.status, 'DECLINED_ADMIN');
  assert.equal((await c.db.one('SELECT decline_reason FROM plan_refund_requests WHERE id=$1', [first.id])).decline_reason, 'Still in use this month');
  await assert.rejects(acceptPlanBalanceRefund(c.db, first.id, barber), (e: any) => e.code === 'NOT_FORWARDED', 'a declined request cannot be agreed');

  // a new request is allowed once the old one is closed
  const second = await requestPlanBalanceRefund(c.db, pid, cust);
  await forwardPlanBalanceRefund(c.db, second.id, null);
  const no = await declinePlanBalanceRefund(c.db, second.id, barber, 'We still have a session booked');
  assert.equal(no.status, 'DECLINED_OTHER');
  await assert.rejects(declinePlanBalanceRefund(c.db, second.id, barber, ''), (e: any) => e.code === 'NOT_FORWARDED', 'a declined request is closed');
  const plan = await c.db.one('SELECT status FROM plan_purchases WHERE id=$1', [pid]);
  assert.equal(plan.status, 'ACTIVE', 'a declined refund leaves the plan as it was');
});

test('only the person who asked can withdraw; a plan with a booking still on it cannot be refunded', async () => {
  const { c, pid, cust, barber } = await setup();
  const customer = cust.userId;

  // a booking still on the plan blocks the request
  await c.db.query(`INSERT INTO bookings (customer_id, barber_id, service_id, scheduled_at, ends_at, service_name, price_kobo, duration_min, status, payment_option, payment_status, plan_purchase_id)
    VALUES ($1,$2,$3, now() + interval '2 days', now() + interval '2 days 30 minutes','Kids',150000,30,'CONFIRMED','ONLINE','PAID',$4)`, [customer, c.barberId, c.serviceIds[0], pid]);
  await assert.rejects(requestPlanBalanceRefund(c.db, pid, cust), (e: any) => e.code === 'UPCOMING_BOOKINGS');
  await c.db.query(`UPDATE bookings SET status='CANCELLED' WHERE plan_purchase_id=$1`, [pid]);

  const asked = await requestPlanBalanceRefund(c.db, pid, cust);
  await assert.rejects(withdrawPlanBalanceRefund(c.db, asked.id, barber), (e: any) => e.code === 'NOT_REQUESTER', 'the other party cannot take the request back');
  await forwardPlanBalanceRefund(c.db, asked.id, null);
  const w = await withdrawPlanBalanceRefund(c.db, asked.id, cust);
  assert.equal(w.status, 'WITHDRAWN');
  const plan = await c.db.one('SELECT status FROM plan_purchases WHERE id=$1', [pid]);
  assert.equal(plan.status, 'ACTIVE', 'a withdrawn request leaves the plan as it was');
});
