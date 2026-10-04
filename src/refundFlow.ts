/** Refund-vs-credit rules (one outcome per booking, never both):
 *   - a PREPAID (paid online) booking cancelled in time (or one the barber could not serve) gets a REFUND, never a credit;
 *   - a missed / no-show paid booking gets a CREDIT (see issueCredit), never a refund.
 *  A refund starts as PENDING_APPROVAL. The admin approves or rejects it; if nobody decides within `refund_auto_approve_hours` the sweeper
 *  auto-approves it and asks Paystack for the refund. Admin alerts: waiting / auto-approved / failed (see adminNotify.ts). */
import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { Conn, Db } from './db';
import { requirePin } from './adminPin';
import { adminEvent, flushAdminPush } from './adminNotify';
import { badRequest, conflict, notFound } from './errors';
import { audit, fmtWhen, naira, notify } from './helpers';
import { requestRefund } from './paystack';
import { getSettings } from './plans';
import { clock, isoNow } from './time';

type H = (req: Request, res: Response) => Promise<any>;
const ADMIN = { id: null as number | null, role: 'admin' as const };
const SYSTEM = { id: null as number | null, role: 'system' as const };

/** Put the refund of a booking's online payment into the approval queue. Runs inside the caller's transaction (the booking row is already locked). */
export async function openRefundRequest(t: Conn, b: { id: number; customer_id: number; service_name: string; price_kobo: number; booking_fee_kobo?: number; date: string; start_min: number }, reason: string): Promise<{ reference: string | null; due_at: string; hours: number }> {
  const s = await getSettings(t);
  const due = new Date(clock.now().getTime() + s.refund_auto_approve_hours * 3600000).toISOString();
  const p = await t.maybeOne<any>(`SELECT reference, refund_status FROM payments WHERE booking_id=$1 AND status='SUCCESS' ORDER BY id DESC LIMIT 1 FOR UPDATE`, [b.id]);
  if (p && !p.refund_status) await t.query(`UPDATE payments SET refund_status='PENDING_APPROVAL', refund_reason=$2, refund_due_at=$3 WHERE reference=$1`, [p.reference, reason.slice(0, 200), due]);
  await adminEvent(t, 'REFUND_WAITING', 'Refund waiting for approval', `${naira(b.price_kobo + (b.booking_fee_kobo || 0))} for ${b.service_name} on ${fmtWhen(b.date, b.start_min)} (${reason}). It auto-approves in ${s.refund_auto_approve_hours} h if nobody decides.`,
    { link: '/admin.html#/decisions', refKey: 'booking:' + b.id });
  return { reference: p?.reference ?? null, due_at: due, hours: s.refund_auto_approve_hours };
}

export type RefundDecision = { result: 'approved' | 'rejected'; refund?: 'requested' | 'failed' | 'not_needed' };

