import { Conn, Db, isExclusionViolation, isUniqueViolation } from './db';
import { config, CANCEL_CUTOFF_MIN } from './config';
import { AppError, badRequest, conflict, notFound } from './errors';
import { assertTransition, QUEUE_ACTIVE, Status } from './stateMachine';
import { Actor, audit, fmtWhen, naira, notify } from './helpers';
import { generateSlots, loadSchedule, busyIntervals, validateBookableDate } from './slots';
import { claimEntitlement, getSettings, issueCredit, restoreEntitlement } from './plans';
import { accrueCommission, assertBookable } from './ledger';
import { clock, isoNow, lagosDate, lagosMinutes, scheduledInstant, hhmmToMin } from './time';

/** Timestamps are ISO-8601 UTC strings, `date` is the Lagos calendar date 'YYYY-MM-DD' (derived by Postgres from scheduled_at). */
export interface BookingRow {
  id: number; customer_id: number; barber_id: number; service_id: number;
  family_member_id: number | null; entitlement_type: string;
  date: string; start_min: number; end_min: number; scheduled_at: string; ends_at: string;
  service_name: string; price_kobo: number; duration_min: number;
  status: Status; payment_option: 'ONLINE' | 'ON_ARRIVAL' | 'PLAN' | 'CREDIT';
  payment_status: 'PENDING' | 'PAYMENT_DUE' | 'PAID' | 'CREDIT_PENDING' | 'CREDITED' | 'VOID';
  plan_purchase_id: number | null; credit_id: number | null;
  paid_via: string | null; paid_at: string | null; hold_expires_at: string | null;
  arrival_time: string | null; arrival_source: string | null;
  service_start: string | null; service_complete: string | null;
  cancelled_at: string | null; cancelled_by: string | null;
  barber_hold: boolean; skipped_at: string | null; last_queue_pos: number | null; created_at: string;
}

/** An "incomplete" booking = a Pay-now booking whose payment never completed (hold expired, or customer walked away). Customer-only. */
export const isIncomplete = (b: Pick<BookingRow, 'payment_option' | 'status' | 'payment_status' | 'paid_at'>) =>
  b.payment_option === 'ONLINE' && !b.paid_at && (b.status === 'PENDING_PAYMENT' || (b.status === 'CANCELLED' && b.payment_status === 'VOID'));
/** SQL fragment (table alias optional): rows a BARBER may see = everything except incomplete Pay-now bookings. */
export const barberVisible = (a = '') => { const p = a ? a + '.' : ''; return `NOT (${p}payment_option='ONLINE' AND ${p}paid_at IS NULL AND (${p}status='PENDING_PAYMENT' OR (${p}status='CANCELLED' AND ${p}payment_status='VOID')))`; };

