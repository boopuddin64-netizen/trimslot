import { NextFunction, Request, Response, Router } from 'express';
import { Db } from './db';
import { requireAuth, requireRole } from './auth';
import { notFound, badRequest } from './errors';
import { config } from './config';
import { notify } from './helpers';
import { getSettingsCached } from './plans';
import * as S from './smart';
import { flushPush, pushAvailable, removeSubscription, saveSubscription, vapidPublicKey } from './push';
import { logger } from './logger';

type H = (req: Request, res: Response) => any;
const numId = (v: unknown) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw notFound(); return n; };

/** Fire-and-forget housekeeping that must still finish on serverless: kept alive with waitUntil, run after the response is sent. */
export function backgroundAfterResponse(db: Db) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (process.env.NODE_ENV === 'test' && !process.env.PUSH_AUTO) return next();
    if (req.method === 'OPTIONS' || req.path === '/config' || req.path.startsWith('/admin/settings')) return next();
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    const poll = req.method === 'GET' && (req.path === '/auth/me' || req.path === '/notifications' || req.path === '/barber/today' || req.path === '/bookings');
    if (!mutating && !poll) return next();
    let done: () => void = () => {};
    const p = new Promise<void>((r) => { done = r; });
    (async () => { try { const m = await import('@vercel/functions'); (m as any).waitUntil?.(p); } catch { /* not on Vercel */ } })();
    res.on('close', () => {
      (async () => {
        try {
          if (mutating || poll) await S.runSmartTick(db, mutating);
          for (let i = 0; i < 6; i++) { const r = await flushPush(db, 100); if (r.claimed < 100) break; }
        } catch (e: any) { logger.warn('background_failed', { err: String(e?.message).slice(0, 100) }); }
      })().finally(done);
    });
    next();
  };
}

