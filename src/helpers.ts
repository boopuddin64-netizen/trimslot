import { Conn } from './db';
import { isoNow, minToHhmm } from './time';

export interface Actor { id: number | null; role: 'customer' | 'barber' | 'system' | 'admin' }

export async function audit(c: Conn, bookingId: number | null, actor: Actor, action: string, details?: unknown) {
  await c.query('INSERT INTO audit_log (booking_id, actor_user_id, actor_role, action, details, created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
    [bookingId, actor.id, actor.role, action, details === undefined ? null : JSON.stringify(details), isoNow()]);
}

export async function notify(c: Conn, userId: number, type: string, title: string, body: string, bookingId?: number | null) {
  await c.query('INSERT INTO notifications (user_id, type, title, body, booking_id, is_read, created_at) VALUES ($1,$2,$3,$4,$5,FALSE,$6)',
    [userId, type, title, body, bookingId ?? null, isoNow()]);
}

export function naira(kobo: number): string {
  const n = kobo / 100;
  return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtTime12(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
export function fmtWhen(date: string, startMin: number): string {
  const d = new Date(date + 'T00:00:00Z');
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${fmtTime12(startMin)}`;
}
export { minToHhmm };

/** Tap-to-call and WhatsApp links for a phone number (Nigerian local 0803... -> +234803...). Returns null when the number is not usable. */
export function phoneLinks(phone: string | null | undefined): { tel: string; whatsapp: string } | null {
  const raw = String(phone ?? '').replace(/[\s\-()]/g, '');
  if (!raw) return null;
  let digits: string;
  if (/^0\d{10}$/.test(raw)) digits = '234' + raw.slice(1);
  else if (/^\+?\d{8,15}$/.test(raw)) digits = raw.replace(/^\+/, '');
  else return null;
  return { tel: `tel:+${digits}`, whatsapp: `https://wa.me/${digits}` };
}
