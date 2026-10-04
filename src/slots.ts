import { Conn } from './db';
import { SLOT_STEP_MIN, MAX_ADVANCE_DAYS } from './config';
import { addDays, hhmmToMin, isValidDate, lagosDate, lagosMinutes, minToHhmm, weekdayOf, clock } from './time';
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
 */
export async function busyIntervals(c: Conn, barberId: number, date: string): Promise<Interval[]> {
  const rows = await c.many(
    `SELECT start_min, end_min FROM bookings WHERE barber_id=$1 AND date=$2 AND status IN ('CONFIRMED','ARRIVED','IN_SERVICE','COMPLETED')`,
    [barberId, date]);
  return rows.map((r) => ({ start: r.start_min, end: r.end_min }));
}

export function validateBookableDate(date: string) {
  if (!isValidDate(date)) throw badRequest('Write the date as YYYY-MM-DD.');
  const today = lagosDate(clock.now());
  if (date < today) throw badRequest('You cannot book a date in the past.');
  if (date > addDays(today, MAX_ADVANCE_DAYS)) throw badRequest(`You can book up to ${MAX_ADVANCE_DAYS} days ahead.`);
}

/** Free slots for a barber/service/date (verified barbers only). Unpaid attempts never block (see busyIntervals). */
export async function getAvailableSlots(c: Conn, barberId: number, serviceId: number, date: string) {
  validateBookableDate(date);
  if (!(await c.maybeOne('SELECT 1 FROM barbers WHERE id=$1 AND verified', [barberId]))) throw notFound('We could not find that barber.');
  const svc = await c.maybeOne('SELECT * FROM services WHERE id=$1 AND barber_id=$2 AND active', [serviceId, barberId]);
  if (!svc) throw notFound('This barber does not offer that service.');
  const { schedule, dayOff } = await loadSchedule(c, barberId, date);
  const isToday = date === lagosDate(clock.now());
  const slots = generateSlots({
    schedule, isDayOff: !!dayOff, durationMin: svc.duration_min,
    busy: await busyIntervals(c, barberId, date), nowMin: isToday ? lagosMinutes(clock.now()) : null,
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