export const getBooking = (c: Conn, id: number) => c.maybeOne<BookingRow>('SELECT * FROM bookings WHERE id=$1', [id]);
/** Row lock: serialises concurrent state changes / payment processing on one booking. */
export const getBookingForUpdate = (c: Conn, id: number) => c.maybeOne<BookingRow>('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [id]);
const barberUserId = async (c: Conn, barberId: number) => (await c.one<{ user_id: number }>('SELECT user_id FROM barbers WHERE id=$1', [barberId])).user_id;
const customerName = async (c: Conn, id: number) => (await c.maybeOne<{ name: string }>('SELECT name FROM users WHERE id=$1', [id]))?.name ?? 'Customer';

/* ---------------- cancellation rule (pure) ---------------- */
export function cancelCutoff(scheduledAtIso: string): Date {
  return new Date(new Date(scheduledAtIso).getTime() - CANCEL_CUTOFF_MIN * 60000);
}
/** Customer may cancel until exactly 30 minutes before the appointment (inclusive). */
export function canCustomerCancel(scheduledAtIso: string, now: Date): boolean {
  return now.getTime() <= cancelCutoff(scheduledAtIso).getTime();
}

/* ---------------- attempt expiry ----------------
 * An unpaid Pay-now attempt (PENDING_PAYMENT) does NOT reserve a slot at all - only complete bookings (paid, pay-on-arrival, plan/credit) do.
 * `hold_expires_at` is just how long the attempt stays open before it is marked Incomplete. Expired attempts are closed LAZILY: by every booking creation (for that barber), by every authenticated API request (for that user),
 * and by the optional cron sweeper. Slot availability additionally ignores expired holds in SQL (slots.busyIntervals), so correctness never
 * depends on the sweeper running. */
export interface HoldScope { barberId?: number; customerId?: number }

export async function expireHoldsIn(c: Conn, scope: HoldScope = {}): Promise<number> {
  const now = isoNow();
  const params: unknown[] = [now];
  let where = `status='PENDING_PAYMENT' AND hold_expires_at IS NOT NULL AND hold_expires_at < $1`;
  if (scope.barberId != null) { params.push(scope.barberId); where += ` AND barber_id=$${params.length}`; }
  if (scope.customerId != null) { params.push(scope.customerId); where += ` AND customer_id=$${params.length}`; }
  // UPDATE re-checks the WHERE after taking the row lock, so a payment confirmed a millisecond earlier is never cancelled.
  const rows = await c.many<BookingRow>(
    `UPDATE bookings SET status='CANCELLED', payment_status='VOID', cancelled_at=$1, cancelled_by='system' WHERE ${where} RETURNING *`, params);
  for (const b of rows) {
    await audit(c, b.id, { id: null, role: 'system' }, 'HOLD_EXPIRED', { note: 'Payment not completed in time; slot released' });
    // Customer-only: an unpaid Pay-now hold never existed as far as the barber is concerned.
    await notify(c, b.customer_id, 'BOOKING_INCOMPLETE', 'Booking incomplete', `Your ${b.service_name} booking for ${fmtWhen(b.date, b.start_min)} was not completed because payment wasn't finished, so the slot was released. You haven't been charged - just book again.`, b.id);
  }
  return rows.length;
}

/** Cheap pre-check (1 indexed read) so ordinary requests don't open a write transaction. */
export async function expireHolds(db: Db, scope: HoldScope = {}): Promise<number> {
  const params: unknown[] = [isoNow()];
  let where = `status='PENDING_PAYMENT' AND hold_expires_at < $1`;
  if (scope.barberId != null) { params.push(scope.barberId); where += ` AND barber_id=$${params.length}`; }
  if (scope.customerId != null) { params.push(scope.customerId); where += ` AND customer_id=$${params.length}`; }
  if (!(await db.maybeOne(`SELECT 1 FROM bookings WHERE ${where} LIMIT 1`, params))) return 0;
  return db.tx((t) => expireHoldsIn(t, scope));
}

/* ---------------- create ---------------- */
export interface CreateInput { barber_id: number; service_id: number; date: string; time: string; payment_option: 'ONLINE' | 'ON_ARRIVAL' | 'PLAN' | 'CREDIT'; plan_purchase_id?: number; credit_id?: number }

export async function createBooking(db: Db, customerId: number, input: CreateInput): Promise<BookingRow> {
  validateBookableDate(input.date);
  if (!/^\d{2}:\d{2}$/.test(input.time)) throw badRequest('time must be HH:MM');
  const startMin = hhmmToMin(input.time);
  return db.tx(async (t) => {
    // 1) Serialise every booking attempt for this barber: whoever gets this row lock first books first; the other then sees the new row.
    const barber = await t.maybeOne('SELECT id FROM barbers WHERE id=$1 AND verified FOR UPDATE', [input.barber_id]);
    if (!barber) throw notFound('Barber not found');
    await assertBookable(t, input.barber_id, input.payment_option);
    { const cu = await t.maybeOne<any>('SELECT account_status, status_reason FROM users WHERE id=$1', [customerId]); if (cu && cu.account_status !== 'ACTIVE') throw new AppError(403, 'ACCOUNT_RESTRICTED', `Your account cannot make bookings${cu.status_reason ? ': ' + cu.status_reason : ''}. Please contact support.`); }
    // (Unpaid Pay-now attempts never occupy a slot, so there is nothing to release here.)
    // Price/duration ALWAYS come from the server-side service row - never from the client.
    const svc = await t.maybeOne('SELECT * FROM services WHERE id=$1 AND barber_id=$2 AND active', [input.service_id, input.barber_id]);
    if (!svc) throw notFound('Service not found for this barber');
    const { schedule, dayOff } = await loadSchedule(t, input.barber_id, input.date);
    const isToday = input.date === lagosDate(clock.now());
    const free = generateSlots({ schedule, isDayOff: !!dayOff, durationMin: svc.duration_min, busy: await busyIntervals(t, input.barber_id, input.date), nowMin: isToday ? lagosMinutes(clock.now()) : null });
    if (!free.some((s) => s.start === startMin)) throw conflict('SLOT_UNAVAILABLE', 'That time is no longer available. Please pick another slot.');
    const endMin = startMin + svc.duration_min;
    // A customer cannot hold two overlapping appointments
    const mine = await t.many('SELECT start_min, end_min FROM bookings WHERE customer_id=$1 AND date=$2 AND status IN (\'CONFIRMED\',\'ARRIVED\',\'IN_SERVICE\')', [customerId, input.date]);
    if (mine.some((m) => m.start_min < endMin && startMin < m.end_min)) throw conflict('CUSTOMER_OVERLAP', 'You already have a booking that overlaps this time.');
    const online = input.payment_option === 'ONLINE';
    const start = scheduledInstant(input.date, startMin);
    const holdUntil = online ? new Date(clock.now().getTime() + config.paymentHoldMin * 60000).toISOString() : null;
    // Plan session / credit: spent atomically in THIS transaction (conditional UPDATE => no double spend); booking is complete immediately.
    const ent = input.payment_option === 'PLAN' || input.payment_option === 'CREDIT'
      ? await claimEntitlement(t, { customerId, barberId: input.barber_id, serviceId: svc.id, priceKobo: svc.price_kobo, startAt: start, option: input.payment_option, id: input.payment_option === 'PLAN' ? input.plan_purchase_id : input.credit_id })
      : null;
    const now = isoNow();
    let b: BookingRow;
    try {
      b = await t.one<BookingRow>(`INSERT INTO bookings (customer_id, barber_id, service_id, family_member_id, entitlement_type, scheduled_at, ends_at,
            service_name, price_kobo, duration_min, status, payment_option, payment_status, paid_via, paid_at, hold_expires_at, plan_purchase_id, credit_id, created_at)
          VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [customerId, input.barber_id, svc.id, ent ? (ent.option === 'PLAN' ? 'SUBSCRIPTION' : 'CREDIT') : 'NONE', start.toISOString(), new Date(start.getTime() + svc.duration_min * 60000).toISOString(),
          svc.name, svc.price_kobo, svc.duration_min, online ? 'PENDING_PAYMENT' : 'CONFIRMED', input.payment_option, ent ? 'PAID' : online ? 'PENDING' : 'PAYMENT_DUE',
          ent ? ent.option : null, ent ? now : null, holdUntil, ent?.plan_purchase_id ?? null, ent?.credit_id ?? null, now]);
    } catch (e: any) {
      // Backstop: the unique index / exclusion constraint fired (should be unreachable behind the barber lock, but the DB is the final judge).
      if (isUniqueViolation(e) || isExclusionViolation(e)) throw conflict('SLOT_UNAVAILABLE', 'That time was just taken. Please pick another slot.');
      throw e;
    }
    if (ent?.credit_id) await t.query('UPDATE session_credits SET used_booking_id=$1 WHERE id=$2', [b.id, ent.credit_id]);
    await audit(t, b.id, { id: customerId, role: 'customer' }, 'BOOKED', { payment_option: input.payment_option, price_kobo: svc.price_kobo, status: b.status });
    if (!online) await announceConfirmed(t, b);
    return b;
  });
}

async function announceConfirmed(c: Conn, b: BookingRow) {
  const when = fmtWhen(b.date, b.start_min);
  await notify(c, b.customer_id, 'BOOKING_CONFIRMED', 'Booking confirmed', `${b.service_name} on ${when}. ${b.payment_option === 'ON_ARRIVAL' ? `Pay ${naira(b.price_kobo)} on arrival.` : b.payment_option === 'PLAN' ? 'Covered by your plan session.' : b.payment_option === 'CREDIT' ? 'Covered by your session credit.' : 'Payment received.'}`, b.id);
  await notify(c, await barberUserId(c, b.barber_id), 'NEW_BOOKING', 'New booking', `${await customerName(c, b.customer_id)} booked ${b.service_name} on ${when}${b.payment_option === 'PLAN' ? ' (plan session)' : b.payment_option === 'CREDIT' ? ' (session credit)' : ''}.`, b.id);
}

/* ---------------- payment confirmation (called only after SERVER-SIDE verification, inside the caller's transaction) ---------------- */
/** Is this booking's time still bookable right now (working hours, not a day off, not started, and no COMPLETE booking overlapping)? */
async function slotStillFree(t: Conn, b: BookingRow): Promise<boolean> {
  const { schedule, dayOff } = await loadSchedule(t, b.barber_id, b.date);
  const isToday = b.date === lagosDate(clock.now());
  const free = generateSlots({ schedule, isDayOff: !!dayOff, durationMin: b.duration_min, busy: await busyIntervals(t, b.barber_id, b.date), nowMin: isToday ? lagosMinutes(clock.now()) : null });
  return free.some((s) => s.start === b.start_min);
}

/** Money arrived that cannot be honoured: never keep it silently. Recorded on the payment row (NEEDS_REFUND) and audited; the caller tries the gateway refund after commit. */
async function flagRefund(t: Conn, b: BookingRow, reference: string | undefined, reason: string) {
  await t.query(`UPDATE payments SET refund_status='NEEDS_REFUND', refund_reason=$1 WHERE status='SUCCESS' AND refund_status IS NULL AND (reference=$2 OR ($2::text IS NULL AND booking_id=$3))`, [reason, reference ?? null, b.id]);
}

export type PaymentOutcome = 'confirmed' | 'already_paid' | 'late_payment' | 'slot_taken';
export async function applyVerifiedPayment(t: Conn, bookingId: number, via: string, reference?: string): Promise<PaymentOutcome> {
  // Lock order is always barber -> booking (same as createBooking), so a payment and a fresh booking for the same barber serialise instead of deadlocking.
  const pre = await t.maybeOne<{ barber_id: number }>('SELECT barber_id FROM bookings WHERE id=$1', [bookingId]);
  if (!pre) throw notFound('Booking not found');
  await t.query('SELECT 1 FROM barbers WHERE id=$1 FOR UPDATE', [pre.barber_id]);
  const b = await getBookingForUpdate(t, bookingId);     // row lock: serialises with attempt-expiry, cancel and duplicate payments
  if (!b) throw notFound('Booking not found');
  const now = isoNow();
  if (b.status === 'PENDING_PAYMENT') {
    // The attempt reserved nothing, so the slot must be RE-CHECKED now, under the barber lock. If someone else took it: do not confirm.
    if (!(await slotStillFree(t, b))) {
      assertTransition('PENDING_PAYMENT', 'CANCELLED');
      await t.query(`UPDATE bookings SET status='CANCELLED', payment_status='VOID', cancelled_at=$1, cancelled_by='system', hold_expires_at=NULL WHERE id=$2`, [now, b.id]);
      await flagRefund(t, b, reference, 'Slot was taken before payment completed');
      await audit(t, b.id, { id: null, role: 'system' }, 'PAYMENT_SLOT_TAKEN', { via, amount_kobo: b.price_kobo, note: 'slot no longer free at payment time - booking NOT confirmed; payment flagged NEEDS_REFUND' });
      await notify(t, b.customer_id, 'BOOKING_INCOMPLETE', 'Slot no longer available', `Your payment for ${b.service_name} on ${fmtWhen(b.date, b.start_min)} arrived after someone else booked that time, so your booking was not confirmed. We're refunding ${naira(b.price_kobo)} to your card - please book another time.`, b.id);
      return 'slot_taken';
    }
    assertTransition('PENDING_PAYMENT', 'CONFIRMED');
    await t.query(`UPDATE bookings SET status='CONFIRMED', payment_status='PAID', paid_via=$1, paid_at=$2, hold_expires_at=NULL WHERE id=$3`, [via, now, b.id]);
    await audit(t, b.id, { id: null, role: 'system' }, 'PAYMENT_CONFIRMED', { via, amount_kobo: b.price_kobo });
    await announceConfirmed(t, (await getBooking(t, b.id))!);
    await notify(t, b.customer_id, 'PAYMENT_SUCCESS', 'Payment successful', `We received ${naira(b.price_kobo)} for your ${b.service_name}. Your slot is now secured.`, b.id);
    return 'confirmed';
  }
  if (b.payment_status === 'PAID' || b.payment_status === 'CREDIT_PENDING' || b.payment_status === 'CREDITED') {
    await flagRefund(t, b, reference, 'Duplicate payment for an already-paid booking');
    await audit(t, b.id, { id: null, role: 'system' }, 'DUPLICATE_PAYMENT', { via, note: 'extra successful payment on an already-paid booking - flagged NEEDS_REFUND' });
    return 'already_paid';
  }
  // Money arrived for an attempt that was already closed (expired / abandoned). The booking stays Incomplete (barber never sees it); the money is flagged for refund.
  await flagRefund(t, b, reference, 'Payment arrived after the attempt was closed');
  await audit(t, b.id, { id: null, role: 'system' }, 'LATE_PAYMENT', { via, status: b.status, note: 'payment received after the attempt was closed - booking NOT confirmed; payment flagged NEEDS_REFUND' });
  await notify(t, b.customer_id, 'PAYMENT_SUCCESS', 'Payment received - refund on its way', `We received ${naira(b.price_kobo)} after your ${b.service_name} attempt had already closed, so no booking was made. It is being refunded to you.`, b.id);
  return 'late_payment';
}

/* ---------------- queue ---------------- */
/** Ordered live queue for one barber on one date. IN_SERVICE first, then ARRIVED, then not-yet-arrived; skipped go last in their group; ties by scheduled time. */
export async function orderedQueue(c: Conn, barberId: number, date: string): Promise<BookingRow[]> {
  const rows = await c.many<BookingRow>(`SELECT * FROM bookings WHERE barber_id=$1 AND date=$2 AND status = ANY($3::text[])`, [barberId, date, QUEUE_ACTIVE as unknown as string[]]);
  const rank = (b: BookingRow) => (b.status === 'IN_SERVICE' ? 0 : b.status === 'ARRIVED' ? 1 : 2);
  return rows.sort((a, b) =>
    rank(a) - rank(b) ||
    (a.skipped_at ? 1 : 0) - (b.skipped_at ? 1 : 0) ||
    (a.skipped_at && b.skipped_at ? a.skipped_at.localeCompare(b.skipped_at) : 0) ||
    a.start_min - b.start_min || a.id - b.id);
}

export type QueueState = 'BEING_SERVED' | 'READY' | 'NEXT' | 'IN_LINE' | 'NOT_ACTIVE';
export async function queueInfo(c: Conn, b: BookingRow, preloaded?: BookingRow[]) {
  if (!QUEUE_ACTIVE.includes(b.status)) return { state: 'NOT_ACTIVE' as QueueState, position: null, ahead: null, message: '', now_serving: false, is_today: b.date === lagosDate() };
  const isToday = b.date === lagosDate();
  const q = preloaded ?? await orderedQueue(c, b.barber_id, b.date);
  const idx = q.findIndex((x) => x.id === b.id);
  const serving = q.some((x) => x.status === 'IN_SERVICE');
  const ahead = idx; // includes the customer currently in the chair
  const position = idx + 1;
  let state: QueueState; let message: string;
  if (b.status === 'IN_SERVICE') { state = 'BEING_SERVED'; message = "You're being served now"; }
  else if (ahead === 0) { state = 'READY'; message = b.status === 'ARRIVED' ? 'Your barber is ready for you' : 'Your barber is ready - tap "I\'m Here" when you arrive'; }
  else if (ahead === 1 && serving) { state = 'NEXT'; message = "You're next"; }
  else { state = 'IN_LINE'; message = `You're #${position} in line - ${ahead} customer${ahead === 1 ? '' : 's'} ahead`; }
  return { state, position, ahead, message, now_serving: serving, is_today: isToday, total_in_queue: q.length };
}

/** Send queue-position notifications to ARRIVED customers whose position changed. */
export async function refreshQueueNotifications(c: Conn, barberId: number, date: string) {
  const q = await orderedQueue(c, barberId, date);
  const serving = q.some((x) => x.status === 'IN_SERVICE');
  for (let idx = 0; idx < q.length; idx++) {
    const b = q[idx];
    const pos = idx + 1;
    // "next while somebody is being served" is a different state from "second in an idle queue": encode it so the customer is told when the chair gets busy.
    const key = idx === 1 && serving ? pos + 1000 : pos;
    if (b.last_queue_pos === key) continue;
    await c.query('UPDATE bookings SET last_queue_pos=$1 WHERE id=$2', [key, b.id]);
    if (b.status !== 'ARRIVED') continue;
    const ahead = idx;
    if (ahead === 0) await notify(c, b.customer_id, 'YOUR_TURN', 'Your barber is ready', 'Please head to the chair - your barber is ready for you.', b.id);
    else if (ahead === 1 && serving) await notify(c, b.customer_id, 'YOURE_NEXT', "You're next", "You're next in line. Stay close!", b.id);
    else await notify(c, b.customer_id, 'QUEUE_CHANGED', 'Queue update', `You're now #${pos} in line (${ahead} ahead).`, b.id);
  }
}

/* ---------------- shared transition helper ---------------- */
async function setStatus(c: Conn, b: BookingRow, to: Status, sets: Record<string, unknown> = {}) {
  assertTransition(b.status, to);
  const cols = Object.keys(sets);   // column names come from code, never from user input
  const sql = `UPDATE bookings SET status=$1${cols.map((k, i) => `, ${k}=$${i + 2}`).join('')} WHERE id=$${cols.length + 2} AND status=$${cols.length + 3}`;
  const r = await c.query(sql, [to, ...cols.map((k) => sets[k]), b.id, b.status]);
  if (r.rowCount !== 1) throw conflict('STALE_STATE', 'This booking was just changed by someone else. Refresh and try again.');
}

/* ---------------- customer actions ---------------- */
export async function customerCancel(db: Db, customerId: number, bookingId: number) {
  return db.tx(async (t) => {
    const b = await getBookingForUpdate(t, bookingId);
    if (!b || b.customer_id !== customerId) throw notFound('Booking not found');
    if (!['PENDING_PAYMENT', 'CONFIRMED', 'ARRIVED'].includes(b.status)) {
      throw new AppError(409, 'ILLEGAL_TRANSITION', `This booking is ${b.status} and cannot be cancelled.`);
    }
    if (!canCustomerCancel(b.scheduled_at, clock.now())) {
      throw new AppError(403, 'CANCEL_LOCKED', `Cancellation closed ${CANCEL_CUTOFF_MIN} minutes before your appointment, so this time stays booked for you. If you don't make it, it counts as a missed session: no refund, but a paid session becomes one credit with this barber. Please contact your barber if something came up.`);
    }
    const now = isoNow();
    const abandoned = isIncomplete({ ...b, status: 'PENDING_PAYMENT' });   // walked away from an unpaid Pay-now attempt: barber never hears about it
    let payStatus: string = b.payment_status === 'PAID' ? 'CREDIT_PENDING' : 'VOID';
    let note = '';
    if (b.payment_status === 'PAID' && (b.plan_purchase_id || b.credit_id)) {
      // Cancelled in time: the plan session / credit simply goes back to the customer (same expiry rules still apply).
      await restoreEntitlement(t, b);
      payStatus = 'VOID'; note = b.plan_purchase_id ? 'Your plan session has been returned.' : 'Your session credit has been returned.';
    } else if (b.payment_status === 'PAID') {
      const s = await getSettings(t);
      if (s.credit_on_early_cancel_prepaid) { await issueCredit(t, b, 'EARLY_CANCEL', s); payStatus = 'CREDITED'; note = 'You have a session credit with this barber (see My plans & credits).'; }
    }
    await setStatus(t, b, 'CANCELLED', { payment_status: payStatus, cancelled_at: now, cancelled_by: 'customer', hold_expires_at: null });
    await audit(t, b.id, { id: customerId, role: 'customer' }, 'CANCELLED', {
      payment_status: payStatus,
      ...(payStatus === 'CREDIT_PENDING' ? { note: 'TODO(owner): refund/credit policy undecided - NOT refunded automatically' } : note ? { note } : {}),
    });
    if (!abandoned) await notify(t, await barberUserId(t, b.barber_id), 'BOOKING_CANCELLED', 'Booking cancelled', `${await customerName(t, customerId)} cancelled ${b.service_name} on ${fmtWhen(b.date, b.start_min)}. The slot is open again.`, b.id);
    await notify(t, customerId, abandoned ? 'BOOKING_INCOMPLETE' : 'BOOKING_CANCELLED', abandoned ? 'Booking incomplete' : 'Booking cancelled', abandoned ? 'You left this booking before paying, so it was marked incomplete. You have not been charged.' : payStatus === 'CREDIT_PENDING'
      ? `Your booking was cancelled. Your payment of ${naira(b.price_kobo)} is marked credit pending - it is not refunded automatically; the shop will follow up.`
      : `Your booking was cancelled and the slot has been released. ${note}`.trim(), b.id);
    await refreshQueueNotifications(t, b.barber_id, b.date);
    return (await getBooking(t, b.id))!;
  });
}

async function markArrived(t: Conn, b: BookingRow, actor: Actor, source: 'CUSTOMER' | 'BARBER') {
  if (b.date !== lagosDate()) throw new AppError(409, 'NOT_TODAY', 'Check-in is only available on the day of the booking.');
  if (b.status !== 'CONFIRMED') {
    if (b.status === 'PENDING_PAYMENT') throw new AppError(409, 'PAYMENT_PENDING', 'Payment is still pending for this booking.');
    throw new AppError(409, 'ILLEGAL_TRANSITION', `This booking is ${b.status}; it cannot be checked in.`);
  }
  const now = isoNow();
  await setStatus(t, b, 'ARRIVED', { arrival_time: now, arrival_source: source, barber_hold: false });
  await audit(t, b.id, actor, source === 'CUSTOMER' ? 'CHECKED_IN' : 'MARKED_PRESENT', { arrival_time: now });
  await notify(t, await barberUserId(t, b.barber_id), 'CUSTOMER_ARRIVED', 'Customer arrived', `${await customerName(t, b.customer_id)} is here for ${b.service_name} (${fmtWhen(b.date, b.start_min)}).`, b.id);
  await refreshQueueNotifications(t, b.barber_id, b.date);
}

export async function customerCheckIn(db: Db, customerId: number, bookingId: number) {
  return db.tx(async (t) => {
    const b = await getBookingForUpdate(t, bookingId);
    if (!b || b.customer_id !== customerId) throw notFound('Booking not found');
    await markArrived(t, b, { id: customerId, role: 'customer' }, 'CUSTOMER');
    return (await getBooking(t, b.id))!;
  });
}

/* ---------------- barber actions ---------------- */
export type BarberAction = 'mark-present' | 'start' | 'complete' | 'record-payment' | 'no-show' | 'skip' | 'wait' | 'not-served';

export async function barberAction(db: Db, barberUid: number, barberId: number, bookingId: number, action: BarberAction, body: any = {}) {
  return db.tx(async (t) => {
    const b = await getBookingForUpdate(t, bookingId);
    if (!b || b.barber_id !== barberId || isIncomplete(b)) throw notFound('Booking not found');
    const actor: Actor = { id: barberUid, role: 'barber' };
    const now = isoNow();
    switch (action) {
      case 'mark-present':
        await markArrived(t, b, actor, 'BARBER');
        break;
      case 'start': {
        if (b.date !== lagosDate()) throw new AppError(409, 'NOT_TODAY', "Only today's bookings can be started.");
        if (b.status !== 'ARRIVED') {
          throw new AppError(409, b.status === 'CONFIRMED' ? 'NOT_ARRIVED' : 'ILLEGAL_TRANSITION',
            b.status === 'CONFIRMED' ? 'Customer has not arrived yet. Tap "Mark Present" first.' : `Cannot start a booking that is ${b.status}.`);
        }
        if (await t.maybeOne(`SELECT id FROM bookings WHERE barber_id=$1 AND status='IN_SERVICE'`, [barberId])) throw conflict('ALREADY_SERVING', 'You are already serving someone. Complete that haircut first.');
        try {
          // scheduled time is NEVER rewritten - early arrivals are simply served early.
          await setStatus(t, b, 'IN_SERVICE', { service_start: now });
        } catch (e: any) {
          if (isUniqueViolation(e)) throw conflict('ALREADY_SERVING', 'You are already serving someone. Complete that haircut first.'); // uq_bookings_one_in_service
          throw e;
        }
        await audit(t, b.id, actor, 'STARTED', { scheduled_at: b.scheduled_at, arrival_time: b.arrival_time, service_start: now, early: new Date(now) < new Date(b.scheduled_at) });
        break;
      }
      case 'record-payment': {
        const method = String(body?.method || '').toUpperCase();
        if (!['CASH', 'TRANSFER'].includes(method)) throw badRequest('method must be "cash" or "transfer"');
        if (b.payment_option !== 'ON_ARRIVAL') throw new AppError(409, 'NOT_PAY_ON_ARRIVAL', 'This booking is an online payment; nothing to record.');
        if (b.payment_status !== 'PAYMENT_DUE') throw new AppError(409, 'ALREADY_PAID', `Payment status is ${b.payment_status}.`);
        if (!['ARRIVED', 'IN_SERVICE'].includes(b.status)) throw new AppError(409, 'ILLEGAL_STATE', 'Payment can be recorded once the customer has arrived.');
        await t.query(`UPDATE bookings SET payment_status='PAID', paid_via=$1, paid_at=$2 WHERE id=$3`, [method, now, b.id]);
        await audit(t, b.id, actor, 'PAYMENT_RECORDED', { method, amount_kobo: b.price_kobo });
        await notify(t, b.customer_id, 'PAYMENT_SUCCESS', 'Payment recorded', `${naira(b.price_kobo)} received (${method.toLowerCase()}). Thank you!`, b.id);
        break;
      }
      case 'complete': {
        if (b.status !== 'IN_SERVICE') throw new AppError(409, 'ILLEGAL_TRANSITION', `Cannot complete a booking that is ${b.status}.`);
        if (b.payment_status === 'PAYMENT_DUE') throw new AppError(409, 'PAYMENT_REQUIRED', 'Record the cash/transfer payment before completing this pay-on-arrival booking.');
        await setStatus(t, b, 'COMPLETED', { service_complete: now });
        await audit(t, b.id, actor, 'COMPLETED', { service_start: b.service_start, service_complete: now });
        await accrueCommission(t, b);      // off-app (pay on arrival) booking: commission debt goes on the barber's ledger
        break;
      }
      case 'no-show': {
        if (!['CONFIRMED', 'ARRIVED'].includes(b.status)) throw new AppError(409, 'ILLEGAL_TRANSITION', `Cannot mark a ${b.status} booking as no-show.`);
        if (new Date(now) < new Date(b.scheduled_at)) throw new AppError(409, 'TOO_EARLY', 'You can mark a no-show only after the scheduled time has passed.');
        await setStatus(t, b, 'NO_SHOW');
        if (b.payment_status === 'PENDING' || b.payment_status === 'PAYMENT_DUE') await t.query(`UPDATE bookings SET payment_status='VOID' WHERE id=$1`, [b.id]);
        // Missed PAID session (online or plan session): no refund; ONE credit with the SAME barber. A session already paid by a credit is not re-credited (that credit was the make-good).
        const s = await getSettings(t);
        const credit = b.payment_status === 'PAID' && b.payment_option !== 'CREDIT' && s.credit_on_missed_session ? await issueCredit(t, b, 'NO_SHOW', s) : null;
        if (credit) await t.query(`UPDATE bookings SET payment_status='CREDITED' WHERE id=$1`, [b.id]);
        await audit(t, b.id, actor, 'NO_SHOW', { credit_id: credit?.id ?? null, paid: b.payment_status === 'PAID', via: b.payment_option });
        await notify(t, b.customer_id, 'NO_SHOW', 'Marked as no-show', `You were marked as a no-show for ${b.service_name} on ${fmtWhen(b.date, b.start_min)}.${credit ? ' No refund, but you have 1 session credit with this barber.' : ''}`, b.id);
        break;
      }
      case 'not-served': {
        if (!['CONFIRMED', 'ARRIVED'].includes(b.status)) throw new AppError(409, 'ILLEGAL_TRANSITION', `Cannot mark a ${b.status} booking as not served.`);
        const entitlement = b.payment_status === 'PAID' && !!(b.plan_purchase_id || b.credit_id);   // the barber's fault: plan session / credit goes straight back
        const credit = b.payment_status === 'PAID' && !entitlement;
        if (entitlement) await restoreEntitlement(t, b);
        await setStatus(t, b, 'NOT_SERVED', { payment_status: credit ? 'CREDIT_PENDING' : entitlement || b.payment_status === 'PAYMENT_DUE' || b.payment_status === 'PENDING' ? 'VOID' : b.payment_status });
        await audit(t, b.id, actor, 'NOT_SERVED', { reason: String(body?.reason || '').slice(0, 200) || null, ...(credit ? { note: 'TODO(owner): refund/credit policy undecided - CREDIT_PENDING' } : entitlement ? { note: 'plan session / credit returned' } : {}) });
        await notify(t, b.customer_id, 'NOT_SERVED', "We couldn't serve you", `Sorry - your barber could not serve you for ${b.service_name} on ${fmtWhen(b.date, b.start_min)}.${credit ? ' Your payment is marked credit pending.' : entitlement ? ' Your session has been returned.' : ''}`, b.id);
        break;
      }
      case 'skip': {
        if (!['CONFIRMED', 'ARRIVED'].includes(b.status)) throw new AppError(409, 'ILLEGAL_TRANSITION', `Cannot skip a ${b.status} booking.`);
        await t.query('UPDATE bookings SET skipped_at=$1 WHERE id=$2', [now, b.id]);
        await audit(t, b.id, actor, 'SKIPPED', { note: 'moved to back of queue' });
        break;
      }
      case 'wait': {
        if (b.status !== 'CONFIRMED') throw new AppError(409, 'ILLEGAL_STATE', 'Wait applies to customers who have not arrived yet.');
        await t.query('UPDATE bookings SET barber_hold=TRUE WHERE id=$1', [b.id]);
        await audit(t, b.id, actor, 'WAITING_FOR_CUSTOMER', {});
        break;
      }
    }
    await refreshQueueNotifications(t, b.barber_id, b.date);
    return (await getBooking(t, b.id))!;
  });
}
