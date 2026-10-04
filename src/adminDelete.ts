/** Admin: PIN setup + deletes.
 *  - customers, barbers, plans, reviews, reports are SOFT deleted (hidden everywhere, restorable for 30 days, no PIN to restore)
 *  - hard delete ("Delete forever") is allowed only for soft-deleted rows (bookings have no soft state) and never when real money was taken
 *  - EVERY delete / purge / test-data purge needs the 4-digit PIN (X-Admin-Pin header) and writes an audit row. */
import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { Conn, Db } from './db';
import { AppError, badRequest, conflict, notFound } from './errors';
import { audit, fmtWhen, notify } from './helpers';
import { restoreEntitlement } from './plans';
import { requestRefund } from './paystack';
import { changePin, pinStatus, requirePin, setupPin } from './adminPin';
import { clock, isoNow, lagosDate } from './time';

type H = (req: Request, res: Response) => Promise<any>;
const ADMIN = { id: null as number | null, role: 'admin' as const };
export const RESTORE_DAYS = 30;
const TYPES = ['customer', 'barber', 'plan', 'review', 'report', 'booking'] as const;
type T = (typeof TYPES)[number];
const idOf = (v: unknown) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw notFound(); return n; };
const typeOf = (v: unknown): T => { if (!(TYPES as readonly string[]).includes(String(v))) throw notFound('We do not know that type.'); return v as T; };
const reasonOf = (body: unknown) => { const r = z.object({ reason: z.string().trim().min(3, 'Write a reason (at least 3 letters).').max(300), cancel_bookings: z.boolean().optional() }).safeParse(body ?? {}); if (!r.success) throw badRequest(r.error.issues[0]?.message || 'Please check what you typed and try again.'); return r.data; };
const cutoff = () => new Date(clock.now().getTime() - RESTORE_DAYS * 86400000).toISOString();
const daysLeft = (d: Date | string) => Math.max(0, Math.ceil((new Date(d).getTime() + RESTORE_DAYS * 86400000 - clock.now().getTime()) / 86400000));

/** test-data patterns: throwaway accounts only. Nothing else can ever match. */
export const TEST_EMAIL_SQL = `(u.email ~* '^smoketest\\+.*@example\\.com$' OR u.email ~* '^perf[a-z]*[0-9]+@perf\\.test$')`;

/** Cancels live bookings matching `where`, notifies the other side, flags paid ones for refund. Returns refund references to action after the tx. */
async function cancelUpcoming(t: Conn, where: string, params: unknown[], who: 'customer' | 'barber', what: string): Promise<{ cancelled: number; refs: string[] }> {
  const rows = await t.many<any>(`SELECT k.*, b.user_id AS barber_user_id, b.shop_name FROM bookings k JOIN barbers b ON b.id=k.barber_id WHERE ${where} AND k.date>=$${params.length + 1} AND k.status IN ('PENDING_PAYMENT','CONFIRMED','ARRIVED') ORDER BY k.id FOR UPDATE OF k`, [...params, lagosDate()]);
  const refs: string[] = [];
  for (const k of rows) {
    let pay = 'VOID'; let note = '';
    if (k.payment_status === 'PAID') {
      if (k.plan_purchase_id || k.credit_id) { await restoreEntitlement(t, k); note = ' We gave your plan session or credit back.'; }
      else {
        const p = await t.maybeOne<any>(`SELECT reference, refund_status FROM payments WHERE booking_id=$1 AND status='SUCCESS' ORDER BY id DESC LIMIT 1 FOR UPDATE`, [k.id]);
        if (p && !p.refund_status) { await t.query(`UPDATE payments SET refund_status='NEEDS_REFUND', refund_reason=$2 WHERE reference=$1`, [p.reference, `${what}: booking cancelled`]); refs.push(p.reference); }
        note = ' We are sending your money back the way you paid.';
      }
    }
    await t.query(`UPDATE bookings SET status='CANCELLED', payment_status=$2, cancelled_at=$3, cancelled_by='admin', hold_expires_at=NULL WHERE id=$1`, [k.id, pay, isoNow()]);
    await audit(t, k.id, ADMIN, 'ADMIN_BOOKING_CANCELLED_DELETE', { reason: what });
    if (who === 'barber') await notify(t, k.customer_id, 'BOOKING_CANCELLED', 'Booking cancelled', `${k.shop_name} is not available any more, so we cancelled your ${k.service_name} booking on ${fmtWhen(k.date, k.start_min)}.${note}`.trim(), k.id);
    else await notify(t, k.barber_user_id, 'BOOKING_CANCELLED', 'Booking cancelled', `A customer account was removed, so the ${k.service_name} booking on ${fmtWhen(k.date, k.start_min)} is cancelled.`, k.id);
  }
  return { cancelled: rows.length, refs };
}