export function registerSmart(api: Router, barberR: Router, db: Db, wrap: (fn: H) => any, decorate: (b: any, o?: any) => Promise<any>, limits: { api: any }) {
  const cust = requireRole('customer');

  /* ---------- push ---------- */
  api.post('/push/subscribe', requireAuth, wrap(async (req, res) => {
    if (!(await getSettingsCached(db)).feature_push) throw badRequest('Push alerts are off.');
    await saveSubscription(db, req.user!.id, req.body?.subscription ?? req.body, req.headers['user-agent']);
    res.status(201).json({ ok: true });
  }));
  api.post('/push/unsubscribe', requireAuth, wrap(async (req, res) => {
    await removeSubscription(db, req.user!.id, typeof req.body?.endpoint === 'string' ? req.body.endpoint : undefined);
    res.json({ ok: true });
  }));
  api.get('/push/status', requireAuth, wrap(async (req, res) => {
    const n = (await db.one<{ c: number }>('SELECT COUNT(*)::int c FROM push_subscriptions WHERE user_id=$1', [req.user!.id])).c;
    res.json({ available: pushAvailable(), devices: n });
  }));
  api.post('/push/test', requireAuth, wrap(async (req, res) => {
    const recent = await db.one<{ c: number }>(`SELECT COUNT(*)::int c FROM notifications WHERE user_id=$1 AND type='TEST_PUSH' AND created_at > $2`, [req.user!.id, new Date(Date.now() - 60000).toISOString()]);
    if (recent.c >= 2) throw badRequest('Wait a minute before you send another test.');
    await notify(db, req.user!.id, 'TEST_PUSH', 'Alerts are on', "You will get alerts here about bookings, your turn in line and reminders.");
    const r = await flushPush(db, 20);
    res.json({ ok: true, sent: r.sent });
  }));

  /* ---------- notifications centre (paged, per-item read) ---------- */
  api.get('/notifications', requireAuth, wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100);
    const before = Number(req.query.before) || 0, after = Number(req.query.after) || 0;
    const p: unknown[] = [req.user!.id, limit]; let w = '';
    if (before) { p.push(before); w += ` AND id < $${p.length}`; }
    if (after) { p.push(after); w += ` AND id > $${p.length}`; }
    const rows = await db.many(`SELECT id, type, title, body, booking_id, is_read, created_at FROM notifications WHERE user_id=$1${w} ORDER BY id DESC LIMIT $2`, p);
    const unread = (await db.one<{ c: number }>('SELECT COUNT(*) c FROM notifications WHERE user_id=$1 AND NOT is_read', [req.user!.id])).c;
    res.json({ unread, notifications: rows, next_before: rows.length === limit ? rows[rows.length - 1].id : null });
  }));
  api.post('/notifications/read', requireAuth, wrap(async (req, res) => {
    const id = Number(req.body?.id);
    if (Number.isInteger(id) && id > 0) await db.query('UPDATE notifications SET is_read=TRUE WHERE user_id=$1 AND id=$2', [req.user!.id, id]);
    else await db.query('UPDATE notifications SET is_read=TRUE WHERE user_id=$1 AND NOT is_read', [req.user!.id]);
    res.json({ ok: true });
  }));

  /* ---------- customer: favourites / rebook / waitlist / reviews ---------- */
  api.post('/barbers/:id/favourite', cust, wrap(async (req, res) => res.json(await S.setFavourite(db, req.user!.id, numId(req.params.id), req.body?.on !== false))));
  api.get('/me/favourites', cust, wrap(async (req, res) => {
    if (!(await getSettingsCached(db)).feature_favourites) return void res.json({ barbers: [] });
    res.json({ barbers: await db.many(`SELECT b.id, b.shop_name, b.photo_url, b.location, u.name FROM favourites f JOIN barbers b ON b.id=f.barber_id AND b.verified JOIN users u ON u.id=b.user_id WHERE f.customer_id=$1 ORDER BY f.created_at DESC`, [req.user!.id]) });
  }));
  api.get('/me/rebook', cust, wrap(async (req, res) => {
    if (!(await getSettingsCached(db)).feature_rebook) return void res.json({ suggestion: null });
    res.json(await S.rebookSuggestion(db, req.user!.id));
  }));
  api.post('/waitlist', cust, wrap(async (req, res) => res.status(201).json({ entry: await S.joinWaitlist(db, req.user!.id, req.body) })));
  api.get('/waitlist', cust, wrap(async (req, res) => res.json({ waitlist: (await getSettingsCached(db)).feature_waitlist ? await S.myWaitlist(db, req.user!.id) : [] })));
  api.delete('/waitlist/:id', cust, wrap(async (req, res) => res.json(await S.leaveWaitlist(db, req.user!.id, numId(req.params.id)))));
  api.post('/bookings/:id/review', cust, wrap(async (req, res) => res.status(201).json({ review: await S.addReview(db, req.user!.id, numId(req.params.id), req.body) })));
  api.get('/barbers/:id/reviews', wrap(async (req, res) => {
    if (!(await getSettingsCached(db)).feature_reviews) return void res.json({ enabled: false, summary: { count: 0, average: null }, reviews: [] });
    const id = numId(req.params.id);
    res.json({ enabled: true, summary: await S.ratingSummary(db, id), reviews: await S.listReviews(db, id, { limit: Number(req.query.limit) || 10, before: Number(req.query.before) || undefined }) });
  }));

  /* ---------- barber ---------- */
  const bid = (req: Request) => req.user!.barberId!;
  barberR.get('/reviews', wrap(async (req, res) => {
    if (!(await getSettingsCached(db)).feature_reviews) return void res.json({ enabled: false, summary: { count: 0, average: null }, reviews: [] });
    res.json({ enabled: true, summary: await S.ratingSummary(db, bid(req)), reviews: await S.listReviews(db, bid(req), { limit: 30, before: Number(req.query.before) || undefined }) });
  }));
  barberR.post('/reviews/:id/reply', wrap(async (req, res) => res.json(await S.barberReply(db, bid(req), numId(req.params.id), req.body?.reply))));
  barberR.put('/customers/:id/note', wrap(async (req, res) => res.json(await S.saveCustomerNote(db, bid(req), numId(req.params.id), req.body?.note ?? ''))));
  barberR.get('/queue/templates', wrap(async (_req, res) => res.json({ templates: Object.entries(S.TEMPLATES).map(([key, t]) => ({ key, label: t.label })), enabled: (await getSettingsCached(db)).feature_quick_actions })));
  barberR.post('/queue/message', wrap(async (req, res) => res.json(await S.broadcastToQueue(db, req.user!.id, bid(req), String(req.body?.template || '')))));
  barberR.post('/queue/delay', wrap(async (req, res) => res.json(await S.delayQueue(db, req.user!.id, bid(req), Number(req.body?.minutes)))));
  barberR.delete('/queue/delay', wrap(async (req, res) => res.json(await S.clearDelay(db, bid(req)))));
  barberR.get('/summary', wrap(async (req, res) => {
    if (!(await getSettingsCached(db)).feature_daily_summary) return void res.json({ enabled: false });
    res.json({ enabled: true, ...(await S.dailySummary(db, bid(req))) });
  }));
}
