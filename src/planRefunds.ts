/**
 * Plan balance refunds. Rules as agreed in Nov 2026.
 *   1. The customer or the barber asks (OPEN). The admin reviews it first.
 *   2. The admin declines it (DECLINED_ADMIN, with the reason and what to do next), or forwards it to the other side (FORWARDED).
 *   3. The other side agrees (CONFIRMED): the request locks, nobody can withdraw it. Or the other side declines (OTHER_DECLINED): the admin reviews the reason.
 *   4. After an other-side decline, the admin closes it with feedback (DECLINED_OTHER). The requester sees why and can ask again once it is sorted.
 *   5. The admin confirms (authorize) and picks the route. The plan ends and the balance is refunded in full. The barber's share is their cost:
 *        PAYSTACK:  Paystack refunds the balance (REFUNDING). The barber owes the same amount on their ledger. Closed when Paystack confirms (refund.processed).
 *        TRANSFER:  the barber sends the money and records it (TRANSFER_SENT). The customer confirms receipt (REFUNDED). Both get a reminder after 24 hours and every day after that.
 *                   If there is no confirmation after 7 days, the case closes itself (CLOSED_UNCONFIRMED) and the admin is told.
 * Amount = unused sessions x (plan price / sessions), rounded down. Paystack fees and used sessions are not refunded.
 * Open bookings on the plan block the refund until they are cancelled (their sessions go back to the plan).
 */
import { Conn, Db } from './db';
import { conflict, notFound, badRequest } from './errors';
import { adminEvent } from './adminNotify';
import { addAdjustment } from './ledger';
import { audit, naira, notify, Actor } from './helpers';
import { requestRefund } from './paystack';
import { isoNow } from './time';

export interface RefundActor { userId: number; role: 'CUSTOMER' | 'BARBER'; barberId?: number }
export type RefundRoute = 'PAYSTACK' | 'TRANSFER';

interface Purchase {
  id: number; customer_id: number; barber_id: number; plan_name: string; price_kobo: number;
  sessions_total: number; sessions_used: number; status: string; expires_at: string;
}

export function balanceOf(p: Pick<Purchase, 'price_kobo' | 'sessions_total' | 'sessions_used'>) {
  const left = Math.max(0, p.sessions_total - p.sessions_used);
  return { sessions_left: left, amount_kobo: p.sessions_total > 0 ? Math.floor((p.price_kobo * left) / p.sessions_total) : 0 };
}

/** Requests that are still going. Each one blocks a new request for the same plan, blocks new bookings on the plan, and blocks account deletion. */
export const LIVE = ['OPEN', 'FORWARDED', 'OTHER_DECLINED', 'CONFIRMED', 'REFUNDING', 'TRANSFER_DUE', 'TRANSFER_SENT'];
/** The requester can withdraw only until the other side agrees. */
const WITHDRAWABLE = ['OPEN', 'FORWARDED'];
const TRANSFER_REMIND_HOURS = 24;
const TRANSFER_CLOSE_DAYS = 7;

const ownsPurchase = (p: Purchase, a: RefundActor) => (a.role === 'CUSTOMER' ? p.customer_id === a.userId : p.barber_id === a.barberId);
const barberUid = async (c: Conn, barberId: number) => (await c.one<{ user_id: number }>('SELECT user_id FROM barbers WHERE id=$1', [barberId])).user_id;
const who = (role: 'CUSTOMER' | 'BARBER') => (role === 'CUSTOMER' ? 'The customer' : 'The barber');
const other = (role: 'CUSTOMER' | 'BARBER') => (role === 'CUSTOMER' ? 'the barber' : 'the customer');
const otherRole = (role: 'CUSTOMER' | 'BARBER') => (role === 'CUSTOMER' ? 'BARBER' : 'CUSTOMER');
const partyUser = (c: Conn, p: Purchase, role: 'CUSTOMER' | 'BARBER') => (role === 'CUSTOMER' ? Promise.resolve(p.customer_id) : barberUid(c, p.barber_id));
const auditActor = (a: RefundActor): Actor => ({ id: a.userId, role: a.role === 'CUSTOMER' ? 'customer' : 'barber' });
const adminActor = (adminId: number | null): Actor => ({ id: adminId, role: 'admin' });

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

/** Bookings still open on this plan. Any of them blocks a balance refund. */
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

/** Step 2a (admin): the request goes to the other side. */
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
    await audit(t, null, adminActor(adminId), 'ADMIN_PLAN_REFUND_FORWARDED', { request_id: r.id, purchase_id: p.id, amount_kobo: r.amount_kobo });
    return { id: r.id, status: 'FORWARDED' };
  });
}

