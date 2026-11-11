/**
 * Plan balance refunds. A plan can be cancelled part-way only when the customer AND the barber both agree, and an admin approves it.
 *   1. The customer or the barber asks. Only TrimSlot sees it at first (OPEN): an admin reviews it.
 *   2. The admin forwards it to the other party (FORWARDED), or declines it (DECLINED_ADMIN).
 *   3. The other party accepts (CONFIRMED), or declines (DECLINED_OTHER).
 *   4. An admin authorizes it (PIN). The plan ends and the unused sessions' share is sent back through Paystack.
 * The person who asked can withdraw it at any time before the money is being sent.
 * Amount = unused sessions x (plan price / sessions). Paystack fees and anything already used are not refunded.
 * A plan with any booking still on it cannot be refunded: those bookings are cancelled first, and their sessions go back to the plan.
 */
import { Conn, Db } from './db';
import { conflict, notFound } from './errors';
import { adminEvent } from './adminNotify';
import { Actor, audit, naira, notify } from './helpers';
import { requestRefund } from './paystack';
import { isoNow } from './time';

export interface RefundActor { userId: number; role: 'CUSTOMER' | 'BARBER'; barberId?: number }

interface Purchase {
  id: number; customer_id: number; barber_id: number; plan_name: string; price_kobo: number;
  sessions_total: number; sessions_used: number; status: string; expires_at: string;
}

export function balanceOf(p: Pick<Purchase, 'price_kobo' | 'sessions_total' | 'sessions_used'>) {
  const left = Math.max(0, p.sessions_total - p.sessions_used);
  return { sessions_left: left, amount_kobo: p.sessions_total > 0 ? Math.floor((p.price_kobo * left) / p.sessions_total) : 0 };
}

/** Requests that still block a new one for the same plan. */
const LIVE = ['OPEN', 'FORWARDED', 'CONFIRMED', 'REFUNDING'];
/** The person who asked can withdraw while the money has not started to move. */
const WITHDRAWABLE = ['OPEN', 'FORWARDED', 'CONFIRMED'];

const ownsPurchase = (p: Purchase, a: RefundActor) => (a.role === 'CUSTOMER' ? p.customer_id === a.userId : p.barber_id === a.barberId);
const barberUid = async (c: Conn, barberId: number) => (await c.one<{ user_id: number }>('SELECT user_id FROM barbers WHERE id=$1', [barberId])).user_id;
const who = (role: 'CUSTOMER' | 'BARBER') => (role === 'CUSTOMER' ? 'The customer' : 'The barber');
const other = (role: 'CUSTOMER' | 'BARBER') => (role === 'CUSTOMER' ? 'the barber' : 'the customer');
const otherRole = (role: 'CUSTOMER' | 'BARBER') => (role === 'CUSTOMER' ? 'BARBER' : 'CUSTOMER');
const partyUser = (c: Conn, p: Purchase, role: 'CUSTOMER' | 'BARBER') => (role === 'CUSTOMER' ? Promise.resolve(p.customer_id) : barberUid(c, p.barber_id));
const auditActor = (a: RefundActor): Actor => ({ id: a.userId, role: a.role === 'CUSTOMER' ? 'customer' : 'barber' });

async function lockPurchase(t: Conn, purchaseId: number): Promise<Purchase> {
  const p = await t.maybeOne<Purchase>(`SELECT id, customer_id, barber_id, plan_name, price_kobo, sessions_total, sessions_used, status, expires_at FROM plan_purchases WHERE id=$1 FOR UPDATE`, [purchaseId]);
  if (!p) throw notFound('We could not find that plan.');
  return p;
}

async function lockRequest(t: Conn, requestId: number) {
  const r = await t.maybeOne<any>(`SELECT * FROM plan_refund_requests WHERE id=$1 FOR UPDATE`, [requestId]);
  if (!r) throw notFound('We could not find that refund request.');
  return r;
}

/** Bookings still on this plan. Any of them blocks a balance refund. */
const bookingsOnPlan = async (c: Conn, purchaseId: number) =>
  (await c.one<{ c: number }>(`SELECT COUNT(*)::int c FROM bookings WHERE plan_purchase_id=$1 AND status IN ('CONFIRMED','ARRIVED','IN_SERVICE')`, [purchaseId])).c;

