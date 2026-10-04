import { Conn } from './db';
import { addDays, isoNow, lagosDate, weekdayOf } from './time';
import { MAX_ADVANCE_DAYS } from './config';
import { getSettingsCached } from './plans';
import { audit, fmtTime12, fmtWhen, notify } from './helpers';
import { barberVisible } from './bookingService';

export interface Sched { is_working: boolean; start_min: number; end_min: number; break_start_min: number | null; break_end_min: number | null }
export interface AvailState { schedule: Map<number, Sched>; offDates: Set<string> }
export interface AffectedBooking { id: number; customer_id: number; date: string; start_min: number; end_min: number; service_name: string; status: string; incomplete: boolean }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDay(date: string): string { const d = new Date(date + 'T00:00:00Z'); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; }
export const DAY_NAMES = DAYS;

/** Does a booking still sit inside the barber's availability for its day? */
export function bookingFits(b: { date: string; start_min: number; end_min: number }, st: AvailState): boolean {
  if (st.offDates.has(b.date)) return false;
  const s = st.schedule.get(weekdayOf(b.date));
  if (!s || !s.is_working) return false;
  if (b.start_min < s.start_min || b.end_min > s.end_min) return false;
  if (s.break_start_min != null && s.break_end_min != null && s.break_end_min > s.break_start_min && b.start_min < s.break_end_min && s.break_start_min < b.end_min) return false;
  return true;
}

export async function loadAvailState(c: Conn, barberId: number): Promise<AvailState> {
  const rows = await c.many('SELECT weekday, is_working, start_min, end_min, break_start_min, break_end_min FROM barber_schedule WHERE barber_id=$1', [barberId]);
  const off = await c.many('SELECT date FROM days_off WHERE barber_id=$1', [barberId]);
  return {
    schedule: new Map(rows.map((r) => [r.weekday as number, { is_working: !!r.is_working, start_min: r.start_min, end_min: r.end_min, break_start_min: r.break_start_min, break_end_min: r.break_end_min }])),
    offDates: new Set(off.map((r) => r.date as string)),
  };
}

/** Upcoming COMPLETE bookings customers hold (CONFIRMED). Unpaid Pay-now attempts hold nothing, so they are not counted. */
export async function activeUpcoming(c: Conn, barberId: number, onlyDate?: string): Promise<AffectedBooking[]> {
  const params: unknown[] = [barberId, lagosDate()];
  let extra = '';
  if (onlyDate) { params.push(onlyDate); extra = ' AND date=$3'; }
  return c.many<AffectedBooking>(
    `SELECT id, customer_id, date, start_min, end_min, service_name, status, NOT (${barberVisible()}) AS incomplete FROM bookings
      WHERE barber_id=$1 AND date>=$2 AND status='CONFIRMED'${extra}
      ORDER BY date, start_min`, params);
}

/** Bookings that fit under the current availability but would NOT fit under the proposed one. */
export async function bookingsAffectedBy(c: Conn, barberId: number, before: AvailState, after: AvailState, onlyDate?: string): Promise<AffectedBooking[]> {
  return (await activeUpcoming(c, barberId, onlyDate)).filter((b) => bookingFits(b, before) && !bookingFits(b, after));
}

/** What the BARBER is told: unpaid Pay-now holds are invisible to them, so they are neither counted nor listed (the customers are still notified). */
export function conflictDetails(all: AffectedBooking[]) {
  const list = all.filter((b) => !b.incomplete);
  return { count: list.length, bookings: list.slice(0, 20).map((b) => ({ id: b.id, date: b.date, when: fmtWhen(b.date, b.start_min), service_name: b.service_name })) };
}

/** In-app notification + audit entry for every affected booking. Never cancels anything. */
export async function notifyAffected(t: Conn, barber: { userId: number; shop_name: string; name: string }, list: AffectedBooking[], reason: string) {
  const CANCEL_CUTOFF_MIN = (await getSettingsCached(t)).cancel_cutoff_min;
  for (const b of list) {
    const body = `${barber.shop_name} (${barber.name}) updated availability: ${reason}. Your ${b.service_name} booking on ${fmtWhen(b.date, b.start_min)} is affected. `
      + `Nothing was cancelled - please check with the shop, or cancel it from My bookings (free cancellation applies until ${CANCEL_CUTOFF_MIN} minutes before the appointment).`;
    await notify(t, b.customer_id, 'AVAILABILITY_CHANGED', 'Availability updated', body, b.id);
    await audit(t, b.id, { id: barber.userId, role: 'barber' }, 'AVAILABILITY_CHANGED', { note: reason });
  }
}

/** Human summary of which weekdays changed (null when nothing changed). */
export function scheduleDiff(before: AvailState, after: AvailState): { days: number[]; summary: string } | null {
  const days: number[] = [];
  for (let wd = 0; wd < 7; wd++) {
    const a = before.schedule.get(wd), b = after.schedule.get(wd);
    const key = (s?: Sched) => !s ? 'none' : !s.is_working ? 'off' : `${s.start_min}-${s.end_min}/${s.break_start_min ?? ''}-${s.break_end_min ?? ''}`;
    if (key(a) !== key(b)) days.push(wd);
  }
  if (!days.length) return null;
  const parts = days.map((wd) => {
    const b = after.schedule.get(wd);
    return `${DAYS[wd]} ${!b || !b.is_working ? 'closed' : `${fmtTime12(b.start_min)}-${fmtTime12(b.end_min)}`}`;
  });
  return { days, summary: `Opening hours updated (${parts.join(', ')})` };
}

/** Notes shown on the public barber page. */
export async function publicNotices(c: Conn, barberId: number) {
  const today = lagosDate();
  const off = await c.many('SELECT date, reason FROM days_off WHERE barber_id=$1 AND date>=$2 AND date<=$3 ORDER BY date', [barberId, today, addDays(today, MAX_ADVANCE_DAYS)]);
  const since = new Date(Date.now() - 14 * 86400_000).toISOString();
  const ch = await c.many('SELECT note, created_at FROM availability_changes WHERE barber_id=$1 AND created_at > $2 ORDER BY id DESC LIMIT 1', [barberId, since]);
  return [
    ...ch.map((r) => ({ type: 'HOURS_UPDATED', title: 'Availability updated', text: r.note as string, at: r.created_at as string })),
    ...off.map((r) => ({ type: 'CLOSED', title: `Closed on ${fmtDay(r.date)}`, date: r.date as string, reason: (r.reason as string | null) ?? null, text: r.reason ? `Closed on ${fmtDay(r.date)} - ${r.reason}` : `Closed on ${fmtDay(r.date)}` })),
  ];
}