/** Step 2b (admin): declined before it reaches the other side. The reason and what to do next go to the requester. */
export async function declinePlanBalanceRefundByAdmin(db: Db, requestId: number, adminId: number | null, reason: string) {
  return db.tx(async (t) => {
    const r = await lockRequest(t, requestId);
    if (r.status !== 'OPEN') throw conflict('NOT_OPEN', 'This request has already been reviewed.');
    const p = await lockPurchase(t, r.plan_purchase_id);
    await t.query(`UPDATE plan_refund_requests SET status='DECLINED_ADMIN', decline_reason=$2, admin_reviewed_at=$3, decided_at=$3 WHERE id=$1`, [r.id, reason, isoNow()]);
    await notify(t, await partyUser(t, p, r.requested_role), 'PLAN_REFUND_DECLINED', 'Plan refund not sent on',
      `TrimSlot did not send your refund request for "${p.plan_name}". The plan is unchanged. Reason: ${reason}. Fix this, then you can ask again.`);
    await audit(t, null, adminActor(adminId), 'ADMIN_PLAN_REFUND_DECLINED', { request_id: r.id, purchase_id: p.id, reason });
    return { id: r.id, status: 'DECLINED_ADMIN' };
  });
}

/** Step 3a: the other side agrees. The request locks: it can no longer be withdrawn. Only an admin can take it on from here. */
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
    await notify(t, p.customer_id, 'PLAN_REFUND_AGREED', 'Plan refund agreed', `You and the barber agreed to cancel "${p.plan_name}" and refund ${amount}. The request is locked now. TrimSlot will confirm it and send the money back.`);
    await notify(t, await barberUid(t, p.barber_id), 'PLAN_REFUND_AGREED', 'Plan refund agreed', `You and the customer agreed to cancel "${p.plan_name}" and refund ${amount}. The request is locked now. TrimSlot will confirm it.`);
    await adminEvent(t, 'REFUND_WAITING', 'A plan refund is ready to confirm', `Customer and barber agreed to cancel "${p.plan_name}" and refund ${amount}. Confirm it in Reports and choose how it is paid.`,
      { link: '/admin.html#/reports', refKey: 'plan-refund:' + r.id });
    await audit(t, null, auditActor(a), 'PLAN_REFUND_ACCEPTED', { request_id: r.id, purchase_id: p.id, amount_kobo: r.amount_kobo });
    return { id: r.id, status: 'CONFIRMED' };
  });
}

/** Step 3b: the other side says no. The admin reviews the reason before the requester hears back. */
export async function declinePlanBalanceRefund(db: Db, requestId: number, a: RefundActor, reason: string) {
  return db.tx(async (t) => {
    const r = await lockRequest(t, requestId);
    const p = await lockPurchase(t, r.plan_purchase_id);
    if (!ownsPurchase(p, a)) throw notFound('We could not find that refund request.');
    if (r.requested_role === a.role) throw conflict('SAME_PARTY', 'Only the other party can decline. To take your request back, withdraw it.');
    if (r.status !== 'FORWARDED') throw conflict('NOT_FORWARDED', 'This request is not waiting for your answer.');
    if (!reason.trim()) throw badRequest('Tell us why you are declining.');
    await t.query(`UPDATE plan_refund_requests SET status='OTHER_DECLINED', decline_reason=$2, admin_reviewed_at=NULL WHERE id=$1`, [r.id, reason.trim()]);
    await notify(t, await partyUser(t, p, r.requested_role), 'PLAN_REFUND_DECLINED', 'Plan refund not agreed yet',
      `${who(a.role)} did not agree to cancel "${p.plan_name}" yet. TrimSlot is reviewing the reason and will tell you what to do next.`);
    await adminEvent(t, 'REFUND_REVIEW', 'A plan refund was declined by the other side', `${who(a.role)} declined the refund for "${p.plan_name}". Reason: ${reason.trim()}. Send the feedback to the customer in Reports.`,
      { link: '/admin.html#/reports', refKey: 'plan-refund-review:' + r.id });
    await audit(t, null, auditActor(a), 'PLAN_REFUND_OTHER_DECLINED', { request_id: r.id, purchase_id: p.id, reason: reason.trim() });
    return { id: r.id, status: 'OTHER_DECLINED' };
  });
}

