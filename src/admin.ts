/** Admin portal API. Every route sits behind `adminGuard` (Bearer ADMIN_KEY or the CRON_SECRET fallback, constant-time compare, failed attempts rate-limited). All writes are audited (actor_role='admin'). */
import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { Db } from './db';
import { badRequest, conflict, notFound } from './errors';
import { audit, naira, notify } from './helpers';
import { getSettings, issueCredit } from './plans';
import { requestRefund } from './paystack';
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
        (SELECT COUNT(*) FROM barbers WHERE NOT verified)::int AS barbers_pending,
        (SELECT COUNT(*) FROM users WHERE role='customer')::int AS customers,
        (SELECT COUNT(*) FROM bookings WHERE date=$1 AND status IN ('CONFIRMED','ARRIVED','IN_SERVICE','COMPLETED'))::int AS bookings_today,
        (SELECT COUNT(*) FROM bookings WHERE status IN ('CONFIRMED','ARRIVED','IN_SERVICE','COMPLETED'))::int AS bookings_total,
        (SELECT COALESCE(SUM(amount_kobo),0) FROM payments WHERE status='SUCCESS')::bigint AS revenue_kobo,
        (SELECT COALESCE(SUM(amount_kobo),0) FROM payments WHERE status='SUCCESS' AND verified_at >= (now() - interval '30 days'))::bigint AS revenue_30d_kobo,
        (SELECT COALESCE(SUM(fee_kobo),0) FROM payments WHERE status='SUCCESS')::bigint AS fees_kobo,
        (SELECT COALESCE(SUM(amount_kobo),0) FROM payments WHERE status='SUCCESS' AND plan_purchase_id IS NOT NULL)::bigint AS plan_sales_kobo,
        (SELECT COUNT(*) FROM payments WHERE refund_status IN ('NEEDS_REFUND','REFUND_REQUESTED'))::int AS refunds_open,
        (SELECT COUNT(*) FROM bookings WHERE payment_status='CREDIT_PENDING')::int AS awaiting_decision,
        (SELECT COUNT(*) FROM plan_purchases WHERE status='ACTIVE' AND expires_at > now() AND sessions_used < sessions_total)::int AS active_plans,
        (SELECT COUNT(*) FROM session_credits WHERE status='AVAILABLE' AND expires_at > now())::int AS live_credits`, [today]);
    res.json({ today, ...r, revenue_kobo: Number(r.revenue_kobo), revenue_30d_kobo: Number(r.revenue_30d_kobo), fees_kobo: Number(r.fees_kobo), plan_sales_kobo: Number(r.plan_sales_kobo) });
  }));

  /* ---------- barbers ---------- */
  api.get('/admin/barbers', guard, wrap(async (_req, res) => {
    const rows = await db.many(`SELECT b.id, b.shop_name, b.location, b.verified, b.verified_at, b.created_at, b.paystack_subaccount, u.name, u.email, u.phone,
        (SELECT COUNT(*) FROM services s WHERE s.barber_id=b.id AND s.active)::int AS services,
        (SELECT COUNT(*) FROM bookings k WHERE k.barber_id=b.id AND k.status IN ('CONFIRMED','ARRIVED','IN_SERVICE','COMPLETED'))::int AS bookings
      FROM barbers b JOIN users u ON u.id=b.user_id ORDER BY b.verified, b.id DESC`);
    res.json({ barbers: rows.map((b: any) => ({ ...b, subaccount_status: b.paystack_subaccount ? 'SET' : 'MISSING' })) });
  }));
  const setVerified = (on: boolean): H => async (req, res) => {
    const id = Number(req.params.id);
    const out = await db.tx(async (t) => {
      const b = Number.isInteger(id) ? await t.maybeOne('SELECT b.id, b.shop_name, b.verified, b.user_id FROM barbers b WHERE b.id=$1 FOR UPDATE', [id]) : undefined;
      if (!b) throw notFound('Barber not found');
      if (b.verified === on) return { changed: false, shop_name: b.shop_name, verified: on };
      await t.query('UPDATE barbers SET verified=$1, verified_at=$2 WHERE id=$3', [on, on ? isoNow() : null, id]);
      await audit(t, null, ADMIN, on ? 'ADMIN_BARBER_VERIFIED' : 'ADMIN_BARBER_SUSPENDED', { barber_id: id, shop: b.shop_name });
      if (on) await notify(t, b.user_id, 'BARBER_VERIFIED', "You're live", `${b.shop_name} is now visible to customers and can take bookings.`);
      else await notify(t, b.user_id, 'BARBER_SUSPENDED', 'Shop paused', `${b.shop_name} is hidden from customers and cannot take new bookings while it is under review. Existing bookings are not cancelled.`);
      return { changed: true, shop_name: b.shop_name, verified: on };
    });
    res.json(out);
  };
  api.post('/admin/barbers/:id/verify', guard, wrap(setVerified(true)));
  api.post('/admin/barbers/:id/suspend', guard, wrap(setVerified(false)));

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
    const rows = await db.many(`SELECT k.id, k.date, k.start_min, k.service_name, k.price_kobo, k.status, k.payment_option, k.payment_status, k.paid_via, k.created_at, b.shop_name, u.name AS customer_name
      FROM bookings k JOIN barbers b ON b.id=k.barber_id JOIN users u ON u.id=k.customer_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY k.date DESC, k.start_min DESC, k.id DESC LIMIT $${p.length}`, p);
    res.json({ bookings: rows });
  }));

  /* ---------- payments & refunds ---------- */
  api.get('/admin/payments', guard, wrap(async (req, res) => {
    const f = String(req.query.filter || 'all');
    const where = f === 'paid' ? `p.status='SUCCESS'` : f === 'failed' ? `p.status='FAILED'` : f === 'initiated' ? `p.status='INITIATED'` : f === 'refunds' ? `p.refund_status IS NOT NULL` : f === 'needs_refund' ? `p.refund_status IN ('NEEDS_REFUND','REFUND_REQUESTED')` : 'TRUE';
    const rows = await db.many(`SELECT p.id, p.reference, p.provider, p.amount_kobo, p.fee_kobo, p.status, p.refund_status, p.refund_reason, p.refund_error, p.refund_requested_at, p.created_at, p.verified_at, p.booking_id, p.plan_purchase_id,
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
    if (!p) throw notFound('Payment not found');
    if (p.refund_status !== 'NEEDS_REFUND') throw conflict('NOT_RETRYABLE', p.refund_status ? `This refund is already ${p.refund_status.toLowerCase().replace('_', ' ')}.` : 'This payment is not flagged for refund.');
    const r = await requestRefund(db, ref);
    await audit(db, null, ADMIN, 'ADMIN_REFUND_RETRIED', { reference: ref, result: r });
    const now = await db.one('SELECT refund_status, refund_error FROM payments WHERE reference=$1', [ref]);
    res.json({ result: r, refund_status: now.refund_status, refund_error: now.refund_error });
  }));
  api.post('/admin/payments/:reference/mark-refunded', guard, wrap(async (req, res) => {
    const ref = String(req.params.reference);
    const note = z.object({ note: z.string().trim().max(200).optional() }).parse(req.body || {}).note;
    const out = await db.tx(async (t) => {
      const p = await t.maybeOne('SELECT id, refund_status, amount_kobo, booking_id, plan_purchase_id FROM payments WHERE reference=$1 FOR UPDATE', [ref]);
      if (!p) throw notFound('Payment not found');
      if (!p.refund_status) throw conflict('NOT_FLAGGED', 'This payment is not flagged for refund.');
      if (p.refund_status === 'REFUNDED') return { refund_status: 'REFUNDED' };
      await t.query(`UPDATE payments SET refund_status='REFUNDED', refund_error=NULL WHERE id=$1`, [p.id]);
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
    if (!d.success) throw badRequest("action must be 'credit' or 'refund'");
    let refRef: string | null = null; let credit: any = null;
    await db.tx(async (t) => {
      const b = Number.isInteger(id) ? await t.maybeOne<any>('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [id]) : undefined;
      if (!b) throw notFound('Booking not found');
      if (b.payment_status !== 'CREDIT_PENDING') throw conflict('ALREADY_RESOLVED', 'This booking is not waiting for a decision.');
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
        await notify(t, b.customer_id, 'REFUND_APPROVED', 'Refund approved', `Your ${b.service_name} payment of ${naira(b.price_kobo)} is being refunded to your original payment method.`, id);
      }
    });
    let refund: string | null = null;
    if (refRef) refund = await requestRefund(db, refRef);   // outside the tx: a gateway failure leaves NEEDS_REFUND for retry from Payments
    res.json({ ok: true, action: d.data.action, credit, refund });
  }));

  /* ---------- plans, purchases, credits ---------- */
  api.get('/admin/plans', guard, wrap(async (_req, res) => {
    const plans = await db.many(`SELECT p.id, p.name, p.price_kobo, p.sessions, p.validity_days, p.active, b.shop_name,
        (SELECT COUNT(*) FROM plan_purchases pp WHERE pp.plan_id=p.id AND pp.status='ACTIVE')::int AS buyers,
        (SELECT COALESCE(SUM(pp.price_kobo),0) FROM plan_purchases pp WHERE pp.plan_id=p.id AND pp.status='ACTIVE')::bigint AS revenue_kobo
      FROM plans p JOIN barbers b ON b.id=p.barber_id ORDER BY p.id DESC LIMIT 200`);
    const purchases = await db.many(`SELECT pp.id, pp.plan_name, pp.price_kobo, pp.sessions_total, pp.sessions_used, pp.status, pp.paid_at, pp.expires_at, b.shop_name, u.name AS customer_name,
        (pp.status='ACTIVE' AND pp.expires_at > now() AND pp.sessions_used < pp.sessions_total) AS live
      FROM plan_purchases pp JOIN barbers b ON b.id=pp.barber_id JOIN users u ON u.id=pp.customer_id WHERE pp.status='ACTIVE' ORDER BY pp.paid_at DESC LIMIT 200`);
    res.json({ plans: plans.map((p: any) => ({ ...p, revenue_kobo: Number(p.revenue_kobo) })), purchases });
  }));
  api.get('/admin/credits', guard, wrap(async (_req, res) => {
    const rows = await db.many(`SELECT sc.id, sc.reason, sc.status, sc.value_kobo, sc.expires_at, sc.created_at, sc.used_at, b.shop_name, u.name AS customer_name, (sc.status='AVAILABLE' AND sc.expires_at > now()) AS live
      FROM session_credits sc JOIN barbers b ON b.id=sc.barber_id JOIN users u ON u.id=sc.customer_id ORDER BY sc.created_at DESC LIMIT 200`);
    res.json({ credits: rows });
  }));

  /* ---------- audit ---------- */
  api.get('/admin/audit', guard, wrap(async (req, res) => {
    const onlyAdmin = req.query.scope !== 'all';
    const rows = await db.many(`SELECT id, booking_id, actor_role, action, details, created_at FROM audit_log
      WHERE ${onlyAdmin ? `actor_role='admin' OR action IN ('SETTINGS_UPDATED','BARBER_SIGNUP','BARBER_VERIFIED','BARBER_UNVERIFIED')` : 'TRUE'} ORDER BY id DESC LIMIT 100`);
    res.json({ entries: rows });
  }));
}
