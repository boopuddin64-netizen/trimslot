import { Conn } from './db';
import { CANCEL_CUTOFF_MIN, MAX_ADVANCE_DAYS, SLOT_STEP_MIN } from './config';
import { addDays, hhmmToMin, isValidDate, lagosDate, minToHhmm, weekdayOf, clock, scheduledInstant } from './time';
import { badRequest, notFound } from './errors';

export interface DaySchedule {
  is_working: boolean;
  start_min: number;
  end_min: number;
  break_start_min: number | null;
  break_end_min: number | null;
}
export interface Interval { start: number; end: number }

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

/**
 * Pure slot generator. Candidate starts every SLOT_STEP_MIN minutes from opening time;
 * a slot is kept if the full service duration fits inside working hours, does not
 * overlap the break, and does not overlap any existing booking. If `nowMin` is given
 * (booking for today), slots that already started are dropped.
 */
export function generateSlots(opts: {
  schedule: DaySchedule | null;
  isDayOff: boolean;
  durationMin: number;
  busy: Interval[];
  nowMin?: number | null;
  step?: number;
}): { start: number; end: number }[] {
  const { schedule, isDayOff, durationMin, busy, nowMin = null } = opts;
  const step = opts.step ?? SLOT_STEP_MIN;
  if (!schedule || !schedule.is_working || isDayOff) return [];
  if (durationMin <= 0) return [];
  const out: { start: number; end: number }[] = [];
  const brk: Interval | null =
    schedule.break_start_min != null && schedule.break_end_min != null && schedule.break_end_min > schedule.break_start_min
      ? { start: schedule.break_start_min, end: schedule.break_end_min } : null;
  for (let s = schedule.start_min; s + durationMin <= schedule.end_min; s += step) {
    const iv = { start: s, end: s + durationMin };
    if (nowMin != null && s < nowMin) continue;
    if (brk && overlaps(iv, brk)) continue;
    if (busy.some((b) => overlaps(iv, b))) continue;
    out.push(iv);
  }
  return out;
}

export async function loadSchedule(c: Conn, barberId: number, date: string): Promise<{ schedule: DaySchedule | null; dayOff: { reason: string | null } | null }> {
  const row = await c.maybeOne('SELECT * FROM barber_schedule WHERE barber_id=$1 AND weekday=$2', [barberId, weekdayOf(date)]);
  const off = await c.maybeOne('SELECT reason FROM days_off WHERE barber_id=$1 AND date=$2', [barberId, date]);
  return {
    schedule: row ? {
      is_working: !!row.is_working, start_min: row.start_min, end_min: row.end_min,
      break_start_min: row.break_start_min, break_end_min: row.break_end_min,
    } : null,
    dayOff: off ? { reason: off.reason ?? null } : null,
  };
}

/**
 * Time ranges that block new bookings for a barber on a Lagos calendar date: COMPLETE bookings only (confirmed, arrived, in service, completed).
 * An unpaid Pay-now attempt (PENDING_PAYMENT) never blocks anything. A cancelled booking frees its slot immediately.
 * `excludeBookingId` leaves one booking out (used when that booking is being moved).
 */
export async function busyIntervals(c: Conn, barberId: number, date: string, excludeBookingId?: number): Promise<Interval[]> {
  const rows = await c.many(
    `SELECT start_min, end_min FROM bookings WHERE barber_id=$1 AND date=$2 AND status IN ('CONFIRMED','ARRIVED','IN_SERVICE','COMPLETED') AND ($3::int IS NULL OR id<>$3)`,
    [barberId, date, excludeBookingId ?? null]);
  return rows.map((r) => ({ start: r.start_min, end: r.end_min }));
}

/** A customer's own active bookings on a date (any barber): a new time must not overlap them. */
export async function customerIntervals(c: Conn, customerId: number, date: string, excludeBookingId?: number): Promise<Interval[]> {
  const rows = await c.many(
    `SELECT start_min, end_min FROM bookings WHERE customer_id=$1 AND date=$2 AND status IN ('CONFIRMED','ARRIVED','IN_SERVICE') AND ($3::int IS NULL OR id<>$3)`,
    [customerId, date, excludeBookingId ?? null]);
  return rows.map((r) => ({ start: r.start_min, end: r.end_min }));
}

/**
 * The first start a NEW booking may use on `date`, in minutes from that day's midnight (Lagos): at least the cancel cut-off from now.
 * This is the same rule as the cancel lock and the move check, so the list a customer sees, the booking and the move all agree.
 */
export function earliestStartMin(date: string, now: Date, cutoffMin: number): number {
  const dayStart = scheduledInstant(date, 0).getTime();
  // Whole minutes: the clock carries milliseconds, and rounding them up would refuse a slot at exactly the cut-off.
  const nowMinute = Math.floor(now.getTime() / 60000) * 60000;
  return Math.round((nowMinute + cutoffMin * 60000 - dayStart) / 60000);
}

/** Dates a customer may book: today up to `windowDays` ahead (an admin setting: 14 or 30). */
export function validateBookableDate(date: string, windowDays: number) {
  if (!isValidDate(date)) throw badRequest('Write the date as YYYY-MM-DD.');
  const today = lagosDate(clock.now());
  if (date < today) throw badRequest('You cannot book a date in the past.');
  if (date > addDays(today, windowDays)) throw badRequest(`You can book up to ${windowDays} days ahead.`);
}

/** Free slots for a barber/service/date (verified barbers only). Unpaid attempts never block (see busyIntervals). */
export async function getAvailableSlots(
  c: Conn, barberId: number, serviceId: number, date: string,
  o: { cutoffMin: number; windowDays: number; excludeBookingId?: number; customerId?: number } = { cutoffMin: CANCEL_CUTOFF_MIN, windowDays: MAX_ADVANCE_DAYS },
) {
  validateBookableDate(date, o.windowDays);
  if (!(await c.maybeOne('SELECT 1 FROM barbers WHERE id=$1 AND verified', [barberId]))) throw notFound('We could not find that barber.');
  const svc = await c.maybeOne('SELECT * FROM services WHERE id=$1 AND barber_id=$2 AND active', [serviceId, barberId]);
  if (!svc) throw notFound('This barber does not offer that service.');
  const { schedule, dayOff } = await loadSchedule(c, barberId, date);
  const busy = await busyIntervals(c, barberId, date, o.excludeBookingId);
  if (o.customerId) busy.push(...(await customerIntervals(c, o.customerId, date, o.excludeBookingId)));
  const slots = generateSlots({
    schedule, isDayOff: !!dayOff, durationMin: svc.duration_min,
    busy, nowMin: earliestStartMin(date, clock.now(), o.cutoffMin),
  });
  let closed_reason: string | null = null;
  if (dayOff) closed_reason = dayOff.reason ? `Day off: ${dayOff.reason}` : 'The barber is off on this day.';
  else if (!schedule || !schedule.is_working) closed_reason = 'The barber does not work on this day.';
  return {
    date, service: { id: svc.id, name: svc.name, price_kobo: svc.price_kobo, duration_min: svc.duration_min },
    closed_reason,
    slots: slots.map((s) => ({ time: minToHhmm(s.start), end_time: minToHhmm(s.end), start_min: s.start })),
  };
}

export { hhmmToMin };