/** Checks that the plan can still be refunded right now. Returns the balance. */
async function assertRefundable(t: Conn, p: Purchase) {
  if (p.status !== 'ACTIVE') throw conflict('NOT_ACTIVE', 'This plan is no longer active.');
  if (new Date(p.expires_at).getTime() <= new Date(isoNow()).getTime()) throw conflict('EXPIRED', 'This plan has already ended, so there is nothing to refund.');
  const bal = balanceOf(p);
  if (bal.amount_kobo <= 0) throw conflict('NOTHING_LEFT', 'All sessions are used, so there is no balance to refund.');
  if ((await bookingsOnPlan(t, p.id)) > 0) throw conflict('UPCOMING_BOOKINGS', 'Cancel this plan\'s bookings first. Their sessions go back to the plan, and then the balance is worked out.');
  return bal;
}

/** Step 1: the customer or the barber asks. Only TrimSlot sees it until an admin forwards it. */
export async function requestPlanBalanceRefund(db: Db, purchaseId: number, a: RefundActor) {
  return db.tx(async (t) => {
    const p = await lockPurchase(t, purchaseId);
    if (!ownsPurchase(p, a)) throw notFound('We could not find that plan.');
    if (await t.maybeOne(`SELECT 1 FROM plan_refund_requests WHERE plan_purchase_id=$1 AND status = ANY($2)`, [p.id, LIVE])) throw conflict('ALREADY_REQUESTED', 'A refund request for this plan is already open.');
    const bal = await assertRefundable(t, p);
    const col = a.role === 'CUSTOMER' ? 'customer_confirmed_at' : 'barber_confirmed_at';
    const row = await t.one<{ id: number }>(`INSERT INTO plan_refund_requests (plan_purchase_id, requested_by, requested_role, amount_kobo, sessions_left, status, ${col})
      VALUES ($1,$2,$3,$4,$5,'OPEN',$6) RETURNING id`, [p.id, a.userId, a.role, bal.amount_kobo, bal.sessions_left, isoNow()]);
    await notify(t, await partyUser(t, p, a.role), 'PLAN_REFUND_REQUEST', 'Plan refund requested',
      `You asked to cancel "${p.plan_name}" and refund the ${bal.sessions_left} unused session${bal.sessions_left === 1 ? '' : 's'} (${naira(bal.amount_kobo)}). TrimSlot checks it first, then sends it to ${other(a.role)}.`);
    await adminEvent(t, 'REFUND_REVIEW', 'A plan refund needs review', `${who(a.role)} asked to cancel "${p.plan_name}" and refund ${naira(bal.amount_kobo)}. Forward it or decline it in Reports.`,
      { link: '/admin.html#/reports', refKey: 'plan-refund-review:' + row.id });
    await audit(t, null, auditActor(a), 'PLAN_REFUND_REQUESTED', { purchase_id: p.id, request_id: row.id, amount_kobo: bal.amount_kobo, sessions_left: bal.sessions_left });
    return { id: row.id, status: 'OPEN', amount_kobo: bal.amount_kobo, sessions_left: bal.sessions_left };
  });
}

/** Step 2a (admin): the request goes to the other party. */
export async function forwardPlanBalanceRefund(db: Db, requestId: number, adminId: number | null) {
  return db.tx(async (t) => {
    const r = await lockRequest(t, requestId);
    if (r.status !== 'OPEN') throw conflict('NOT_OPEN', 'This request has already been reviewed.');
    const p = await lockPurchase(t, r.plan_purchase_id);
    const bal = await assertRefundable(t, p);
    if (bal.amount_kobo !== r.amount_kobo) throw conflict('CHANGED', 'The balance changed since the request. Ask for it again.');
    const now = isoNow();
    await t.query(`UPDATE plan_refund_requests SET status='FORWARDED', forwarded_at=$2, admin_reviewed_at=$2 WHERE id=$1`, [r.id, now]);
    const amount = naira(r.amount_kobo);
    await notify(t, await partyUser(t, p, otherRole(r.requested_role)), 'PLAN_REFUND_FORWARDED', 'Plan refund to agree',
      `TrimSlot asks you to agree to cancel "${p.plan_name}" and refund ${amount} for the unused sessions. Open the plan to accept or decline. Nothing is refunded until you both agree and TrimSlot approves it.`);
    await notify(t, await partyUser(t, p, r.requested_role), 'PLAN_REFUND_FORWARDED', 'Plan refund sent on', `TrimSlot sent your refund request for "${p.plan_name}" to ${other(r.requested_role)}.`);
    await audit(t, null, { id: adminId, role: 'admin' }, 'ADMIN_PLAN_REFUND_FORWARDED', { request_id: r.id, purchase_id: p.id, amount_kobo: r.amount_kobo });
    return { id: r.id, status: 'FORWARDED' };
  });
}