/** Hard delete engine. Deletes children first, in dependency order. Returns counts. */
export async function purgeCore(t: Conn, o: { users?: number[]; barbers?: number[]; bookings?: number[]; plans?: number[] }, allowPaid: boolean) {
  const U = o.users ?? [], B = o.barbers ?? [];
  const bookingIds = (await t.many<{ id: number }>(`SELECT id FROM bookings WHERE id = ANY($1::int[]) OR customer_id = ANY($2::int[]) OR barber_id = ANY($3::int[])`, [o.bookings ?? [], U, B])).map((r) => r.id);
  const planIds = (await t.many<{ id: number }>(`SELECT id FROM plans WHERE id = ANY($1::int[]) OR barber_id = ANY($2::int[])`, [o.plans ?? [], B])).map((r) => r.id);
  const ppIds = (await t.many<{ id: number }>(`SELECT id FROM plan_purchases WHERE plan_id = ANY($1::int[]) OR customer_id = ANY($2::int[]) OR barber_id = ANY($3::int[])`, [planIds, U, B])).map((r) => r.id);
  const pays = await t.many<{ id: number; reference: string; status: string }>(`SELECT id, reference, status FROM payments WHERE booking_id = ANY($1::int[]) OR plan_purchase_id = ANY($2::int[]) OR barber_id = ANY($3::int[])`, [bookingIds, ppIds, B]);
  const paid = pays.filter((p) => p.status === 'SUCCESS').length;
  if (paid && !allowPaid) throw conflict('HAS_PAYMENTS', `This has ${paid} paid payment${paid === 1 ? '' : 's'} on record, so you cannot delete it forever. We keep money records. A normal delete hides it everywhere.`);
  const payIds = pays.map((p) => p.id), refs = pays.map((p) => p.reference);
  const ledgerIds = (await t.many<{ id: number }>(`SELECT id FROM commission_ledger WHERE barber_id = ANY($1::int[]) OR booking_id = ANY($2::int[])`, [B, bookingIds])).map((r) => r.id);
  const creditIds = (await t.many<{ id: number }>(`SELECT id FROM session_credits WHERE customer_id = ANY($1::int[]) OR barber_id = ANY($2::int[]) OR source_booking_id = ANY($3::int[])`, [U, B, bookingIds])).map((r) => r.id);
  const q = (sql: string, ...p: unknown[]) => t.query(sql, p);
  await q(`DELETE FROM push_subscriptions WHERE user_id = ANY($1::int[])`, U);
  await q(`DELETE FROM consent_log WHERE user_id = ANY($1::int[])`, U);
  await q(`DELETE FROM favourites WHERE customer_id = ANY($1::int[]) OR barber_id = ANY($2::int[])`, U, B);
  await q(`DELETE FROM waitlist WHERE customer_id = ANY($1::int[]) OR barber_id = ANY($2::int[])`, U, B);
  await q(`DELETE FROM barber_customer_notes WHERE customer_id = ANY($1::int[]) OR barber_id = ANY($2::int[])`, U, B);
  await q(`DELETE FROM reviews WHERE customer_id = ANY($1::int[]) OR barber_id = ANY($2::int[]) OR booking_id = ANY($3::int[])`, U, B, bookingIds);
  await q(`DELETE FROM ledger_applications WHERE ledger_id = ANY($1::int[]) OR payment_id = ANY($2::int[])`, ledgerIds, payIds);
  await q(`DELETE FROM commission_ledger WHERE id = ANY($1::int[])`, ledgerIds);
  await q(`DELETE FROM help_requests WHERE customer_id = ANY($1::int[]) OR booking_id = ANY($2::int[])`, U, bookingIds);
  await q(`DELETE FROM reports WHERE reporter_id = ANY($1::int[]) OR target_user_id = ANY($1::int[]) OR booking_id = ANY($2::int[])`, U, bookingIds);
  await q(`DELETE FROM broadcasts WHERE user_id = ANY($1::int[])`, U);
  await q(`DELETE FROM payment_events WHERE reference = ANY($1::text[])`, refs);
  await q(`DELETE FROM payments WHERE id = ANY($1::int[])`, payIds);
  await q(`UPDATE bookings SET credit_id=NULL WHERE credit_id = ANY($1::int[])`, creditIds);
  await q(`UPDATE bookings SET plan_purchase_id=NULL WHERE plan_purchase_id = ANY($1::int[])`, ppIds);
  await q(`UPDATE session_credits SET used_booking_id=NULL WHERE used_booking_id = ANY($1::int[])`, bookingIds);
  await q(`DELETE FROM session_credits WHERE id = ANY($1::int[])`, creditIds);
  await q(`DELETE FROM notifications WHERE user_id = ANY($1::int[]) OR booking_id = ANY($2::int[])`, U, bookingIds);
  await q(`DELETE FROM audit_log WHERE booking_id = ANY($1::int[])`, bookingIds);
  await q(`DELETE FROM bookings WHERE id = ANY($1::int[])`, bookingIds);
  await q(`DELETE FROM plan_purchases WHERE id = ANY($1::int[])`, ppIds);
  await q(`DELETE FROM plan_services WHERE plan_id = ANY($1::int[])`, planIds);
  await q(`DELETE FROM plans WHERE id = ANY($1::int[])`, planIds);
  if (B.length) {
    await q(`DELETE FROM days_off WHERE barber_id = ANY($1::int[])`, B);
    await q(`DELETE FROM services WHERE barber_id = ANY($1::int[])`, B);
    await q(`DELETE FROM barber_schedule WHERE barber_id = ANY($1::int[])`, B);
    await q(`DELETE FROM barbers WHERE id = ANY($1::int[])`, B);
  }
  await q(`DELETE FROM users WHERE id = ANY($1::int[])`, U);
  return { bookings: bookingIds.length, payments: payIds.length, plans: planIds.length, plan_purchases: ppIds.length, paid_payments: paid };
}