/** Step 3c (admin): close a request the other side declined, with feedback that goes to the requester. They can ask again once it is sorted. */
export async function closeDeclinedPlanBalanceRefund(db: Db, requestId: number, adminId: number | null, feedback: string) {
  return db.tx(async (t) => {
    const r = await lockRequest(t, requestId);
    if (r.status !== 'OTHER_DECLINED') throw conflict('NOT_OTHER_DECLINED', 'This request is not waiting for a review of a decline.');
    const p = await lockPurchase(t, r.plan_purchase_id);
    await t.query(`UPDATE plan_refund_requests SET status='DECLINED_OTHER', admin_reviewed_at=$2, decided_at=$2, close_reason=$3 WHERE id=$1`, [r.id, isoNow(), feedback]);
    await notify(t, await partyUser(t, p, r.requested_role), 'PLAN_REFUND_DECLINED', 'Plan refund not sent on',
      `The refund for "${p.plan_name}" did not go ahead. Reason: ${r.decline_reason}. TrimSlot says: ${feedback}. Sort this out, then you can ask again.`);
    await audit(t, null, adminActor(adminId), 'ADMIN_PLAN_REFUND_OTHER_DECLINED_CLOSED', { request_id: r.id, purchase_id: p.id, feedback });
    return { id: r.id, status: 'DECLINED_OTHER' };
  });
}

/** The person who asked takes the request back. Only until the other side agrees. */
export async function withdrawPlanBalanceRefund(db: Db, requestId: number, a: RefundActor) {
  return db.tx(async (t) => {
    const r = await lockRequest(t, requestId);
    const p = await lockPurchase(t, r.plan_purchase_id);
    if (!ownsPurchase(p, a)) throw notFound('We could not find that refund request.');
    if (r.requested_role !== a.role) throw conflict('NOT_REQUESTER', 'Only the person who asked can withdraw this request. You can decline it instead.');
    if (!WITHDRAWABLE.includes(r.status)) throw conflict('NOT_WITHDRAWABLE', 'The other side has already agreed, so this request is locked and cannot be withdrawn.');
    await t.query(`UPDATE plan_refund_requests SET status='WITHDRAWN', decided_at=$2 WHERE id=$1`, [r.id, isoNow()]);
    if (r.status !== 'OPEN') await notify(t, await partyUser(t, p, otherRole(a.role)), 'PLAN_REFUND_WITHDRAWN', 'Plan refund withdrawn', `The refund request for "${p.plan_name}" was withdrawn. The plan is unchanged.`);
    await audit(t, null, auditActor(a), 'PLAN_REFUND_WITHDRAWN', { request_id: r.id });
    return { id: r.id, status: 'WITHDRAWN' };
  });
}

/**
 * Step 4 (admin, PIN checked by the route): both sides agreed. The plan ends and the balance is refunded in full.
 * PAYSTACK: Paystack sends it; the barber owes the same amount on their ledger. TRANSFER: the barber sends it and records it.
 */
