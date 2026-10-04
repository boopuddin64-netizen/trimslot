/** Smart customer/barber features. EVERY route/hook here checks its admin feature toggle first (platform_settings.feature_*), so an admin can switch each one off.
 *  Everything is in-app notifications (+ web push via push.ts); no SMS / email. */
import { z } from 'zod';
import { Conn, Db } from './db';
import { AppError, badRequest, conflict, notFound } from './errors';
import { audit, fmtTime12, fmtWhen, naira, notify } from './helpers';
import { getSettingsCached, Settings } from './plans';
import { BookingRow, orderedQueue } from './bookingService';
import { generateSlots, loadSchedule, busyIntervals } from './slots';
import { addDays, clock, isoNow, lagosDate, lagosMinutes, minToHhmm, weekdayOf } from './time';
import { MAX_ADVANCE_DAYS } from './config';

const off = (name: string) => new AppError(403, 'FEATURE_OFF', `${name} is off right now.`);
export async function need(c: Conn, key: keyof Settings, label: string): Promise<Settings> {
  const s = await getSettingsCached(c as any);
  if (!(s as any)[key]) throw off(label);
  return s;
}
const flag = async (c: Conn, key: keyof Settings) => !!(await getSettingsCached(c as any) as any)[key];

/* ================= live queue ETA ================= */
export function etaFrom(q: BookingRow[], b: BookingRow, delayMin: number, now = clock.now()) {
  let wait = 0;
  for (const x of q) {
    if (x.id === b.id) break;
    if (x.status === 'IN_SERVICE') wait += Math.max(0, x.duration_min - (x.service_start ? (now.getTime() - new Date(x.service_start).getTime()) / 60000 : 0));
    else if (x.status === 'ARRIVED') wait += x.duration_min;
  }
  const sched = new Date(b.scheduled_at).getTime() + delayMin * 60000;
  const est = Math.max(sched, now.getTime() + wait * 60000);
  return { wait_min: Math.round(wait), est_start: new Date(est).toISOString(), est_min: Math.max(0, Math.round((est - now.getTime()) / 60000)), delay_min: delayMin };
}
export const barberDelay = async (c: Conn, barberId: number, date: string) =>
  (await c.maybeOne<{ delay_min: number; delay_date: string | null }>('SELECT delay_min, delay_date FROM barbers WHERE id=$1', [barberId]).then((r) => (r && r.delay_date === date ? r.delay_min : 0))) || 0;

/* ================= reliability badge ================= */
export type Reliability = { label: 'New' | 'Reliable' | 'Mostly reliable' | 'Often misses'; tone: 'gray' | 'green' | 'amber' | 'red'; completed: number; no_shows: number };
export function reliabilityOf(completed: number, noShows: number): Reliability {
  const done = completed + noShows;
  if (done < 3) return { label: 'New', tone: 'gray', completed, no_shows: noShows };
  const rate = completed / done;
  if (rate >= 0.9) return { label: 'Reliable', tone: 'green', completed, no_shows: noShows };
  if (rate >= 0.7 || noShows < 2) return { label: 'Mostly reliable', tone: 'amber', completed, no_shows: noShows };
  return { label: 'Often misses', tone: 'red', completed, no_shows: noShows };
}
export async function reliabilityFor(c: Conn, customerId: number): Promise<Reliability> {
  const r = await c.one<{ c: number; n: number }>(`SELECT COUNT(*) FILTER (WHERE status='COMPLETED')::int c, COUNT(*) FILTER (WHERE status='NO_SHOW')::int n FROM bookings WHERE customer_id=$1 AND status IN ('COMPLETED','NO_SHOW')`, [customerId]);
  return reliabilityOf(r.c, r.n);
}

