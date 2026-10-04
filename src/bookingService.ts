import { Conn, Db, isExclusionViolation, isUniqueViolation } from './db';
import { config, CANCEL_CUTOFF_MIN } from './config';
import { AppError, badRequest, conflict, notFound } from './errors';
import { assertTransition, QUEUE_ACTIVE, Status } from './stateMachine';
import { Actor, audit, fmtWhen, naira, notify } from './helpers';
import { generateSlots, loadSchedule, busyIntervals, validateBookableDate } from './slots';
import { claimEntitlement, getSettings, issueCredit, restoreEntitlement } from './plans';
import { openRefundRequest } from './refundFlow';
import { accrueCommission, assertBookable } from './ledger';
import { feeSettingsOf, offAppBreakdown, onlineBreakdown } from './fees';
import { afterComplete, closeWaitlistFor } from './smart';
import { clock, isoNow, lagosDate, lagosMinutes, scheduledInstant, hhmmToMin } from './time';

/** Timestamps are ISO-8601 UTC strings, `date` is the Lagos calendar date 'YYYY-MM-DD' (derived by Postgres from scheduled_at). */
export interface BookingRow {
  id: number; customer_id: number; barber_id: number; service_id: number;
  family_member_id: number | null; entitlement_type: string;
  date: string; start_min: number; end_min: number; scheduled_at: string; ends_at: string;
  service_name: string; price_kobo: number; duration_min: number;
  status: Status; payment_option: 'ONLINE' | 'ON_ARRIVAL' | 'PLAN' | 'CREDIT';
  payment_status: 'PENDING' | 'PAYMENT_DUE' | 'PAID' | 'CREDIT_PENDING' | 'CREDITED' | 'VOID' | 'REFUND_PENDING' | 'REFUNDED' | 'REFUND_DECLINED';
  plan_purchase_id: number | null; credit_id: number | null;
  paid_via: string | null; paid_at: string | null; hold_expires_at: string | null;
  arrival_time: string | null; arrival_source: string | null;
  service_start: string | null; service_complete: string | null;
  cancelled_at: string | null; cancelled_by: string | null;
  barber_hold: boolean; skipped_at: string | null; last_queue_pos: number | null; created_at: string;
  note_to_barber: string | null; rem2h_at: string | null; rem30_at: string | null; leave_at: string | null;
  booking_fee_kobo: number; ps_fee_est_kobo: number; barber_fee_kobo: number; platform_charge_kobo: number; payout_kobo: number | null;
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
/** The cut-off minutes are an admin setting (`cancel_cutoff_min`, default 30); callers pass the live value. */
export function cancelCutoff(scheduledAtIso: string, cutoffMin: number = CANCEL_CUTOFF_MIN): Date {
  return new Date(new Date(scheduledAtIso).getTime() - cutoffMin * 60000);
}
/** Customer may cancel until exactly `cutoffMin` minutes before the appointment (inclusive). */
export function canCustomerCancel(scheduledAtIso: string, now: Date, cutoffMin: number = CANCEL_CUTOFF_MIN): boolean {
  return now.getTime() <= cancelCutoff(scheduledAtIso, cutoffMin).getTime();
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
    await notify(c, b.customer_id, 'BOOKING_INCOMPLETE', 'Booking incomplete', `Your ${b.service_name} booking for ${fmtWhen(b.date, b.start_min)} was not finished because the payment did not go through. We freed the time slot. You were not charged. Please book again.`, b.id);
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
export interface CreateInput { barber_id: number; service_id: number; date: string; time: string; payment_option: 'ONLINE' | 'ON_ARRIVAL' | 'PLAN' | 'CREDIT'; plan_purchase_id?: number; credit_id?: number; note?: string }

/** Online payments need a barber payout (Paystack subaccount), otherwise the money has nowhere to go. */
export function assertPayoutReady(b: { paystack_subaccount?: string | null }) {
  if (config.requirePayout && !b.paystack_subaccount) throw new AppError(409, 'PAYOUT_NOT_SETUP', "This barber cannot take online payments yet. Choose Pay on arrival, or pick another barber.");
}

export async function createBooking(db: Db, customerId: number, input: CreateInput): Promise<BookingRow> {
  validateBookableDate(input.date);
  if (!/^\d{2}:\d{2}$/.test(input.time)) throw badRequest('Write the time like 09:30.');
  const startMin = hhmmToMin(input.time);
  return db.tx(async (t) => {
    // 1) Serialise every booking attempt for this barber: whoever gets this row lock first books first; the other then sees the new row.
    const barber = await t.maybeOne('SELECT id, paystack_subaccount, fee_percent_override, fee_flat_kobo_override FROM barbers WHERE id=$1 AND verified FOR UPDATE', [input.barber_id]);
    if (!barber) throw notFound('We could not find that barber.');
    if (input.payment_option === 'ONLINE') assertPayoutReady(barber);
    await assertBookable(t, input.barber_id, input.payment_option);
    { const cu = await t.maybeOne<any>('SELECT account_status, status_reason FROM users WHERE id=$1', [customerId]); if (cu && cu.account_status !== 'ACTIVE') throw new AppError(403, 'ACCOUNT_RESTRICTED', `Your account cannot book right now${cu.status_reason ? ': ' + cu.status_reason : ''}. Please contact support.`); }
    // (Unpaid Pay-now attempts never occupy a slot, so there is nothing to release here.)
    // Price/duration ALWAYS come from the server-side service row - never from the client.
    const svc = await t.maybeOne('SELECT * FROM services WHERE id=$1 AND barber_id=$2 AND active', [input.service_id, input.barber_id]);
    if (!svc) throw notFound('This barber does not offer that service.');
    const { schedule, dayOff } = await loadSchedule(t, input.barber_id, input.date);
    const isToday = input.date === lagosDate(clock.now());
    const free = generateSlots({ schedule, isDayOff: !!dayOff, durationMin: svc.duration_min, busy: await busyIntervals(t, input.barber_id, input.date), nowMin: isToday ? lagosMinutes(clock.now()) : null });
    if (!free.some((s) => s.start === startMin)) throw conflict('SLOT_UNAVAILABLE', 'That time is not free any more. Pick another time.');
    const endMin = startMin + svc.duration_min;
    // A customer cannot hold two overlapping appointments
    const mine = await t.many('SELECT start_min, end_min FROM bookings WHERE customer_id=$1 AND date=$2 AND status IN (\'CONFIRMED\',\'ARRIVED\',\'IN_SERVICE\')', [customerId, input.date]);
    if (mine.some((m) => m.start_min < endMin && startMin < m.end_min)) throw conflict('CUSTOMER_OVERLAP', 'You already have a booking at this time.');
    const online = input.payment_option === 'ONLINE';
    const start = scheduledInstant(input.date, startMin);
    const holdUntil = online ? new Date(clock.now().getTime() + (await getSettings(t)).payment_hold_min * 60000).toISOString() : null;
    // Plan session / credit: spent atomically in THIS transaction (conditional UPDATE => no double spend); booking is complete immediately.
    const ent = input.payment_option === 'PLAN' || input.payment_option === 'CREDIT'
      ? await claimEntitlement(t, { customerId, barberId: input.barber_id, serviceId: svc.id, priceKobo: svc.price_kobo, startAt: start, option: input.payment_option, id: input.payment_option === 'PLAN' ? input.plan_purchase_id : input.credit_id })
      : null;
    const now = isoNow();
    // Money snapshot (frozen now; later setting changes never rewrite it): pay-now carries the booking fee + payout split, pay-on-arrival only the platform charge, plan/credit sessions nothing.
    const fs = feeSettingsOf(await getSettings(t));
    const bd = ent ? null : online ? onlineBreakdown(svc.price_kobo, fs, barber) : offAppBreakdown(svc.price_kobo, fs, barber);
    const noteVal = input.note && (await getSettings(t)).feature_booking_note ? input.note.slice(0, 200) : null;
    let b: BookingRow;
    try {
      b = await t.one<BookingRow>(`INSERT INTO bookings (customer_id, barber_id, service_id, family_member_id, entitlement_type, scheduled_at, ends_at,
            service_name, price_kobo, duration_min, status, payment_option, payment_status, paid_via, paid_at, hold_expires_at, plan_purchase_id, credit_id, created_at, note_to_barber,
            booking_fee_kobo, ps_fee_est_kobo, barber_fee_kobo, platform_charge_kobo, payout_kobo)
          VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
        [customerId, input.barber_id, svc.id, ent ? (ent.option === 'PLAN' ? 'SUBSCRIPTION' : 'CREDIT') : 'NONE', start.toISOString(), new Date(start.getTime() + svc.duration_min * 60000).toISOString(),
          svc.name, svc.price_kobo, svc.duration_min, online ? 'PENDING_PAYMENT' : 'CONFIRMED', input.payment_option, ent ? 'PAID' : online ? 'PENDING' : 'PAYMENT_DUE',
          ent ? ent.option : null, ent ? now : null, holdUntil, ent?.plan_purchase_id ?? null, ent?.credit_id ?? null, now, noteVal,
          bd?.booking_fee_kobo ?? 0, bd?.ps_fee_kobo ?? 0, bd?.barber_fee_kobo ?? 0, bd?.platform_charge_kobo ?? 0, online && bd ? bd.payout_kobo : null]);
    } catch (e: any) {
      // Backstop: the unique index / exclusion constraint fired (should be unreachable behind the barber lock, but the DB is the final judge).
      if (isUniqueViolation(e) || isExclusionViolation(e)) throw conflict('SLOT_UNAVAILABLE', 'Someone just took that time. Pick another time.');
      throw e;
    }
    if (ent?.credit_id) await t.query('UPDATE session_credits SET used_booking_id=$1 WHERE id=$2', [b.id, ent.credit_id]);
    await audit(t, b.id, { id: customerId, role: 'customer' }, 'BOOKED', { payment_option: input.payment_option, price_kobo: svc.price_kobo, status: b.status });
    await t.query(`INSERT INTO customer_barbers (customer_id, barber_id, added, source, created_at) VALUES ($1,$2,TRUE,'booking',$3) ON CONFLICT (customer_id, barber_id) DO UPDATE SET added=TRUE`, [customerId, input.barber_id, now]);   // a barber you booked stays in "My barbers"
    await closeWaitlistFor(t, customerId, input.barber_id, input.date);
    if (!online) await announceConfirmed(t, b);
    return b;
  });
}

async function announceConfirmed(c: Conn, b: BookingRow) {
  const when = fmtWhen(b.date, b.start_min);
  await notify(c, b.customer_id, 'BOOKING_CONFIRMED', 'Booking confirmed', `${b.service_name} on ${when}. ${b.payment_option === 'ON_ARRIVAL' ? `Pay ${naira(b.price_kobo)} on arrival.` : b.payment_option === 'PLAN' ? 'Your plan session pays for this.' : b.payment_option === 'CREDIT' ? 'Your session credit pays for this.' : 'We got your payment.'}`, b.id);
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
  if (!pre) throw notFound('We could not find that booking.');
  await t.query('SELECT 1 FROM barbers WHERE id=$1 FOR UPDATE', [pre.barber_id]);
  const b = await getBookingForUpdate(t, bookingId);     // row lock: serialises with attempt-expiry, cancel and duplicate payments
  if (!b) throw notFound('We could not find that booking.');
  const now = isoNow();
  if (b.status === 'PENDING_PAYMENT') {
    // The attempt reserved nothing, so the slot must be RE-CHECKED now, under the barber lock. If someone else took it: do not confirm.
    if (!(await slotStillFree(t, b))) {
      assertTransition('PENDING_PAYMENT', 'CANCELLED');
      await t.query(`UPDATE bookings SET status='CANCELLED', payment_status='VOID', cancelled_at=$1, cancelled_by='system', hold_expires_at=NULL WHERE id=$2`, [now, b.id]);
      await flagRefund(t, b, reference, 'Slot was taken before payment completed');
      await audit(t, b.id, { id: null, role: 'system' }, 'PAYMENT_SLOT_TAKEN', { via, amount_kobo: b.price_kobo, note: 'slot no longer free at payment time - booking NOT confirmed; payment flagged NEEDS_REFUND' });
      await notify(t, b.customer_id, 'BOOKING_INCOMPLETE', 'Slot no longer available', `Your payment for ${b.service_name} on ${fmtWhen(b.date, b.start_min)} came in after someone else booked that time. Your booking is not confirmed. We are refunding ${naira(b.price_kobo)} to your card. Please book another time.`, b.id);
      return 'slot_taken';
    }
    assertTransition('PENDING_PAYMENT', 'CONFIRMED');
    await t.query(`UPDATE bookings SET status='CONFIRMED', payment_status='PAID', paid_via=$1, paid_at=$2, hold_expires_at=NULL WHERE id=$3`, [via, now, b.id]);
    await audit(t, b.id, { id: null, role: 'system' }, 'PAYMENT_CONFIRMED', { via, amount_kobo: b.price_kobo });
    await announceConfirmed(t, (await getBooking(t, b.id))!);
    await notify(t, b.customer_id, 'PAYMENT_SUCCESS', 'Payment successful', `We got ${naira(b.price_kobo + (b.booking_fee_kobo || 0))} for your ${b.service_name}. Your time is saved.`, b.id);
    return 'confirmed';
  }
  if (['PAID', 'CREDIT_PENDING', 'CREDITED', 'REFUND_PENDING', 'REFUNDED', 'REFUND_DECLINED'].includes(b.payment_status)) {
    await flagRefund(t, b, reference, 'Duplicate payment for an already-paid booking');
    await audit(t, b.id, { id: null, role: 'system' }, 'DUPLICATE_PAYMENT', { via, note: 'extra successful payment on an already-paid booking - flagged NEEDS_REFUND' });
    await notify(t, b.customer_id, 'PAYMENT_SUCCESS', 'We got a second payment. Your refund is coming.', `We received a second payment for your ${b.service_name}. Your booking is already paid, so we are sending the extra ${naira(b.price_kobo + (b.booking_fee_kobo || 0))} back to you.`, b.id);
    return 'already_paid';
  }
  // The attempt was closed only because time ran out (not cancelled by the customer, and not closed because a shop was removed). If the time is STILL free
  // when the money is confirmed, the booking is confirmed anyway: the outcome must not depend on whether a sweep or a request happened to run first.
  if (b.status === 'CANCELLED' && b.payment_status === 'VOID' && b.cancelled_by === 'system' && b.payment_option === 'ONLINE' && !b.paid_at
    && new Date(b.scheduled_at).getTime() > clock.now().getTime()
    && await t.maybeOne(`SELECT 1 FROM audit_log WHERE booking_id=$1 AND action='HOLD_EXPIRED' LIMIT 1`, [b.id])
    && await t.maybeOne('SELECT 1 FROM barbers WHERE id=$1 AND verified AND NOT booking_paused', [b.barber_id])
    && await slotStillFree(t, b)) {
    await t.query(`UPDATE bookings SET status='CONFIRMED', payment_status='PAID', paid_via=$1, paid_at=$2, cancelled_at=NULL, cancelled_by=NULL, hold_expires_at=NULL WHERE id=$3`, [via, now, b.id]);
    await audit(t, b.id, { id: null, role: 'system' }, 'PAYMENT_CONFIRMED', { via, amount_kobo: b.price_kobo, note: 'paid after the try had timed out; the time was still free, so the booking is confirmed' });
    await announceConfirmed(t, (await getBooking(t, b.id))!);
    await notify(t, b.customer_id, 'PAYMENT_SUCCESS', 'Payment successful', `We got ${naira(b.price_kobo + (b.booking_fee_kobo || 0))} for your ${b.service_name}. Your time is saved.`, b.id);
    return 'confirmed';
  }
  // Money arrived for an attempt that was already closed (expired / abandoned). The booking stays Incomplete (barber never sees it); the money is flagged for refund.
  await flagRefund(t, b, reference, 'Payment arrived after the attempt was closed');
  await audit(t, b.id, { id: null, role: 'system' }, 'LATE_PAYMENT', { via, status: b.status, note: 'payment received after the attempt was closed - booking NOT confirmed; payment flagged NEEDS_REFUND' });
  await notify(t, b.customer_id, 'PAYMENT_SUCCESS', 'We got your payment. Your refund is coming.', `We received ${naira(b.price_kobo + (b.booking_fee_kobo || 0))} after your ${b.service_name} try had closed, so we made no booking. We are sending the money back to you.`, b.id);
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
  if (b.status === 'IN_SERVICE') { state = 'BEING_SERVED'; message = "You are in the chair now."; }
  else if (ahead === 0) { state = 'READY'; message = b.status === 'ARRIVED' ? 'Your barber is ready for you.' : 'Your barber is ready. Tap "I\'m Here" when you get there.'; }
  else if (ahead === 1 && serving) { state = 'NEXT'; message = "You're next"; }
  else { state = 'IN_LINE'; message = `You are number ${position} in line. ${ahead} customer${ahead === 1 ? ' is' : 's are'} ahead of you.`; }
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
    if (ahead === 0) await notify(c, b.customer_id, 'YOUR_TURN', 'Your barber is ready', 'Please come to the chair. Your barber is ready.', b.id);
    else if (ahead === 1 && serving) await notify(c, b.customer_id, 'YOURE_NEXT', "You're next", "You are next. Stay close!", b.id);
    else await notify(c, b.customer_id, 'QUEUE_CHANGED', 'Queue update', `You are now number ${pos} in line. ${ahead} ahead of you.`, b.id);
  }
}

/* ---------------- shared transition helper ---------------- */
async function setStatus(c: Conn, b: BookingRow, to: Status, sets: Record<string, unknown> = {}) {
  assertTransition(b.status, to);
  const cols = Object.keys(sets);   // column names come from code, never from user input
  const sql = `UPDATE bookings SET status=$1${cols.map((k, i) => `, ${k}=$${i + 2}`).join('')} WHERE id=$${cols.length + 2} AND status=$${cols.length + 3}`;
  const r = await c.query(sql, [to, ...cols.map((k) => sets[k]), b.id, b.status]);
  if (r.rowCount !== 1) throw conflict('STALE_STATE', 'This booking just changed. Refresh the page and try again.');
}

/* ---------------- customer actions ---------------- */
export async function customerCancel(db: Db, customerId: number, bookingId: number) {
  return db.tx(async (t) => {
    const b = await getBookingForUpdate(t, bookingId);
    if (!b || b.customer_id !== customerId) throw notFound('We could not find that booking.');
    if (!['PENDING_PAYMENT', 'CONFIRMED', 'ARRIVED'].includes(b.status)) {
      throw new AppError(409, 'ILLEGAL_TRANSITION', `This booking is ${b.status}. You cannot cancel it.`);
    }
    const set = await getSettings(t);
    if (!canCustomerCancel(b.scheduled_at, clock.now(), set.cancel_cutoff_min)) {
      throw new AppError(403, 'CANCEL_LOCKED', `You can no longer cancel. The cut-off is ${set.cancel_cutoff_min} minutes before your visit, so this time stays yours. If you miss it, you get no refund. But if you paid, you get one credit with this barber. Contact your barber if something came up.`);
    }
    const now = isoNow();
    const abandoned = isIncomplete({ ...b, status: 'PENDING_PAYMENT' });   // walked away from an unpaid Pay-now attempt: barber never hears about it
    let payStatus: string = 'VOID';
    let note = '';
    let refundDue: Awaited<ReturnType<typeof openRefundRequest>> | null = null;
    if (b.payment_status === 'PAID' && (b.plan_purchase_id || b.credit_id)) {
      // Cancelled in time: the plan session / credit simply goes back to the customer (same expiry rules still apply).
      await restoreEntitlement(t, b);
      note = b.plan_purchase_id ? 'We gave your plan session back.' : 'We gave your session credit back.';
    } else if (b.payment_status === 'PAID' && b.payment_option === 'ONLINE') {
      // Prepaid and cancelled in time => a REFUND (never a credit). It waits for admin approval and auto-approves after the admin's hold time.
      refundDue = await openRefundRequest(t, b, 'customer cancelled in time');
      payStatus = 'REFUND_PENDING';
      note = `We got your refund request for ${naira(b.price_kobo + (b.booking_fee_kobo || 0))}. We will approve it within ${refundDue.hours} hour${refundDue.hours === 1 ? '' : 's'}. Then we send the money back the way you paid.`;
    }
    await setStatus(t, b, 'CANCELLED', { payment_status: payStatus, cancelled_at: now, cancelled_by: 'customer', hold_expires_at: null });
    await audit(t, b.id, { id: customerId, role: 'customer' }, 'CANCELLED', {
      payment_status: payStatus,
      ...(refundDue ? { note: `Refund requested; pending admin approval, auto-approves in ${refundDue.hours} h`, refund_due_at: refundDue.due_at } : note ? { note } : {}),
    });
    if (!abandoned) await notify(t, await barberUserId(t, b.barber_id), 'BOOKING_CANCELLED', 'Booking cancelled', `${await customerName(t, customerId)} cancelled ${b.service_name} on ${fmtWhen(b.date, b.start_min)}. The time is free again.`, b.id);
    await notify(t, customerId, abandoned ? 'BOOKING_INCOMPLETE' : 'BOOKING_CANCELLED', abandoned ? 'Booking incomplete' : 'Booking cancelled', abandoned ? 'You left before you paid, so we marked this booking as not finished. You were not charged.' : `Your booking is cancelled. The time is free again. ${note}`.trim(), b.id);
    await refreshQueueNotifications(t, b.barber_id, b.date);
    return (await getBooking(t, b.id))!;
  });
}

async function markArrived(t: Conn, b: BookingRow, actor: Actor, source: 'CUSTOMER' | 'BARBER') {
  if (b.date !== lagosDate()) throw new AppError(409, 'NOT_TODAY', 'You can only check in on the day of your booking.');
  if (b.status !== 'CONFIRMED') {
    if (b.status === 'PENDING_PAYMENT') throw new AppError(409, 'PAYMENT_PENDING', 'This booking is not paid yet.');
    throw new AppError(409, 'ILLEGAL_TRANSITION', `This booking is ${b.status}. You cannot check in.`);
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
    if (!b || b.customer_id !== customerId) throw notFound('We could not find that booking.');
    await markArrived(t, b, { id: customerId, role: 'customer' }, 'CUSTOMER');
    return (await getBooking(t, b.id))!;
  });
}

/* ---------------- barber actions ---------------- */
export type BarberAction = 'mark-present' | 'start' | 'complete' | 'record-payment' | 'no-show' | 'skip' | 'wait' | 'not-served';

export async function barberAction(db: Db, barberUid: number, barberId: number, bookingId: number, action: BarberAction, body: any = {}) {
  return db.tx(async (t) => {
    const b = await getBookingForUpdate(t, bookingId);
    if (!b || b.barber_id !== barberId || isIncomplete(b)) throw notFound('We could not find that booking.');
    const actor: Actor = { id: barberUid, role: 'barber' };
    const now = isoNow();
    switch (action) {
      case 'mark-present':
        await markArrived(t, b, actor, 'BARBER');
        break;
      case 'start': {
        if (b.date !== lagosDate()) throw new AppError(409, 'NOT_TODAY', "You can only start today's bookings.");
        if (b.status !== 'ARRIVED') {
          throw new AppError(409, b.status === 'CONFIRMED' ? 'NOT_ARRIVED' : 'ILLEGAL_TRANSITION',
            b.status === 'CONFIRMED' ? 'The customer has not arrived yet. Tap "Mark Present" first.' : `You cannot start a booking that is ${b.status}.`);
        }
        if (await t.maybeOne(`SELECT id FROM bookings WHERE barber_id=$1 AND status='IN_SERVICE'`, [barberId])) throw conflict('ALREADY_SERVING', 'You are already with a customer. Finish that haircut first.');
        try {
          // scheduled time is NEVER rewritten - early arrivals are simply served early.
          await setStatus(t, b, 'IN_SERVICE', { service_start: now });
        } catch (e: any) {
          if (isUniqueViolation(e)) throw conflict('ALREADY_SERVING', 'You are already with a customer. Finish that haircut first.'); // uq_bookings_one_in_service
          throw e;
        }
        await audit(t, b.id, actor, 'STARTED', { scheduled_at: b.scheduled_at, arrival_time: b.arrival_time, service_start: now, early: new Date(now) < new Date(b.scheduled_at) });
        break;
      }
      case 'record-payment': {
        const method = String(body?.method || '').toUpperCase();
        if (!['CASH', 'TRANSFER'].includes(method)) throw badRequest('Choose "cash" or "transfer".');
        if (b.payment_option !== 'ON_ARRIVAL') throw new AppError(409, 'NOT_PAY_ON_ARRIVAL', 'The customer paid online. There is nothing to record.');
        if (b.payment_status !== 'PAYMENT_DUE') throw new AppError(409, 'ALREADY_PAID', `The payment status is ${b.payment_status}.`);
        if (!['ARRIVED', 'IN_SERVICE'].includes(b.status)) throw new AppError(409, 'ILLEGAL_STATE', 'You can record the payment after the customer arrives.');
        await t.query(`UPDATE bookings SET payment_status='PAID', paid_via=$1, paid_at=$2 WHERE id=$3`, [method, now, b.id]);
        await audit(t, b.id, actor, 'PAYMENT_RECORDED', { method, amount_kobo: b.price_kobo });
        await notify(t, b.customer_id, 'PAYMENT_SUCCESS', 'Payment recorded', `${naira(b.price_kobo)} received (${method.toLowerCase()}). Thank you!`, b.id);
        break;
      }
      case 'complete': {
        if (b.status !== 'IN_SERVICE') throw new AppError(409, 'ILLEGAL_TRANSITION', `You cannot complete a booking that is ${b.status}.`);
        if (b.payment_status === 'PAYMENT_DUE') throw new AppError(409, 'PAYMENT_REQUIRED', 'Record the cash or transfer payment first. Then complete this pay-on-arrival booking.');
        await setStatus(t, b, 'COMPLETED', { service_complete: now });
        await audit(t, b.id, actor, 'COMPLETED', { service_start: b.service_start, service_complete: now });
        await afterComplete(t, b);
        await accrueCommission(t, b);      // off-app (pay on arrival) booking: commission debt goes on the barber's ledger
        break;
      }
      case 'no-show': {
        if (!['CONFIRMED', 'ARRIVED'].includes(b.status)) throw new AppError(409, 'ILLEGAL_TRANSITION', `You cannot mark a ${b.status} booking as no-show.`);
        if (new Date(now) < new Date(b.scheduled_at)) throw new AppError(409, 'TOO_EARLY', 'You can mark a no-show only after the booked time has passed.');
        await setStatus(t, b, 'NO_SHOW');
        if (b.payment_status === 'PENDING' || b.payment_status === 'PAYMENT_DUE') await t.query(`UPDATE bookings SET payment_status='VOID' WHERE id=$1`, [b.id]);
        // Missed PAID session (online or plan session): no refund; ONE credit with the SAME barber. A session already paid by a credit is not re-credited (that credit was the make-good).
        const s = await getSettings(t);
        const credit = b.payment_status === 'PAID' && b.payment_option !== 'CREDIT' && s.credit_on_missed_session ? await issueCredit(t, b, 'NO_SHOW', s) : null;
        if (credit) await t.query(`UPDATE bookings SET payment_status='CREDITED' WHERE id=$1`, [b.id]);
        await audit(t, b.id, actor, 'NO_SHOW', { credit_id: credit?.id ?? null, paid: b.payment_status === 'PAID', via: b.payment_option });
        await notify(t, b.customer_id, 'NO_SHOW', 'Marked as no-show', `You did not come for ${b.service_name} on ${fmtWhen(b.date, b.start_min)}, so we marked a no-show.${credit ? ' You get no refund, but you now have 1 session credit with this barber.' : ''}`, b.id);
        break;
      }
      case 'not-served': {
        if (!['CONFIRMED', 'ARRIVED'].includes(b.status)) throw new AppError(409, 'ILLEGAL_TRANSITION', `You cannot mark a ${b.status} booking as not served.`);
        const entitlement = b.payment_status === 'PAID' && !!(b.plan_purchase_id || b.credit_id);   // the barber's fault: plan session / credit goes straight back
        const credit = b.payment_status === 'PAID' && !entitlement && b.payment_option === 'ONLINE';   // (name kept: "refund due")
        if (entitlement) await restoreEntitlement(t, b);
        const refundDue = credit ? await openRefundRequest(t, b, 'barber could not serve the booking') : null;
        await setStatus(t, b, 'NOT_SERVED', { payment_status: credit ? 'REFUND_PENDING' : entitlement || b.payment_status === 'PAYMENT_DUE' || b.payment_status === 'PENDING' ? 'VOID' : b.payment_status });
        await audit(t, b.id, actor, 'NOT_SERVED', { reason: String(body?.reason || '').slice(0, 200) || null, ...(refundDue ? { note: `Refund requested; pending admin approval, auto-approves in ${refundDue.hours} h`, refund_due_at: refundDue.due_at } : entitlement ? { note: 'plan session / credit returned' } : {}) });
        await notify(t, b.customer_id, 'NOT_SERVED', "We could not serve you", `Sorry. Your barber could not serve you for ${b.service_name} on ${fmtWhen(b.date, b.start_min)}.${credit ? ` We got your refund request for ${naira(b.price_kobo + (b.booking_fee_kobo || 0))}. We will approve it within ${refundDue!.hours} hour${refundDue!.hours === 1 ? '' : 's'}.` : entitlement ? ' We gave your session back.' : ''}`, b.id);
        break;
      }
      case 'skip': {
        if (!['CONFIRMED', 'ARRIVED'].includes(b.status)) throw new AppError(409, 'ILLEGAL_TRANSITION', `You cannot skip a ${b.status} booking.`);
        await t.query('UPDATE bookings SET skipped_at=$1 WHERE id=$2', [now, b.id]);
        await audit(t, b.id, actor, 'SKIPPED', { note: 'moved to back of queue' });
        break;
      }
      case 'wait': {
        if (b.status !== 'CONFIRMED') throw new AppError(409, 'ILLEGAL_STATE', 'You can wait only for customers who have not arrived yet.');
        await t.query('UPDATE bookings SET barber_hold=TRUE WHERE id=$1', [b.id]);
        await audit(t, b.id, actor, 'WAITING_FOR_CUSTOMER', {});
        break;
      }
    }
    await refreshQueueNotifications(t, b.barber_id, b.date);
    return (await getBooking(t, b.id))!;
  });
}
