/** Admin alerts. The admin signs in with a key (no user account), so alerts have their own tables:
 *  admin_notifications (in-app list), admin_push_subscriptions (Web Push, same VAPID sender as everyone else), per-event preferences and quiet hours.
 *  adminEvent() never throws into the caller's transaction path for preference problems; it only inserts rows. */
import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { Conn, Db } from './db';
import { badRequest, notFound } from './errors';
import { audit } from './helpers';
import { getPushSender, subscribeSchema, vapidPublicKey, pushAvailable } from './push';
import { getSettings } from './plans';
import { clock, isoNow, lagosMinutes, minToHhmm, hhmmToMin } from './time';
import { logger } from './logger';

type H = (req: Request, res: Response) => Promise<any>;
export const ADMIN_EVENTS = {
  REFUND_WAITING: { label: 'A refund is waiting for approval', defaults: { in_app: true, push: true } },
  REFUND_AUTO_APPROVED: { label: 'A refund was auto-approved (nobody decided in time)', defaults: { in_app: true, push: true } },
  REFUND_FAILED: { label: 'A refund failed at Paystack', defaults: { in_app: true, push: true } },
  DELETION_REQUEST: { label: 'A user asked for their account to be deleted (needs admin)', defaults: { in_app: true, push: false } },
} as const;
export type AdminEvent = keyof typeof ADMIN_EVENTS;
const isEvent = (e: string): e is AdminEvent => e in ADMIN_EVENTS;

export async function getPrefs(c: Conn): Promise<Record<AdminEvent, { in_app: boolean; push: boolean }>> {
  const rows = await c.many<{ event: string; in_app: boolean; push: boolean }>('SELECT event, in_app, push FROM admin_notification_prefs');
  const out: any = {};
  for (const [k, v] of Object.entries(ADMIN_EVENTS)) out[k] = { ...v.defaults };
  for (const r of rows) if (isEvent(r.event)) out[r.event] = { in_app: r.in_app, push: r.push };
  return out;
}
export async function getQuiet(c: Conn) {
  const q = await c.one<{ quiet_enabled: boolean; quiet_start_min: number; quiet_end_min: number }>('SELECT quiet_enabled, quiet_start_min, quiet_end_min FROM admin_notification_settings WHERE id=1');
  return { enabled: q.quiet_enabled, start: minToHhmm(q.quiet_start_min), end: minToHhmm(q.quiet_end_min), start_min: q.quiet_start_min, end_min: q.quiet_end_min };
}
/** Quiet hours wrap past midnight (22:00 -> 07:00). Quiet hours only hold back PUSH; the in-app list always gets the alert. */
export function inQuietHours(q: { enabled: boolean; start_min: number; end_min: number }, nowMin = lagosMinutes(clock.now())): boolean {
  if (!q.enabled || q.start_min === q.end_min) return false;
  return q.start_min < q.end_min ? nowMin >= q.start_min && nowMin < q.end_min : nowMin >= q.start_min || nowMin < q.end_min;
}

