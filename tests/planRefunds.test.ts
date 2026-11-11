import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, userIdOfBarber } from './helpers';
import { clock } from '../src/time';
import {
  balanceOf, requestPlanBalanceRefund, forwardPlanBalanceRefund, declinePlanBalanceRefundByAdmin,
  acceptPlanBalanceRefund, declinePlanBalanceRefund, closeDeclinedPlanBalanceRefund, withdrawPlanBalanceRefund,
  authorizePlanBalanceRefund, recordPlanRefundTransfer, confirmPlanRefundReceived, sendTransferReminders,
  closeUnconfirmedTransfers, paystackRefundProcessed, refundStatesFor,
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

test('Paystack route: the request locks once the barber agrees; the admin authorizes; the barber owes the amount; the case closes only when Paystack confirms', async () => {
  const { c, pid, cust, barber } = await setup();

  const asked = await requestPlanBalanceRefund(c.db, pid, cust);
  assert.equal(asked.status, 'OPEN', 'a new request starts with the admin, not the other side');
  assert.equal(asked.amount_kobo, 600000);
  await assert.rejects(acceptPlanBalanceRefund(c.db, asked.id, barber), (e: any) => e.code === 'NOT_FORWARDED', 'the barber cannot agree before the admin forwards it');
  await assert.rejects(authorizePlanBalanceRefund(c.db, asked.id, null), (e: any) => e.code === 'NOT_CONFIRMED', 'the admin cannot authorize before both agree');

  await forwardPlanBalanceRefund(c.db, asked.id, null);
  await assert.rejects(acceptPlanBalanceRefund(c.db, asked.id, cust), (e: any) => e.code === 'SAME_PARTY', 'the customer cannot agree to their own request');
  const agreed = await acceptPlanBalanceRefund(c.db, asked.id, barber);
  assert.equal(agreed.status, 'CONFIRMED');
  await assert.rejects(withdrawPlanBalanceRefund(c.db, asked.id, cust), (e: any) => e.code === 'NOT_WITHDRAWABLE', 'once the barber agrees, the request is locked');

  const sent = await authorizePlanBalanceRefund(c.db, asked.id, null, 'PAYSTACK');
  assert.equal(sent.refund, 'requested', 'Paystack accepted the refund');
  assert.equal((await c.db.one('SELECT status FROM plan_refund_requests WHERE id=$1', [asked.id])).status, 'REFUNDING', 'still open until Paystack confirms');
  assert.equal((await c.db.one('SELECT status FROM plan_purchases WHERE id=$1', [pid])).status, 'CANCELLED');
  const debt = await c.db.one(`SELECT COALESCE(SUM(remaining_kobo),0)::bigint AS s FROM commission_ledger WHERE barber_id=$1 AND status='ACCRUED'`, [c.barberId]);
  assert.equal(Number(debt.s), 600000, 'the barber owes the full refund on their ledger');

  const closed = await paystackRefundProcessed(c.db, 'TS-PLAN-REFUND-1');
  assert.equal(closed, asked.id, 'Paystack confirmation closes the request');
  assert.equal((await c.db.one('SELECT status FROM plan_refund_requests WHERE id=$1', [asked.id])).status, 'REFUNDED');
  assert.equal((await c.db.one('SELECT refund_status, refund_amount_kobo FROM payments WHERE reference=$1', ['TS-PLAN-REFUND-1'])).refund_amount_kobo, 600000, 'only the balance is refunded');
  await assert.rejects(authorizePlanBalanceRefund(c.db, asked.id, null, 'PAYSTACK'), (e: any) => e.code === 'NOT_CONFIRMED', 'a closed request cannot be authorized again');
});

test('a barber decline goes to the admin first; the admin sends the feedback and closes it; the customer can ask again', async () => {
  const { c, pid, cust, barber } = await setup();

  const first = await requestPlanBalanceRefund(c.db, pid, cust);
  await forwardPlanBalanceRefund(c.db, first.id, null);
  const no = await declinePlanBalanceRefund(c.db, first.id, barber, 'We still have a session booked');
  assert.equal(no.status, 'OTHER_DECLINED', 'the admin reviews the reason before the customer hears back');
  await assert.rejects(requestPlanBalanceRefund(c.db, pid, cust), (e: any) => e.code === 'ALREADY_REQUESTED', 'it still counts as open until the admin closes it');
  await assert.rejects(declinePlanBalanceRefund(c.db, first.id, barber, 'again'), (e: any) => e.code === 'NOT_FORWARDED', 'it cannot be declined twice');

  const closed = await closeDeclinedPlanBalanceRefund(c.db, first.id, null, 'Cancel the booking first, then ask again.');
  assert.equal(closed.status, 'DECLINED_OTHER');
  assert.equal((await c.db.one('SELECT close_reason FROM plan_refund_requests WHERE id=$1', [first.id])).close_reason, 'Cancel the booking first, then ask again.');

  const why = (await refundStatesFor(c.db, [pid])).get(pid)!.refund_last;
  assert.equal(why.status, 'DECLINED_OTHER', 'the customer can see the last request that did not go ahead');
  assert.equal(why.close_reason, 'Cancel the booking first, then ask again.', 'and the feedback the admin sent');

  const second = await requestPlanBalanceRefund(c.db, pid, cust);
  assert.equal(second.status, 'OPEN', 'a new request is allowed once the old one is closed');
  assert.equal((await c.db.one('SELECT status FROM plan_purchases WHERE id=$1', [pid])).status, 'ACTIVE', 'a declined refund leaves the plan as it was');
});

test('admin decline: the reason is kept; only the person who asked can withdraw, and only before the other side agrees', async () => {
  const { c, pid, cust, barber } = await setup();

  const first = await requestPlanBalanceRefund(c.db, pid, cust);
  const declined = await declinePlanBalanceRefundByAdmin(c.db, first.id, null, 'Still in use this month');
  assert.equal(declined.status, 'DECLINED_ADMIN');
  assert.equal((await c.db.one('SELECT decline_reason FROM plan_refund_requests WHERE id=$1', [first.id])).decline_reason, 'Still in use this month');
  await assert.rejects(acceptPlanBalanceRefund(c.db, first.id, barber), (e: any) => e.code === 'NOT_FORWARDED', 'a declined request cannot be agreed');

  const second = await requestPlanBalanceRefund(c.db, pid, cust);
  await forwardPlanBalanceRefund(c.db, second.id, null);
  await assert.rejects(withdrawPlanBalanceRefund(c.db, second.id, barber), (e: any) => e.code === 'NOT_REQUESTER', 'the other side cannot take the request back');
  const w = await withdrawPlanBalanceRefund(c.db, second.id, cust);
  assert.equal(w.status, 'WITHDRAWN');
  assert.equal((await c.db.one('SELECT status FROM plan_purchases WHERE id=$1', [pid])).status, 'ACTIVE', 'a withdrawn request leaves the plan as it was');
});

test('a plan with a booking still on it cannot be refunded', async () => {
  const { c, pid, cust } = await setup();
  const customer = cust.userId;
  await c.db.query(`INSERT INTO bookings (customer_id, barber_id, service_id, scheduled_at, ends_at, service_name, price_kobo, duration_min, status, payment_option, payment_status, plan_purchase_id)
    VALUES ($1,$2,$3, now() + interval '2 days', now() + interval '2 days 30 minutes','Kids',150000,30,'CONFIRMED','ONLINE','PAID',$4)`, [customer, c.barberId, c.serviceIds[0], pid]);
  await assert.rejects(requestPlanBalanceRefund(c.db, pid, cust), (e: any) => e.code === 'UPCOMING_BOOKINGS');
});

test('transfer route: the barber records the transfer; both are reminded every 24 hours; the customer confirms and the case closes', async () => {
  const { c, pid, cust, barber } = await setup();
  try {
    const asked = await requestPlanBalanceRefund(c.db, pid, cust);
    await forwardPlanBalanceRefund(c.db, asked.id, null);
    await acceptPlanBalanceRefund(c.db, asked.id, barber);
    await authorizePlanBalanceRefund(c.db, asked.id, null, 'TRANSFER');
    assert.equal((await c.db.one('SELECT status FROM plan_refund_requests WHERE id=$1', [asked.id])).status, 'TRANSFER_DUE');
    await assert.rejects(recordPlanRefundTransfer(c.db, asked.id, cust, 'REF-1'), (e: any) => e.code === 'NOT_BARBER', 'only the barber records the transfer');
    await assert.rejects(recordPlanRefundTransfer(c.db, asked.id, barber, '   '), (e: any) => e.code === 'VALIDATION_ERROR', 'a reference is needed');

    const t0 = clock.now().getTime();
    const sentRec = await recordPlanRefundTransfer(c.db, asked.id, barber, 'REF-1');
    assert.equal(sentRec.status, 'TRANSFER_SENT');

    clock.setExact(new Date(t0 + 25 * 3600000));
    assert.equal(await sendTransferReminders(c.db), 1, 'after 24 hours both are reminded');
    clock.setExact(new Date(t0 + 26 * 3600000));
    assert.equal(await sendTransferReminders(c.db), 0, 'not again within the same day');
    clock.setExact(new Date(t0 + 50 * 3600000));
    assert.equal(await sendTransferReminders(c.db), 1, 'and again the next day');

    const done = await confirmPlanRefundReceived(c.db, asked.id, cust);
    assert.equal(done.status, 'REFUNDED');
    assert.equal((await c.db.one('SELECT refund_status FROM payments WHERE reference=$1', ['TS-PLAN-REFUND-1'])).refund_status, 'REFUNDED');
    clock.setExact(new Date(t0 + 60 * 24 * 3600000));
    assert.equal(await closeUnconfirmedTransfers(c.db), 0, 'a confirmed case is not closed again');
  } finally { clock.set(null); }
});

test('transfer route: no confirmation after 7 days closes the case by itself', async () => {
  const { c, pid, cust, barber } = await setup();
  try {
    const asked = await requestPlanBalanceRefund(c.db, pid, cust);
    await forwardPlanBalanceRefund(c.db, asked.id, null);
    await acceptPlanBalanceRefund(c.db, asked.id, barber);
    await authorizePlanBalanceRefund(c.db, asked.id, null, 'TRANSFER');
    const t0 = clock.now().getTime();
    await recordPlanRefundTransfer(c.db, asked.id, barber, 'REF-2');
    clock.setExact(new Date(t0 + 6 * 24 * 3600000));
    assert.equal(await closeUnconfirmedTransfers(c.db), 0, 'still inside the 7 days');
    clock.setExact(new Date(t0 + 8 * 24 * 3600000));
    assert.equal(await closeUnconfirmedTransfers(c.db), 1, 'after 7 days it closes itself');
    assert.equal((await c.db.one('SELECT status FROM plan_refund_requests WHERE id=$1', [asked.id])).status, 'CLOSED_UNCONFIRMED');
  } finally { clock.set(null); }
});