/** Step 2b (admin): the request is declined before it reaches the other party. */
export async function declinePlanBalanceRefundByAdmin(db: Db, requestId: number, adminId: number | null, reason: string) {
  return db.tx(async (t) => {
    const r = await lockRequest(t, requestId);
    if (r.status !== 'OPEN') throw conflict('NOT_OPEN', 'This request has already been reviewed.');
    const p = await lockPurchase(t, r.plan_purchase_id);
    await t.query(`UPDATE plan_refund_requests SET status='DECLINED_ADMIN', decline_reason=$2, admin_reviewed_at=$3, decided_at=$3 WHERE id=$1`, [r.id, reason, isoNow()]);
    await notify(t, await partyUser(t, p, r.requested_role), 'PLAN_REFUND_DECLINED', 'Plan refund not sent on',
      `TrimSlot did not send your refund request for "${p.plan_name}" to ${other(r.requested_role)}. The plan is unchanged.${reason ? ' Reason: ' + reason : ''}`);
    await audit(t, null, { id: adminId, role: 'admin' }, 'ADMIN_PLAN_REFUND_DECLINED', { request_id: r.id, purchase_id: p.id, reason });
    return { id: r.id, status: 'DECLINED_ADMIN' };
  });
}

/** Step 3a: the other party agrees. Both agreed now: the request waits for an admin to authorize it. */
export async function acceptPlanBalanceRefund(db: Db, requestId: number, a: RefundActor) {
  return db.tx(async (t) => {
    const r = await lockRequest(t, requestId);
    const p = await lockPurchase(t, r.plan_purchase_id);
    if (!ownsPurchase(p, a)) throw notFound('We could not find that refund request.');
    if (r.requested_role === a.role) throw conflict('SAME_PARTY', 'The other party has to agree. Both of you must agree.');
    if (r.status !== 'FORWARDED') throw conflict('NOT_FORWARDED', 'This request is not waiting for your answer.');
    const bal = await assertRefundable(t, p);
    if (bal.amount_kobo !== r.amount_kobo) throw conflict('CHANGED', 'The balance changed since the request. Ask for it again.');
    const col = a.role === 'CUSTOMER' ? 'customer_confirmed_at' : 'barber_confirmed_at';
    await t.query(`UPDATE plan_refund_requests SET status='CONFIRMED', ${col}=$2 WHERE id=$1`, [r.id, isoNow()]);
    const amount = naira(r.amount_kobo);
    await notify(t, p.customer_id, 'PLAN_REFUND_AGREED', 'Plan refund agreed', `You and the barber agreed to cancel "${p.plan_name}" and refund ${amount}. TrimSlot will authorize it and send the money back.`);
    await notify(t, await barberUid(t, p.barber_id), 'PLAN_REFUND_AGREED', 'Plan refund agreed', `You and the customer agreed to cancel "${p.plan_name}" and refund ${amount}. TrimSlot will authorize it.`);
    await adminEvent(t, 'REFUND_WAITING', 'A plan refund is ready to authorize', `Customer and barber agreed to cancel "${p.plan_name}" and refund ${amount}. Authorize it in Reports.`,
      { link: '/admin.html#/reports', refKey: 'plan-refund:' + r.id });
    await audit(t, null, auditActor(a), 'PLAN_REFUND_ACCEPTED', { request_id: r.id, purchase_id: p.id, amount_kobo: r.amount_kobo });
    return { id: r.id, status: 'CONFIRMED' };
  });
}

