/** "Emergency, please help": a customer with a LOCKED, paid, upcoming booking tells the barber something urgent came up.
 *  The barber answers with the actions they already have: "Not served" (release it) or "Wait" (come later). If nobody answers in
 *  HELP_ESCALATE_MIN minutes, staff are told (a report + an admin alert) and the customer sees a clear status. */
import { Conn, Db, isUniqueViolation } from './db';
import { clock, isoNow } from './time';
import { AppError, badRequest, conflict, notFound } from './errors';
import { HELP_ESCALATE_MIN } from './config';
import { audit, fmtWhen, notify } from './helpers';
import { getBookingForUpdate, canCustomerCancel, BookingRow } from './bookingService';
import { getSettings } from './plans';
import { adminEvent } from './adminNotify';
import { logger } from './logger';

export const HELP_NOTE_MAX = 200;
export const HELP_DAILY_MAX = 5;
/** reports.reporter_id is NOT NULL (no migration), so the customer stays on the row; an alert is told apart by help_requests.report_id (admin lists: `staff_alert`) and this message start. */
export const HELP_ALERT_PREFIX = 'Unanswered help request';

/** Can this booking ask for help right now? (paid, upcoming, cancel window closed) */
export function helpEligible(b: Pick<BookingRow, 'status' | 'payment_status' | 'scheduled_at'>, cutoffMin: number): boolean {
  return b.status === 'CONFIRMED' && b.payment_status === 'PAID' && !canCustomerCancel(b.scheduled_at, clock.now(), cutoffMin);
}

export async function requestHelp(db: Db, customerId: number, bookingId: number, noteRaw: unknown) {
  const note = typeof noteRaw === 'string' ? noteRaw.trim() : '';
  if (note.length < 3) throw badRequest('Tell your barber in a few words what happened.');
  if (note.length > HELP_NOTE_MAX) throw badRequest(`Keep it short. ${HELP_NOTE_MAX} letters at most.`);
  return db.tx(async (t) => {
    const b = await getBookingForUpdate(t, bookingId);
    if (!b || b.customer_id !== customerId) throw notFound('We could not find that booking.');
    const set = await getSettings(t);
    if (b.status !== 'CONFIRMED' || b.payment_status !== 'PAID') throw new AppError(409, 'HELP_NOT_AVAILABLE', 'You can ask for urgent help only on a paid booking that is coming up.');
    if (canCustomerCancel(b.scheduled_at, clock.now(), set.cancel_cutoff_min)) throw new AppError(409, 'HELP_NOT_NEEDED', 'You can still cancel this booking. Cancel it, or change the time.');
    const day = new Date(clock.now().getTime() - 86400000).toISOString();
    if ((await t.one<{ c: number }>('SELECT COUNT(*)::int c FROM help_requests WHERE customer_id=$1 AND created_at > $2', [customerId, day])).c >= HELP_DAILY_MAX) throw new AppError(429, 'RATE_LIMITED', 'You sent many help requests today. Please call your barber.');
    let id: number;
    try {
      id = (await t.one<{ id: number }>('INSERT INTO help_requests (booking_id, customer_id, note, created_at) VALUES ($1,$2,$3,$4) RETURNING id', [b.id, customerId, note, isoNow()])).id;
    } catch (e: any) {
      if (isUniqueViolation(e)) throw conflict('HELP_ALREADY_OPEN', 'You already asked for help on this booking. Your barber has been told.');
      throw e;
    }
    const cust = await t.one<{ name: string }>('SELECT name FROM users WHERE id=$1', [customerId]);
    const bu = await t.one<{ user_id: number }>('SELECT user_id FROM barbers WHERE id=$1', [b.barber_id]);
    await audit(t, b.id, { id: customerId, role: 'customer' }, 'HELP_REQUESTED', { help_id: id, note });
    // High priority: the in-app notification is pushed at once (the service worker keeps HELP_REQUEST pushes on screen until tapped).
    await notify(t, bu.user_id, 'HELP_REQUEST', 'Urgent: a customer needs help', `${cust.name} says: "${note}" (${b.service_name}, ${fmtWhen(b.date, b.start_min)}). Call them, or answer in the app.`, b.id);
    await notify(t, customerId, 'HELP_SENT', 'We told your barber', 'Your barber got your message. We will tell you when they answer.', b.id);
    return { id };
  });
}