/** Approve (admin, or `auto` from the sweeper) or reject a pending refund. Exactly-once: the booking row lock + status check make a second call a 409. */
export async function decideRefund(db: Db, bookingId: number, action: 'approve' | 'reject', by: 'admin' | 'auto', reason?: string): Promise<RefundDecision> {
  let ref: string | null = null;
  const out = await db.tx(async (t) => {
    const b = await t.maybeOne<any>('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [bookingId]);
    if (!b) throw notFound('Booking not found');
    if (b.payment_status !== 'REFUND_PENDING') throw conflict('ALREADY_DECIDED', 'This refund is not waiting for a decision.');
    const actor = by === 'admin' ? ADMIN : SYSTEM;
    const now = isoNow();
    const p = await t.maybeOne<any>(`SELECT reference, refund_status FROM payments WHERE booking_id=$1 AND status='SUCCESS' ORDER BY id DESC LIMIT 1 FOR UPDATE`, [bookingId]);
    if (action === 'approve') {
      if (await t.maybeOne('SELECT 1 FROM session_credits WHERE source_booking_id=$1', [bookingId])) throw conflict('CREDIT_EXISTS', 'A credit was already issued for this booking, so it cannot also be refunded.');
      if (p && p.refund_status === 'PENDING_APPROVAL') { await t.query(`UPDATE payments SET refund_status='NEEDS_REFUND', refund_decided_at=$2, refund_decided_by=$3 WHERE reference=$1`, [p.reference, now, by]); ref = p.reference; }
      await t.query(`UPDATE bookings SET payment_status='REFUNDED' WHERE id=$1`, [bookingId]);
      await audit(t, bookingId, actor, by === 'auto' ? 'REFUND_AUTO_APPROVED' : 'REFUND_APPROVED', { reference: p?.reference ?? null, amount_kobo: b.price_kobo });
      await notify(t, b.customer_id, 'REFUND_APPROVED', 'Refund approved', `Your ${b.service_name} payment of ${naira(b.price_kobo + (b.booking_fee_kobo || 0))} is being refunded to your original payment method. Your bank can take a few working days to show it.`, bookingId);
      if (by === 'auto') await adminEvent(t, 'REFUND_AUTO_APPROVED', 'Refund auto-approved', `${naira(b.price_kobo + (b.booking_fee_kobo || 0))} for ${b.service_name} on ${fmtWhen(b.date, b.start_min)} was approved automatically because nobody decided in time. The refund was sent to Paystack.`,
        { link: '/admin.html#/payments?filter=refunds', refKey: 'booking:' + bookingId });
      return { result: 'approved' as const };
    }
    const why = String(reason || '').trim();
    if (why.length < 3) throw badRequest('Write a reason (at least 3 characters) - the customer will see it.');
    if (p && p.refund_status === 'PENDING_APPROVAL') await t.query(`UPDATE payments SET refund_status='REJECTED', refund_decided_at=$2, refund_decided_by=$3, refund_error=NULL WHERE reference=$1`, [p.reference, now, by]);
    await t.query(`UPDATE bookings SET payment_status='REFUND_DECLINED' WHERE id=$1`, [bookingId]);
    await audit(t, bookingId, actor, 'REFUND_REJECTED', { reference: p?.reference ?? null, reason: why.slice(0, 300) });
    await notify(t, b.customer_id, 'REFUND_REJECTED', 'Refund not approved', `We could not approve a refund for your ${b.service_name} booking on ${fmtWhen(b.date, b.start_min)}: ${why.slice(0, 200)}. Contact support if you disagree.`, bookingId);
    return { result: 'rejected' as const };
  });
  if (ref) {
    const refund = await requestRefund(db, ref);   // outside the tx; on failure it stays NEEDS_REFUND (retried by the sweeper) and the admin is alerted
    await flushAdminPush(db).catch(() => {});
    return { ...out, refund };
  }
  await flushAdminPush(db).catch(() => {});
  return out;
}

/** Sweeper step: every refund still pending after its deadline is approved automatically and sent to Paystack. */
export async function autoApproveDueRefunds(db: Db, limit = 25): Promise<{ approved: number; failed: number }> {
  const due = await db.many<{ booking_id: number }>(`SELECT p.booking_id FROM payments p JOIN bookings k ON k.id=p.booking_id
      WHERE p.refund_status='PENDING_APPROVAL' AND p.refund_due_at <= $1 AND k.payment_status='REFUND_PENDING' ORDER BY p.refund_due_at LIMIT $2`, [isoNow(), limit]);
  let approved = 0, failed = 0;
  for (const d of due) {
    try { await decideRefund(db, d.booking_id, 'approve', 'auto'); approved++; } catch { failed++; }
  }
  return { approved, failed };
}

export function registerRefundAdmin(api: Router, db: Db, guard: any, wrap: (fn: H) => any) {
  /** The approval queue: pending refunds with their deadline, plus legacy CREDIT_PENDING rows from before this rule (still resolvable). */
  api.get('/admin/refund-queue', guard, wrap(async (_req, res) => {
    const s = await getSettings(db);
    const pending = await db.many(`SELECT k.id, k.date, k.start_min, k.service_name, k.price_kobo, k.status, k.cancelled_at, k.cancelled_by, b.shop_name, u.name AS customer_name, u.email AS customer_email, u.avatar_url AS customer_avatar,
        p.reference, p.refund_reason, p.refund_due_at FROM bookings k JOIN barbers b ON b.id=k.barber_id JOIN users u ON u.id=k.customer_id
        LEFT JOIN LATERAL (SELECT reference, refund_reason, refund_due_at FROM payments WHERE booking_id=k.id AND status='SUCCESS' ORDER BY id DESC LIMIT 1) p ON TRUE
        WHERE k.payment_status='REFUND_PENDING' ORDER BY p.refund_due_at NULLS FIRST, k.id`);
    const legacy = await db.many(`SELECT k.id, k.date, k.start_min, k.service_name, k.price_kobo, k.status, k.cancelled_at, k.cancelled_by, b.shop_name, u.name AS customer_name, u.email AS customer_email
        FROM bookings k JOIN barbers b ON b.id=k.barber_id JOIN users u ON u.id=k.customer_id WHERE k.payment_status='CREDIT_PENDING' ORDER BY k.cancelled_at NULLS LAST, k.id`);
    res.json({ pending, legacy, auto_approve_hours: s.refund_auto_approve_hours, credit_expiry_days: s.credit_expiry_days });
  }));
  api.post('/admin/bookings/:id/refund-decision', guard, wrap(async (req, res) => {
    const id = Number(req.params.id); if (!Number.isInteger(id) || id < 1) throw notFound('Booking not found');
    const d = z.object({ action: z.enum(['approve', 'reject']), reason: z.string().trim().max(300).optional() }).safeParse(req.body);
    if (!d.success) throw badRequest("action must be 'approve' or 'reject'");
    if (d.data.action === 'approve') await requirePin(db, req);    // sends money back: irreversible
    res.json({ ok: true, ...(await decideRefund(db, id, d.data.action, 'admin', d.data.reason)) });
  }));
}