/** Step 3b: the other party says no. The plan is unchanged. */
export async function declinePlanBalanceRefund(db: Db, requestId: number, a: RefundActor, reason: string) {
  return db.tx(async (t) => {
    const r = await lockRequest(t, requestId);
    const p = await lockPurchase(t, r.plan_purchase_id);
    if (!ownsPurchase(p, a)) throw notFound('We could not find that refund request.');
    if (r.requested_role === a.role) throw conflict('SAME_PARTY', 'Only the other party can decline. To take your request back, withdraw it.');
    if (r.status !== 'FORWARDED') throw conflict('NOT_FORWARDED', 'This request is not waiting for your answer.');
    await t.query(`UPDATE plan_refund_requests SET status='DECLINED_OTHER', decline_reason=$2, decided_at=$3 WHERE id=$1`, [r.id, reason, isoNow()]);
    await notify(t, await partyUser(t, p, r.requested_role), 'PLAN_REFUND_DECLINED', 'Plan refund declined',
      `${who(a.role)} did not agree to cancel "${p.plan_name}". Nothing was refunded and the plan is unchanged.${reason ? ' Reason: ' + reason : ''}`);
    await audit(t, null, auditActor(a), 'PLAN_REFUND_DECLINED', { request_id: r.id, purchase_id: p.id, reason });
    return { id: r.id, status: 'DECLINED_OTHER' };
  });
}

/** The person who asked takes the request back, until the money is being sent. */
export async function withdrawPlanBalanceRefund(db: Db, requestId: number, a: RefundActor) {
  return db.tx(async (t) => {
    const r = await lockRequest(t, requestId);
    const p = await lockPurchase(t, r.plan_purchase_id);
    if (!ownsPurchase(p, a)) throw notFound('We could not find that refund request.');
    if (r.requested_role !== a.role) throw conflict('NOT_REQUESTER', 'Only the person who asked can withdraw this request. You can decline it instead.');
    if (!WITHDRAWABLE.includes(r.status)) throw conflict('NOT_WITHDRAWABLE', 'This refund is already being sent, so it cannot be withdrawn.');
    await t.query(`UPDATE plan_refund_requests SET status='WITHDRAWN', decided_at=$2 WHERE id=$1`, [r.id, isoNow()]);
    if (r.status !== 'OPEN') await notify(t, await partyUser(t, p, otherRole(a.role)), 'PLAN_REFUND_WITHDRAWN', 'Plan refund withdrawn', `The refund request for "${p.plan_name}" was withdrawn. The plan is unchanged.`);
    await audit(t, null, auditActor(a), 'PLAN_REFUND_WITHDRAWN', { request_id: r.id });
    return { id: r.id, status: 'WITHDRAWN' };
  });
}