/** Called inside a barber action's transaction: the barber did something about the booking, so an open request is answered. */
export async function answerHelpOnAction(t: Conn, b: BookingRow, action: string) {
  const open = await t.maybeOne<{ id: number }>(`SELECT id FROM help_requests WHERE booking_id=$1 AND status='OPEN' FOR UPDATE`, [b.id]);
  if (!open) return;
  const status = action === 'not-served' ? 'RELEASED' : action === 'wait' ? 'COME_LATER' : 'CLOSED';
  await t.query('UPDATE help_requests SET status=$1, answered_at=$2 WHERE id=$3', [status, isoNow(), open.id]);
  if (status === 'COME_LATER') await notify(t, b.customer_id, 'HELP_ANSWERED', 'Your barber will wait', 'Your barber says: come later. They will wait for you. Come as soon as you can.', b.id);
  if (status === 'RELEASED') await notify(t, b.customer_id, 'HELP_ANSWERED', 'Your barber released the booking', 'Your barber released this booking. Open it to see what happens with your money.', b.id);
}

/** What the booking page shows. `escalated` is also true the moment the wait is over, even before the sweeper has run. */
export async function helpView(c: Conn, bookingId: number) {
  const h = await c.maybeOne<any>('SELECT id, note, status, created_at, answered_at, escalated_at FROM help_requests WHERE booking_id=$1 ORDER BY id DESC LIMIT 1', [bookingId]);
  if (!h) return null;
  const overdue = h.status === 'OPEN' && new Date(h.created_at).getTime() + HELP_ESCALATE_MIN * 60000 <= clock.now().getTime();
  return { id: h.id, note: h.note, status: h.status as string, created_at: h.created_at, answered_at: h.answered_at, escalated: !!h.escalated_at || overdue };
}

/** Sweep: an open request nobody answered in `minutes` goes to staff (a report in the staff list + an admin alert). Once per request. */
export async function escalateUnansweredHelp(db: Db, minutes = HELP_ESCALATE_MIN): Promise<number> {
  const cutoff = new Date(clock.now().getTime() - minutes * 60000).toISOString();
  // A request on a booking that is no longer live (cancelled, completed, no-show, released ...) is closed quietly: nobody needs urgent help for it any more.
  await db.query(`UPDATE help_requests h SET status='CLOSED', answered_at=$1 FROM bookings k WHERE k.id=h.booking_id AND h.status='OPEN' AND k.status NOT IN ('CONFIRMED','ARRIVED')`, [isoNow()]).catch(() => {});
  const due = await db.many<{ id: number }>(`SELECT h.id FROM help_requests h JOIN bookings k ON k.id=h.booking_id WHERE h.status='OPEN' AND h.escalated_at IS NULL AND h.created_at <= $1 AND k.status IN ('CONFIRMED','ARRIVED') ORDER BY h.id LIMIT 50`, [cutoff]);
  let n = 0;
  for (const d of due) {
    try {
      const done = await db.tx(async (t) => {
        const h = await t.maybeOne<any>(`SELECT * FROM help_requests WHERE id=$1 AND status='OPEN' AND escalated_at IS NULL FOR UPDATE`, [d.id]);
        if (!h) return false;
        const b = await t.one<any>('SELECT k.*, bb.user_id AS barber_uid FROM bookings k JOIN barbers bb ON bb.id=k.barber_id WHERE k.id=$1 FOR UPDATE OF k', [h.booking_id]);
        if (!['CONFIRMED', 'ARRIVED'].includes(b.status)) { await t.query(`UPDATE help_requests SET status='CLOSED', answered_at=$1 WHERE id=$2`, [isoNow(), h.id]); return false; }
        const msg = `${HELP_ALERT_PREFIX} (staff alert, not a complaint about the barber). The customer asked the barber for help on a locked booking and nobody answered in ${minutes} minutes. Booking #${b.id}, ${b.service_name}, ${fmtWhen(b.date, b.start_min)}. Customer note: "${h.note}". Please contact them both.`;
        const r = await t.one<{ id: number }>(`INSERT INTO reports (reporter_id, target_user_id, booking_id, category, message, created_at) VALUES ($1,NULL,$2,'OTHER',$3,$4) RETURNING id`, [h.customer_id, b.id, msg, isoNow()]);   // no target: this is an alert for staff, never a report against the barber
        await t.query('UPDATE help_requests SET escalated_at=$1, report_id=$2 WHERE id=$3', [isoNow(), r.id, h.id]);
        await audit(t, b.id, { id: null, role: 'system' }, 'HELP_ESCALATED', { help_id: h.id, report_id: r.id, minutes });
        await notify(t, h.customer_id, 'HELP_ESCALATED', 'Our team is helping', 'Your barber has not answered yet. We told the TrimSlot team and they will help you.', b.id);
        await adminEvent(t, 'HELP_UNANSWERED', 'A customer needs urgent help', `Booking #${b.id} (${fmtWhen(b.date, b.start_min)}): the barber did not answer in ${minutes} minutes. Note: "${String(h.note).slice(0, 120)}". See Reports.`, { link: '/admin.html#/reports', refKey: 'help:' + h.id });
        return true;
      });
      if (done) n++;
    } catch (e: any) { logger.warn('help_escalate_failed', { id: d.id, err: String(e?.message).slice(0, 120) }); }
  }
  return n;
}