/* ================= favourites ================= */
export async function setFavourite(db: Db, customerId: number, barberId: number, on: boolean) {
  await need(db, 'feature_favourites', 'Favourites');
  if (!(await db.maybeOne('SELECT 1 FROM barbers WHERE id=$1 AND verified', [barberId]))) throw notFound('We could not find that barber.');
  if (on) {
    await db.query('INSERT INTO favourites (customer_id, barber_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [customerId, barberId]);
    await db.query(`INSERT INTO customer_barbers (customer_id, barber_id, added, source) VALUES ($1,$2,TRUE,'favourite') ON CONFLICT (customer_id, barber_id) DO UPDATE SET added=TRUE`, [customerId, barberId]);
  }
  else await db.query('DELETE FROM favourites WHERE customer_id=$1 AND barber_id=$2', [customerId, barberId]);
  return { favourite: on };
}
export const myFavourites = async (db: Db, customerId: number): Promise<number[]> =>
  (await db.many<{ barber_id: number }>('SELECT barber_id FROM favourites WHERE customer_id=$1', [customerId])).map((r) => r.barber_id);

/* ================= ratings & reviews ================= */
export const reviewSchema = z.object({ rating: z.coerce.number().int().min(1).max(5), comment: z.string().trim().max(500).optional().transform((v) => v || null) });
export async function ratingSummary(c: Conn, barberId: number) {
  const r = await c.one<{ n: number; avg: string | null }>('SELECT COUNT(*)::int n, ROUND(AVG(rating)::numeric,1) avg FROM reviews WHERE barber_id=$1 AND NOT hidden', [barberId]);
  return { count: r.n, average: r.avg == null ? null : Number(r.avg) };
}
export async function addReview(db: Db, customerId: number, bookingId: number, body: unknown) {
  await need(db, 'feature_reviews', 'Reviews');
  const p = reviewSchema.safeParse(body); if (!p.success) throw badRequest(p.error.issues[0]?.message || 'Please check your review and try again.');
  return db.tx(async (t) => {
    const b = await t.maybeOne<BookingRow>('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [bookingId]);
    if (!b || b.customer_id !== customerId) throw notFound('We could not find that booking.');
    if (b.status !== 'COMPLETED') throw new AppError(409, 'NOT_COMPLETED', 'You can review a visit after it is done.');
    if (new Date(isoNow()).getTime() - new Date(b.service_complete ?? b.scheduled_at).getTime() > 45 * 86400000) throw new AppError(409, 'REVIEW_WINDOW_CLOSED', 'You can leave a review up to 45 days after your visit.');
    if (await t.maybeOne('SELECT 1 FROM reviews WHERE booking_id=$1', [bookingId])) throw conflict('ALREADY_REVIEWED', 'You already reviewed this visit.');
    const r = await t.one<any>('INSERT INTO reviews (booking_id, customer_id, barber_id, rating, comment, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, rating, comment, created_at', [bookingId, customerId, b.barber_id, p.data.rating, p.data.comment, isoNow()]);
    const bu = await t.one<{ user_id: number }>('SELECT user_id FROM barbers WHERE id=$1', [b.barber_id]);
    const cn = await t.one<{ name: string }>('SELECT name FROM users WHERE id=$1', [customerId]);
    await notify(t, bu.user_id, 'REVIEW_RECEIVED', `New ${p.data.rating}-star review`, `${cn.name.split(' ')[0]} rated your ${b.service_name}${p.data.comment ? `: "${p.data.comment.slice(0, 80)}"` : '.'}`);
    await audit(t, bookingId, { id: customerId, role: 'customer' }, 'REVIEW_ADDED', { rating: p.data.rating });
    return r;
  });
}
export async function barberReply(db: Db, barberId: number, reviewId: number, text: unknown) {
  await need(db, 'feature_reviews', 'Reviews');
  const r = z.string().trim().min(2, 'Write a short reply.').max(500).safeParse(text); if (!r.success) throw badRequest(r.error.issues[0].message);
  return db.tx(async (t) => {
    const rv = await t.maybeOne<any>('SELECT * FROM reviews WHERE id=$1 AND barber_id=$2 FOR UPDATE', [reviewId, barberId]);
    if (!rv) throw notFound('We could not find that review.');
    await t.query('UPDATE reviews SET reply=$1, replied_at=$2 WHERE id=$3', [r.data, isoNow(), reviewId]);
    await notify(t, rv.customer_id, 'REVIEW_REPLY', 'Your barber replied', `"${r.data.slice(0, 120)}"`, rv.booking_id);
    return { ok: true };
  });
}
export async function listReviews(c: Conn, barberId: number, opts: { limit?: number; before?: number; includeHidden?: boolean } = {}) {
  const rows = await c.many(`SELECT r.id, r.rating, r.comment, r.reply, r.replied_at, r.created_at, r.hidden, r.booking_id, split_part(u.name, ' ', 1) AS customer_name
      FROM reviews r JOIN users u ON u.id=r.customer_id WHERE r.barber_id=$1 ${opts.includeHidden ? '' : 'AND NOT r.hidden'} ${opts.before ? 'AND r.id < $3' : ''} ORDER BY r.id DESC LIMIT $2`,
    opts.before ? [barberId, Math.min(opts.limit ?? 10, 50), opts.before] : [barberId, Math.min(opts.limit ?? 10, 50)]);
  return rows;
}

/* ================= barber private notes, usual service ================= */
export async function getCustomerInsights(c: Conn, barberId: number, customerId: number) {
  const s = await getSettingsCached(c as any);
  const out: any = {};
  if (s.feature_barber_notes) {
    out.note = (await c.maybeOne<{ note: string }>('SELECT note FROM barber_customer_notes WHERE barber_id=$1 AND customer_id=$2', [barberId, customerId]))?.note ?? '';
    const u = await c.maybeOne<{ service_name: string; n: number }>(`SELECT service_name, COUNT(*)::int n FROM bookings WHERE barber_id=$1 AND customer_id=$2 AND status='COMPLETED' GROUP BY service_name ORDER BY n DESC, MAX(id) DESC LIMIT 1`, [barberId, customerId]);
    out.usual = u ? { service_name: u.service_name, times: u.n } : null;
  }
  if (s.feature_reliability) out.reliability = await reliabilityFor(c, customerId);
  return out;
}
export async function saveCustomerNote(db: Db, barberId: number, customerId: number, note: unknown) {
  await need(db, 'feature_barber_notes', 'Customer notes');
  const n = z.string().trim().max(1000).safeParse(note); if (!n.success) throw badRequest('Keep notes under 1000 characters.');
  if (!(await db.maybeOne('SELECT 1 FROM bookings WHERE barber_id=$1 AND customer_id=$2 LIMIT 1', [barberId, customerId]))) throw notFound('We could not find that customer.');
  if (!n.data) await db.query('DELETE FROM barber_customer_notes WHERE barber_id=$1 AND customer_id=$2', [barberId, customerId]);
  else await db.query(`INSERT INTO barber_customer_notes (barber_id, customer_id, note, updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (barber_id, customer_id) DO UPDATE SET note=EXCLUDED.note, updated_at=EXCLUDED.updated_at`, [barberId, customerId, n.data, isoNow()]);
  return { note: n.data };
}

/* ================= rebook: "Book again" ================= */
async function freeStarts(c: Conn, barberId: number, durationMin: number, date: string): Promise<number[]> {
  const { schedule, dayOff } = await loadSchedule(c, barberId, date);
  const isToday = date === lagosDate();
  return generateSlots({ schedule, isDayOff: !!dayOff, durationMin, busy: await busyIntervals(c, barberId, date), nowMin: isToday ? lagosMinutes() : null }).map((s) => s.start);
}
const mode = (xs: number[]) => { const m = new Map<number, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0]; };
export async function rebookSuggestion(db: Db, customerId: number) {
  await need(db, 'feature_rebook', 'Book again');
  const last = await db.maybeOne<any>(`SELECT b.barber_id, b.service_id FROM bookings b JOIN barbers br ON br.id=b.barber_id AND br.verified AND NOT br.booking_paused
      JOIN services s ON s.id=b.service_id AND s.active WHERE b.customer_id=$1 AND b.status='COMPLETED' ORDER BY b.date DESC, b.id DESC LIMIT 1`, [customerId]);
  if (!last) return { suggestion: null };
  const hist = await db.many<{ date: string; start_min: number }>(`SELECT date, start_min FROM bookings WHERE customer_id=$1 AND barber_id=$2 AND service_id=$3 AND status='COMPLETED' ORDER BY id DESC LIMIT 12`, [customerId, last.barber_id, last.service_id]);
  const usualWd = mode(hist.map((h) => weekdayOf(h.date))); const usualMin = mode(hist.map((h) => h.start_min)) ?? 600;
  const svc = await db.one<any>('SELECT id, name, price_kobo, duration_min FROM services WHERE id=$1', [last.service_id]);
  const barber = await db.one<any>('SELECT b.id, b.shop_name, u.name FROM barbers b JOIN users u ON u.id=b.user_id WHERE b.id=$1', [last.barber_id]);
  const today = lagosDate(); const usualPicks: { date: string; time: string; usual_day: boolean }[] = []; let soonest: { date: string; time: string; usual_day: boolean } | null = null;
  const st = await getSettingsCached(db);
  for (let i = 1; i <= Math.min(MAX_ADVANCE_DAYS, 21) && (usualPicks.length < 2 || !soonest); i++) {
    const d = addDays(today, i); const usualDay = weekdayOf(d) === usualWd;
    if (!usualDay && soonest) continue;
    const starts = await freeStarts(db, last.barber_id, svc.duration_min, d);
    if (!starts.length) continue;
    const best = starts.reduce((a, x) => (Math.abs(x - usualMin) < Math.abs(a - usualMin) ? x : a), starts[0]);
    const pick = { date: d, time: minToHhmm(best), usual_day: usualDay };
    if (usualDay) { if (usualPicks.length < 2) usualPicks.push(pick); } else if (!soonest) soonest = pick;
  }
  const picks = [...usualPicks, ...(soonest ? [soonest] : [])];
  picks.sort((a, b) => Number(b.usual_day) - Number(a.usual_day) || a.date.localeCompare(b.date));
  return { suggestion: { barber: { id: barber.id, shop_name: barber.shop_name, name: barber.name }, service: svc, usual: usualWd == null ? null : { weekday: usualWd, time: minToHhmm(usualMin) }, options: picks.slice(0, 3), pay_on_arrival: st.feature_pay_on_arrival } };
}

/* ================= waitlist ================= */
export const waitSchema = z.object({ barber_id: z.coerce.number().int().positive(), service_id: z.coerce.number().int().positive(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
export async function joinWaitlist(db: Db, customerId: number, body: unknown) {
  await need(db, 'feature_waitlist', 'Waitlist');
  const p = waitSchema.safeParse(body); if (!p.success) throw badRequest('Pick a barber, a service and a date.');
  const d = p.data; const today = lagosDate();
  if (d.date < today || d.date > addDays(today, MAX_ADVANCE_DAYS)) throw badRequest('You cannot book that date.');
  const svc = await db.maybeOne<any>('SELECT duration_min FROM services WHERE id=$1 AND barber_id=$2 AND active', [d.service_id, d.barber_id]);
  if (!svc || !(await db.maybeOne('SELECT 1 FROM barbers WHERE id=$1 AND verified', [d.barber_id]))) throw notFound('We could not find that barber or service.');
  const { schedule, dayOff } = await loadSchedule(db, d.barber_id, d.date);
  if (dayOff || !schedule || !schedule.is_working) throw new AppError(409, 'DAY_CLOSED', 'This barber does not work that day.');
  if ((await freeStarts(db, d.barber_id, svc.duration_min, d.date)).length) throw new AppError(409, 'SLOTS_AVAILABLE', 'There are still free times that day. Book one.');
  const active = (await db.one<{ c: number }>(`SELECT COUNT(*)::int c FROM waitlist WHERE customer_id=$1 AND status IN ('WAITING','NOTIFIED')`, [customerId])).c;
  if (active >= 5) throw new AppError(409, 'WAITLIST_LIMIT', 'You can be on up to 5 waitlists at one time.');
  try {
    const r = await db.one<any>('INSERT INTO waitlist (customer_id, barber_id, service_id, date, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id, date, status', [customerId, d.barber_id, d.service_id, d.date, isoNow()]);
    return r;
  } catch (e: any) { if (e?.code === '23505') throw conflict('ALREADY_WAITING', 'You are already on the waitlist for that day.'); throw e; }
}
export const leaveWaitlist = async (db: Db, customerId: number, id: number) => {
  const r = await db.query(`UPDATE waitlist SET status='CANCELLED' WHERE id=$1 AND customer_id=$2 AND status IN ('WAITING','NOTIFIED')`, [id, customerId]);
  if (!r.rowCount) throw notFound('We could not find that waitlist spot.'); return { ok: true };
};
export const myWaitlist = (db: Db, customerId: number) => db.many(`SELECT w.id, w.date, w.status, w.barber_id, w.service_id, b.shop_name, s.name AS service_name FROM waitlist w JOIN barbers b ON b.id=w.barber_id JOIN services s ON s.id=w.service_id
    WHERE w.customer_id=$1 AND w.status IN ('WAITING','NOTIFIED') AND w.date >= $2 ORDER BY w.date, w.id`, [customerId, lagosDate()]);
/** Notify waitlisted customers when a slot has opened (oldest first, at most 2 people per open day so nobody gets spammed; re-armed if it fills again). */
export async function scanWaitlist(db: Db): Promise<number> {
  if (!(await flag(db, 'feature_waitlist'))) return 0;
  const today = lagosDate();
  await db.query(`UPDATE waitlist SET status='EXPIRED' WHERE status IN ('WAITING','NOTIFIED') AND date < $1`, [today]);
  const rows = await db.many<any>(`SELECT w.*, s.duration_min, s.name AS service_name, b.shop_name FROM waitlist w JOIN services s ON s.id=w.service_id JOIN barbers b ON b.id=w.barber_id WHERE w.status IN ('WAITING','NOTIFIED') ORDER BY w.id LIMIT 200`);
  let n = 0; const seen = new Map<string, number>();
  for (const w of rows) {
    const starts = await freeStarts(db, w.barber_id, w.duration_min, w.date);
    if (!starts.length) { if (w.status === 'NOTIFIED') await db.query(`UPDATE waitlist SET status='WAITING' WHERE id=$1 AND status='NOTIFIED'`, [w.id]); continue; }
    if (w.status !== 'WAITING') continue;
    const key = w.barber_id + '|' + w.date; const c = seen.get(key) ?? 0; if (c >= 2) continue; seen.set(key, c + 1);
    const r = await db.query(`UPDATE waitlist SET status='NOTIFIED', notified_at=$2 WHERE id=$1 AND status='WAITING'`, [w.id, isoNow()]);
    if (!r.rowCount) continue;
    await notify(db, w.customer_id, 'WAITLIST_OPEN', 'A time just opened up', `${w.shop_name} has a free time for ${w.service_name} on ${fmtWhen(w.date, starts[0]).split(',')[0]} (from ${fmtTime12(starts[0])}). Book it now before someone else does.`);
    n++;
  }
  return n;
}
/** A customer who books the day they were waiting for is marked BOOKED. */
export async function closeWaitlistFor(c: Conn, customerId: number, barberId: number, date: string) {
  await c.query(`UPDATE waitlist SET status='BOOKED' WHERE customer_id=$1 AND barber_id=$2 AND date=$3 AND status IN ('WAITING','NOTIFIED')`, [customerId, barberId, date]);
}

/* ================= smart reminders (2h, 30 min, leave-now) ================= */
let lastTick = 0;
/** Idempotent (each reminder is claimed with a conditional UPDATE). Triggered lazily by app polling + after mutations + the daily cron;
 *  it is NOT an exact-time scheduler - see README. `force` skips the per-instance throttle. */
export async function runSmartTick(db: Db, force = false): Promise<{ reminders: number; waitlist: number }> {
  if (!force && Date.now() - lastTick < 15000) return { reminders: 0, waitlist: 0 };
  lastTick = Date.now();
  const s = await getSettingsCached(db);
  let reminders = 0, waitlist = 0;
  if (s.feature_reminders) reminders = await sendReminders(db);
  if (s.feature_waitlist) waitlist = await scanWaitlist(db);
  return { reminders, waitlist };
}
export const resetTickThrottle = () => { lastTick = 0; };

async function sendReminders(db: Db): Promise<number> {
  const nowD = clock.now(); const now = nowD.toISOString(); let sent = 0;
  const in130 = new Date(nowD.getTime() + 130 * 60000).toISOString(); const back = new Date(nowD.getTime() - 180 * 60000).toISOString();
  const cand = await db.many<BookingRow>(`SELECT * FROM bookings WHERE status IN ('CONFIRMED','ARRIVED') AND scheduled_at > $1 AND scheduled_at <= $2 AND (rem2h_at IS NULL OR rem30_at IS NULL OR leave_at IS NULL) ORDER BY scheduled_at LIMIT 300`, [back, in130]);
  const queues = new Map<string, BookingRow[]>(); const delays = new Map<number, number>();
  for (const b of cand) {
    const minsTo = (new Date(b.scheduled_at).getTime() - nowD.getTime()) / 60000;
    const leadMin = (new Date(b.scheduled_at).getTime() - new Date(b.created_at).getTime()) / 60000;
    const when = fmtTime12(b.start_min);
    // leave-now (only for customers not yet at the shop): estimated start from the live queue, minus a ~25 min travel buffer
    let leaveSent = false;
    if (b.status === 'CONFIRMED' && b.date === lagosDate() && !b.leave_at && minsTo <= 90) {
      const k = b.barber_id + '|' + b.date; if (!queues.has(k)) queues.set(k, await orderedQueue(db, b.barber_id, b.date));
      if (!delays.has(b.barber_id)) delays.set(b.barber_id, await barberDelay(db, b.barber_id, b.date));
      const e = etaFrom(queues.get(k)!, b, delays.get(b.barber_id)!, nowD);
      if (e.est_min <= 20) {
        const r = await db.query('UPDATE bookings SET leave_at=$2, rem2h_at=COALESCE(rem2h_at,$2), rem30_at=COALESCE(rem30_at,$2) WHERE id=$1 AND leave_at IS NULL', [b.id, now]);
        if (r.rowCount) { leaveSent = true; sent++; await notify(db, b.customer_id, 'LEAVE_NOW', 'Time to leave', `Your ${b.service_name} should start around ${fmtTime12(Math.floor(lagosMinutesOf(e.est_start)))}${e.delay_min ? ` (your barber is about ${e.delay_min} min late)` : ''}. Leave now to be on time.`, b.id); }
      }
    }
    if (leaveSent || minsTo <= 0) continue;
    if (minsTo <= 30 && !b.rem30_at) {
      const r = await db.query('UPDATE bookings SET rem30_at=$2, rem2h_at=COALESCE(rem2h_at,$2) WHERE id=$1 AND rem30_at IS NULL', [b.id, now]);
      if (r.rowCount && leadMin > 35) { sent++; await notify(db, b.customer_id, 'REMINDER_30', 'Starts in 30 minutes', `${b.service_name} at ${when}. ${b.status === 'CONFIRMED' ? "Tap I'm Here when you get there." : 'Your barber has marked you as here.'}`, b.id); }
    } else if (minsTo <= 120 && !b.rem2h_at) {
      const r = await db.query('UPDATE bookings SET rem2h_at=$2 WHERE id=$1 AND rem2h_at IS NULL', [b.id, now]);
      if (r.rowCount && leadMin > 130) { sent++; await notify(db, b.customer_id, 'REMINDER_2H', 'Starts in 2 hours', `${b.service_name} at ${when}. You can cancel for free up to 30 minutes before.`, b.id); }
    }
  }
  return sent;
}
function lagosMinutesOf(iso: string): number { return lagosMinutes(new Date(iso)); }

/* ================= barber quick actions ================= */
export const TEMPLATES: Record<string, { label: string; text: (shop: string) => string }> = {
  LATE_10: { label: 'Running 10 min late', text: (s) => `${s} is about 10 minutes late. Thank you for waiting.` },
  LATE_20: { label: 'Running 20 min late', text: (s) => `${s} is about 20 minutes late. Thank you for waiting.` },
  READY_SOON: { label: 'Ready for the next customer soon', text: (s) => `${s} will be ready for you soon. Please stay close.` },
  BREAK: { label: 'Short break', text: (s) => `${s} is on a short break. Back in about 15 minutes.` },
};
async function todaysCustomers(t: Conn, barberId: number) {
  return t.many<any>(`SELECT id, customer_id, start_min, service_name FROM bookings WHERE barber_id=$1 AND date=$2 AND status IN ('CONFIRMED','ARRIVED') ORDER BY start_min`, [barberId, lagosDate()]);
}
async function dailyCap(t: Conn, barberUid: number, action: string, max: number) {
  const n = (await t.one<{ c: number }>(`SELECT COUNT(*)::int c FROM audit_log WHERE actor_user_id=$1 AND action=$2 AND created_at > $3`, [barberUid, action, new Date(clock.now().getTime() - 86400000).toISOString()])).c;
  if (n >= max) throw new AppError(429, 'RATE_LIMITED', `You can send up to ${max} of these each day.`);
}
export async function broadcastToQueue(db: Db, barberUid: number, barberId: number, template: string) {
  await need(db, 'feature_quick_actions', 'Quick actions');
  const tpl = TEMPLATES[template]; if (!tpl) throw badRequest('We do not know that message.');
  return db.tx(async (t) => {
    await dailyCap(t, barberUid, 'QUEUE_MESSAGE', 12);
    const shop = (await t.one<{ shop_name: string }>('SELECT shop_name FROM barbers WHERE id=$1', [barberId])).shop_name;
    const rows = await todaysCustomers(t, barberId);
    for (const r of rows) await notify(t, r.customer_id, 'BARBER_MESSAGE', shop, tpl.text(shop), r.id);
    await audit(t, null, { id: barberUid, role: 'barber' }, 'QUEUE_MESSAGE', { template, recipients: rows.length });
    return { sent: rows.length };
  });
}
/** One-tap "I'm running N minutes behind": remembered for today, shifts every customer's expected start and tells them (appointment times themselves are never rewritten). */
export async function delayQueue(db: Db, barberUid: number, barberId: number, minutes: number) {
  await need(db, 'feature_quick_actions', 'Quick actions');
  if (![5, 10, 15, 20, 30].includes(minutes)) throw badRequest('Choose 5, 10, 15, 20 or 30 minutes.');
  return db.tx(async (t) => {
    await dailyCap(t, barberUid, 'QUEUE_DELAY', 12);
    const today = lagosDate();
    const cur = await barberDelay(t, barberId, today);
    const next = Math.min(240, cur + minutes);
    await t.query('UPDATE barbers SET delay_min=$2, delay_date=$3 WHERE id=$1', [barberId, next, today]);
    const shop = (await t.one<{ shop_name: string }>('SELECT shop_name FROM barbers WHERE id=$1', [barberId])).shop_name;
    const rows = await todaysCustomers(t, barberId);
    for (const r of rows) {
      const newStart = fmtTime12(r.start_min + next);
      await notify(t, r.customer_id, 'QUEUE_DELAY', `${shop} is ${next} min late`, `Your ${r.service_name} should now start around ${newStart} (you booked ${fmtTime12(r.start_min)}). No need to rush. You can still cancel up to 30 minutes before your booked time.`, r.id);
    }
    await audit(t, null, { id: barberUid, role: 'barber' }, 'QUEUE_DELAY', { added: minutes, total: next, recipients: rows.length });
    return { delay_min: next, notified: rows.length };
  });
}
export async function clearDelay(db: Db, barberId: number) {
  await db.query('UPDATE barbers SET delay_min=0, delay_date=NULL WHERE id=$1', [barberId]); return { delay_min: 0 };
}

/* ================= barber daily summary ================= */
export async function dailySummary(db: Db, barberId: number) {
  await need(db, 'feature_daily_summary', 'Daily summary');
  const today = lagosDate(); const yday = addDays(today, -1);
  const q = (d: string) => db.one<any>(`SELECT COUNT(*) FILTER (WHERE status='COMPLETED')::int completed, COALESCE(SUM(price_kobo) FILTER (WHERE status='COMPLETED'),0)::int earned,
      COUNT(*) FILTER (WHERE status='NO_SHOW')::int no_shows, COUNT(*) FILTER (WHERE status='CANCELLED' AND payment_option<>'ONLINE' OR status='CANCELLED' AND paid_at IS NOT NULL)::int cancelled,
      COUNT(*) FILTER (WHERE status IN ('CONFIRMED','ARRIVED','IN_SERVICE'))::int remaining FROM bookings WHERE barber_id=$1 AND date=$2`, [barberId, d]);
  const [t, y] = await Promise.all([q(today), q(yday)]);
  const tomorrow = (await db.one<{ c: number }>(`SELECT COUNT(*)::int c FROM bookings WHERE barber_id=$1 AND date=$2 AND status IN ('CONFIRMED','ARRIVED')`, [barberId, addDays(today, 1)])).c;
  const rating = await ratingSummary(db, barberId);
  const wait = (await db.one<{ c: number }>(`SELECT COUNT(*)::int c FROM waitlist WHERE barber_id=$1 AND date >= $2 AND status IN ('WAITING','NOTIFIED')`, [barberId, today])).c;
  return { date: today, today: t, yesterday: y, tomorrow_booked: tomorrow, rating, waitlisted: wait };
}

/* ================= loyalty ================= */
export async function loyaltyProgress(c: Conn, s: Settings, customerId: number, barberId: number) {
  if (!s.feature_loyalty) return null;
  const visits = (await c.one<{ c: number }>(`SELECT COUNT(*)::int c FROM bookings WHERE customer_id=$1 AND barber_id=$2 AND status='COMPLETED'`, [customerId, barberId])).c;
  return { every_n: s.loyalty_every_n, visits, into_cycle: visits % s.loyalty_every_n, reward_kobo: s.loyalty_credit_kobo, next_in: s.loyalty_every_n - (visits % s.loyalty_every_n) };
}

/* ================= hooks called from bookingService ================= */
export async function afterComplete(t: Conn, b: BookingRow) {
  const s = await getSettingsCached(t as any);
  if (s.feature_reviews) await notify(t, b.customer_id, 'REVIEW_PROMPT', 'How was your visit?', `Rate your ${b.service_name}. It takes 5 seconds and helps others choose.`, b.id);
  if (s.feature_loyalty && s.loyalty_credit_kobo > 0) {
    const visits = (await t.one<{ c: number }>(`SELECT COUNT(*)::int c FROM bookings WHERE customer_id=$1 AND barber_id=$2 AND status='COMPLETED'`, [b.customer_id, b.barber_id])).c;
    if (visits > 0 && visits % s.loyalty_every_n === 0) {
      const exp = new Date(clock.now().getTime() + 90 * 86400000).toISOString();
      const r = await t.maybeOne<{ id: number }>(`INSERT INTO session_credits (customer_id, barber_id, source_booking_id, reason, value_kobo, expires_at, created_at) VALUES ($1,$2,$3,'LOYALTY',$4,$5,$6) ON CONFLICT (source_booking_id) DO NOTHING RETURNING id`, [b.customer_id, b.barber_id, b.id, s.loyalty_credit_kobo, exp, isoNow()]);
      if (r) {
        await audit(t, b.id, { id: null, role: 'system' }, 'LOYALTY_CREDIT', { credit_id: r.id, visits });
        await notify(t, b.customer_id, 'LOYALTY_CREDIT', 'Loyalty reward unlocked', `That was visit number ${visits}. You earned a ${naira(s.loyalty_credit_kobo)} session credit with this barber. We use it when you book.`, b.id);
      }
    }
  }
}