/** Record an alert for the admin(s). `dedupeHours`: skip if the same event+ref was already raised that recently. Returns the new id (or null when muted / duplicate). */
export async function adminEvent(c: Conn, event: AdminEvent, title: string, body: string, o: { link?: string; refKey?: string; dedupeHours?: number } = {}): Promise<number | null> {
  try {
    const prefs = (await getPrefs(c))[event];
    if (!prefs.in_app && !prefs.push) return null;
    if (o.refKey && o.dedupeHours) {
      const dup = await c.maybeOne(`SELECT 1 FROM admin_notifications WHERE event=$1 AND ref_key=$2 AND created_at > $3::timestamptz - make_interval(hours => $4) LIMIT 1`, [event, o.refKey, isoNow(), o.dedupeHours]);
      if (dup) return null;
    }
    const r = await c.one<{ id: number }>(`INSERT INTO admin_notifications (event, title, body, link, ref_key, in_app, push, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [event, title.slice(0, 120), body.slice(0, 400), o.link ?? null, o.refKey ?? null, prefs.in_app, prefs.push, isoNow()]);
    return r.id;
  } catch (e: any) { logger.warn('admin_event_failed', { event, err: String(e?.message).slice(0, 120) }); return null; }
}

/** Send pending admin pushes. Held back during quiet hours (they go out when quiet hours end). Safe to call from the cron and right after a request. */
export async function flushAdminPush(db: Db, limit = 30): Promise<{ claimed: number; sent: number; removed: number; held: boolean }> {
  const quiet = await getQuiet(db);
  if (inQuietHours(quiet)) return { claimed: 0, sent: 0, removed: 0, held: true };
  const rows = await db.many<any>(`UPDATE admin_notifications n SET pushed_at=$2 WHERE n.id IN (SELECT id FROM admin_notifications WHERE push AND pushed_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING n.id, n.event, n.title, n.body, n.link`, [limit, isoNow()]);
  if (!rows.length) return { claimed: 0, sent: 0, removed: 0, held: false };
  const send = getPushSender();
  let enabled = true; try { enabled = (await getSettings(db)).feature_push; } catch { /* default on */ }
  if (!send || !enabled) return { claimed: rows.length, sent: 0, removed: 0, held: false };
  const subs = await db.many<any>('SELECT id, endpoint, p256dh, auth FROM admin_push_subscriptions');
  let sent = 0; const dead: number[] = [], okIds: number[] = [], failIds: number[] = [];
  await Promise.all(rows.flatMap((n) => subs.map((s) => {
    const payload = JSON.stringify({ title: n.title, body: n.body, url: n.link || '/admin.html#/alerts', tag: 'admin:' + n.event.toLowerCase(), type: 'ADMIN_' + n.event, id: n.id, admin: true });
    return send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload).then(
      () => { sent++; okIds.push(s.id); },
      (e: any) => { const code = e?.statusCode; if (code === 404 || code === 410) dead.push(s.id); else { failIds.push(s.id); logger.warn('admin_push_failed', { code: code ?? String(e?.message).slice(0, 80) }); } });
  })));
  if (dead.length) await db.query('DELETE FROM admin_push_subscriptions WHERE id = ANY($1::int[])', [dead]);
  if (okIds.length) await db.query('UPDATE admin_push_subscriptions SET last_ok_at=$2, failures=0 WHERE id = ANY($1::int[])', [okIds, isoNow()]);
  if (failIds.length) { await db.query('UPDATE admin_push_subscriptions SET failures=failures+1 WHERE id = ANY($1::int[])', [failIds]); await db.query('DELETE FROM admin_push_subscriptions WHERE failures >= 8'); }
  return { claimed: rows.length, sent, removed: dead.length, held: false };
}

const prefsSchema = z.object({
  prefs: z.record(z.string(), z.object({ in_app: z.boolean(), push: z.boolean() })).optional(),
  quiet: z.object({ enabled: z.boolean(), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }).optional(),
}).strict();
const okTime = (s: string) => { const [h, m] = s.split(':').map(Number); return h >= 0 && h < 24 && m >= 0 && m < 60; };

export function registerAdminAlerts(api: Router, db: Db, guard: any, wrap: (fn: H) => any) {
  const ADMIN = { id: null as number | null, role: 'admin' as const };
  api.get('/admin/alerts', guard, wrap(async (_req, res) => {
    const items = await db.many(`SELECT id, event, title, body, link, created_at, read_at FROM admin_notifications WHERE in_app ORDER BY id DESC LIMIT 100`);
    const unread = (await db.one<{ c: number }>('SELECT COUNT(*)::int c FROM admin_notifications WHERE in_app AND read_at IS NULL')).c;
    res.json({ items, unread });
  }));
  api.get('/admin/alerts/unread', guard, wrap(async (_req, res) => res.json({ unread: (await db.one<{ c: number }>('SELECT COUNT(*)::int c FROM admin_notifications WHERE in_app AND read_at IS NULL')).c })));
  api.post('/admin/alerts/read', guard, wrap(async (req, res) => {
    const id = Number(req.body?.id);
    if (req.body?.all) await db.query('UPDATE admin_notifications SET read_at=$1 WHERE read_at IS NULL', [isoNow()]);
    else if (Number.isInteger(id)) await db.query('UPDATE admin_notifications SET read_at=$2 WHERE id=$1 AND read_at IS NULL', [id, isoNow()]);
    else throw badRequest('id or all is required');
    res.json({ ok: true });
  }));
  api.get('/admin/alerts/prefs', guard, wrap(async (_req, res) => {
    const prefs = await getPrefs(db);
    res.json({ events: Object.entries(ADMIN_EVENTS).map(([k, v]) => ({ event: k, label: v.label, ...prefs[k as AdminEvent] })), quiet: await getQuiet(db),
      push: { available: pushAvailable(), vapid_public_key: vapidPublicKey(), devices: (await db.one<{ c: number }>('SELECT COUNT(*)::int c FROM admin_push_subscriptions')).c } });
  }));
  api.put('/admin/alerts/prefs', guard, wrap(async (req, res) => {
    const r = prefsSchema.safeParse(req.body); if (!r.success) throw badRequest('Invalid preferences');
    await db.tx(async (t) => {
      for (const [ev, v] of Object.entries(r.data.prefs ?? {})) {
        if (!isEvent(ev)) throw badRequest('Unknown event ' + ev);
        await t.query(`INSERT INTO admin_notification_prefs (event, in_app, push) VALUES ($1,$2,$3) ON CONFLICT (event) DO UPDATE SET in_app=EXCLUDED.in_app, push=EXCLUDED.push`, [ev, v.in_app, v.push]);
      }
      if (r.data.quiet) {
        if (!okTime(r.data.quiet.start) || !okTime(r.data.quiet.end)) throw badRequest('Quiet hours must be HH:MM');
        await t.query('UPDATE admin_notification_settings SET quiet_enabled=$1, quiet_start_min=$2, quiet_end_min=$3 WHERE id=1', [r.data.quiet.enabled, hhmmToMin(r.data.quiet.start), hhmmToMin(r.data.quiet.end)]);
      }
      await audit(t, null, ADMIN, 'ADMIN_ALERT_PREFS_UPDATED', { prefs: r.data.prefs ?? null, quiet: r.data.quiet ?? null });
    });
    res.json({ ok: true });
  }));
  api.post('/admin/alerts/subscribe', guard, wrap(async (req, res) => {
    const r = subscribeSchema.safeParse(req.body); if (!r.success) throw badRequest('Invalid push subscription');
    const n = (await db.one<{ c: number }>('SELECT COUNT(*)::int c FROM admin_push_subscriptions')).c;
    if (n >= 10) await db.query('DELETE FROM admin_push_subscriptions WHERE id IN (SELECT id FROM admin_push_subscriptions ORDER BY id LIMIT $1)', [n - 9]);
    await db.query(`INSERT INTO admin_push_subscriptions (endpoint, p256dh, auth, user_agent, created_at) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (endpoint) DO UPDATE SET p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, failures=0, user_agent=EXCLUDED.user_agent`,
      [r.data.endpoint, r.data.keys.p256dh, r.data.keys.auth, String(req.headers['user-agent'] || '').slice(0, 200), isoNow()]);
    res.json({ ok: true });
  }));
  api.post('/admin/alerts/unsubscribe', guard, wrap(async (req, res) => {
    const ep = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    if (!ep) throw badRequest('endpoint is required');
    await db.query('DELETE FROM admin_push_subscriptions WHERE endpoint=$1', [ep]);
    res.json({ ok: true });
  }));
  api.post('/admin/alerts/test', guard, wrap(async (_req, res) => {
    const id = await adminEvent(db, 'REFUND_WAITING', 'Test alert', 'This is a test alert from TrimSlot admin. If you see it, alerts are working.', { link: '/admin.html#/alerts' });
    if (id == null) throw notFound('Alerts for "refund waiting" are switched off in your preferences.');
    res.json({ ok: true, flush: await flushAdminPush(db) });
  }));
}