export async function authorizePlanBalanceRefund(db: Db, requestId: number, adminId: number | null, route: RefundRoute = 'PAYSTACK') {
  if (route !== 'PAYSTACK' && route !== 'TRANSFER') throw badRequest('Choose how the money is sent: PAYSTACK or TRANSFER.');
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
    const amount = naira(r.amount_kobo);
    await t.query(`UPDATE plan_purchases SET status='CANCELLED' WHERE id=$1`, [p.id]);
    await t.query(`UPDATE plan_refund_requests SET refund_method=$2, status=$3, decided_at=$4 WHERE id=$1`, [r.id, route, route === 'PAYSTACK' ? 'REFUNDING' : 'TRANSFER_DUE', isoNow()]);
    if (route === 'PAYSTACK') {
      // Paystack sends the money. Nothing is closed until Paystack confirms (refund.processed). The barber pays TrimSlot back through the ledger.
      await t.query(`UPDATE payments SET refund_status='NEEDS_REFUND', refund_reason=$2, refund_amount_kobo=$3 WHERE reference=$1`, [pay.reference, 'plan balance refund: request #' + r.id, r.amount_kobo]);
      await addAdjustment(t, p.barber_id, r.amount_kobo, `Plan refund for "${p.plan_name}" (request #${r.id}), paid back by Paystack`);
      await notify(t, p.customer_id, 'PLAN_CANCELLED', 'Plan cancelled and refunded', `"${p.plan_name}" is cancelled. We are sending ${amount} back for your unused sessions. Paystack fees are not refunded.`);
      await notify(t, await barberUid(t, p.barber_id), 'PLAN_CANCELLED', 'Plan cancelled', `"${p.plan_name}" is cancelled by agreement. The unused sessions (${amount}) are refunded to the customer, and we take that amount from your payouts.`);
    } else {
      await t.query(`UPDATE payments SET refund_amount_kobo=$2 WHERE reference=$1`, [pay.reference, r.amount_kobo]);
      await notify(t, p.customer_id, 'PLAN_CANCELLED', 'Plan cancelled. Your refund is coming.', `"${p.plan_name}" is cancelled. The barber will send you ${amount} for your unused sessions. Confirm in the app when it arrives.`);
      await notify(t, await barberUid(t, p.barber_id), 'PLAN_CANCELLED', 'Send the refund', `"${p.plan_name}" is cancelled by agreement. Send ${amount} to the customer, then record the transfer in TrimSlot with its reference.`);
    }
    await audit(t, null, adminActor(adminId), 'ADMIN_PLAN_BALANCE_AUTHORIZED', { request_id: r.id, purchase_id: p.id, amount_kobo: r.amount_kobo, reference: pay.reference, route });
    return { reference: pay.reference, amount_kobo: r.amount_kobo, route };
  });
  if (sent.route === 'TRANSFER') return { refund: 'transfer_due' as const, amount_kobo: sent.amount_kobo };
  // Outside the transaction: the Paystack call. A failure leaves it REFUNDING with refund_error set, and the admin sees it.
  const result = await requestRefund(db, sent.reference);
  if (result !== 'requested') await db.query(`UPDATE plan_refund_requests SET refund_error=$2 WHERE id=$1`, [requestId, 'Paystack did not accept the refund. Try again from Payments.']);
  return { refund: result, amount_kobo: sent.amount_kobo };
}

/** Transfer route: the barber records the transfer they made. The customer is asked to confirm when it arrives. */
export async function recordPlanRefundTransfer(db: Db, requestId: number, a: RefundActor, reference: string) {
  if (a.role !== 'BARBER') throw conflict('NOT_BARBER', 'Only the barber can record the transfer.');
  const ref = reference.trim();
  if (!ref) throw badRequest('Enter the transfer reference from your bank.');
  return db.tx(async (t) => {
    const r = await lockRequest(t, requestId);
    const p = await lockPurchase(t, r.plan_purchase_id);
    if (!ownsPurchase(p, a)) throw notFound('We could not find that refund request.');
    if (r.status !== 'TRANSFER_DUE') throw conflict('NOT_TRANSFER_DUE', 'There is no transfer to record for this refund.');
    const now = isoNow();
    await t.query(`UPDATE plan_refund_requests SET status='TRANSFER_SENT', transfer_reference=$2, transfer_amount_kobo=$3, transfer_recorded_at=$4, last_reminder_at=$4 WHERE id=$1`, [r.id, ref, r.amount_kobo, now]);
    await notify(t, p.customer_id, 'PLAN_REFUND_TRANSFER', 'Refund sent. Did it arrive?', `The barber sent ${naira(r.amount_kobo)} for "${p.plan_name}" (reference ${ref}). Confirm in the app when you receive it.`);
    await notify(t, await barberUid(t, p.barber_id), 'PLAN_REFUND_TRANSFER', 'Transfer recorded', `We told the customer about the ${naira(r.amount_kobo)} transfer. We will remind them until they confirm.`);
    await audit(t, null, auditActor(a), 'PLAN_REFUND_TRANSFER_RECORDED', { request_id: r.id, reference: ref, amount_kobo: r.amount_kobo });
    return { id: r.id, status: 'TRANSFER_SENT' };
  });
}

