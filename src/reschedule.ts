/** Reschedule: move an upcoming booking to another FREE slot with the same barber and service.
 *  Only while the customer could still cancel it. Payment, plan session and credit stay exactly as they are (only the time changes). */
import { Db, isExclusionViolation, isUniqueViolation } from './db';
import { RESCHEDULE_MAX } from './config';
import { AppError, badRequest, conflict, notFound } from './errors';
import { audit, fmtWhen, notify } from './helpers';
import { generateSlots, loadSchedule, validateBookableDate } from './slots';
import { getSettings } from './plans';
import { canCustomerCancel, getBooking, getBookingForUpdate, refreshQueueNotifications } from './bookingService';
import { clock, hhmmToMin, isoNow, lagosDate, lagosMinutes, scheduledInstant } from './time';

export const canReschedule = (b: { status: string; scheduled_at: string; reschedule_count?: number }, cutoffMin: number) =>
  b.status === 'CONFIRMED' && canCustomerCancel(b.scheduled_at, clock.now(), cutoffMin) && (b.reschedule_count ?? 0) < RESCHEDULE_MAX;

export async function rescheduleBooking(db: Db, customerId: number, bookingId: number, input: { date: string; time: string }) {
  validateBookableDate(input.date);
  if (!/^\d{2}:\d{2}$/.test(input.time)) throw badRequest('Write the time like 09:30.');
  const startMin = hhmmToMin(input.time);
  return db.tx(async (t) => {
    const pre = await getBooking(t, bookingId);
    if (!pre || pre.customer_id !== customerId) throw notFound('We could not find that booking.');
    // Lock order is always barber -> booking (same as createBooking), so a move and a new booking for the same barber line up one after the other.
    await t.query('SELECT 1 FROM barbers WHERE id=$1 FOR UPDATE', [pre.barber_id]);
    const b = await getBookingForUpdate(t, bookingId);
    if (!b || b.customer_id !== customerId) throw notFound('We could not find that booking.');
    const set = await getSettings(t);
    if (b.status !== 'CONFIRMED') throw new AppError(409, 'RESCHEDULE_NOT_ALLOWED', 'You can only change the time of a booking that is confirmed and still coming up.');
    if (!canCustomerCancel(b.scheduled_at, clock.now(), set.cancel_cutoff_min)) throw new AppError(403, 'RESCHEDULE_LOCKED', `You can no longer change this booking. The cut-off was ${set.cancel_cutoff_min} minutes before your visit. If something urgent came up, call your barber.`);
    if (b.reschedule_count >= RESCHEDULE_MAX) throw new AppError(409, 'RESCHEDULE_LIMIT', `You already changed this booking ${RESCHEDULE_MAX} times. Please keep this time, or cancel it.`);
    const barber = await t.maybeOne<any>('SELECT b.id, b.user_id, b.booking_paused FROM barbers b WHERE b.id=$1 AND b.verified', [b.barber_id]);
    if (!barber) throw notFound('We could not find that barber.');
    if (barber.booking_paused) throw new AppError(409, 'BARBER_PAUSED', 'This barber is not taking new times right now.');
    const start = scheduledInstant(input.date, startMin);
    if (start.toISOString() === new Date(b.scheduled_at).toISOString()) throw badRequest('That is the time you already have. Pick another time.');
    // The new time must itself be at least the cut-off away, so a move cannot be used to dodge the cancel lock.
    if (!canCustomerCancel(start.toISOString(), clock.now(), set.cancel_cutoff_min)) throw new AppError(409, 'RESCHEDULE_TOO_SOON', `Pick a time that is more than ${set.cancel_cutoff_min} minutes from now.`);
    // Plan sessions and credits only work for visits that start before they end.
    if (b.plan_purchase_id && !(await t.maybeOne(`SELECT 1 FROM plan_purchases WHERE id=$1 AND expires_at >= $2`, [b.plan_purchase_id, start.toISOString()]))) throw new AppError(409, 'AFTER_PLAN_END', 'Your plan ends before that time. Pick an earlier time.');
    if (b.credit_id && !(await t.maybeOne(`SELECT 1 FROM session_credits WHERE id=$1 AND expires_at >= $2`, [b.credit_id, start.toISOString()]))) throw new AppError(409, 'AFTER_CREDIT_END', 'Your credit ends before that time. Pick an earlier time.');
    // Free-slot check: this booking's own old time does not count as busy (it is being moved).
    const { schedule, dayOff } = await loadSchedule(t, b.barber_id, input.date);
    const busyRows = await t.many<{ start_min: number; end_min: number }>(`SELECT start_min, end_min FROM bookings WHERE barber_id=$1 AND date=$2 AND id<>$3 AND status IN ('CONFIRMED','ARRIVED','IN_SERVICE','COMPLETED')`, [b.barber_id, input.date, b.id]);
    const isToday = input.date === lagosDate(clock.now());
    const free = generateSlots({ schedule, isDayOff: !!dayOff, durationMin: b.duration_min, busy: busyRows.map((r) => ({ start: r.start_min, end: r.end_min })), nowMin: isToday ? lagosMinutes(clock.now()) : null });
    if (!free.some((s) => s.start === startMin)) throw conflict('SLOT_UNAVAILABLE', 'That time is not free any more. Pick another time.');
    const endMin = startMin + b.duration_min;
    const mine = await t.many<{ start_min: number; end_min: number }>(`SELECT start_min, end_min FROM bookings WHERE customer_id=$1 AND date=$2 AND id<>$3 AND status IN ('CONFIRMED','ARRIVED','IN_SERVICE')`, [customerId, input.date, b.id]);
    if (mine.some((m) => m.start_min < endMin && startMin < m.end_min)) throw conflict('CUSTOMER_OVERLAP', 'You already have a booking at this time.');
    const was = fmtWhen(b.date, b.start_min);
    try {
      await t.query(`UPDATE bookings SET scheduled_at=$1, ends_at=$2, reschedule_count=reschedule_count+1, rescheduled_at=$3, rem2h_at=NULL, rem30_at=NULL, leave_at=NULL, last_queue_pos=NULL, skipped_at=NULL, barber_hold=FALSE WHERE id=$4 AND status='CONFIRMED'`,
        [start.toISOString(), new Date(start.getTime() + b.duration_min * 60000).toISOString(), isoNow(), b.id]);
    } catch (e: any) {
      if (isUniqueViolation(e) || isExclusionViolation(e)) throw conflict('SLOT_UNAVAILABLE', 'Someone just took that time. Pick another time.');
      throw e;
    }
    const nb = (await getBooking(t, b.id))!;
    const now = fmtWhen(nb.date, nb.start_min);
    await audit(t, b.id, { id: customerId, role: 'customer' }, 'RESCHEDULED', { from: b.scheduled_at, to: nb.scheduled_at, note: `moved from ${was} to ${now}` });
    const cust = await t.one<{ name: string }>('SELECT name FROM users WHERE id=$1', [customerId]);
    await notify(t, barber.user_id, 'BOOKING_RESCHEDULED', 'Booking moved', `${cust.name} moved ${b.service_name} from ${was} to ${now}. The old time is free again.`, b.id);
    await notify(t, customerId, 'BOOKING_RESCHEDULED', 'Booking moved', `Your ${b.service_name} is now on ${now}. Your payment stays the same.`, b.id);
    await refreshQueueNotifications(t, b.barber_id, b.date);
    if (nb.date !== b.date) await refreshQueueNotifications(t, b.barber_id, nb.date);
    return nb;
  });
}
