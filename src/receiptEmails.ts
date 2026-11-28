/** Customer receipts for a confirmed booking or an activated plan. Sent after the payment transaction commits.
 *  Barbers do not get these emails; they see the in-app notice. A failed send is logged and never fails the payment. */
import { Db } from './db';
import { sendMail } from './mailer';
import { renderEmail } from './emailTemplate';
import { fmtWhen, naira } from './helpers';
import { logger } from './logger';

export async function sendBookingReceipt(db: Db, bookingId: number): Promise<void> {
  try {
    const r = await db.maybeOne<any>(`SELECT b.service_name, b.price_kobo, b.booking_fee_kobo, b.date, b.start_min, br.shop_name,
        u.email, u.name, (SELECT p.reference FROM payments p WHERE p.booking_id = b.id AND p.status = 'SUCCESS' ORDER BY p.id DESC LIMIT 1) AS reference
      FROM bookings b JOIN barbers br ON br.id = b.barber_id JOIN users u ON u.id = b.customer_id WHERE b.id = $1`, [bookingId]);
    if (!r || !r.email) return;
    const fee = Number(r.booking_fee_kobo || 0);
    const rows: Array<[string, string]> = [
      ['Service', r.service_name],
      ['Barber', r.shop_name],
      ['When', fmtWhen(r.date, r.start_min)],
      ['Price', naira(Number(r.price_kobo))],
    ];
    if (fee > 0) rows.push(['Booking fee', naira(fee)]);
    rows.push(['Total paid', naira(Number(r.price_kobo) + fee)]);
    if (r.reference) rows.push(['Reference', r.reference]);
    const { text, html } = renderEmail({
      eyebrow: 'BOOKING CONFIRMED',
      title: 'Your booking is confirmed',
      intro: `Hi ${r.name || 'there'}, your payment came in and your time is saved.`,
      rows,
      note: 'Need to change it? Open TrimSlot and go to My bookings. Cancellations follow the time limit shown in the app.',
    });
    await sendMail({ to: r.email, subject: `Booking confirmed: ${r.service_name}, ${fmtWhen(r.date, r.start_min)}`, text, html });
  } catch (e) {
    logger.error('receipt_email_failed', { kind: 'booking', booking_id: bookingId, why: String((e as any)?.message ?? e).slice(0, 160) });
  }
}

export async function sendPlanReceipt(db: Db, purchaseId: number): Promise<void> {
  try {
    const r = await db.maybeOne<any>(`SELECT pp.plan_name, pp.price_kobo, pp.sessions_total, pp.expires_at, br.shop_name, u.email, u.name,
        (SELECT p.reference FROM payments p WHERE p.plan_purchase_id = pp.id AND p.status = 'SUCCESS' ORDER BY p.id DESC LIMIT 1) AS reference
      FROM plan_purchases pp JOIN barbers br ON br.id = pp.barber_id JOIN users u ON u.id = pp.customer_id WHERE pp.id = $1`, [purchaseId]);
    if (!r || !r.email) return;
    const until = new Date(r.expires_at).toISOString().slice(0, 10);
    const rows: Array<[string, string]> = [
      ['Plan', r.plan_name],
      ['Barber', r.shop_name],
      ['Sessions', String(r.sessions_total)],
      ['Valid until', until],
      ['Total paid', naira(Number(r.price_kobo))],
    ];
    if (r.reference) rows.push(['Reference', r.reference]);
    const { text, html } = renderEmail({
      eyebrow: 'PLAN ACTIVE',
      title: 'Your plan is active',
      intro: `Hi ${r.name || 'there'}, thank you. Your "${r.plan_name}" plan is ready to use.`,
      rows,
      note: 'To use a session, choose "Use plan" when you book with this barber. Sessions expire on the date above.',
    });
    await sendMail({ to: r.email, subject: `Plan active: ${r.plan_name}`, text, html });
  } catch (e) {
    logger.error('receipt_email_failed', { kind: 'plan', purchase_id: purchaseId, why: String((e as any)?.message ?? e).slice(0, 160) });
  }
}
