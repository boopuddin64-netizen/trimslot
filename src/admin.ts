/** Admin portal API. Every route sits behind `adminGuard` (Bearer ADMIN_KEY or the CRON_SECRET fallback, constant-time compare, failed attempts rate-limited). All writes are audited (actor_role='admin'). */
import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { Db } from './db';
import { requirePin } from './adminPin';
import { AppError, badRequest, conflict, notFound } from './errors';
import { audit, fmtWhen, naira, notify } from './helpers';
import { getSettings, issueCredit, restoreEntitlement } from './plans';
import { requestRefund, processReference, MISMATCH_REASON, notifyMismatchRefund } from './paystack';
import { isoNow, lagosDate } from './time';

const ADMIN = { id: null as number | null, role: 'admin' as const };
type H = (req: Request, res: Response) => Promise<any>;
const num = (v: unknown, d: number, max: number) => Math.min(max, Math.max(1, Number.isFinite(Number(v)) ? Math.floor(Number(v)) : d));
const dateOk = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function registerAdmin(api: Router, db: Db, guard: any, wrap: (fn: H) => any) {
  /** Cheap credential check used by the login screen. */
  api.post('/admin/login', guard, wrap(async (_req, res) => res.json({ ok: true })));

  api.get('/admin/refunds', guard, wrap(async (_req, res) => res.json({ payments: await db.many(`SELECT reference, amount_kobo, refund_status, refund_reason, refund_error, refund_requested_at, booking_id, plan_purchase_id FROM payments WHERE refund_status IS NOT NULL ORDER BY id DESC LIMIT 100`) })));

  api.get('/admin/overview', guard, wrap(async (_req, res) => {
    const today = lagosDate();
    const r = await db.one(`SELECT
        (SELECT COUNT(*) FROM barbers WHERE verified)::int AS barbers_verified,
        (SELECT COUNT(*) FROM barbers WHERE review_status IN ('PENDING','NEEDS_INFO'))::int AS barbers_pending,
        (SELECT COUNT(*) FROM users WHERE role='customer')::int AS customers,
        (SELECT COUNT(*) FROM bookings WHERE date=$1 AND status IN ('CONFIRMED','ARRIVED','IN_SERVICE','COMPLETED'))::int AS bookings_today,
        (SELECT COUNT(*) FROM bookings WHERE status IN ('CONFIRMED','ARRIVED','IN_SERVICE','COMPLETED'))::int AS bookings_total,
        (SELECT COALESCE(SUM(amount_kobo),0) FROM payments WHERE status='SUCCESS')::bigint AS revenue_kobo,
        (SELECT COALESCE(SUM(amount_kobo),0) FROM payments WHERE status='SUCCESS' AND verified_at >= (now() - interval '30 days'))::bigint AS revenue_30d_kobo,
        (SELECT COALESCE(SUM(fee_kobo),0) FROM payments WHERE status='SUCCESS')::bigint AS fees_kobo,
        (SELECT COALESCE(SUM(amount_kobo),0) FROM payments WHERE status='SUCCESS' AND plan_purchase_id IS NOT NULL)::bigint AS plan_sales_kobo,
        (SELECT COUNT(*) FROM payments WHERE refund_status IN ('NEEDS_REFUND','REFUND_REQUESTED'))::int AS refunds_open,
        (SELECT COUNT(*) FROM bookings WHERE payment_status IN ('CREDIT_PENDING','REFUND_PENDING'))::int AS awaiting_decision,
        (SELECT COUNT(*) FROM plan_purchases WHERE status='ACTIVE' AND expires_at > now() AND sessions_used < sessions_total)::int AS active_plans,
        (SELECT COUNT(*) FROM session_credits WHERE status='AVAILABLE' AND expires_at > now())::int AS live_credits,
        (SELECT COUNT(*) FROM reports WHERE status='OPEN')::int AS reports_open,
        (SELECT COALESCE(SUM(remaining_kobo),0) FROM commission_ledger WHERE status='ACCRUED')::bigint AS ledger_owed_kobo,
        (SELECT maintenance_mode FROM platform_settings WHERE id=1) AS maintenance_mode`, [today]);
    res.json({ today, ...r, revenue_kobo: Number(r.revenue_kobo), revenue_30d_kobo: Number(r.revenue_30d_kobo), fees_kobo: Number(r.fees_kobo), plan_sales_kobo: Number(r.plan_sales_kobo), ledger_owed_kobo: Number(r.ledger_owed_kobo) });
  }));

  /* ---------- barbers: review workflow (PENDING / NEEDS_INFO / VERIFIED / REJECTED / SUSPENDED) ---------- */
  const STATES = ['PENDING', 'NEEDS_INFO', 'VERIFIED', 'REJECTED', 'SUSPENDED'] as const;
  const BARBER_SQL = `SELECT b.id, b.shop_name, b.location, b.verified, b.verified_at, b.created_at, b.paystack_subaccount, b.payout_bank_name, b.payout_account_last4, b.payout_account_name, b.payout_set_at, b.review_status, b.review_reason, b.reviewed_at, b.resubmit_note, b.resubmitted_at, b.booking_paused, b.pause_reason, b.fee_percent_override, b.fee_flat_kobo_override,
        (SELECT COALESCE(SUM(remaining_kobo),0) FROM commission_ledger l WHERE l.barber_id=b.id AND l.status='ACCRUED')::bigint AS owed_kobo,
        u.name, u.email, u.phone, u.id AS user_id,
        (SELECT COUNT(*) FROM services s WHERE s.barber_id=b.id AND s.active)::int AS services,
        (SELECT COUNT(*) FROM bookings k WHERE k.barber_id=b.id AND k.status IN ('CONFIRMED','ARRIVED','IN_SERVICE','COMPLETED'))::int AS bookings,
        (SELECT COUNT(*) FROM bookings k WHERE k.barber_id=b.id AND k.date >= $1 AND k.status IN ('CONFIRMED','ARRIVED'))::int AS upcoming
      FROM barbers b JOIN users u ON u.id=b.user_id`;
  const barberRow = (b: any) => ({ ...b, owed_kobo: Number(b.owed_kobo || 0), subaccount_status: b.paystack_subaccount ? 'SET' : 'MISSING' });
  api.get('/admin/barbers', guard, wrap(async (req, res) => {
    const st = String(req.query.status || '').toUpperCase();
    const rows = (await db.many(`${BARBER_SQL} WHERE u.deleted_at IS NULL ORDER BY CASE b.review_status WHEN 'PENDING' THEN 0 WHEN 'NEEDS_INFO' THEN 1 WHEN 'SUSPENDED' THEN 2 WHEN 'VERIFIED' THEN 3 ELSE 4 END, b.id DESC`, [lagosDate()])).map(barberRow);
    const counts: Record<string, number> = { ALL: rows.length }; for (const k of STATES) counts[k] = rows.filter((r: any) => r.review_status === k).length;
    res.json({ barbers: (STATES as readonly string[]).includes(st) ? rows.filter((r: any) => r.review_status === st) : rows, counts });
  }));
  api.get('/admin/barbers/:id', guard, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const b = Number.isInteger(id) ? await db.maybeOne<any>(`${BARBER_SQL} WHERE b.id=$2`, [lagosDate(), id]) : undefined;
    if (!b) throw notFound('We could not find that barber.');
    const extra = await db.one<any>('SELECT about, photo_url FROM barbers WHERE id=$1', [id]);
    const services = await db.many('SELECT id, name, price_kobo, duration_min, active FROM services WHERE barber_id=$1 ORDER BY active DESC, price_kobo, id', [id]);
    const schedule = await db.many('SELECT weekday, is_working, start_min, end_min, break_start_min, break_end_min FROM barber_schedule WHERE barber_id=$1 ORDER BY weekday', [id]);
    const uid = (await db.one<any>('SELECT user_id FROM barbers WHERE id=$1', [id])).user_id;
    const history = await db.many(`SELECT id, actor_role, action, details, created_at FROM audit_log
      WHERE booking_id IS NULL AND ((details->>'barber_id') = $1 OR (actor_user_id = $2 AND action IN ('BARBER_SIGNUP','BARBER_RESUBMITTED'))) ORDER BY id DESC LIMIT 30`, [String(id), uid]);
    res.json({ barber: { ...barberRow(b), about: extra.about, has_photo: !!extra.photo_url }, services, schedule, history, plans: (await db.one<any>('SELECT COUNT(*)::int c FROM plans WHERE barber_id=$1 AND active', [id])).c });
  }));

  const reasonSchema = (what: string) => z.object({ reason: z.string().trim().min(3, `Write a ${what} (at least 3 letters).`).max(500, 'Keep it under 500 characters.') });
  const parseBody = <T extends z.ZodTypeAny>(sch: T, body: unknown): z.infer<T> => { const r = sch.safeParse(body ?? {}); if (!r.success) throw badRequest(r.error.issues[0]?.message || 'Please check what you typed and try again.'); return r.data; };
  const lockBarber = async (t: any, id: number) => {
    const b = Number.isInteger(id) ? await t.maybeOne('SELECT b.id, b.shop_name, b.review_status, b.review_reason, b.user_id FROM barbers b WHERE b.id=$1 FOR UPDATE', [id]) : undefined;
    if (!b) throw notFound('We could not find that barber.');
    return b;
  };
  const setReview = async (t: any, b: any, to: string, reason: string | null) => {
    await t.query('UPDATE barbers SET review_status=$1, review_reason=$2, reviewed_at=$3, verified_at=CASE WHEN $1=\'VERIFIED\' THEN COALESCE(verified_at, $3::timestamptz) ELSE verified_at END WHERE id=$4', [to, reason, isoNow(), b.id]);
  };
  const out = (b: any, to: string, changed: boolean, extra: any = {}) => ({ changed, shop_name: b.shop_name, review_status: to, verified: to === 'VERIFIED', ...extra });

  const approve = (kind: 'approve' | 'reinstate' | 'auto'): H => async (req, res) => {
    const id = Number(req.params.id);
    res.json(await db.tx(async (t) => {
      const b = await lockBarber(t, id);
      if (b.review_status === 'VERIFIED') return out(b, 'VERIFIED', false);
      const was = b.review_status;
      if (kind === 'approve' && was === 'SUSPENDED') throw conflict('USE_REINSTATE', 'This shop is suspended. Use Reinstate.');
      if (kind === 'reinstate' && was !== 'SUSPENDED') throw conflict('NOT_SUSPENDED', 'You can only reinstate a suspended shop.');
      await setReview(t, b, 'VERIFIED', null);
      const reinstated = was === 'SUSPENDED';
      await audit(t, null, ADMIN, reinstated ? 'ADMIN_BARBER_REINSTATED' : 'ADMIN_BARBER_VERIFIED', { barber_id: id, shop: b.shop_name, from: was });
      await notify(t, b.user_id, reinstated ? 'BARBER_REINSTATED' : 'BARBER_VERIFIED', reinstated ? 'Your shop is back' : 'Your shop is live', `${b.shop_name} is ${reinstated ? 'visible to customers again' : 'now visible to customers'}. It can take bookings.`);
      return out(b, 'VERIFIED', true, { from: was });
    }));
  };
  api.post('/admin/barbers/:id/approve', guard, wrap(approve('approve')));
  api.post('/admin/barbers/:id/verify', guard, wrap(approve('auto')));       // kept: approve, or reinstate when suspended
  api.post('/admin/barbers/:id/reinstate', guard, wrap(approve('reinstate')));

  api.post('/admin/barbers/:id/reject', guard, wrap(async (req, res) => {
    const id = Number(req.params.id); const { reason } = parseBody(reasonSchema('reason for saying no'), req.body);
    res.json(await db.tx(async (t) => {
      const b = await lockBarber(t, id);
      if (b.review_status === 'REJECTED') return out(b, 'REJECTED', false);
      if (!['PENDING', 'NEEDS_INFO'].includes(b.review_status)) throw conflict('BAD_STATE', b.review_status === 'VERIFIED' ? 'This shop is live. Suspend it instead.' : 'You can only reject a shop that is waiting for review.');
      await setReview(t, b, 'REJECTED', reason);
      await audit(t, null, ADMIN, 'ADMIN_BARBER_REJECTED', { barber_id: id, shop: b.shop_name, reason });
      await notify(t, b.user_id, 'BARBER_REJECTED', 'Shop not approved', `${b.shop_name} was not approved: ${reason} Fix this, then send your details again in your app.`);
      return out(b, 'REJECTED', true);
    }));
  }));
  api.post('/admin/barbers/:id/request-info', guard, wrap(async (req, res) => {
    const id = Number(req.params.id); const { message } = parseBody(z.object({ message: z.string().trim().min(3, 'Write a message for the barber (at least 3 letters).').max(500, 'Keep it under 500 characters.') }), req.body);
    res.json(await db.tx(async (t) => {
      const b = await lockBarber(t, id);
      if (!['PENDING', 'NEEDS_INFO'].includes(b.review_status)) throw conflict('BAD_STATE', 'You can only ask for more information from a shop that is waiting for review.');
      const again = b.review_status === 'NEEDS_INFO';
      await setReview(t, b, 'NEEDS_INFO', message);
      await audit(t, null, ADMIN, 'ADMIN_BARBER_INFO_REQUESTED', { barber_id: id, shop: b.shop_name, message, again });
      await notify(t, b.user_id, 'BARBER_NEEDS_INFO', 'We need a little more information', `About ${b.shop_name}: ${message} Update your details, then send them again in your app.`);
      return out(b, 'NEEDS_INFO', true);
    }));
  }));

  /** Suspend a live shop. If it has upcoming bookings the admin must choose: keep them (customers are told) or cancel them (customers are told and paid ones refunded). No choice => 409 with the count. */
  api.post('/admin/barbers/:id/suspend', guard, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const d = parseBody(z.object({ reason: z.string().trim().min(3, 'Write a reason for the suspension (at least 3 letters).').max(500, 'Keep it under 500 characters.'), bookings: z.enum(['keep', 'cancel']).optional() }), req.body);
    const refs: string[] = [];
    const result = await db.tx(async (t) => {
      const b = await lockBarber(t, id);
      if (b.review_status === 'SUSPENDED') return out(b, 'SUSPENDED', false);
      if (b.review_status !== 'VERIFIED') throw conflict('BAD_STATE', 'You can only suspend a live shop. To stop a shop that is still in review, use Reject.');
      const future = await t.many<any>(`SELECT * FROM bookings WHERE barber_id=$1 AND date>=$2 AND status IN ('CONFIRMED','ARRIVED') ORDER BY date, start_min FOR UPDATE`, [id, lagosDate()]);
      if (future.length && !d.bookings) {
        throw new AppError(409, 'FUTURE_BOOKINGS', `${b.shop_name} has ${future.length} upcoming booking${future.length === 1 ? '' : 's'}. Choose to keep them or cancel them.`, { count: future.length, bookings: future.slice(0, 20).map((k: any) => ({ id: k.id, when: fmtWhen(k.date, k.start_min), service_name: k.service_name, paid: k.payment_status === 'PAID' })) });
      }
      await setReview(t, b, 'SUSPENDED', d.reason);
      // unpaid pay-now attempts of a suspended shop would only confuse customers; release them quietly
      await t.query(`UPDATE bookings SET status='CANCELLED', payment_status='VOID', cancelled_at=$2, cancelled_by='system', hold_expires_at=NULL WHERE barber_id=$1 AND status='PENDING_PAYMENT'`, [id, isoNow()]);
      let cancelled = 0;
      for (const k of future) {
        if (d.bookings === 'cancel') {
          let pay = 'VOID'; let note = '';
          if (k.payment_status === 'PAID') {
            if (k.plan_purchase_id || k.credit_id) { await restoreEntitlement(t, k); note = ' We gave your plan session or credit back.'; }
            else {
              const p = await t.maybeOne<any>(`SELECT reference, refund_status FROM payments WHERE booking_id=$1 AND status='SUCCESS' ORDER BY id DESC LIMIT 1 FOR UPDATE`, [k.id]);
              if (p && !p.refund_status) { await t.query(`UPDATE payments SET refund_status='NEEDS_REFUND', refund_reason=$2 WHERE reference=$1`, [p.reference, 'shop suspended by admin: booking cancelled']); refs.push(p.reference); }
              note = ' We are sending your money back the way you paid.';
            }
          }
          await t.query(`UPDATE bookings SET status='CANCELLED', payment_status=$2, cancelled_at=$3, cancelled_by='admin', hold_expires_at=NULL WHERE id=$1 AND status IN ('CONFIRMED','ARRIVED')`, [k.id, pay, isoNow()]);
          await audit(t, k.id, ADMIN, 'ADMIN_BOOKING_CANCELLED_SUSPENSION', { barber_id: id, payment_status: pay });
          await notify(t, k.customer_id, 'BOOKING_CANCELLED', 'Booking cancelled', `${b.shop_name} is not available for now, so we cancelled your ${k.service_name} booking on ${fmtWhen(k.date, k.start_min)}.${note}`.trim(), k.id);
          cancelled++;
        } else {
          await notify(t, k.customer_id, 'SHOP_PAUSED', 'This shop is paused', `${b.shop_name} is paused on TrimSlot for now. Your ${k.service_name} booking on ${fmtWhen(k.date, k.start_min)} is not cancelled. Please check with the shop before you go. You can cancel it in My bookings.`, k.id);
        }
      }
      await audit(t, null, ADMIN, 'ADMIN_BARBER_SUSPENDED', { barber_id: id, shop: b.shop_name, reason: d.reason, upcoming: future.length, bookings: future.length ? d.bookings : undefined, cancelled });
      await notify(t, b.user_id, 'BARBER_SUSPENDED', 'Shop paused', `${b.shop_name} is hidden from customers. It cannot take new bookings: ${d.reason}${future.length ? (d.bookings === 'cancel' ? ` Your ${future.length} upcoming booking${future.length === 1 ? ' was' : 's were'} cancelled and the customers told.` : ` Your ${future.length} upcoming booking${future.length === 1 ? ' was' : 's were'} kept and the customers told.`) : ''}`);
      return out(b, 'SUSPENDED', true, { upcoming: future.length, cancelled, customers_notified: future.length });
    });
    const refunds: string[] = [];
    for (const r of refs) refunds.push(await requestRefund(db, r));   // outside the tx; a failure stays NEEDS_REFUND for retry from Payments
    res.json({ ...result, refunds });
  }));

  /* ---------- bookings ---------- */
  api.get('/admin/bookings', guard, wrap(async (req, res) => {
    const p: unknown[] = []; const w: string[] = [];
    if (dateOk(req.query.date)) { p.push(req.query.date); w.push(`k.date=$${p.length}`); }
    if (dateOk(req.query.from)) { p.push(req.query.from); w.push(`k.date>=$${p.length}`); }
    if (dateOk(req.query.to)) { p.push(req.query.to); w.push(`k.date<=$${p.length}`); }
    const bid = Number(req.query.barber_id); if (Number.isInteger(bid) && bid > 0) { p.push(bid); w.push(`k.barber_id=$${p.length}`); }
    const st = String(req.query.status || '');
    if (['PENDING_PAYMENT', 'CONFIRMED', 'ARRIVED', 'IN_SERVICE', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'NOT_SERVED'].includes(st)) { p.push(st); w.push(`k.status=$${p.length}`); }
    p.push(num(req.query.limit, 100, 300));
    const rows = await db.many(`SELECT k.id, k.date, k.start_min, k.service_name, k.price_kobo, k.status, k.payment_option, k.payment_status, k.paid_via, k.created_at, k.barber_id, k.customer_id, b.shop_name, u.name AS customer_name
      FROM bookings k JOIN barbers b ON b.id=k.barber_id JOIN users u ON u.id=k.customer_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY k.date DESC, k.start_min DESC, k.id DESC LIMIT $${p.length}`, p);
    res.json({ bookings: rows });
  }));

  /* ---------- payments & refunds ---------- */
  api.get('/admin/payments', guard, wrap(async (req, res) => {
    const f = String(req.query.filter || 'all');
    const where = f === 'paid' ? `p.status='SUCCESS'` : f === 'failed' ? `p.status='FAILED'` : f === 'initiated' ? `p.status='INITIATED'` : f === 'refunds' ? `p.refund_status IS NOT NULL` : f === 'needs_refund' ? `p.refund_status IN ('NEEDS_REFUND','REFUND_REQUESTED')` : 'TRUE';
    const rows = await db.many(`SELECT p.id, p.reference, p.provider, p.amount_kobo, p.fee_kobo, p.status, p.refund_status, p.refund_reason, p.refund_error, p.refund_requested_at, p.created_at, p.verified_at, p.booking_id, p.plan_purchase_id, p.disputed, p.dispute_note, p.debt_netted_kobo,
        COALESCE(b.service_name, pp.plan_name) AS item, COALESCE(bb.shop_name, pb.shop_name) AS shop_name, cu.name AS customer_name
      FROM payments p LEFT JOIN bookings b ON b.id=p.booking_id LEFT JOIN plan_purchases pp ON pp.id=p.plan_purchase_id
        LEFT JOIN users cu ON cu.id=COALESCE(b.customer_id, pp.customer_id) LEFT JOIN barbers bb ON bb.id=b.barber_id LEFT JOIN barbers pb ON pb.id=pp.barber_id
      WHERE ${where} ORDER BY p.id DESC LIMIT 200`);
    const sum = await db.one(`SELECT COUNT(*) FILTER (WHERE status='SUCCESS')::int AS paid, COUNT(*) FILTER (WHERE status='FAILED')::int AS failed, COUNT(*) FILTER (WHERE status='INITIATED')::int AS initiated,
        COUNT(*) FILTER (WHERE refund_status IN ('NEEDS_REFUND','REFUND_REQUESTED'))::int AS open_refunds FROM payments`);
    res.json({ payments: rows, summary: sum });
  }));
  api.post('/admin/payments/:reference/retry-refund', guard, wrap(async (req, res) => {
    const ref = String(req.params.reference);
    const p = await db.maybeOne('SELECT refund_status FROM payments WHERE reference=$1', [ref]);
    if (!p) throw notFound('We could not find that payment.');
    if (p.refund_status !== 'NEEDS_REFUND') throw conflict('NOT_RETRYABLE', p.refund_status ? `This refund is already ${p.refund_status.toLowerCase().replace('_', ' ')}.` : 'This payment is not marked for a refund.');
    const r = await requestRefund(db, ref);
    await audit(db, null, ADMIN, 'ADMIN_REFUND_RETRIED', { reference: ref, result: r });
    const now = await db.one('SELECT refund_status, refund_error FROM payments WHERE reference=$1', [ref]);
    res.json({ result: r, refund_status: now.refund_status, refund_error: now.refund_error });
  }));
  /** Ask Paystack again about a payment that never confirmed (webhook missed / old amount bug). Confirms the booking if it was really paid and the slot is still free; otherwise the customer is flagged for a refund. */
  api.post('/admin/payments/:reference/reverify', guard, wrap(async (req, res) => {
    const ref = String(req.params.reference);
    const p = await db.maybeOne<any>('SELECT reference, status FROM payments WHERE reference=$1', [ref]); if (!p) throw notFound('We could not find that payment.');
    const result = await processReference(db, ref);
    await audit(db, null, ADMIN, 'ADMIN_PAYMENT_REVERIFIED', { reference: ref, result: result.result });
    res.json({ result: result.result, payment: await db.one('SELECT reference, status, refund_status, booking_id, plan_purchase_id FROM payments WHERE reference=$1', [ref]) });
  }));
  /** A payment whose amount did not fit the booking waits for staff: "retry refund" sends it back, this confirms the booking anyway (the money is kept). Only for an unrefunded "Amount mismatch" payment, and never for another currency. */
  api.post('/admin/payments/:reference/confirm-anyway', guard, wrap(async (req, res) => {
    const ref = String(req.params.reference);
    const p = await db.maybeOne<any>('SELECT reference, status, refund_status, refund_reason, amount_kobo FROM payments WHERE reference=$1', [ref]);
    if (!p) throw notFound('We could not find that payment.');
    if (p.status === 'SUCCESS') throw conflict('ALREADY_APPLIED', 'This payment is already applied.');
    if (p.refund_status !== 'NEEDS_REFUND' || p.refund_reason !== 'Amount mismatch') throw conflict('NOT_A_MISMATCH', p.refund_status ? `This payment is already ${String(p.refund_status).toLowerCase().replace('_', ' ')}, so it cannot be confirmed.` : 'This payment is not waiting for a decision.');
    await requirePin(db, req);      // keeps money whose amount did not match: a decision, so it needs the PIN
    const out = await processReference(db, ref, { force: true });
    await audit(db, null, ADMIN, 'ADMIN_MISMATCH_CONFIRMED', { reference: ref, result: out.result, asked_kobo: p.amount_kobo });
    res.json({ result: out.result, payment: await db.one('SELECT reference, status, refund_status, booking_id, plan_purchase_id FROM payments WHERE reference=$1', [ref]) });
  }));
  api.post('/admin/payments/:reference/mark-refunded', guard, wrap(async (req, res) => {
    const ref = String(req.params.reference);
    const note = z.object({ note: z.string().trim().max(200).optional() }).parse(req.body || {}).note;
    await requirePin(db, req);    // irreversible: records a refund as paid out
    const out = await db.tx(async (t) => {
      const p = await t.maybeOne('SELECT id, refund_status, refund_reason, amount_kobo, booking_id, plan_purchase_id FROM payments WHERE reference=$1 FOR UPDATE', [ref]);
      if (!p) throw notFound('We could not find that payment.');
      if (!p.refund_status) throw conflict('NOT_FLAGGED', 'This payment is not marked for a refund.');
      if (p.refund_status === 'REFUNDED') return { refund_status: 'REFUNDED' };
      await t.query(`UPDATE payments SET refund_status='REFUNDED', refund_error=NULL WHERE id=$1`, [p.id]);
      if (p.refund_reason === MISMATCH_REASON && (p.booking_id || p.plan_purchase_id)) await notifyMismatchRefund(t, p, 'sent');   // staff recorded the money as paid back; the customer was told "we asked" if it was requested earlier
      await audit(t, p.booking_id, ADMIN, 'ADMIN_MARKED_REFUNDED', { reference: ref, amount_kobo: p.amount_kobo, note: note || null });
      return { refund_status: 'REFUNDED' };
    });
    res.json(out);
  }));

  /* ---------- cancellations awaiting a refund/credit decision (CREDIT_PENDING) ---------- */
  api.get('/admin/cancellations', guard, wrap(async (_req, res) => {
    const rows = await db.many(`SELECT k.id, k.date, k.start_min, k.service_name, k.price_kobo, k.status, k.cancelled_at, k.cancelled_by, b.shop_name, u.name AS customer_name, u.email AS customer_email
      FROM bookings k JOIN barbers b ON b.id=k.barber_id JOIN users u ON u.id=k.customer_id WHERE k.payment_status='CREDIT_PENDING' ORDER BY k.cancelled_at NULLS LAST, k.id`);
    res.json({ bookings: rows, credit_expiry_days: (await getSettings(db)).credit_expiry_days });
  }));
  api.post('/admin/bookings/:id/resolve', guard, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const d = z.object({ action: z.enum(['credit', 'refund']) }).safeParse(req.body);
    if (!d.success) throw badRequest("Choose credit or refund.");
    if (d.data.action === 'refund') await requirePin(db, req);    // refunding money is irreversible; choosing a credit is not
    let refRef: string | null = null; let credit: any = null;
    await db.tx(async (t) => {
      const b = Number.isInteger(id) ? await t.maybeOne<any>('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [id]) : undefined;
      if (!b) throw notFound('We could not find that booking.');
      if (b.payment_status !== 'CREDIT_PENDING') throw conflict('ALREADY_RESOLVED', 'This booking does not need a decision.');
      if (d.data.action === 'credit') {
        credit = await issueCredit(t, b, 'EARLY_CANCEL');
        await t.query(`UPDATE bookings SET payment_status='CREDITED' WHERE id=$1`, [id]);
        await audit(t, id, ADMIN, 'ADMIN_RESOLVED_CREDIT', { credit_id: credit?.id ?? null });
      } else {
        const pay = await t.maybeOne<any>(`SELECT reference, refund_status FROM payments WHERE booking_id=$1 AND status='SUCCESS' ORDER BY id DESC LIMIT 1 FOR UPDATE`, [id]);
        if (pay && !pay.refund_status) {
          await t.query(`UPDATE payments SET refund_status='NEEDS_REFUND', refund_reason=$2 WHERE reference=$1`, [pay.reference, 'admin decision: refund cancelled booking']);
          refRef = pay.reference;
        }
        await t.query(`UPDATE bookings SET payment_status='VOID' WHERE id=$1`, [id]);
        await audit(t, id, ADMIN, 'ADMIN_RESOLVED_REFUND', { reference: pay?.reference ?? null });
        await notify(t, b.customer_id, 'REFUND_APPROVED', 'Refund approved', `Your ${b.service_name} payment of ${naira(b.price_kobo + (b.booking_fee_kobo || 0))} is on its way back to the way you paid.`, id);
      }
    });
    let refund: string | null = null;
    if (refRef) refund = await requestRefund(db, refRef);   // outside the tx: a gateway failure leaves NEEDS_REFUND for retry from Payments
    res.json({ ok: true, action: d.data.action, credit, refund });
  }));

  /* ---------- plans, purchases, credits ---------- */
  api.get('/admin/plans', guard, wrap(async (_req, res) => {
    const plans = await db.many(`SELECT p.id, p.name, p.price_kobo, p.sessions, p.validity_days, p.active, b.shop_name, p.barber_id,
        (SELECT COUNT(*) FROM plan_purchases pp WHERE pp.plan_id=p.id AND pp.status='ACTIVE')::int AS buyers,
        (SELECT COALESCE(SUM(pp.price_kobo),0) FROM plan_purchases pp WHERE pp.plan_id=p.id AND pp.status='ACTIVE')::bigint AS revenue_kobo
      FROM plans p JOIN barbers b ON b.id=p.barber_id ORDER BY p.id DESC LIMIT 200`);
    const purchases = await db.many(`SELECT pp.id, pp.plan_name, pp.price_kobo, pp.sessions_total, pp.sessions_used, pp.status, pp.paid_at, pp.expires_at, b.shop_name, u.name AS customer_name,
        (pp.status='ACTIVE' AND pp.expires_at > now() AND pp.sessions_used < pp.sessions_total) AS live, pp.status AS pstatus, pp.customer_id
      FROM plan_purchases pp JOIN barbers b ON b.id=pp.barber_id JOIN users u ON u.id=pp.customer_id WHERE pp.status IN ('ACTIVE','CANCELLED') ORDER BY pp.paid_at DESC NULLS LAST LIMIT 200`);
    res.json({ plans: plans.map((p: any) => ({ ...p, revenue_kobo: Number(p.revenue_kobo) })), purchases });
  }));
  api.get('/admin/credits', guard, wrap(async (_req, res) => {
    const rows = await db.many(`SELECT sc.id, sc.customer_id, sc.barber_id, sc.reason, sc.status, sc.value_kobo, sc.expires_at, sc.created_at, sc.used_at, b.shop_name, u.name AS customer_name, (sc.status='AVAILABLE' AND sc.expires_at > now()) AS live
      FROM session_credits sc JOIN barbers b ON b.id=sc.barber_id JOIN users u ON u.id=sc.customer_id ORDER BY sc.created_at DESC LIMIT 200`);
    res.json({ credits: rows });
  }));
}