export function registerAdminDelete(api: Router, db: Db, guard: any, wrap: (fn: H) => any) {
  const get = (p: string, fn: H) => api.get('/admin' + p, guard, wrap(fn));
  const post = (p: string, fn: H) => api.post('/admin' + p, guard, wrap(fn));

  /* ---------- PIN ---------- */
  get('/pin/status', async (_req, res) => res.json(await pinStatus(db)));
  post('/pin/setup', async (req, res) => { await setupPin(db, req.body?.pin); res.json(await pinStatus(db)); });
  post('/pin/change', async (req, res) => { await changePin(db, req.body?.old_pin, req.body?.new_pin); res.json(await pinStatus(db)); });
  /** lets the UI check a PIN once up-front (counts as a real try). */
  post('/pin/check', async (req, res) => { await requirePin(db, req); res.json({ ok: true }); });

  /* ---------- soft delete ---------- */
  post('/delete/:type/:id', async (req, res) => {
    const type = typeOf(req.params.type), id = idOf(req.params.id); const d = reasonOf(req.body);
    await requirePin(db, req);
    let refunds: string[] = [];
    const out = await db.tx(async (t) => {
      const now = isoNow();
      if (type === 'booking') {   // bookings have no soft state: hard delete, only when nothing was paid
        const k = await t.maybeOne<any>('SELECT id, status, customer_id FROM bookings WHERE id=$1 FOR UPDATE', [id]); if (!k) throw notFound('We could not find that booking.');
        if (['PENDING_PAYMENT', 'CONFIRMED', 'ARRIVED', 'IN_SERVICE'].includes(k.status)) throw conflict('BOOKING_LIVE', 'This booking is still live. Cancel it first. Then the customer is told and gets a refund. After that, delete it.');
        const r = await purgeCore(t, { bookings: [id] }, false);
        await audit(t, null, ADMIN, 'ADMIN_BOOKING_DELETED', { booking_id: id, status: k.status, reason: d.reason, ...r });
        return { deleted: true, hard: true };
      }
      if (type === 'customer' || type === 'barber') {
        const row = type === 'customer'
          ? await t.maybeOne<any>(`SELECT u.id AS user_id, u.name, u.account_status, u.deleted_at, NULL::int AS barber_id FROM users u WHERE u.id=$1 AND u.role='customer' FOR UPDATE OF u`, [id])
          : await t.maybeOne<any>(`SELECT u.id AS user_id, b.shop_name AS name, u.account_status, u.deleted_at, b.id AS barber_id, b.review_status FROM barbers b JOIN users u ON u.id=b.user_id WHERE b.id=$1 FOR UPDATE OF u, b`, [id]);
        if (!row) throw notFound(type === 'customer' ? 'We could not find that customer.' : 'We could not find that barber.');
        if (row.deleted_at) return { deleted: true, changed: false };
        const where = type === 'customer' ? 'k.customer_id=$1' : 'k.barber_id=$1';
        const live = await t.one<any>(`SELECT COUNT(*)::int n FROM bookings k WHERE ${where} AND k.date>=$2 AND k.status IN ('PENDING_PAYMENT','CONFIRMED','ARRIVED')`, [id, lagosDate()]);
        if (live.n && !d.cancel_bookings) throw new AppError(409, 'FUTURE_BOOKINGS', `${row.name} has ${live.n} upcoming booking${live.n === 1 ? '' : 's'}. To delete anyway, tick “cancel their upcoming bookings”. Customers are told, and paid ones get a refund.`, { count: live.n });
        let cancelled = 0;
        if (live.n) { const c = await cancelUpcoming(t, where, [id], type === 'barber' ? 'barber' : 'customer', `${type} deleted by admin`); cancelled = c.cancelled; refunds = c.refs; }
        await t.query(`UPDATE users SET deleted_at=$2, deleted_prev_status=account_status, delete_reason=$3, account_status='DELETED', status_at=$2 WHERE id=$1`, [row.user_id, now, d.reason]);
        if (type === 'barber') await t.query(`UPDATE barbers SET deleted_prev_review=review_status, review_status='SUSPENDED' WHERE id=$1`, [id]);
        await t.query('DELETE FROM push_subscriptions WHERE user_id=$1', [row.user_id]);
        await audit(t, null, ADMIN, type === 'customer' ? 'ADMIN_CUSTOMER_DELETED' : 'ADMIN_BARBER_DELETED', { id, user_id: row.user_id, name: row.name, reason: d.reason, cancelled });
        return { deleted: true, changed: true, cancelled };
      }
      const cfg = { plan: ['plans', 'deleted_prev_active=active, active=FALSE', 'ADMIN_PLAN_DELETED'], review: ['reviews', 'deleted_prev_hidden=hidden, hidden=TRUE', 'ADMIN_REVIEW_DELETED'], report: ['reports', '', 'ADMIN_REPORT_DELETED'] }[type]!;
      const cur = await t.maybeOne<any>(`SELECT id, deleted_at FROM ${cfg[0]} WHERE id=$1 FOR UPDATE`, [id]); if (!cur) throw notFound('Not found');
      if (cur.deleted_at) return { deleted: true, changed: false };
      await t.query(`UPDATE ${cfg[0]} SET deleted_at=$2${cfg[1] ? ', ' + cfg[1] : ''} WHERE id=$1`, [id, now]);
      await audit(t, null, ADMIN, cfg[2], { id, reason: d.reason });
      return { deleted: true, changed: true };
    });
    for (const r of refunds) await requestRefund(db, r).catch(() => {});
    res.json({ ...out, restorable_days: (out as any).hard ? 0 : RESTORE_DAYS });
  });

  /* ---------- restore (reversible, so no PIN) ---------- */
  post('/restore/:type/:id', async (req, res) => {
    const type = typeOf(req.params.type), id = idOf(req.params.id);
    if (type === 'booking') throw conflict('NOT_RESTORABLE', 'You cannot bring back a deleted booking.');
    res.json(await db.tx(async (t) => {
      const tbl = { customer: 'users', barber: 'barbers', plan: 'plans', review: 'reviews', report: 'reports' }[type];
      const row = type === 'barber'
        ? await t.maybeOne<any>(`SELECT b.id, b.user_id, b.deleted_prev_review, u.deleted_at, u.deleted_prev_status FROM barbers b JOIN users u ON u.id=b.user_id WHERE b.id=$1 FOR UPDATE OF b, u`, [id])
        : await t.maybeOne<any>(`SELECT * FROM ${tbl} WHERE id=$1 ${type === 'customer' ? `AND role='customer'` : ''} FOR UPDATE`, [id]);
      if (!row) throw notFound('Not found');
      if (!row.deleted_at) return { restored: false, changed: false };
      if (new Date(row.deleted_at).toISOString() < cutoff()) throw conflict('RESTORE_EXPIRED', `The ${RESTORE_DAYS} days to bring it back are over. You can only “Delete forever” now.`);
      if (type === 'customer') await t.query(`UPDATE users SET account_status=COALESCE(deleted_prev_status,'ACTIVE'), deleted_at=NULL, deleted_prev_status=NULL, delete_reason=NULL, status_at=$2 WHERE id=$1`, [id, isoNow()]);
      else if (type === 'barber') {
        await t.query(`UPDATE users SET account_status=COALESCE(deleted_prev_status,'ACTIVE'), deleted_at=NULL, deleted_prev_status=NULL, delete_reason=NULL, status_at=$2 WHERE id=$1`, [row.user_id, isoNow()]);
        await t.query(`UPDATE barbers SET review_status=COALESCE(deleted_prev_review,'SUSPENDED'), deleted_prev_review=NULL WHERE id=$1`, [id]);
      }
      else if (type === 'plan') await t.query(`UPDATE plans SET deleted_at=NULL, active=COALESCE(deleted_prev_active,FALSE), deleted_prev_active=NULL WHERE id=$1`, [id]);
      else if (type === 'review') await t.query(`UPDATE reviews SET deleted_at=NULL, hidden=COALESCE(deleted_prev_hidden,FALSE), deleted_prev_hidden=NULL WHERE id=$1`, [id]);
      else await t.query(`UPDATE reports SET deleted_at=NULL WHERE id=$1`, [id]);
      await audit(t, null, ADMIN, 'ADMIN_RESTORED', { type, id });
      return { restored: true, changed: true };
    }));
  });

  /* ---------- delete forever (PIN) ---------- */
  post('/purge/:type/:id', async (req, res) => {
    const type = typeOf(req.params.type), id = idOf(req.params.id); const d = reasonOf(req.body);
    await requirePin(db, req);
    res.json(await db.tx(async (t) => {
      let r: any;
      if (type === 'booking') { const k = await t.maybeOne<any>('SELECT status FROM bookings WHERE id=$1 FOR UPDATE', [id]); if (!k) throw notFound('We could not find that booking.'); if (['PENDING_PAYMENT', 'CONFIRMED', 'ARRIVED', 'IN_SERVICE'].includes(k.status)) throw conflict('BOOKING_LIVE', 'This booking is still live. Cancel it first. Then delete it.'); r = await purgeCore(t, { bookings: [id] }, false); }
      else if (type === 'customer') {
        const u = await t.maybeOne<any>(`SELECT id, deleted_at FROM users WHERE id=$1 AND role='customer' FOR UPDATE`, [id]); if (!u) throw notFound('We could not find that customer.');
        if (!u.deleted_at) throw conflict('DELETE_FIRST', 'Delete the customer first. You can bring them back for 30 days. Then delete forever.');
        r = await purgeCore(t, { users: [id] }, false);
      } else if (type === 'barber') {
        const b = await t.maybeOne<any>(`SELECT b.id, b.user_id, u.deleted_at FROM barbers b JOIN users u ON u.id=b.user_id WHERE b.id=$1 FOR UPDATE OF b, u`, [id]); if (!b) throw notFound('We could not find that barber.');
        if (!b.deleted_at) throw conflict('DELETE_FIRST', 'Delete the barber first. You can bring them back for 30 days. Then delete forever.');
        r = await purgeCore(t, { users: [b.user_id], barbers: [id] }, false);
      } else {
        const tbl = { plan: 'plans', review: 'reviews', report: 'reports' }[type]!;
        const row = await t.maybeOne<any>(`SELECT id, deleted_at FROM ${tbl} WHERE id=$1 FOR UPDATE`, [id]); if (!row) throw notFound('Not found');
        if (!row.deleted_at) throw conflict('DELETE_FIRST', 'Delete it first. You can bring it back for 30 days. Then delete forever.');
        if (type === 'plan') { const pp = await t.one<any>(`SELECT COUNT(*) FILTER (WHERE status<>'PENDING')::int n FROM plan_purchases WHERE plan_id=$1`, [id]); if (pp.n) throw conflict('HAS_PAYMENTS', `This plan has ${pp.n} purchase${pp.n === 1 ? '' : 's'} on record, so we keep it (hidden) for money records.`); r = await purgeCore(t, { plans: [id] }, false); }
        else { await t.query(`DELETE FROM ${tbl} WHERE id=$1`, [id]); r = {}; }
      }
      await audit(t, null, ADMIN, 'ADMIN_PURGED', { type, id, reason: d.reason, ...r });
      return { purged: true, ...r };
    }));
  });

  /* ---------- recently deleted ---------- */
  get('/deleted', async (_req, res) => {
    const [customers, barbers, plans, reviews, reports] = await Promise.all([
      db.many(`SELECT u.id, u.name AS label, u.email AS sub, u.deleted_at, u.delete_reason FROM users u WHERE u.deleted_at IS NOT NULL AND u.role='customer' ORDER BY u.deleted_at DESC LIMIT 100`),
      db.many(`SELECT b.id, b.shop_name AS label, u.email AS sub, u.deleted_at, u.delete_reason FROM barbers b JOIN users u ON u.id=b.user_id WHERE u.deleted_at IS NOT NULL ORDER BY u.deleted_at DESC LIMIT 100`),
      db.many(`SELECT p.id, p.name AS label, b.shop_name AS sub, p.deleted_at FROM plans p JOIN barbers b ON b.id=p.barber_id WHERE p.deleted_at IS NOT NULL ORDER BY p.deleted_at DESC LIMIT 100`),
      db.many(`SELECT r.id, 'Review ' || r.rating || '★ ' || COALESCE(left(r.comment, 40), '') AS label, b.shop_name AS sub, r.deleted_at FROM reviews r JOIN barbers b ON b.id=r.barber_id WHERE r.deleted_at IS NOT NULL ORDER BY r.deleted_at DESC LIMIT 100`),
      db.many(`SELECT r.id, r.category || ': ' || left(r.message, 40) AS label, NULL AS sub, r.deleted_at FROM reports r WHERE r.deleted_at IS NOT NULL ORDER BY r.deleted_at DESC LIMIT 100`),
    ]);
    const dec = (type: string, rows: any[]) => rows.map((r) => ({ ...r, type, days_left: daysLeft(r.deleted_at) }));
    res.json({ window_days: RESTORE_DAYS, items: [...dec('customer', customers), ...dec('barber', barbers), ...dec('plan', plans), ...dec('review', reviews), ...dec('report', reports)].sort((a, b) => +new Date(b.deleted_at) - +new Date(a.deleted_at)) });
  });

  /* ---------- test data (throwaway accounts only) ---------- */
  async function testPreview(c: Conn) {
    const users = await c.many<any>(`SELECT u.id, u.role, u.email FROM users u WHERE ${TEST_EMAIL_SQL}`);
    const ids = users.map((u) => u.id);
    const c2 = await c.one<any>(`SELECT (SELECT COUNT(*) FROM barbers WHERE user_id = ANY($1::int[]))::int AS barbers,
        (SELECT COUNT(*) FROM bookings WHERE customer_id = ANY($1::int[]) OR barber_id IN (SELECT id FROM barbers WHERE user_id = ANY($1::int[])))::int AS bookings`, [ids]);
    return { users: users.length, customers: users.filter((u) => u.role === 'customer').length, barbers: c2.barbers, bookings: c2.bookings, sample: users.slice(0, 8).map((u) => u.email), ids };
  }
  get('/testdata/preview', async (_req, res) => { const { ids, ...p } = await testPreview(db); res.json({ ...p, patterns: ['smoketest+…@example.com', 'perf…@perf.test'] }); });
  post('/testdata/purge', async (req, res) => {
    if (req.body?.confirm !== 'DELETE TEST DATA') throw badRequest('Type DELETE TEST DATA to confirm.');
    await requirePin(db, req);
    res.json(await db.tx(async (t) => {
      const p = await testPreview(t);
      const barberIds = (await t.many<{ id: number }>('SELECT id FROM barbers WHERE user_id = ANY($1::int[])', [p.ids])).map((r) => r.id);
      const r = p.ids.length ? await purgeCore(t, { users: p.ids, barbers: barberIds }, true) : {};
      const { ids, ...pub } = p;
      await audit(t, null, ADMIN, 'ADMIN_TESTDATA_PURGED', { users: p.users, barbers: p.barbers, bookings: p.bookings });
      return { purged: true, ...pub, ...r };
    }));
  });
}