/** Step 4: admin authorizes a request both parties agreed to (the route checks the PIN). The plan ends and the balance is sent back. */
export async function authorizePlanBalanceRefund(db: Db, requestId: number, adminId: number | null) {
  const sent = await db.tx(async (t) => {
    const r = await lockRequest(t, requestId);
    if (r.status !== 'CONFIRMED') throw conflict('NOT_CONFIRMED', 'Both the customer and the barber must agree first.');
    const p = await lockPurchase(t, r.plan_purchase_id);
    const bal = await assertRefundable(t, p);
    if (bal.amount_kobo !== r.amount_kobo) throw conflict('CHANGED', 'The balance changed since they agreed. Ask them to withdraw and request again.');
    const pay = await t.maybeOne<{ reference: string; amount_kobo: number; refund_status: string | null }>(`SELECT reference, amount_kobo, refund_status FROM payments WHERE plan_purchase_id=$1 AND status='SUCCESS' ORDER BY id DESC LIMIT 1 FOR UPDATE`, [p.id]);
    if (!pay) throw conflict('NO_PAYMENT', 'We cannot find the payment for this plan, so nothing can be sent here. Check Payments.');
    if (pay.refund_status) throw conflict('REFUND_ALREADY', `This payment already has a refund (${pay.refund_status.toLowerCase().replace('_', ' ')}).`);
    if (r.amount_kobo > pay.amount_kobo) throw conflict('OVER_PAYMENT', 'The balance is more than the amount paid, so it cannot be sent. Check Payments.');
    await t.query(`UPDATE plan_purchases SET status='CANCELLED' WHERE id=$1`, [p.id]);
    // NEEDS_REFUND + the amount: requestRefund then sends only this balance (and keeps the claim safe against a double send)
    await t.query(`UPDATE payments SET refund_status='NEEDS_REFUND', refund_reason=$2, refund_amount_kobo=$3 WHERE reference=$1`, [pay.reference, 'plan balance refund: request #' + r.id, r.amount_kobo]);
    await t.query(`UPDATE plan_refund_requests SET status='REFUNDING', decided_at=$2 WHERE id=$1`, [r.id, isoNow()]);
    const amount = naira(r.amount_kobo);
    await notify(t, p.customer_id, 'PLAN_CANCELLED', 'Plan cancelled and refunded', `"${p.plan_name}" is cancelled. We are sending ${amount} back for your unused sessions. Paystack fees are not refunded.`);
    await notify(t, await barberUid(t, p.barber_id), 'PLAN_CANCELLED', 'Plan cancelled', `"${p.plan_name}" is cancelled by agreement. The unused sessions (${amount}) are refunded to the customer.`);
    await audit(t, null, { id: adminId, role: 'admin' }, 'ADMIN_PLAN_BALANCE_AUTHORIZED', { request_id: r.id, purchase_id: p.id, amount_kobo: r.amount_kobo, reference: pay.reference });
    return { reference: pay.reference, amount_kobo: r.amount_kobo };
  });
  // outside the transaction: the Paystack call. A failure leaves the payment NEEDS_REFUND for Payments to retry (same amount).
  const result = await requestRefund(db, sent.reference);
  if (result === 'requested') await db.query(`UPDATE plan_refund_requests SET status='REFUNDED' WHERE id=$1`, [requestId]);
  return { refund: result, amount_kobo: sent.amount_kobo };
}

/** Requests for the admin list, by status. */
export async function listPlanBalanceRefunds(db: Db, status: string) {
  return db.many(`SELECT r.id, r.status, r.requested_role, r.amount_kobo, r.sessions_left, r.customer_confirmed_at, r.barber_confirmed_at, r.created_at, r.refund_error,
      pp.id AS purchase_id, pp.plan_name, pp.sessions_total, pp.sessions_used, pp.price_kobo, u.name AS customer_name, b.shop_name
    FROM plan_refund_requests r JOIN plan_purchases pp ON pp.id=r.plan_purchase_id JOIN users u ON u.id=pp.customer_id JOIN barbers b ON b.id=pp.barber_id
    WHERE r.status = $1 ORDER BY r.id DESC LIMIT 200`, [status]);
}

/** For the customer's wallet and the barber's plan list: the balance, the blocking bookings and the live request of each plan. */
export async function refundStatesFor(c: Conn, purchaseIds: number[]) {
  const out = new Map<number, { balance_kobo: number; upcoming: number; refund_request: any | null }>();
  if (!purchaseIds.length) return out;
  const purchases = await c.many<Purchase>(`SELECT id, customer_id, barber_id, plan_name, price_kobo, sessions_total, sessions_used, status, expires_at FROM plan_purchases WHERE id = ANY($1)`, [purchaseIds]);
  const counts = await c.many<{ plan_purchase_id: number; c: number }>(`SELECT plan_purchase_id, COUNT(*)::int c FROM bookings WHERE plan_purchase_id = ANY($1) AND status IN ('CONFIRMED','ARRIVED','IN_SERVICE') GROUP BY plan_purchase_id`, [purchaseIds]);
  const reqs = await c.many<any>(`SELECT id, plan_purchase_id, status, requested_role, amount_kobo, customer_confirmed_at, barber_confirmed_at FROM plan_refund_requests WHERE plan_purchase_id = ANY($1) AND status = ANY($2)`, [purchaseIds, LIVE]);
  for (const p of purchases) {
    out.set(p.id, {
      balance_kobo: balanceOf(p).amount_kobo,
      upcoming: counts.find((x) => x.plan_purchase_id === p.id)?.c ?? 0,
      refund_request: reqs.find((x) => x.plan_purchase_id === p.id) ?? null,
    });
  }
  return out;
}
