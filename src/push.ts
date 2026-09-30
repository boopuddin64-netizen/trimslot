/** Web Push (VAPID). Every row in `notifications` is an outbox item: `pushed_at IS NULL` = not pushed yet. flushPush() claims rows with
 *  FOR UPDATE SKIP LOCKED (safe across serverless instances), sends them, and removes subscriptions the push service reports gone (404/410).
 *  Push is best-effort delivery on top of the in-app notification, which is always stored. No SMS / email / paid service involved. */
import webpush from 'web-push';
import { z } from 'zod';
import { Db } from './db';
import { getSettings } from './plans';
import { isoNow } from './time';
import { logger } from './logger';
import { badRequest } from './errors';

export interface PushPayload { title: string; body: string; url: string; tag: string; type: string; id: number }
export type Sender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<void>;

let sender: Sender | null = null;
export const setPushSender = (s: Sender | null) => { sender = s; };   // tests inject a fake gateway

let vapidReady: boolean | undefined;
export function vapidPublicKey(): string { return process.env.VAPID_PUBLIC_KEY || ''; }
export function pushAvailable(): boolean { return !!sender || (!!process.env.VAPID_PUBLIC_KEY && !!process.env.VAPID_PRIVATE_KEY); }
function realSender(): Sender | null {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return null;
  if (!vapidReady) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://trimslot-eight.vercel.app', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    vapidReady = true;
  }
  return async (sub, payload) => { await webpush.sendNotification(sub, payload, { TTL: 3600, urgency: 'high', timeout: 8000 }); };
}

export const subscribeSchema = z.object({
  endpoint: z.string().url().max(1000).refine((u) => u.startsWith('https://'), 'Push endpoint must be https'),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(6).max(100) }),
});
export async function saveSubscription(db: Db, userId: number, body: unknown, ua: string | undefined) {
  const r = subscribeSchema.safeParse(body); if (!r.success) throw badRequest('Invalid push subscription');
  const n = (await db.one<{ c: number }>('SELECT COUNT(*)::int c FROM push_subscriptions WHERE user_id=$1', [userId])).c;
  if (n >= 10) await db.query('DELETE FROM push_subscriptions WHERE id IN (SELECT id FROM push_subscriptions WHERE user_id=$1 ORDER BY id LIMIT $2)', [userId, n - 9]);
  // an endpoint belongs to one browser profile: if another account used it before on this device, it moves to the current user
  await db.query(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, failures=0, user_agent=EXCLUDED.user_agent`,
    [userId, r.data.endpoint, r.data.keys.p256dh, r.data.keys.auth, (ua || '').slice(0, 200), isoNow()]);
}
export const removeSubscription = (db: Db, userId: number, endpoint?: string) =>
  db.query(endpoint ? 'DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2' : 'DELETE FROM push_subscriptions WHERE user_id=$1', endpoint ? [userId, endpoint] : [userId]);

/** Where tapping the notification should land. */
export function urlFor(type: string, role: string, bookingId: number | null): string {
  if (bookingId) return role === 'barber' ? `/#/b/${bookingId}` : `/#/booking/${bookingId}`;
  if (type.startsWith('PLAN_') || type.startsWith('CREDIT') || type === 'LOYALTY_CREDIT') return role === 'barber' ? '/#/notifications' : '/#/wallet';
  if (type === 'WAITLIST_OPEN') return '/#/notifications';
  return '/#/notifications';
}
const TAGS: Record<string, string> = { QUEUE_CHANGED: 'queue', YOURE_NEXT: 'queue', YOUR_TURN: 'queue' };

/** Send every not-yet-pushed notification. Returns counts. Safe to call from many places at once. */
export async function flushPush(db: Db, limit = 60): Promise<{ claimed: number; sent: number; removed: number }> {
  const rows = await db.many<any>(`UPDATE notifications n SET pushed_at=$2 WHERE n.id IN (SELECT id FROM notifications WHERE pushed_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING n.id, n.user_id, n.type, n.title, n.body, n.booking_id`, [limit, isoNow()]);
  if (!rows.length) return { claimed: 0, sent: 0, removed: 0 };
  const send = sender ?? realSender();
  let enabled = true;
  try { enabled = (await getSettings(db)).feature_push; } catch { /* default on */ }
  if (!send || !enabled) return { claimed: rows.length, sent: 0, removed: 0 };
  const uids = [...new Set(rows.map((r) => r.user_id))];
  const subs = await db.many<any>('SELECT s.id, s.user_id, s.endpoint, s.p256dh, s.auth, u.role FROM push_subscriptions s JOIN users u ON u.id=s.user_id WHERE s.user_id = ANY($1::int[])', [uids]);
  let sent = 0; const dead: number[] = []; const okIds: number[] = []; const failIds: number[] = [];
  const jobs: Promise<void>[] = [];
  for (const n of rows) for (const s of subs.filter((x) => x.user_id === n.user_id)) {
    const payload: PushPayload = { title: n.title, body: n.body, url: urlFor(n.type, s.role, n.booking_id), tag: (TAGS[n.type] ?? n.type.toLowerCase()) + (n.booking_id ? ':' + n.booking_id : ''), type: n.type, id: n.id };
    jobs.push(send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload)).then(
      () => { sent++; okIds.push(s.id); },
      (e: any) => { const code = e?.statusCode; if (code === 404 || code === 410) dead.push(s.id); else { failIds.push(s.id); logger.warn('push_failed', { code: code ?? String(e?.message).slice(0, 80) }); } }));
  }
  await Promise.all(jobs);
  if (dead.length) await db.query('DELETE FROM push_subscriptions WHERE id = ANY($1::int[])', [dead]);
  if (okIds.length) await db.query('UPDATE push_subscriptions SET last_ok_at=$2, failures=0 WHERE id = ANY($1::int[])', [okIds, isoNow()]);
  if (failIds.length) { await db.query('UPDATE push_subscriptions SET failures=failures+1 WHERE id = ANY($1::int[])', [failIds]); await db.query('DELETE FROM push_subscriptions WHERE failures >= 8'); }
  return { claimed: rows.length, sent, removed: dead.length };
}