/** Transfer route: the customer confirms the money arrived. The case closes. */
export async function confirmPlanRefundReceived(db: Db, requestId: number, a: RefundActor) {
  if (a.role !== 'CUSTOMER') throw conflict('NOT_CUSTOMER', 'Only the customer confirms receipt.');
  return db.tx(async (t) => {
    const r = await lockRequest(t, requestId);
    const p = await lockPurchase(t, r.plan_purchase_id);
    if (!ownsPurchase(p, a)) throw notFound('We could not find that refund request.');
    if (r.status !== 'TRANSFER_SENT') throw conflict('NOT_SENT', 'There is no transfer waiting for you to confirm.');
    await t.query(`UPDATE plan_refund_requests SET status='REFUNDED', customer_received_at=$2, closed_at=$2 WHERE id=$1`, [r.id, isoNow()]);
    await t.query(`UPDATE payments SET refund_status='REFUNDED', refund_error=NULL WHERE reference=(SELECT reference FROM payments WHERE plan_purchase_id=$1 AND status='SUCCESS' ORDER BY id DESC LIMIT 1)`, [p.id]);
    await notify(t, await barberUid(t, p.barber_id), 'PLAN_REFUND_DONE', 'Refund confirmed', `The customer confirmed the ${naira(r.amount_kobo)} refund for "${p.plan_name}". This is closed.`);
    await notify(t, p.customer_id, 'PLAN_REFUND_DONE', 'Refund confirmed', `Thank you. The ${naira(r.amount_kobo)} refund for "${p.plan_name}" is closed.`);
    await adminEvent(t, 'PLAN_REFUND_CLOSED', 'A plan refund was confirmed and closed', `The customer confirmed receiving ${naira(r.amount_kobo)} for "${p.plan_name}".`, { link: '/admin.html#/reports', refKey: 'plan-refund-closed:' + r.id });
    await audit(t, null, auditActor(a), 'PLAN_REFUND_RECEIPT_CONFIRMED', { request_id: r.id, amount_kobo: r.amount_kobo });
    return { id: r.id, status: 'REFUNDED' };
  });
}

/** Sweep: remind the customer and the barber every 24 hours until the customer confirms or the 7 days run out. */
export async function sendTransferReminders(db: Db): Promise<number> {
  const now = clockNow();
  const due = await db.many<{ id: number; customer_id: number; barber_id: number; plan_name: string; transfer_amount_kobo: number; transfer_reference: string }>(
    `SELECT r.id, pp.customer_id, pp.barber_id, pp.plan_name, r.transfer_amount_kobo, r.transfer_reference FROM plan_refund_requests r JOIN plan_purchases pp ON pp.id = r.plan_purchase_id
      WHERE r.status='TRANSFER_SENT' AND r.transfer_recorded_at > $1 AND (r.last_reminder_at IS NULL OR r.last_reminder_at <= $2)`,
    [new Date(now - TRANSFER_CLOSE_DAYS * 86400000).toISOString(), new Date(now - TRANSFER_REMIND_HOURS * 3600000).toISOString()]);
  for (const d of due) {
    await db.tx(async (t) => {
      const uid = await barberUid(t, d.barber_id);
      const amt = naira(d.transfer_amount_kobo);
      await notify(t, d.customer_id, 'PLAN_REFUND_REMINDER', 'Did the refund arrive?', `Reminder: the barber sent ${amt} for "${d.plan_name}" (reference ${d.transfer_reference}). Please confirm in the app.`);
      await notify(t, uid, 'PLAN_REFUND_REMINDER', 'Reminder: waiting for the customer', `We have asked the customer to confirm the ${amt} for "${d.plan_name}". We will keep reminding them until they confirm.`);
      await t.query(`UPDATE plan_refund_requests SET last_reminder_at=$2 WHERE id=$1`, [d.id, isoNow()]);
    });
  }
  return due.length;
}

/** Sweep: after 7 days with no confirmation, the case closes by itself and the admin is told. */
export async function closeUnconfirmedTransfers(db: Db): Promise<number> {
  const now = clockNow();
  const stale = await db.many<{ id: number }>(`SELECT id FROM plan_refund_requests WHERE status='TRANSFER_SENT' AND transfer_recorded_at <= $1`, [new Date(now - TRANSFER_CLOSE_DAYS * 86400000).toISOString()]);
  for (const s of stale) {
    await db.tx(async (t) => {
      const r = await lockRequest(t, s.id);
      if (r.status !== 'TRANSFER_SENT') return;
      const p = await lockPurchase(t, r.plan_purchase_id);
      const now2 = isoNow();
      await t.query(`UPDATE plan_refund_requests SET status='CLOSED_UNCONFIRMED', closed_at=$2, close_reason='Customer did not confirm within 7 days' WHERE id=$1`, [r.id, now2]);
      await notify(t, p.customer_id, 'PLAN_REFUND_CLOSED', 'Refund case closed', `The refund for "${p.plan_name}" was closed because we did not get a confirmation within 7 days. If you still have not received it, contact TrimSlot.`);
      await notify(t, await barberUid(t, p.barber_id), 'PLAN_REFUND_CLOSED', 'Refund case closed', `The refund for "${p.plan_name}" was closed without the customer's confirmation after 7 days.`);
      await adminEvent(t, 'PLAN_REFUND_CLOSED', 'A plan refund closed without confirmation', `The customer did not confirm the transfer for "${p.plan_name}" within 7 days, so the case closed by itself.`, { link: '/admin.html#/reports', refKey: 'plan-refund-closed:' + r.id });
      await audit(t, null, { id: null, role: 'system' }, 'PLAN_REFUND_CLOSED_UNCONFIRMED', { request_id: r.id });
    });
  }
  return stale.length;
}

