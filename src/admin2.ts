/** Admin power tools: customers, booking control, money, plan oversight, broadcasts, reports inbox, global controls, off-app commission ledger, analytics, search, CSV export, audit filters.
 *  Every route sits behind the admin guard; every write is audited (actor_role='admin') and the affected people are notified. */
import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { Db } from './db';
import { requirePin } from './adminPin';
import { AppError, badRequest, conflict, notFound } from './errors';
import { audit, fmtWhen, naira, notify } from './helpers';
import { getSettings, issueCredit, restoreEntitlement } from './plans';
import { requestRefund } from './paystack';
import { clock, hhmmToMin, isoNow, lagosDate, lagosMinutes, scheduledInstant, addDays, isValidDate } from './time';
import { generateSlots, loadSchedule, busyIntervals, validateBookableDate } from './slots';
import { refreshQueueNotifications, isIncomplete } from './bookingService';
import { addAdjustment, commissionKobo, inAppFeeKobo, ledgerBlocked, manualSettle, outstandingKobo, sendLedgerReminders, waive, reverseNettingForPayment, accrueCommission } from './ledger';
import { isExclusionViolation, isUniqueViolation } from './db';

const ADMIN = { id: null as number | null, role: 'admin' as const };
type H = (req: Request, res: Response) => Promise<any>;
const reasonZ = z.object({ reason: z.string().trim().min(3, 'Write a reason (at least 3 characters)').max(500, 'Keep the reason under 500 characters') });
const parseB = <T extends z.ZodTypeAny>(sch: T, body: unknown): z.infer<T> => { const r = sch.safeParse(body ?? {}); if (!r.success) throw badRequest(r.error.issues[0]?.message || 'Invalid request'); return r.data; };
const idOf = (v: unknown) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw notFound(); return n; };
const like = (q: string) => '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
const dateQ = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && isValidDate(v) ? v : null);
const csvCell = (v: unknown) => { let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCsv = (cols: string[], rows: any[][]) => [cols.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
const kobo = (n: unknown) => Number(n || 0);

export function registerAdminPower(api: Router, db: Db, guard: any, wrap: (fn: H) => any) {
  const get = (p: string, fn: H) => api.get('/admin' + p, guard, wrap(fn));
  const post = (p: string, fn: H) => api.post('/admin' + p, guard, wrap(fn));

  /* ================= customers & users ================= */
  get('/customers', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 60); const st = String(req.query.status || '').toUpperCase();
    const p: unknown[] = []; const w: string[] = [`u.role='customer'`];
    if (q) { p.push(like(q)); const n = Number(q); w.push(`(u.name ILIKE $${p.length} OR u.email ILIKE $${p.length} OR u.phone ILIKE $${p.length}${Number.isInteger(n) ? ` OR u.id=${n}` : ''})`); }
    if (['ACTIVE', 'SUSPENDED', 'BANNED'].includes(st)) { p.push(st); w.push(`u.account_status=$${p.length}`); }
    const rows = await db.many(`SELECT u.id, u.name, u.email, u.phone, u.created_at, u.account_status, u.status_reason, u.warn_count,
        (SELECT COUNT(*) FROM bookings k WHERE k.customer_id=u.id)::int AS bookings,
        (SELECT COUNT(*) FROM bookings k WHERE k.customer_id=u.id AND k.status='COMPLETED')::int AS completed,
        (SELECT COUNT(*) FROM bookings k WHERE k.customer_id=u.id AND k.status='NO_SHOW')::int AS no_shows,
        (SELECT COUNT(*) FROM bookings k WHERE k.customer_id=u.id AND k.status='CANCELLED' AND k.cancelled_by='customer')::int AS cancelled,
        (SELECT COALESCE(SUM(p.amount_kobo),0) FROM payments p LEFT JOIN bookings b ON b.id=p.booking_id LEFT JOIN plan_purchases pp ON pp.id=p.plan_purchase_id WHERE p.status='SUCCESS' AND COALESCE(b.customer_id, pp.customer_id)=u.id)::bigint AS spent_kobo
      FROM users u WHERE ${w.join(' AND ')} ORDER BY u.id DESC LIMIT 200`, p);
    const c = await db.one<any>(`SELECT COUNT(*)::int all_, COUNT(*) FILTER (WHERE account_status='SUSPENDED')::int suspended, COUNT(*) FILTER (WHERE account_status='BANNED')::int banned FROM users WHERE role='customer'`);
    res.json({ customers: rows.map((r: any) => ({ ...r, spent_kobo: kobo(r.spent_kobo) })), counts: { ALL: c.all_, SUSPENDED: c.suspended, BANNED: c.banned } });
  });
  get('/users/:id', async (req, res) => {
    const id = idOf(req.params.id);
    const u = await db.maybeOne<any>('SELECT id, role, name, email, phone, created_at, account_status, status_reason, status_at, warn_count FROM users WHERE id=$1', [id]);
    if (!u) throw notFound('User not found');
    const barber = u.role === 'barber' ? await db.maybeOne<any>('SELECT id, shop_name, review_status, booking_paused FROM barbers WHERE user_id=$1', [id]) : null;
    const col = u.role === 'customer' ? 'k.customer_id' : 'k.barber_id'; const who = u.role === 'customer' ? id : barber?.id ?? -1;
    const bookings = await db.many(`SELECT k.id, k.date, k.start_min, k.service_name, k.price_kobo, k.status, k.payment_status, k.payment_option, b.shop_name, cu.name AS customer_name FROM bookings k JOIN barbers b ON b.id=k.barber_id JOIN users cu ON cu.id=k.customer_id WHERE ${col}=$1 ORDER BY k.date DESC, k.start_min DESC LIMIT 40`, [who]);
    const stats = await db.one<any>(`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status='COMPLETED')::int completed, COUNT(*) FILTER (WHERE status='NO_SHOW')::int no_shows, COUNT(*) FILTER (WHERE status='CANCELLED')::int cancelled FROM bookings k WHERE ${col}=$1`, [who]);
    const payments = u.role === 'customer' ? await db.many(`SELECT p.reference, p.amount_kobo, p.status, p.refund_status, p.disputed, p.created_at FROM payments p LEFT JOIN bookings b ON b.id=p.booking_id LEFT JOIN plan_purchases pp ON pp.id=p.plan_purchase_id WHERE COALESCE(b.customer_id, pp.customer_id)=$1 ORDER BY p.id DESC LIMIT 20`, [id]) : [];
    const credits = u.role === 'customer' ? await db.many(`SELECT sc.id, sc.reason, sc.status, sc.value_kobo, sc.expires_at, b.shop_name FROM session_credits sc JOIN barbers b ON b.id=sc.barber_id WHERE sc.customer_id=$1 ORDER BY sc.id DESC LIMIT 20`, [id]) : [];
    const plans = u.role === 'customer' ? await db.many(`SELECT pp.id, pp.plan_name, pp.sessions_total, pp.sessions_used, pp.status, pp.expires_at, b.shop_name FROM plan_purchases pp JOIN barbers b ON b.id=pp.barber_id WHERE pp.customer_id=$1 AND pp.status<>'PENDING' ORDER BY pp.id DESC LIMIT 20`, [id]) : [];
    const reports = await db.many(`SELECT r.id, r.category, r.status, r.message, r.created_at, r.reporter_id, r.target_user_id FROM reports r WHERE r.reporter_id=$1 OR r.target_user_id=$1 ORDER BY r.id DESC LIMIT 20`, [id]);
    const history = await db.many(`SELECT id, action, details, created_at FROM audit_log WHERE booking_id IS NULL AND actor_role='admin' AND (details->>'user_id')=$1::text ORDER BY id DESC LIMIT 30`, [String(id)]);
    const balance = barber ? { owed_kobo: await outstandingKobo(db, barber.id) } : null;
    res.json({ user: u, barber, stats, bookings, payments, credits, plans, reports, history, balance });
  });
  const restrict = (to: 'SUSPENDED' | 'BANNED'): H => async (req, res) => {
    const id = idOf(req.params.id); const { reason } = parseB(reasonZ, req.body);
    if (to === 'BANNED') await requirePin(db, req);    // a ban is permanent until an admin reverses it by hand
    res.json(await db.tx(async (t) => {
      const u = await t.maybeOne<any>('SELECT id, role, name, account_status FROM users WHERE id=$1 FOR UPDATE', [id]); if (!u) throw notFound('User not found');
      if (u.role !== 'customer') throw conflict('USE_BARBER_REVIEW', 'Barbers are suspended from the Barbers section (review workflow).');
      if (u.account_status === to) return { changed: false, account_status: to };
      await t.query(`UPDATE users SET account_status=$2, status_reason=$3, status_at=$4 WHERE id=$1`, [id, to, reason, isoNow()]);
      await audit(t, null, ADMIN, to === 'BANNED' ? 'ADMIN_USER_BANNED' : 'ADMIN_USER_SUSPENDED', { user_id: id, reason, from: u.account_status });
      await notify(t, id, to === 'BANNED' ? 'ACCOUNT_BANNED' : 'ACCOUNT_SUSPENDED', to === 'BANNED' ? 'Account banned' : 'Account suspended', `Your TrimSlot account is ${to === 'BANNED' ? 'banned' : 'suspended'}: ${reason}`);
      return { changed: true, account_status: to };
    }));
  };
  post('/users/:id/suspend', restrict('SUSPENDED')); post('/users/:id/ban', restrict('BANNED'));
  post('/users/:id/reinstate', async (req, res) => {
    const id = idOf(req.params.id);
    res.json(await db.tx(async (t) => {
      const u = await t.maybeOne<any>('SELECT id, account_status FROM users WHERE id=$1 FOR UPDATE', [id]); if (!u) throw notFound('User not found');
      if (u.account_status === 'ACTIVE') return { changed: false, account_status: 'ACTIVE' };
      await t.query(`UPDATE users SET account_status='ACTIVE', status_reason=NULL, status_at=$2 WHERE id=$1`, [id, isoNow()]);
      await audit(t, null, ADMIN, 'ADMIN_USER_REINSTATED', { user_id: id, from: u.account_status });
      await notify(t, id, 'ACCOUNT_REINSTATED', 'Account restored', 'Your TrimSlot account is active again. Welcome back.');
      return { changed: true, account_status: 'ACTIVE' };
    }));
  });
  post('/users/:id/warn', async (req, res) => {
    const id = idOf(req.params.id); const { reason } = parseB(reasonZ, req.body);
    res.json(await db.tx(async (t) => {
      const u = await t.maybeOne<any>('SELECT id FROM users WHERE id=$1 FOR UPDATE', [id]); if (!u) throw notFound('User not found');
      const n = (await t.one<any>('UPDATE users SET warn_count=warn_count+1 WHERE id=$1 RETURNING warn_count', [id])).warn_count;
      await audit(t, null, ADMIN, 'ADMIN_USER_WARNED', { user_id: id, reason, warn_count: n });
      await notify(t, id, 'ACCOUNT_WARNING', 'Warning from TrimSlot', reason);
      return { warn_count: n };
    }));
  });
  post('/users/:id/notify', async (req, res) => {
    const id = idOf(req.params.id); const d = parseB(z.object({ title: z.string().trim().max(80).optional(), body: z.string().trim().min(3, 'Write a message').max(500) }), req.body);
    await db.tx(async (t) => {
      if (!(await t.maybeOne('SELECT 1 FROM users WHERE id=$1', [id]))) throw notFound('User not found');
      await notify(t, id, 'ADMIN_MESSAGE', d.title || 'Message from TrimSlot', d.body);
      await audit(t, null, ADMIN, 'ADMIN_USER_NOTIFIED', { user_id: id, title: d.title || null });
    });
    res.json({ ok: true });
  });

  /* ================= booking control ================= */
  get('/bookings/:id', async (req, res) => {
    const id = idOf(req.params.id);
    const b = await db.maybeOne<any>(`SELECT k.*, b.shop_name, cu.name AS customer_name, cu.email AS customer_email, bu.name AS barber_name FROM bookings k JOIN barbers b ON b.id=k.barber_id JOIN users cu ON cu.id=k.customer_id JOIN users bu ON bu.id=b.user_id WHERE k.id=$1`, [id]);
    if (!b) throw notFound('Booking not found');
    const payments = await db.many(`SELECT reference, amount_kobo, fee_kobo, debt_netted_kobo, status, refund_status, refund_reason, disputed, dispute_note, created_at, verified_at FROM payments WHERE booking_id=$1 ORDER BY id DESC`, [id]);
    const history = await db.many(`SELECT id, actor_role, action, details, created_at FROM audit_log WHERE booking_id=$1 ORDER BY id DESC LIMIT 40`, [id]);
    const { id: _i, ...rest } = b;
    res.json({ booking: { id, ...rest, start_label: fmtWhen(b.date, b.start_min), incomplete: isIncomplete(b) }, payments, history });
  });
  const lockBooking = async (t: any, id: number) => {
    const pre = await t.maybeOne('SELECT barber_id FROM bookings WHERE id=$1', [id]); if (!pre) throw notFound('Booking not found');
    await t.query('SELECT 1 FROM barbers WHERE id=$1 FOR UPDATE', [pre.barber_id]);     // same lock order as booking/payment code: barber -> booking
    return (await t.one('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [id])) as any;
  };
  const barberUid = async (t: any, barberId: number) => (await t.one('SELECT user_id FROM barbers WHERE id=$1', [barberId])).user_id as number;
  const tell = async (t: any, b: any, type: string, title: string, cust: string, barber: string) => {
    await notify(t, b.customer_id, type, title, cust, b.id);
    if (!isIncomplete(b)) await notify(t, await barberUid(t, b.barber_id), type, title, barber, b.id);
  };

  post('/bookings/:id/cancel', async (req, res) => {
    const id = idOf(req.params.id); const d = parseB(z.object({ reason: reasonZ.shape.reason, refund: z.enum(['refund', 'credit', 'none']).optional() }), req.body);
    let ref: string | null = null;
    const out = await db.tx(async (t) => {
      const b = await lockBooking(t, id);
      if (!['PENDING_PAYMENT', 'CONFIRMED', 'ARRIVED'].includes(b.status)) throw conflict('ILLEGAL_TRANSITION', `This booking is ${b.status} and cannot be cancelled.`);
      const now = isoNow(); let pay = 'VOID'; let note = ''; let credit: any = null;
      if (b.payment_status === 'PAID') {
        if (b.plan_purchase_id || b.credit_id) { await restoreEntitlement(t, b); note = ' Your plan session / credit has been returned.'; }
        else if (b.payment_option === 'ONLINE') {
          const choice = d.refund ?? 'refund';
          if (choice === 'credit') { credit = await issueCredit(t, b, 'EARLY_CANCEL'); pay = credit ? 'CREDITED' : 'VOID'; note = ' You have a session credit with this barber.'; }
          else if (choice === 'refund') {
            const p = await t.maybeOne<any>(`SELECT reference, refund_status FROM payments WHERE booking_id=$1 AND status='SUCCESS' ORDER BY id DESC LIMIT 1 FOR UPDATE`, [id]);
            if (p && !p.refund_status) { await t.query(`UPDATE payments SET refund_status='NEEDS_REFUND', refund_reason=$2 WHERE reference=$1`, [p.reference, 'cancelled by admin: ' + d.reason]); ref = p.reference; }
            note = ' Your payment is being refunded to your original payment method.';
          }
        }
      }
      await t.query(`UPDATE bookings SET status='CANCELLED', payment_status=$2, cancelled_at=$3, cancelled_by='admin', hold_expires_at=NULL WHERE id=$1`, [id, pay, now]);
      await audit(t, id, ADMIN, 'ADMIN_BOOKING_CANCELLED', { reason: d.reason, refund: d.refund ?? null, payment_status: pay });
      await tell(t, b, 'BOOKING_CANCELLED', 'Booking cancelled', `Your ${b.service_name} booking on ${fmtWhen(b.date, b.start_min)} was cancelled by TrimSlot support: ${d.reason}.${note}`, `${b.service_name} on ${fmtWhen(b.date, b.start_min)} was cancelled by TrimSlot support: ${d.reason}. The slot is open again.`);
      await refreshQueueNotifications(t, b.barber_id, b.date);
      return { status: 'CANCELLED', payment_status: pay, credit_id: credit?.id ?? null };
    });
    res.json({ ...out, refund: ref ? await requestRefund(db, ref) : null });
  });

  post('/bookings/:id/reschedule', async (req, res) => {
    const id = idOf(req.params.id);
    const d = parseB(z.object({ reason: reasonZ.shape.reason, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}$/), force: z.boolean().optional() }), req.body);
    validateBookableDate(d.date);
    res.json(await db.tx(async (t) => {
      const b = await lockBooking(t, id);
      if (b.status !== 'CONFIRMED') throw conflict('ILLEGAL_TRANSITION', `Only confirmed bookings can be moved (this one is ${b.status}).`);
      const startMin = hhmmToMin(d.time);
      const { schedule, dayOff } = await loadSchedule(t, b.barber_id, d.date);
      const busy = (await busyIntervals(t, b.barber_id, d.date)).filter((iv) => !(d.date === b.date && iv.start === b.start_min && iv.end === b.end_min));
      const isToday = d.date === lagosDate(clock.now());
      const free = generateSlots({ schedule, isDayOff: !!dayOff, durationMin: b.duration_min, busy, nowMin: isToday ? lagosMinutes(clock.now()) : null });
      const endMin = startMin + b.duration_min;
      const overlaps = busy.some((iv) => iv.start < endMin && startMin < iv.end);
      if (overlaps || (!d.force && !free.some((s) => s.start === startMin))) throw conflict('SLOT_UNAVAILABLE', overlaps ? 'That time overlaps another booking.' : 'That time is outside the barber\'s working hours, in a break or on a day off. Tick "override hours" to allow it.');
      const mine = await t.many('SELECT start_min, end_min FROM bookings WHERE customer_id=$1 AND date=$2 AND status IN (\'CONFIRMED\',\'ARRIVED\',\'IN_SERVICE\') AND id<>$3', [b.customer_id, d.date, id]);
      if (mine.some((m: any) => m.start_min < endMin && startMin < m.end_min)) throw conflict('CUSTOMER_OVERLAP', 'The customer already has a booking that overlaps this time.');
      const start = scheduledInstant(d.date, startMin);
      try { await t.query(`UPDATE bookings SET scheduled_at=$2, ends_at=$3, barber_hold=FALSE, skipped_at=NULL WHERE id=$1`, [id, start.toISOString(), new Date(start.getTime() + b.duration_min * 60000).toISOString()]); }
      catch (e: any) { if (isUniqueViolation(e) || isExclusionViolation(e)) throw conflict('SLOT_UNAVAILABLE', 'That time was just taken.'); throw e; }
      const from = fmtWhen(b.date, b.start_min), to = fmtWhen(d.date, startMin);
      await audit(t, id, ADMIN, 'ADMIN_BOOKING_RESCHEDULED', { reason: d.reason, from, to, forced: !!d.force });
      await tell(t, b, 'BOOKING_RESCHEDULED', 'Booking moved', `Your ${b.service_name} booking was moved from ${from} to ${to} by TrimSlot support: ${d.reason}. If that does not work for you, cancel it from My bookings.`, `${b.service_name} was moved from ${from} to ${to} by TrimSlot support: ${d.reason}.`);
      await refreshQueueNotifications(t, b.barber_id, b.date); if (d.date !== b.date) await refreshQueueNotifications(t, b.barber_id, d.date);
      return { from, to };
    }));
  });

  post('/bookings/:id/complete', async (req, res) => {
    const id = idOf(req.params.id); const d = parseB(z.object({ reason: reasonZ.shape.reason, paid: z.boolean().optional() }), req.body);
    res.json(await db.tx(async (t) => {
      const b = await lockBooking(t, id);
      if (!['CONFIRMED', 'ARRIVED', 'IN_SERVICE'].includes(b.status)) throw conflict('ILLEGAL_TRANSITION', `Cannot complete a booking that is ${b.status}.`);
      const now = isoNow();
      if (b.payment_status === 'PAYMENT_DUE') {
        if (d.paid === undefined) throw new AppError(409, 'PAYMENT_CHOICE', 'This is a pay-on-arrival booking. Say whether the customer paid (paid: true) or not (paid: false).');
        await t.query(d.paid ? `UPDATE bookings SET payment_status='PAID', paid_via='ADMIN', paid_at=$2 WHERE id=$1` : `UPDATE bookings SET payment_status='VOID' WHERE id=$1`, d.paid ? [id, now] : [id]);
      } else if (b.payment_status === 'PENDING') throw conflict('UNPAID', 'This booking is an unpaid online attempt; it cannot be completed.');
      await t.query(`UPDATE bookings SET status='COMPLETED', service_complete=$2, arrival_time=COALESCE(arrival_time,$2), service_start=COALESCE(service_start,$2) WHERE id=$1`, [id, now]);
      const after = await t.one<any>('SELECT * FROM bookings WHERE id=$1', [id]);
      const ledger = await accrueCommission(t, after);
      await audit(t, id, ADMIN, 'ADMIN_BOOKING_COMPLETED', { reason: d.reason, paid: d.paid ?? null, ledger_id: ledger });
      await tell(t, b, 'BOOKING_COMPLETED', 'Booking completed', `Your ${b.service_name} on ${fmtWhen(b.date, b.start_min)} was marked completed by TrimSlot support.`, `${b.service_name} on ${fmtWhen(b.date, b.start_min)} was marked completed by TrimSlot support: ${d.reason}.`);
      await refreshQueueNotifications(t, b.barber_id, b.date);
      return { status: 'COMPLETED', ledger_id: ledger };
    }));
  });

  post('/bookings/:id/no-show', async (req, res) => {
    const id = idOf(req.params.id); const { reason } = parseB(reasonZ, req.body);
    res.json(await db.tx(async (t) => {
      const b = await lockBooking(t, id);
      if (!['CONFIRMED', 'ARRIVED'].includes(b.status)) throw conflict('ILLEGAL_TRANSITION', `Cannot mark a ${b.status} booking as no-show.`);
      await t.query(`UPDATE bookings SET status='NO_SHOW' WHERE id=$1`, [id]);
      if (b.payment_status === 'PENDING' || b.payment_status === 'PAYMENT_DUE') await t.query(`UPDATE bookings SET payment_status='VOID' WHERE id=$1`, [id]);
      const s = await getSettings(t);
      const credit = b.payment_status === 'PAID' && b.payment_option !== 'CREDIT' && s.credit_on_missed_session ? await issueCredit(t, b, 'NO_SHOW', s) : null;
      if (credit) await t.query(`UPDATE bookings SET payment_status='CREDITED' WHERE id=$1`, [id]);
      await audit(t, id, ADMIN, 'ADMIN_BOOKING_NO_SHOW', { reason, credit_id: credit?.id ?? null });
      await tell(t, b, 'NO_SHOW', 'Marked as no-show', `You were marked as a no-show for ${b.service_name} on ${fmtWhen(b.date, b.start_min)} by TrimSlot support: ${reason}.${credit ? ' No refund, but you have 1 session credit with this barber.' : ''}`, `${b.service_name} on ${fmtWhen(b.date, b.start_min)} was marked no-show by TrimSlot support.`);
      await refreshQueueNotifications(t, b.barber_id, b.date);
      return { status: 'NO_SHOW', credit_id: credit?.id ?? null };
    }));
  });

  /* ---- credits ---- */
  post('/credits/issue', async (req, res) => {
    const d = parseB(z.object({ customer_id: z.coerce.number().int().positive(), barber_id: z.coerce.number().int().positive(), value_naira: z.coerce.number().positive().max(1_000_000), reason: reasonZ.shape.reason, days: z.coerce.number().int().min(1).max(365).optional() }), req.body);
    res.json(await db.tx(async (t) => {
      const c = await t.maybeOne<any>(`SELECT id FROM users WHERE id=$1 AND role='customer'`, [d.customer_id]); if (!c) throw notFound('Customer not found');
      const bb = await t.maybeOne<any>('SELECT id, shop_name FROM barbers WHERE id=$1', [d.barber_id]); if (!bb) throw notFound('Barber not found');
      const s = await getSettings(t); const exp = new Date(Date.now() + (d.days ?? s.credit_expiry_days) * 86400000).toISOString();
      const cr = await t.one<any>(`INSERT INTO session_credits (customer_id, barber_id, source_booking_id, reason, value_kobo, expires_at, created_at) VALUES ($1,$2,NULL,'ADMIN_GRANT',$3,$4,$5) RETURNING id`, [d.customer_id, d.barber_id, Math.round(d.value_naira * 100), exp, isoNow()]);
      await audit(t, null, ADMIN, 'ADMIN_CREDIT_ISSUED', { user_id: d.customer_id, barber_id: d.barber_id, credit_id: cr.id, value_kobo: Math.round(d.value_naira * 100), reason: d.reason });
      await notify(t, d.customer_id, 'CREDIT_ISSUED', 'Session credit added', `You received a session credit worth ${naira(Math.round(d.value_naira * 100))} for ${bb.shop_name} (valid until ${exp.slice(0, 10)}): ${d.reason}.`);
      return { credit_id: cr.id, expires_at: exp };
    }));
  });
  post('/credits/:id/revoke', async (req, res) => {
    const id = idOf(req.params.id); const { reason } = parseB(reasonZ, req.body);
    await requirePin(db, req);
    res.json(await db.tx(async (t) => {
      const c = await t.maybeOne<any>('SELECT * FROM session_credits WHERE id=$1 FOR UPDATE', [id]); if (!c) throw notFound('Credit not found');
      if (c.status === 'REVOKED') return { changed: false };
      if (c.status !== 'AVAILABLE') throw conflict('CREDIT_USED', 'This credit has already been used.');
      await t.query(`UPDATE session_credits SET status='REVOKED' WHERE id=$1`, [id]);
      await audit(t, null, ADMIN, 'ADMIN_CREDIT_REVOKED', { user_id: c.customer_id, credit_id: id, reason });
      await notify(t, c.customer_id, 'CREDIT_REVOKED', 'Session credit removed', `A session credit was removed from your account: ${reason}.`);
      return { changed: true };
    }));
  });

  /* ---- plans oversight ---- */
  post('/plans/:id/visibility', async (req, res) => {
    const id = idOf(req.params.id); const d = parseB(z.object({ active: z.boolean(), reason: reasonZ.shape.reason }), req.body);
    res.json(await db.tx(async (t) => {
      const p = await t.maybeOne<any>('SELECT id, name, active, barber_id FROM plans WHERE id=$1 FOR UPDATE', [id]); if (!p) throw notFound('Plan not found');
      if (p.active === d.active) return { changed: false, active: p.active };
      await t.query('UPDATE plans SET active=$2 WHERE id=$1', [id, d.active]);
      await audit(t, null, ADMIN, d.active ? 'ADMIN_PLAN_RESTORED' : 'ADMIN_PLAN_HIDDEN', { plan_id: id, barber_id: p.barber_id, reason: d.reason });
      await notify(t, await barberUid(t, p.barber_id), 'PLAN_ADMIN', d.active ? 'Plan restored' : 'Plan hidden', `Your plan "${p.name}" was ${d.active ? 'restored' : 'hidden from customers'} by TrimSlot: ${d.reason}. Existing purchases are not affected.`);
      return { changed: true, active: d.active };
    }));
  });
  post('/plan-purchases/:id/adjust', async (req, res) => {
    const id = idOf(req.params.id);
    const d = parseB(z.object({ reason: reasonZ.shape.reason, delta: z.coerce.number().int().min(-100).max(100).optional(), extend_days: z.coerce.number().int().min(-365).max(365).optional() }), req.body);
    if (!d.delta && !d.extend_days) throw badRequest('Give a session change (delta) or extra days (extend_days).');
    res.json(await db.tx(async (t) => {
      const p = await t.maybeOne<any>('SELECT * FROM plan_purchases WHERE id=$1 FOR UPDATE', [id]); if (!p) throw notFound('Plan purchase not found');
      if (p.status !== 'ACTIVE') throw conflict('NOT_ACTIVE', 'Only active plan purchases can be adjusted.');
      const total = p.sessions_total + (d.delta ?? 0);
      if (total < Math.max(1, p.sessions_used)) throw badRequest(`Total sessions cannot go below ${Math.max(1, p.sessions_used)} (already used).`);
      if (total > 500) throw badRequest('Total sessions cannot exceed 500.');
      const base = Math.max(new Date(p.expires_at).getTime(), (d.extend_days ?? 0) > 0 ? Date.now() : 0);
      const exp = d.extend_days ? new Date(base + d.extend_days * 86400000).toISOString() : p.expires_at;
      await t.query('UPDATE plan_purchases SET sessions_total=$2, expires_at=$3 WHERE id=$1', [id, total, exp]);
      await audit(t, null, ADMIN, 'ADMIN_PLAN_ADJUSTED', { user_id: p.customer_id, purchase_id: id, delta: d.delta ?? 0, extend_days: d.extend_days ?? 0, reason: d.reason });
      await notify(t, p.customer_id, 'PLAN_ADJUSTED', 'Plan updated', `Your plan "${p.plan_name}" was updated: ${total - p.sessions_used} session${total - p.sessions_used === 1 ? '' : 's'} left, valid until ${String(exp).slice(0, 10)}. ${d.reason}.`);
      return { sessions_total: total, expires_at: exp };
    }));
  });
  post('/plan-purchases/:id/cancel', async (req, res) => {
    const id = idOf(req.params.id); const d = parseB(z.object({ reason: reasonZ.shape.reason, refund: z.boolean().optional() }), req.body);
    if (d.refund) await requirePin(db, req);
    let ref: string | null = null;
    const out = await db.tx(async (t) => {
      const p = await t.maybeOne<any>('SELECT * FROM plan_purchases WHERE id=$1 FOR UPDATE', [id]); if (!p) throw notFound('Plan purchase not found');
      if (p.status === 'CANCELLED') return { changed: false };
      if (p.status !== 'ACTIVE') throw conflict('NOT_ACTIVE', 'Only active plan purchases can be cancelled.');
      await t.query(`UPDATE plan_purchases SET status='CANCELLED' WHERE id=$1`, [id]);
      if (d.refund) { const pay = await t.maybeOne<any>(`SELECT reference, refund_status FROM payments WHERE plan_purchase_id=$1 AND status='SUCCESS' ORDER BY id DESC LIMIT 1 FOR UPDATE`, [id]);
        if (pay && !pay.refund_status) { await t.query(`UPDATE payments SET refund_status='NEEDS_REFUND', refund_reason=$2 WHERE reference=$1`, [pay.reference, 'plan cancelled by admin: ' + d.reason]); ref = pay.reference; } }
      const upcoming = (await t.one<any>(`SELECT COUNT(*)::int c FROM bookings WHERE plan_purchase_id=$1 AND status IN ('CONFIRMED','ARRIVED') AND date>=$2`, [id, lagosDate()])).c;
      await audit(t, null, ADMIN, 'ADMIN_PLAN_PURCHASE_CANCELLED', { user_id: p.customer_id, purchase_id: id, refund: !!d.refund, reason: d.reason, upcoming_plan_bookings: upcoming });
      await notify(t, p.customer_id, 'PLAN_ADJUSTED', 'Plan cancelled', `Your plan "${p.plan_name}" was cancelled by TrimSlot: ${d.reason}.${d.refund ? ' Your payment is being refunded.' : ''}`);
      await notify(t, await barberUid(t, p.barber_id), 'PLAN_ADMIN', 'Plan purchase cancelled', `A customer's "${p.plan_name}" purchase was cancelled by TrimSlot: ${d.reason}.`);
      return { changed: true, refund_flagged: !!ref, upcoming_plan_bookings: upcoming };
    });
    res.json({ ...out, refund: ref ? await requestRefund(db, ref) : null });
  });

  /* ================= money ================= */
  const range = (req: Request) => { const to = dateQ(req.query.to) ?? lagosDate(); const from = dateQ(req.query.from) ?? addDays(to, -29); return { from, to }; };
  get('/earnings', async (req, res) => {
    const { from, to } = range(req);
    const s = await getSettings(db);
    const rows = await db.many<any>(`SELECT b.id, b.shop_name, b.review_status, b.paystack_subaccount, b.fee_percent_override, b.fee_flat_kobo_override,
        COALESCE(SUM(p.amount_kobo) FILTER (WHERE p.refund_status IS NULL),0)::bigint AS gross_kobo,
        COALESCE(SUM(p.fee_kobo) FILTER (WHERE p.refund_status IS NULL),0)::bigint AS fees_kobo,
        COALESCE(SUM(p.debt_netted_kobo) FILTER (WHERE p.refund_status IS NULL),0)::bigint AS netted_kobo,
        COALESCE(SUM(p.amount_kobo) FILTER (WHERE p.refund_status IS NOT NULL),0)::bigint AS refunded_kobo,
        COUNT(p.id) FILTER (WHERE p.refund_status IS NULL)::int AS payments
      FROM barbers b LEFT JOIN payments p ON p.barber_id=b.id AND p.status='SUCCESS' AND (p.verified_at AT TIME ZONE 'Africa/Lagos')::date BETWEEN $1 AND $2
      GROUP BY b.id ORDER BY gross_kobo DESC, b.id`, [from, to]);
    const off = await db.many<any>(`SELECT barber_id, COUNT(*)::int n, COALESCE(SUM(price_kobo),0)::bigint v FROM bookings WHERE status='COMPLETED' AND payment_option='ON_ARRIVAL' AND payment_status='PAID' AND date BETWEEN $1 AND $2 GROUP BY barber_id`, [from, to]);
    const owed = await db.many<any>(`SELECT barber_id, SUM(remaining_kobo)::bigint AS s FROM commission_ledger WHERE status='ACCRUED' GROUP BY barber_id`);
    const om = new Map(off.map((o: any) => [o.barber_id, o])), wm = new Map(owed.map((o: any) => [o.barber_id, kobo(o.s)]));
    const barbers = rows.map((r: any) => { const gross = kobo(r.gross_kobo), fees = kobo(r.fees_kobo), netted = kobo(r.netted_kobo); const hasSub = !!r.paystack_subaccount;
      return { id: r.id, shop_name: r.shop_name, review_status: r.review_status, subaccount_status: hasSub ? 'SET' : 'MISSING', fee_override: r.fee_percent_override != null || r.fee_flat_kobo_override != null ? { percent: r.fee_percent_override != null ? Number(r.fee_percent_override) : null, flat_kobo: r.fee_flat_kobo_override } : null,
        payments: r.payments, gross_kobo: gross, fees_kobo: fees, netted_kobo: netted, refunded_kobo: kobo(r.refunded_kobo),
        barber_share_kobo: hasSub ? Math.max(0, gross - fees - netted) : 0, held_by_platform_kobo: hasSub ? 0 : gross,
        offapp_bookings: (om.get(r.id) as any)?.n ?? 0, offapp_value_kobo: kobo((om.get(r.id) as any)?.v), owed_kobo: wm.get(r.id) ?? 0 }; });
    const tot = barbers.reduce((a: any, b: any) => ({ gross_kobo: a.gross_kobo + b.gross_kobo, fees_kobo: a.fees_kobo + b.fees_kobo, netted_kobo: a.netted_kobo + b.netted_kobo, owed_kobo: a.owed_kobo + b.owed_kobo, refunded_kobo: a.refunded_kobo + b.refunded_kobo }), { gross_kobo: 0, fees_kobo: 0, netted_kobo: 0, owed_kobo: 0, refunded_kobo: 0 });
    res.json({ from, to, barbers, totals: tot, rules: { fee_percent: s.platform_fee_percent, fee_flat_kobo: s.platform_fee_kobo, commission_factor: s.commission_factor, example_fee_kobo: inAppFeeKobo(300000, s), example_commission_kobo: commissionKobo(300000, s) } });
  });
  post('/payments/:reference/dispute', async (req, res) => {
    const ref = String(req.params.reference); const d = parseB(z.object({ disputed: z.boolean().default(true), note: z.string().trim().max(500).optional() }), req.body);
    if (d.disputed && (!d.note || d.note.length < 3)) throw badRequest('Write a note about the dispute (at least 3 characters)');
    res.json(await db.tx(async (t) => {
      const p = await t.maybeOne<any>('SELECT id, disputed, booking_id FROM payments WHERE reference=$1 FOR UPDATE', [ref]); if (!p) throw notFound('Payment not found');
      await t.query(`UPDATE payments SET disputed=$2, dispute_note=$3, disputed_at=$4 WHERE id=$1`, [p.id, d.disputed, d.disputed ? d.note : null, d.disputed ? isoNow() : null]);
      await audit(t, p.booking_id, ADMIN, d.disputed ? 'ADMIN_PAYMENT_FLAGGED' : 'ADMIN_PAYMENT_UNFLAGGED', { reference: ref, note: d.note || null });
      return { disputed: d.disputed };
    }));
  });

  const csvRes = async (res: Response, name: string, cols: string[], rows: any[][]) => {
    await audit(db, null, ADMIN, 'ADMIN_EXPORT', { export: name, rows: rows.length });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="trimslot-${name}-${lagosDate()}.csv"`);
    res.send(toCsv(cols, rows));
  };
  get('/export/bookings.csv', async (req, res) => {
    const { from, to } = range(req);
    const rows = await db.many<any>(`SELECT k.id, k.date, k.start_min, b.shop_name, cu.name AS customer, cu.email, k.service_name, k.price_kobo, k.status, k.payment_option, k.payment_status, k.paid_via, k.cancelled_by, k.created_at FROM bookings k JOIN barbers b ON b.id=k.barber_id JOIN users cu ON cu.id=k.customer_id WHERE k.date BETWEEN $1 AND $2 ORDER BY k.date, k.start_min LIMIT 20000`, [from, to]);
    await csvRes(res, 'bookings', ['id', 'date', 'time', 'shop', 'customer', 'customer_email', 'service', 'price_naira', 'status', 'payment_option', 'payment_status', 'paid_via', 'cancelled_by', 'created_at'],
      rows.map((r) => [r.id, String(r.date).slice(0, 10), `${String(Math.floor(r.start_min / 60)).padStart(2, '0')}:${String(r.start_min % 60).padStart(2, '0')}`, r.shop_name, r.customer, r.email, r.service_name, r.price_kobo / 100, r.status, r.payment_option, r.payment_status, r.paid_via, r.cancelled_by, r.created_at]));
  });
  get('/export/payments.csv', async (req, res) => {
    const { from, to } = range(req);
    const rows = await db.many<any>(`SELECT p.reference, p.provider, p.amount_kobo, p.fee_kobo, p.debt_netted_kobo, p.status, p.refund_status, p.disputed, b.shop_name, p.booking_id, p.plan_purchase_id, p.created_at, p.verified_at FROM payments p LEFT JOIN barbers b ON b.id=p.barber_id WHERE (p.created_at AT TIME ZONE 'Africa/Lagos')::date BETWEEN $1 AND $2 ORDER BY p.id LIMIT 20000`, [from, to]);
    await csvRes(res, 'payments', ['reference', 'provider', 'amount_naira', 'platform_fee_naira', 'commission_netted_naira', 'status', 'refund_status', 'disputed', 'shop', 'booking_id', 'plan_purchase_id', 'created_at', 'verified_at'],
      rows.map((r) => [r.reference, r.provider, r.amount_kobo / 100, r.fee_kobo / 100, r.debt_netted_kobo / 100, r.status, r.refund_status, r.disputed, r.shop_name, r.booking_id, r.plan_purchase_id, r.created_at, r.verified_at]));
  });
  get('/export/barbers.csv', async (_req, res) => {
    const rows = await db.many<any>(`SELECT b.id, b.shop_name, u.name, u.email, u.phone, b.review_status, (b.paystack_subaccount IS NOT NULL) AS sub, b.booking_paused, b.created_at,
        (SELECT COUNT(*) FROM bookings k WHERE k.barber_id=b.id AND k.status='COMPLETED')::int AS completed,
        (SELECT COALESCE(SUM(remaining_kobo),0) FROM commission_ledger l WHERE l.barber_id=b.id AND l.status='ACCRUED')::bigint AS owed FROM barbers b JOIN users u ON u.id=b.user_id ORDER BY b.id`);
    await csvRes(res, 'barbers', ['id', 'shop', 'owner', 'email', 'phone', 'review_status', 'paystack_subaccount_set', 'bookings_paused', 'joined', 'completed_bookings', 'balance_owed_naira'],
      rows.map((r) => [r.id, r.shop_name, r.name, r.email, r.phone, r.review_status, r.sub, r.booking_paused, r.created_at, r.completed, kobo(r.owed) / 100]));
  });

  /* ================= broadcasts ================= */
  post('/broadcast', async (req, res) => {
    const d = parseB(z.object({ audience: z.enum(['customers', 'barbers', 'user']), user_id: z.coerce.number().int().positive().optional(), title: z.string().trim().min(2, 'Add a title').max(80), body: z.string().trim().min(3, 'Write the message').max(500) }), req.body);
    res.json(await db.tx(async (t) => {
      let n = 0;
      if (d.audience === 'user') { if (!d.user_id) throw badRequest('Choose the user (user_id).'); if (!(await t.maybeOne('SELECT 1 FROM users WHERE id=$1', [d.user_id]))) throw notFound('User not found'); await notify(t, d.user_id, 'ANNOUNCEMENT', d.title, d.body); n = 1; }
      else n = (await t.query(`INSERT INTO notifications (user_id, type, title, body, is_read, created_at) SELECT id, 'ANNOUNCEMENT', $2, $3, FALSE, $4 FROM users WHERE role=$1 AND account_status='ACTIVE'`, [d.audience === 'customers' ? 'customer' : 'barber', d.title, d.body, isoNow()])).rowCount;
      const b = await t.one<any>(`INSERT INTO broadcasts (audience, user_id, title, body, recipients, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [d.audience.toUpperCase(), d.user_id ?? null, d.title, d.body, n, isoNow()]);
      await audit(t, null, ADMIN, 'ADMIN_BROADCAST', { broadcast_id: b.id, audience: d.audience, recipients: n, title: d.title, ...(d.user_id ? { user_id: d.user_id } : {}) });
      return { id: b.id, recipients: n };
    }));
  });
  get('/broadcasts', async (_req, res) => res.json({ broadcasts: await db.many('SELECT id, audience, user_id, title, body, recipients, created_at FROM broadcasts ORDER BY id DESC LIMIT 50') }));

  /* ================= reports inbox ================= */
  get('/reports', async (req, res) => {
    const st = String(req.query.status || 'OPEN').toUpperCase();
    const rows = await db.many(`SELECT r.id, r.category, r.message, r.status, r.admin_note, r.created_at, r.resolved_at, r.booking_id, r.reporter_id, r.target_user_id,
        ru.name AS reporter_name, ru.role AS reporter_role, tu.name AS target_name, tu.role AS target_role
      FROM reports r JOIN users ru ON ru.id=r.reporter_id LEFT JOIN users tu ON tu.id=r.target_user_id ${['OPEN', 'RESOLVED', 'DISMISSED'].includes(st) ? `WHERE r.status='${st}'` : ''} ORDER BY r.id DESC LIMIT 200`);
    const c = await db.one<any>(`SELECT COUNT(*) FILTER (WHERE status='OPEN')::int open, COUNT(*) FILTER (WHERE status='RESOLVED')::int resolved, COUNT(*) FILTER (WHERE status='DISMISSED')::int dismissed FROM reports`);
    res.json({ reports: rows, counts: { OPEN: c.open, RESOLVED: c.resolved, DISMISSED: c.dismissed } });
  });
  post('/reports/:id/resolve', async (req, res) => {
    const id = idOf(req.params.id); const d = parseB(z.object({ status: z.enum(['RESOLVED', 'DISMISSED']), note: z.string().trim().min(3, 'Add a resolution note (at least 3 characters)').max(500), notify_reporter: z.boolean().optional() }), req.body);
    res.json(await db.tx(async (t) => {
      const r = await t.maybeOne<any>('SELECT * FROM reports WHERE id=$1 FOR UPDATE', [id]); if (!r) throw notFound('Report not found');
      if (r.status !== 'OPEN') throw conflict('ALREADY_RESOLVED', 'This report is already closed.');
      await t.query('UPDATE reports SET status=$2, admin_note=$3, resolved_at=$4 WHERE id=$1', [id, d.status, d.note, isoNow()]);
      await audit(t, r.booking_id, ADMIN, 'ADMIN_REPORT_' + d.status, { report_id: id, note: d.note, user_id: r.target_user_id });
      if (d.notify_reporter !== false) await notify(t, r.reporter_id, 'REPORT_UPDATE', d.status === 'RESOLVED' ? 'Your report was resolved' : 'Your report was reviewed', d.note);
      return { status: d.status };
    }));
  });

  /* ================= global + per-barber controls ================= */
  post('/barbers/:id/pause', async (req, res) => {
    const id = idOf(req.params.id); const d = parseB(z.object({ paused: z.boolean(), reason: z.string().trim().max(300).optional() }), req.body);
    if (d.paused && (!d.reason || d.reason.length < 3)) throw badRequest('Write a reason for pausing bookings (at least 3 characters)');
    res.json(await db.tx(async (t) => {
      const b = await t.maybeOne<any>('SELECT id, shop_name, booking_paused, user_id FROM barbers WHERE id=$1 FOR UPDATE', [id]); if (!b) throw notFound('Barber not found');
      if (b.booking_paused === d.paused) return { changed: false, paused: d.paused };
      await t.query('UPDATE barbers SET booking_paused=$2, pause_reason=$3 WHERE id=$1', [id, d.paused, d.paused ? d.reason : null]);
      await audit(t, null, ADMIN, d.paused ? 'ADMIN_BARBER_BOOKINGS_PAUSED' : 'ADMIN_BARBER_BOOKINGS_RESUMED', { barber_id: id, shop: b.shop_name, reason: d.reason || null });
      await notify(t, b.user_id, 'BARBER_PAUSE', d.paused ? 'New bookings paused' : 'New bookings resumed', d.paused ? `New bookings for ${b.shop_name} are paused by TrimSlot: ${d.reason}. Existing bookings are not affected.` : `${b.shop_name} can take new bookings again.`);
      return { changed: true, paused: d.paused };
    }));
  });
  post('/barbers/:id/fee', async (req, res) => {
    const id = idOf(req.params.id);
    const d = parseB(z.object({ percent: z.coerce.number().min(0).max(100).nullable().optional(), flat_naira: z.coerce.number().min(0).max(1_000_000).nullable().optional(), reason: z.string().trim().max(300).optional() }), req.body);
    res.json(await db.tx(async (t) => {
      const b = await t.maybeOne<any>('SELECT id, shop_name FROM barbers WHERE id=$1 FOR UPDATE', [id]); if (!b) throw notFound('Barber not found');
      const clear = d.percent == null && d.flat_naira == null;
      await t.query('UPDATE barbers SET fee_percent_override=$2, fee_flat_kobo_override=$3 WHERE id=$1', [id, clear ? null : (d.percent ?? 0), clear ? null : Math.round((d.flat_naira ?? 0) * 100)]);
      await audit(t, null, ADMIN, 'ADMIN_BARBER_FEE_SET', { barber_id: id, shop: b.shop_name, percent: clear ? null : d.percent ?? 0, flat_naira: clear ? null : d.flat_naira ?? 0, reason: d.reason || null });
      return { override: !clear };
    }));
  });

  /* ================= off-app commission ledger ================= */
  get('/ledger', async (_req, res) => {
    const s = await getSettings(db);
    const rows = await db.many<any>(`SELECT b.id, b.shop_name, b.review_status,
        COALESCE(SUM(l.remaining_kobo) FILTER (WHERE l.status='ACCRUED'),0)::bigint AS owed_kobo,
        COALESCE(SUM(l.amount_kobo) FILTER (WHERE l.kind='COMMISSION'),0)::bigint AS accrued_total_kobo,
        COUNT(l.id) FILTER (WHERE l.status='ACCRUED')::int AS open_entries,
        MIN(l.created_at) FILTER (WHERE l.status='ACCRUED') AS oldest
      FROM barbers b LEFT JOIN commission_ledger l ON l.barber_id=b.id GROUP BY b.id HAVING COUNT(l.id) > 0 ORDER BY owed_kobo DESC, b.id`);
    const out = [] as any[];
    for (const r of rows) { const bl = await ledgerBlocked(db, r.id, s); out.push({ ...r, owed_kobo: kobo(r.owed_kobo), accrued_total_kobo: kobo(r.accrued_total_kobo), oldest_days: bl.oldest_days, blocked: bl.blocked, blocked_reason: bl.reason }); }
    res.json({ barbers: out, total_owed_kobo: out.reduce((a, b) => a + b.owed_kobo, 0), rules: { commission_enabled: s.commission_enabled, commission_factor: s.commission_factor, max_debt_kobo: s.ledger_max_debt_kobo, max_age_days: s.ledger_max_age_days, min_payout_percent: s.min_barber_payout_percent } });
  });
  get('/ledger/:barberId', async (req, res) => {
    const id = idOf(req.params.barberId);
    const b = await db.maybeOne<any>('SELECT id, shop_name FROM barbers WHERE id=$1', [id]); if (!b) throw notFound('Barber not found');
    const entries = await db.many(`SELECT l.id, l.booking_id, l.kind, l.amount_kobo, l.remaining_kobo, l.status, l.note, l.created_at, l.settled_at FROM commission_ledger l WHERE l.barber_id=$1 ORDER BY l.id DESC LIMIT 200`, [id]);
    const apps = await db.many(`SELECT a.id, a.ledger_id, a.kind, a.amount_kobo, a.reason, a.created_at, p.reference FROM ledger_applications a JOIN commission_ledger l ON l.id=a.ledger_id LEFT JOIN payments p ON p.id=a.payment_id WHERE l.barber_id=$1 ORDER BY a.id DESC LIMIT 200`, [id]);
    res.json({ barber: b, balance: await ledgerBlocked(db, id), entries, applications: apps });
  });
  const ledgerAction = (kind: 'settle' | 'waive' | 'adjust'): H => async (req, res) => {
    const id = idOf(req.params.barberId);
    const d = parseB(z.object({ amount_naira: z.coerce.number().positive().max(10_000_000).optional(), all: z.boolean().optional(), reason: reasonZ.shape.reason }), req.body);
    if (kind !== 'settle') await requirePin(db, req);    // waive / adjust permanently change what a barber owes
    res.json(await db.tx(async (t) => {
      const b = await t.maybeOne<any>('SELECT id, shop_name, user_id FROM barbers WHERE id=$1 FOR UPDATE', [id]); if (!b) throw notFound('Barber not found');
      const owed = await outstandingKobo(t, id);
      const amt = d.all ? owed : Math.round((d.amount_naira ?? 0) * 100);
      if (amt <= 0) throw badRequest(d.all ? 'Nothing is owed.' : 'Enter an amount.');
      let applied = amt;
      if (kind === 'adjust') await addAdjustment(t, id, amt, d.reason);
      else { if (amt > owed) throw badRequest(`Only ${naira(owed)} is owed.`); applied = kind === 'settle' ? await manualSettle(t, id, amt, d.reason) : await waive(t, id, amt, d.reason); }
      await audit(t, null, ADMIN, kind === 'settle' ? 'ADMIN_LEDGER_SETTLED' : kind === 'waive' ? 'ADMIN_LEDGER_WAIVED' : 'ADMIN_LEDGER_ADJUSTED', { barber_id: id, shop: b.shop_name, amount_kobo: applied, reason: d.reason });
      const left = await outstandingKobo(t, id);
      await notify(t, b.user_id, 'LEDGER_UPDATE', 'Platform balance updated', `${kind === 'settle' ? `${naira(applied)} was marked as paid` : kind === 'waive' ? `${naira(applied)} was waived` : `${naira(applied)} was added to your balance`}: ${d.reason}. Balance owed now: ${naira(left)}.`);
      return { applied_kobo: applied, owed_kobo: left };
    }));
  };
  post('/ledger/:barberId/settle', ledgerAction('settle')); post('/ledger/:barberId/waive', ledgerAction('waive')); post('/ledger/:barberId/adjust', ledgerAction('adjust'));
  post('/ledger/remind', async (req, res) => {
    const bid = req.body?.barber_id ? idOf(req.body.barber_id) : undefined;
    const n = await db.tx((t) => sendLedgerReminders(t, bid, true));
    await audit(db, null, ADMIN, 'ADMIN_LEDGER_REMINDED', { barber_id: bid ?? null, reminded: n });
    res.json({ reminded: n });
  });

  /* ================= analytics ================= */
  get('/analytics', async (req, res) => {
    const days = Number(req.query.days) === 7 ? 7 : 30; const to = lagosDate(); const from = addDays(to, -(days - 1));
    const series = await db.many<any>(`SELECT d::date AS day,
        (SELECT COUNT(*) FROM bookings k WHERE (k.created_at AT TIME ZONE 'Africa/Lagos')::date = d::date AND NOT (k.payment_option='ONLINE' AND k.paid_at IS NULL))::int AS bookings,
        (SELECT COUNT(*) FROM bookings k WHERE k.date = d::date AND k.status='COMPLETED')::int AS completed,
        (SELECT COALESCE(SUM(p.amount_kobo),0) FROM payments p WHERE p.status='SUCCESS' AND (p.verified_at AT TIME ZONE 'Africa/Lagos')::date = d::date)::bigint AS revenue_kobo
      FROM generate_series($1::date, $2::date, interval '1 day') d ORDER BY d`, [from, to]);
    const top = await db.many<any>(`SELECT b.id, b.shop_name, COUNT(k.id) FILTER (WHERE k.status='COMPLETED')::int AS completed,
        COALESCE((SELECT SUM(p.amount_kobo) FROM payments p WHERE p.barber_id=b.id AND p.status='SUCCESS' AND (p.verified_at AT TIME ZONE 'Africa/Lagos')::date BETWEEN $1 AND $2),0)::bigint AS revenue_kobo
      FROM barbers b LEFT JOIN bookings k ON k.barber_id=b.id AND k.date BETWEEN $1 AND $2 GROUP BY b.id ORDER BY completed DESC, revenue_kobo DESC LIMIT 5`, [from, to]);
    const r = await db.one<any>(`SELECT
        COUNT(*) FILTER (WHERE status='COMPLETED')::int AS completed, COUNT(*) FILTER (WHERE status='NO_SHOW')::int AS no_show,
        COUNT(*) FILTER (WHERE status='CANCELLED' AND cancelled_by IN ('customer','barber','admin'))::int AS cancelled,
        COUNT(*) FILTER (WHERE NOT (payment_option='ONLINE' AND paid_at IS NULL))::int AS real_bookings,
        COUNT(*) FILTER (WHERE payment_option='ONLINE')::int AS online_attempts,
        COUNT(*) FILTER (WHERE payment_option='ONLINE' AND paid_at IS NULL AND status IN ('CANCELLED','PENDING_PAYMENT'))::int AS online_incomplete
      FROM bookings WHERE date BETWEEN $1 AND $2`, [from, to]);
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
    const tot = series.reduce((a: any, s: any) => ({ bookings: a.bookings + s.bookings, revenue_kobo: a.revenue_kobo + kobo(s.revenue_kobo) }), { bookings: 0, revenue_kobo: 0 });
    res.json({ days, from, to, series: series.map((s: any) => ({ day: String(s.day).slice(0, 10), bookings: s.bookings, completed: s.completed, revenue_kobo: kobo(s.revenue_kobo) })), totals: tot,
      top_barbers: top.map((t: any) => ({ ...t, revenue_kobo: kobo(t.revenue_kobo) })),
      rates: { no_show_pct: pct(r.no_show, r.completed + r.no_show), cancellation_pct: pct(r.cancelled, r.real_bookings), incomplete_payment_pct: pct(r.online_incomplete, r.online_attempts), completed: r.completed, no_show: r.no_show, cancelled: r.cancelled, online_attempts: r.online_attempts, online_incomplete: r.online_incomplete } });
  });

  /* ================= search + audit ================= */
  get('/search', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 60);
    if (q.length < 2) return void res.json({ q, users: [], bookings: [], payments: [], barbers: [] });
    const n = /^#?\d+$/.test(q) ? Number(q.replace('#', '')) : null; const l = like(q);
    const users = await db.many(`SELECT id, role, name, email, phone, account_status FROM users WHERE name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1 ${n ? 'OR id=' + n : ''} ORDER BY id DESC LIMIT 8`, [l]);
    const bookings = await db.many(`SELECT k.id, k.date, k.start_min, k.service_name, k.status, k.payment_status, b.shop_name, cu.name AS customer_name FROM bookings k JOIN barbers b ON b.id=k.barber_id JOIN users cu ON cu.id=k.customer_id WHERE k.service_name ILIKE $1 OR cu.name ILIKE $1 OR b.shop_name ILIKE $1 ${n ? 'OR k.id=' + n : ''} ORDER BY k.id DESC LIMIT 8`, [l]);
    const payments = await db.many(`SELECT p.reference, p.amount_kobo, p.status, p.refund_status, p.booking_id FROM payments p WHERE p.reference ILIKE $1 ORDER BY p.id DESC LIMIT 8`, [l]);
    const barbers = await db.many(`SELECT b.id, b.shop_name, b.review_status, u.name FROM barbers b JOIN users u ON u.id=b.user_id WHERE b.shop_name ILIKE $1 OR u.name ILIKE $1 ${n ? 'OR b.id=' + n : ''} ORDER BY b.id DESC LIMIT 8`, [l]);
    res.json({ q, users, bookings, payments, barbers });
  });
  get('/audit', async (req, res) => {
    const p: unknown[] = []; const w: string[] = [];
    if (req.query.scope !== 'all') w.push(`(actor_role='admin' OR action IN ('SETTINGS_UPDATED','BARBER_SIGNUP','BARBER_RESUBMITTED','BARBER_VERIFIED','BARBER_UNVERIFIED'))`);
    const action = String(req.query.action || '').trim().toUpperCase().replace(/[^A-Z_]/g, ''); if (action) { p.push(action + '%'); w.push(`action LIKE $${p.length}`); }
    const q = String(req.query.q || '').trim().slice(0, 60); if (q) { p.push(like(q)); w.push(`(action ILIKE $${p.length} OR details::text ILIKE $${p.length}${/^\d+$/.test(q) ? ` OR booking_id=${Number(q)}` : ''})`); }
    const from = dateQ(req.query.from), to = dateQ(req.query.to);
    if (from) { p.push(from); w.push(`(created_at AT TIME ZONE 'Africa/Lagos')::date >= $${p.length}`); }
    if (to) { p.push(to); w.push(`(created_at AT TIME ZONE 'Africa/Lagos')::date <= $${p.length}`); }
    if (req.query.actor && ['admin', 'system', 'customer', 'barber'].includes(String(req.query.actor))) { p.push(String(req.query.actor)); w.push(`actor_role=$${p.length}`); }
    const before = Number(req.query.before); if (Number.isInteger(before) && before > 0) { p.push(before); w.push(`id < $${p.length}`); }
    const limit = Math.min(300, Math.max(10, Number(req.query.limit) || 100));
    const rows = await db.many(`SELECT id, booking_id, actor_role, action, details, created_at FROM audit_log ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`, p);
    const actions = (await db.many<any>(`SELECT action, COUNT(*)::int n FROM audit_log GROUP BY action ORDER BY n DESC LIMIT 60`)).map((r: any) => r.action).sort();
    res.json({ entries: rows, actions, next_before: rows.length === limit ? (rows[rows.length - 1] as any).id : null });
  });
}