/** Paystack confirmed the refund (refund.processed): the plan refund closes. Returns the request id or null. */
export async function paystackRefundProcessed(db: Db, reference: string): Promise<number | null> {
  return db.tx(async (t) => {
    const pay = await t.maybeOne<{ plan_purchase_id: number | null }>(`SELECT plan_purchase_id FROM payments WHERE reference=$1 FOR UPDATE`, [reference]);
    if (!pay?.plan_purchase_id) return null;
    const r = await t.maybeOne<any>(`SELECT * FROM plan_refund_requests WHERE plan_purchase_id=$1 AND status='REFUNDING' FOR UPDATE`, [pay.plan_purchase_id]);
    if (!r) return null;
    const p = await lockPurchase(t, r.plan_purchase_id);
    await t.query(`UPDATE plan_refund_requests SET status='REFUNDED', closed_at=$2, refund_error=NULL WHERE id=$1`, [r.id, isoNow()]);
    await t.query(`UPDATE payments SET refund_status='REFUNDED', refund_error=NULL WHERE reference=$1`, [reference]);
    await notify(t, p.customer_id, 'PLAN_REFUND_DONE', 'Refund sent', `Paystack sent ${naira(r.amount_kobo)} back for "${p.plan_name}". Your bank may take a few working days to show it.`);
    await notify(t, await barberUid(t, p.barber_id), 'PLAN_REFUND_DONE', 'Refund sent', `Paystack sent ${naira(r.amount_kobo)} back to the customer for "${p.plan_name}". It is added to what you owe TrimSlot.`);
    await audit(t, null, { id: null, role: 'system' }, 'PLAN_REFUND_PAYSTACK_PROCESSED', { request_id: r.id, reference });
    return r.id;
  });
}

/** Paystack could not send the refund (refund.failed): the admin is told and can retry from Payments. */
export async function paystackRefundFailed(db: Db, reference: string, message: string): Promise<number | null> {
  return db.tx(async (t) => {
    const pay = await t.maybeOne<{ plan_purchase_id: number | null }>(`SELECT plan_purchase_id FROM payments WHERE reference=$1 FOR UPDATE`, [reference]);
    if (!pay?.plan_purchase_id) return null;
    const r = await t.maybeOne<any>(`SELECT * FROM plan_refund_requests WHERE plan_purchase_id=$1 AND status='REFUNDING' FOR UPDATE`, [pay.plan_purchase_id]);
    if (!r) return null;
    await t.query(`UPDATE plan_refund_requests SET refund_error=$2 WHERE id=$1`, [r.id, message.slice(0, 300)]);
    await adminEvent(t, 'REFUND_FAILED', 'A plan refund failed', `Paystack could not send the plan refund (request #${r.id}). It is still open. Retry it from Payments.`, { link: '/admin.html#/payments', refKey: 'plan-refund-failed:' + r.id });
    await audit(t, null, { id: null, role: 'system' }, 'PLAN_REFUND_PAYSTACK_FAILED', { request_id: r.id, reference, message });
    return r.id;
  });
}

const clockNow = () => new Date(isoNow()).getTime();

/** Requests for the admin list, by status. */
export async function listPlanBalanceRefunds(db: Db, status: string) {
  return db.many(`SELECT r.id, r.status, r.requested_role, r.amount_kobo, r.sessions_left, r.customer_confirmed_at, r.barber_confirmed_at, r.created_at, r.refund_error, r.decline_reason, r.refund_method, r.transfer_reference, r.transfer_recorded_at,
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
  const reqs = await c.many<any>(`SELECT id, plan_purchase_id, status, requested_role, amount_kobo, customer_confirmed_at, barber_confirmed_at, decline_reason, refund_method, transfer_reference FROM plan_refund_requests WHERE plan_purchase_id = ANY($1) AND status = ANY($2)`, [purchaseIds, LIVE]);
  for (const p of purchases) {
    out.set(p.id, {
      balance_kobo: balanceOf(p).amount_kobo,
      upcoming: counts.find((x) => x.plan_purchase_id === p.id)?.c ?? 0,
      refund_request: reqs.find((x) => x.plan_purchase_id === p.id) ?? null,
    });
  }
  return out;
}
