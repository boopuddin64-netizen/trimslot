import { z } from 'zod';
import express, { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import helmet from 'helmet';
import { Db, isUniqueViolation } from './db';
import { config, CANCEL_CUTOFF_MIN, TIMEZONE } from './config';
import { AppError, badRequest, conflict, notFound } from './errors';
import { authenticate, requireAuth, requireRole, setAuthCookie, signToken } from './auth';
import * as V from './validation';
import { parse } from './validation';
import { getAvailableSlots } from './slots';
import { audit, fmtTime12 } from './helpers';
import {
  BarberAction, barberAction, canCustomerCancel, cancelCutoff, createBooking, customerCancel, customerCheckIn,
  expireHolds, getBooking, orderedQueue, queueInfo, BookingRow, isIncomplete, barberVisible,
} from './bookingService';
import { handleWebhook, initializePayment, initializePlanPurchase, mockMarkPaid, processReference, recordPaymentEvent } from './paystack';
import { barberPlanOverview, customerWallet, entitlementsFor, getSettings, limitsOf, planSchema, publicPlans, savePlan, settingsView, updateSettings } from './plans';
import { clock, hhmmToMin, isValidDate, isoNow, lagosDate, minToHhmm } from './time';
import { TRANSITIONS } from './stateMachine';
import { makeLimits, corsAndOriginGuard, assertLoginNotLocked, recordFailedLogin, LOGIN_LOCK_MESSAGE, cronAuth, adminAuth } from './security';
import { registerAdmin } from './admin';
import { registerAdminPower } from './admin2';
import { registerAdmin3 } from './admin3';
import { registerAdminDelete } from './adminDelete';
import { ledgerBlocked, outstandingKobo } from './ledger';
import { logger, requestLogger } from './logger';
import { registerSmart, backgroundAfterResponse } from './smartRoutes';
import { vapidPublicKey, pushAvailable, flushPush } from './push';
import { etaFrom, barberDelay, getCustomerInsights, ratingSummary, reliabilityFor, loyaltyProgress } from './smart';
import { getSettingsCached } from './plans';
import { runSweep } from './sweep';
import { listBankInfo, resolveAccount, savePayout, payoutStatus, acctSchema } from './payouts';
import { bookingsAffectedBy, conflictDetails, loadAvailState, notifyAffected, publicNotices, scheduleDiff, AvailState, Sched, fmtDay } from './availability';

const wrap = (fn: (req: Request, res: Response) => any) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

/** What a barber sees about their review: verified flag, status, and the admin's reason / message. */
const barberReview = async (db: Db, userId: number) => {
  const r = await db.maybeOne<any>('SELECT verified, review_status, review_reason, resubmit_note FROM barbers WHERE user_id=$1', [userId]);
  return { verified: !!r?.verified, review_status: r?.review_status ?? 'PENDING', review_reason: r && r.review_status !== 'VERIFIED' && r.review_status !== 'PENDING' ? r.review_reason : null };
};
const publicUser = async (db: Db, u: any) => {
  const out: any = { id: u.id, role: u.role, name: u.name, email: u.email ?? null, phone: u.phone ?? null };
  if (u.role === 'barber') Object.assign(out, await barberReview(db, u.id));
  return out;
};

/** Per-request memo so lists of bookings don't repeat the same barber/queue lookups (N+1). */
type Memo = { barbers: Map<number, Promise<any>>; queues: Map<string, Promise<BookingRow[]>>; delays: Map<number, Promise<number>> };
const newMemo = (): Memo => ({ barbers: new Map(), queues: new Map(), delays: new Map() });
async function decorate(db: Db, b: BookingRow, opts: { forBarber?: boolean; queue?: BookingRow[]; memo?: Memo } = {}) {
  const memo = opts.memo;
  const barberQ = () => db.maybeOne('SELECT b.id, b.shop_name, b.location, u.name AS barber_name FROM barbers b JOIN users u ON u.id=b.user_id WHERE b.id=$1', [b.barber_id]);
  let barberP: Promise<any>;
  if (memo) { barberP = memo.barbers.get(b.barber_id) ?? barberQ(); memo.barbers.set(b.barber_id, barberP); } else barberP = barberQ();
  const barber = await barberP;
  const incomplete = isIncomplete(b);
  const out: any = {
    id: b.id, customer_id: b.customer_id, barber_id: b.barber_id, service_id: b.service_id,
    family_member_id: b.family_member_id, entitlement_type: b.entitlement_type,
    service_name: b.service_name, price_kobo: b.price_kobo, duration_min: b.duration_min,
    date: b.date, start_time: minToHhmm(b.start_min), end_time: minToHhmm(b.end_min), start_label: fmtTime12(b.start_min),
    scheduled_time: b.scheduled_at, arrival_time: b.arrival_time, arrival_source: b.arrival_source,
    service_start: b.service_start, service_complete: b.service_complete,
    status: b.status, payment_option: b.payment_option, payment_status: b.payment_status, paid_via: b.paid_via,
    plan_purchase_id: b.plan_purchase_id, credit_id: b.credit_id,
    hold_expires_at: b.hold_expires_at, barber_hold: !!b.barber_hold, skipped: !!b.skipped_at,
    barber_name: barber?.barber_name, shop_name: barber?.shop_name, location: barber?.location,
    cancel_deadline: cancelCutoff(b.scheduled_at).toISOString(),
    can_cancel: ['PENDING_PAYMENT', 'CONFIRMED', 'ARRIVED'].includes(b.status) && canCustomerCancel(b.scheduled_at, clock.now()),
    can_check_in: b.status === 'CONFIRMED' && b.date === lagosDate(),
    allowed_next: TRANSITIONS[b.status],
    created_at: b.created_at,
  };
  // Customer-facing only: an unpaid Pay-now booking that expired/was abandoned is "Incomplete" (no credit/refund implications).
  if (!opts.forBarber) out.incomplete = incomplete && b.status !== 'PENDING_PAYMENT';
  if (b.date === lagosDate() || b.status === 'IN_SERVICE') {
    let q = opts.queue;
    if (!q && memo) { const k = b.barber_id + '|' + b.date; const p = memo.queues.get(k) ?? orderedQueue(db, b.barber_id, b.date); memo.queues.set(k, p); q = await p; }
    out.queue = await queueInfo(db, b, q);
    const st = await getSettingsCached(db);
    if (st.feature_reminders && ['CONFIRMED', 'ARRIVED', 'IN_SERVICE'].includes(b.status)) {
      const qq = q ?? await orderedQueue(db, b.barber_id, b.date);
      const dm = memo ? (memo.delays.get(b.barber_id) ?? memo.delays.set(b.barber_id, barberDelay(db, b.barber_id, b.date)).get(b.barber_id)!) : barberDelay(db, b.barber_id, b.date);
      out.queue.eta = b.status === 'IN_SERVICE' ? null : etaFrom(qq, b, await dm);
    }
  }
  if (b.note_to_barber) out.note_to_barber = b.note_to_barber;
  if (!opts.forBarber && b.status === 'COMPLETED') {
    const st = await getSettingsCached(db);
    if (st.feature_reviews) { const rv = await db.maybeOne<any>('SELECT rating, comment, reply FROM reviews WHERE booking_id=$1', [b.id]); out.review = rv ?? null; out.can_review = !rv; }
  }
  if (opts.forBarber) {
    const c = await db.one('SELECT id, name, phone, email FROM users WHERE id=$1', [b.customer_id]);
    out.customer = { id: c.id, name: c.name, phone: c.phone, email: c.email };
    const st = await getSettingsCached(db);
    if (st.feature_reliability && ['CONFIRMED', 'ARRIVED', 'IN_SERVICE'].includes(b.status)) out.customer.reliability = await reliabilityFor(db, b.customer_id);
    if (st.feature_barber_notes && ['CONFIRMED', 'ARRIVED', 'IN_SERVICE'].includes(b.status)) { const ins = await getCustomerInsights(db, b.barber_id, b.customer_id); out.customer.note = ins.note || null; out.customer.usual = ins.usual || null; }
  }
  return out;
}

export function createApp(db: Db) {
  const app = express();
  const limits = makeLimits(db);
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use((req, _res, next) => { req.db = db; next(); });

  app.use(requestLogger);
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // the SPA uses inline style="" attributes
        imgSrc: ["'self'", 'data:', 'https:'],    // barber photo URLs are arbitrary https images
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        ...(config.isProd ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    hsts: config.isProd ? { maxAge: 15552000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'same-origin' },
  }));
  app.use('/api', corsAndOriginGuard);

  // Liveness/readiness. ?deep=1 also checks the database (used by humans / uptime monitors; the platform probe stays cheap).
  app.get('/healthz', wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.query.deep === '1') {
      try { await db.query('SELECT 1'); } catch { return void res.status(503).json({ status: 'unavailable', db: 'down' }); }
    }
    res.json({ status: 'ok', ...(req.query.deep === '1' ? { db: 'ok' } : {}), payments: config.paystackMode, runtime: config.isVercel ? 'vercel' : 'node' });
  }));

  // Webhook needs the RAW body for HMAC verification - mounted before the JSON parser, and on Vercel the platform body helper is disabled
  // (NODEJS_HELPERS=0 in vercel.json) so the stream is untouched. `req.rawBody` fallback covers runtimes that pre-read the stream.
  app.post('/api/payments/webhook', limits.webhook, express.raw({ type: () => true, limit: '256kb' }), wrap(async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.isBuffer((req as any).rawBody) ? (req as any).rawBody : Buffer.from('');
    const out = await handleWebhook(db, raw, req.header('x-paystack-signature'));
    res.status(out.status).json(out.body);
    flushPush(db, 50).catch(() => {});
  }));

  // Cron sweeper (Vercel Cron / cron-job.org): Authorization: Bearer <CRON_SECRET>. GET or POST. Idempotent.
  app.all('/api/cron/sweep', wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!config.cronSecret) return void res.status(503).json({ error: { code: 'CRON_DISABLED', message: 'CRON_SECRET is not configured' } });
    if (!cronAuth(req)) return void res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid cron credentials' } });
    if (req.method !== 'GET' && req.method !== 'POST') return void res.status(405).json({ error: { code: 'METHOD', message: 'Use GET or POST' } });
    res.json({ ok: true, ...(await runSweep(db)) });
  }));

  // Shop photo upload: raw image bytes (client-compressed JPEG, <= 300 KB). Mounted before the 50 KB JSON parser; auth is applied inline.
  app.put('/api/barber/photo', limits.api, cookieParser(), authenticate, requireRole('barber'), express.raw({ type: 'image/*', limit: '320kb' }), wrap(async (req, res) => {
    const buf: Buffer | undefined = Buffer.isBuffer(req.body) ? req.body : Buffer.isBuffer((req as any).rawBody) ? (req as any).rawBody : undefined;
    if (!buf || !buf.length) throw badRequest('Send the image as the request body (Content-Type: image/jpeg, image/png or image/webp).');
    if (buf.length > MAX_PHOTO_BYTES) throw new AppError(413, 'PHOTO_TOO_LARGE', `Photo is too large (max ${Math.round(MAX_PHOTO_BYTES / 1024)} KB after compression).`);
    const mime = sniffImage(buf);
    if (!mime) throw badRequest('Only JPEG, PNG or WebP photos are allowed.');
    const declared = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (declared !== mime) throw badRequest('Photo content does not match its declared type.');
    const id = req.user!.barberId!;
    await db.tx(async (t) => {
      await t.query(`INSERT INTO barber_photos (barber_id, mime, data, updated_at) VALUES ($1,$2,$3,$4)
        ON CONFLICT (barber_id) DO UPDATE SET mime=EXCLUDED.mime, data=EXCLUDED.data, updated_at=EXCLUDED.updated_at`, [id, mime, buf, isoNow()]);
      await t.query('UPDATE barbers SET photo_url=$1 WHERE id=$2', [`/api/barbers/${id}/photo?v=${Date.now().toString(36)}`, id]);
    });
    res.json({ ok: true, photo_url: (await db.one('SELECT photo_url FROM barbers WHERE id=$1', [id])).photo_url });
  }));

  app.use(express.json({ limit: '50kb' }));
  // Serverless (api/index.ts) pre-reads the body and marks the request as parsed; turn those bytes into req.body for JSON routes.
  app.use((req, _res, next) => {
    const raw = (req as any).rawBody;
    if (!(req as any)._body || !Buffer.isBuffer(raw) || !Buffer.isBuffer(req.body) || !req.is('application/json')) return next();
    if (raw.length > 50 * 1024) return next(new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large'));
    try { req.body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { return next(new AppError(400, 'BAD_JSON', 'Invalid JSON body')); }
    next();
  });
  app.use(cookieParser());
  // API requests are never cached by browsers/proxies
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  // CSRF hardening: cookie is SameSite=Lax and every mutating API call must be application/json.
  app.use('/api', (req, _res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json') && req.headers['content-length'] !== '0' && req.headers['content-length'] !== undefined) {
      return next(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
    }
    next();
  });
  app.use('/api', limits.api);
  app.use('/api', authenticate);
  app.use('/api', backgroundAfterResponse(db));
  const api = express.Router();

  /* ---------- admin: platform rules (Bearer ADMIN_KEY, or CRON_SECRET as fallback; never exposed to barbers/customers) ---------- */
  const adminGuard = async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!config.cronSecret && !config.adminKey) return void res.status(503).json({ error: { code: 'ADMIN_DISABLED', message: 'The admin key is not configured on the server' } });
    const lockKey = 'admin:' + req.ip;
    const wait = await assertLoginNotLocked(db, lockKey);
    if (wait) return void res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many wrong admin keys. Try again in a few minutes.' } });
    if (!adminAuth(req)) { await recordFailedLogin(db, lockKey); return void res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid admin key' } }); }
    next();
  };
  api.get('/admin/settings', adminGuard, wrap(async (_req, res) => res.json({ settings: settingsView(await getSettings(db)) })));
  api.put('/admin/settings', adminGuard, wrap(async (req, res) => res.json({ settings: await db.tx((t) => updateSettings(t, req.body)) })));
  registerAdmin(api, db, adminGuard, wrap);
  registerAdminPower(api, db, adminGuard, wrap);
  registerAdmin3(api, db, adminGuard, wrap);
  registerAdminDelete(api, db, adminGuard, wrap);

  /* ---------- meta ---------- */
  api.get('/config', wrap(async (_req, res) => res.json({
    payment_mode: config.paystackMode, mock: config.mockMode, demo: config.demoEnabled, currency: 'NGN', timezone: TIMEZONE,
    cancel_cutoff_min: CANCEL_CUTOFF_MIN, plans: true, today: lagosDate(), now: clock.now().toISOString(),
    ...(await (async () => { const st = await getSettings(db); return { maintenance: st.maintenance_mode ? st.maintenance_message : null, features: { plans: st.feature_plans, credits: st.feature_credits, pay_on_arrival: st.feature_pay_on_arrival, favourites: st.feature_favourites, rebook: st.feature_rebook, reminders: st.feature_reminders, waitlist: st.feature_waitlist, reviews: st.feature_reviews, barber_notes: st.feature_barber_notes, quick_actions: st.feature_quick_actions, reliability: st.feature_reliability, daily_summary: st.feature_daily_summary, booking_note: st.feature_booking_note, loyalty: st.feature_loyalty, push: st.feature_push && pushAvailable() }, loyalty: st.feature_loyalty ? { every_n: st.loyalty_every_n, reward_kobo: st.loyalty_credit_kobo } : null, vapid_public_key: st.feature_push ? vapidPublicKey() || null : null }; })()),
  })));

  /* ---------- auth ---------- */
  api.post('/auth/signup', limits.signup, wrap(async (req, res) => {
    const d = parse(V.signupSchema, req.body);
    const hash = bcrypt.hashSync(d.password, config.bcryptRounds);
    let userId: number;
    try {
      userId = await db.tx(async (t) => {
        const uid = (await t.one<{ id: number }>('INSERT INTO users (role, name, email, phone, password_hash, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
          [d.role, d.name, d.email ?? null, d.phone ?? null, hash, isoNow()])).id;
        if (d.role === 'barber') {
          const bid = (await t.one<{ id: number }>('INSERT INTO barbers (user_id, shop_name, location, created_at) VALUES ($1,$2,$3,$4) RETURNING id', [uid, d.shop_name, d.location ?? null, isoNow()])).id;
          for (let wd = 0; wd < 7; wd++) {
            await t.query('INSERT INTO barber_schedule (barber_id, weekday, is_working, start_min, end_min, break_start_min, break_end_min) VALUES ($1,$2,$3,540,1080,780,840)', [bid, wd, wd >= 1 && wd <= 6]);
          }
          await audit(t, null, { id: uid, role: 'barber' }, 'BARBER_SIGNUP', { note: 'awaiting admin verification' });
        }
        return uid;
      });
    } catch (e: any) {
      if (isUniqueViolation(e)) throw conflict('ACCOUNT_EXISTS', 'An account with that email or phone already exists. Try logging in.');
      throw e;
    }
    if (d.role === 'barber') logger.info('barber_signup_pending', { uid: userId });
    const u = await db.one('SELECT * FROM users WHERE id=$1', [userId]);
    setAuthCookie(res, signToken(u));
    res.status(201).json({ user: await publicUser(db, u), ...(d.role === 'barber' ? { note: 'Your shop is pending verification. You will appear to customers once approved.' } : {}) });
  }));

  api.post('/auth/login', limits.login, wrap(async (req, res) => {
    const d = parse(V.loginSchema, req.body);
    const id = d.identifier.includes('@') ? d.identifier.toLowerCase() : V.normPhone(d.identifier);
    const wait = await assertLoginNotLocked(db, id);
    if (wait) { res.setHeader('Retry-After', String(wait)); throw new AppError(429, 'RATE_LIMITED', LOGIN_LOCK_MESSAGE); }
    const u = await db.maybeOne('SELECT * FROM users WHERE email=$1 OR phone=$1', [id]);
    if (!u || !bcrypt.compareSync(d.password, u.password_hash)) {
      await recordFailedLogin(db, id);
      throw new AppError(401, 'BAD_CREDENTIALS', 'Incorrect email/phone or password.');
    }
    if (u.account_status !== 'ACTIVE') throw new AppError(403, 'ACCOUNT_RESTRICTED', u.account_status === 'DELETED' ? 'This account has been removed. Contact TrimSlot support if you think this is a mistake.' : `Your account is ${u.account_status === 'BANNED' ? 'banned' : 'suspended'}${u.status_reason ? ': ' + u.status_reason : ''}. Contact support if you think this is a mistake.`);
    setAuthCookie(res, signToken(u));
    res.json({ user: await publicUser(db, u) });
  }));

  api.post('/auth/logout', (_req, res) => { res.clearCookie('trimslot_token', { path: '/' }); res.json({ ok: true }); });
  api.get('/auth/me', wrap(async (req, res) => {
    if (!req.user) return void res.json({ user: null });
    const u = req.user;
    const unread = (await db.one<{ c: number }>('SELECT COUNT(*) c FROM notifications WHERE user_id=$1 AND NOT is_read', [u.id])).c;
    const payoutOk = u.role === 'barber' ? (!config.requirePayout || !!(await db.maybeOne<any>('SELECT 1 AS x FROM barbers WHERE user_id=$1 AND paystack_subaccount IS NOT NULL', [u.id]))) : undefined;
    res.json({ user: { id: u.id, role: u.role, name: u.name, email: u.email ?? null, phone: u.phone ?? null, ...(u.role === 'barber' ? { ...(await barberReview(db, u.id)), payout_ok: payoutOk } : {}) }, unread });
  }));

  /** Own account details (both roles). Email/phone are unique; at least one contact must remain. */
  api.patch('/me', requireAuth, wrap(async (req, res) => {
    const d = parse(V.meSchema, req.body);
    const cur = await db.one<any>('SELECT * FROM users WHERE id=$1', [req.user!.id]);
    const email = d.email !== undefined ? (d.email || null) : cur.email;
    const phone = d.phone !== undefined ? (d.phone || null) : cur.phone;
    if (!email && !phone) throw badRequest('Keep at least an email or a phone number on your account.');
    try {
      await db.query('UPDATE users SET name=$1, email=$2, phone=$3 WHERE id=$4', [d.name ?? cur.name, email, phone, cur.id]);
    } catch (e: any) {
      if (isUniqueViolation(e)) throw conflict('ACCOUNT_EXISTS', 'That email or phone is already used by another account.');
      throw e;
    }
    res.json({ user: await publicUser(db, await db.one('SELECT * FROM users WHERE id=$1', [cur.id])) });
  }));

  /* ---------- public barber directory (verified barbers only) ---------- */
  const barberCard = (b: any) => ({ id: b.id, name: b.name, shop_name: b.shop_name, photo_url: b.photo_url, location: b.location, about: b.about });
  api.get('/barbers', wrap(async (_req, res) => {
    const rows = await db.many('SELECT b.*, u.name FROM barbers b JOIN users u ON u.id=b.user_id WHERE b.verified ORDER BY b.id');
    res.json({ barbers: rows.map(barberCard) });
  }));
  api.get('/barbers/:id', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const b = Number.isInteger(id) ? await db.maybeOne('SELECT b.*, u.name FROM barbers b JOIN users u ON u.id=b.user_id WHERE b.id=$1 AND b.verified', [id]) : undefined;
    if (!b) throw notFound('Barber not found');
    const services = await db.many('SELECT id, name, price_kobo, duration_min FROM services WHERE barber_id=$1 AND active ORDER BY price_kobo, id', [b.id]);
    const schedule = await db.many('SELECT weekday, is_working, start_min, end_min, break_start_min, break_end_min FROM barber_schedule WHERE barber_id=$1 ORDER BY weekday', [b.id]);
    const plans = await publicPlans(db, b.id);
    const ent = req.user?.role === 'customer' ? await entitlementsFor(db, req.user.id, b.id) : { plans: [], credits: [] };
    const qn = await db.one<{ waiting: number; serving: number }>(`SELECT COUNT(*) FILTER (WHERE status IN ('CONFIRMED','ARRIVED'))::int AS waiting, COUNT(*) FILTER (WHERE status='IN_SERVICE')::int AS serving FROM bookings WHERE barber_id=$1 AND date=$2 AND status IN ('CONFIRMED','ARRIVED','IN_SERVICE')`, [b.id, lagosDate()]);
    const st = await getSettings(db); const lb = await ledgerBlocked(db, b.id, st);
    const extras: any = { rating: st.feature_reviews ? await ratingSummary(db, b.id) : null };
    if (req.user?.role === 'customer') {
      if (st.feature_favourites) extras.favourite = !!(await db.maybeOne('SELECT 1 FROM favourites WHERE customer_id=$1 AND barber_id=$2', [req.user.id, b.id]));
      extras.loyalty = await loyaltyProgress(db, st, req.user.id, b.id);
      if (st.feature_waitlist) extras.waitlist = await db.many(`SELECT id, date, status FROM waitlist WHERE customer_id=$1 AND barber_id=$2 AND status IN ('WAITING','NOTIFIED') AND date >= $3`, [req.user.id, b.id, lagosDate()]);
    }
    res.json({ ...extras, barber: barberCard(b), queue: qn, services, schedule: schedule.map(fmtScheduleRow), notices: await publicNotices(db, b.id), plans: st.feature_plans ? plans : [], my: st.feature_plans && st.feature_credits ? ent : { plans: st.feature_plans ? ent.plans : [], credits: st.feature_credits ? ent.credits : [] }, plan_rules: limitsOf(st),
      booking: { paused: !!b.booking_paused, online_payments: !config.requirePayout || !!b.paystack_subaccount, maintenance: st.maintenance_mode, pay_on_arrival: st.feature_pay_on_arrival && !lb.blocked, credits: st.feature_credits, plans: st.feature_plans } });
  }));
  api.get('/barbers/:id/photo', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const p = Number.isInteger(id) ? await db.maybeOne<{ mime: string; data: Buffer; updated_at: string }>('SELECT mime, data, updated_at FROM barber_photos WHERE barber_id=$1', [id]) : undefined;
    if (!p) throw notFound('No photo');
    res.setHeader('Content-Type', p.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
    res.send(p.data);
  }));
  api.get('/barbers/:id/slots', wrap(async (req, res) => {
    const serviceId = Number(req.query.service_id);
    if (!serviceId) throw badRequest('service_id is required');
    res.json(await getAvailableSlots(db, Number(req.params.id) || 0, serviceId, String(req.query.date || '')));
  }));

  /* ---------- customer bookings ---------- */
  const cust = requireRole('customer');
  api.post('/bookings', cust, wrap(async (req, res) => {
    const d = parse(V.createBookingSchema, req.body);
    const b = await createBooking(db, req.user!.id, d);
    res.status(201).json({ booking: await decorate(db, b) });
  }));
  api.get('/bookings', cust, wrap(async (req, res) => {
    const rows = await db.many<BookingRow>('SELECT * FROM bookings WHERE customer_id=$1 ORDER BY date DESC, start_min DESC, id DESC LIMIT 300', [req.user!.id]);
    const memo = newMemo();
    res.json({ today: lagosDate(), bookings: await Promise.all(rows.map((b) => decorate(db, b, { memo }))) });
  }));
  const ownBooking = async (req: Request) => {
    const id = Number(req.params.id);
    const b = Number.isInteger(id) ? await getBooking(db, id) : undefined;
    if (!b || b.customer_id !== req.user!.id) throw notFound('Booking not found');
    return b;
  };
  api.get('/bookings/:id', cust, wrap(async (req, res) => res.json({ booking: await decorate(db, await ownBooking(req)) })));
  api.post('/bookings/:id/pay', limits.payment, cust, wrap(async (req, res) => {
    const b = await ownBooking(req);
    const u = await db.one('SELECT email FROM users WHERE id=$1', [req.user!.id]);
    res.json(await initializePayment(db, b.id, u.email));
  }));
  // Customer asks us to (re)check payment. The server verifies with the gateway; client claims are ignored.
  api.post('/bookings/:id/verify', limits.payment, cust, wrap(async (req, res) => {
    const b = await ownBooking(req);
    const p = await db.many('SELECT reference FROM payments WHERE booking_id=$1 ORDER BY id DESC', [b.id]);
    let last: any = { result: 'no_payment' };
    for (const row of p) { last = await processReference(db, row.reference); if (last.result === 'processed' || last.result === 'already_processed') break; }
    res.json({ result: last.result, booking: await decorate(db, (await getBooking(db, b.id))!) });
  }));
  api.post('/bookings/:id/cancel', cust, wrap(async (req, res) => res.json({ booking: await decorate(db, await customerCancel(db, req.user!.id, (await ownBooking(req)).id)) })));
  api.post('/bookings/:id/check-in', cust, wrap(async (req, res) => res.json({ booking: await decorate(db, await customerCheckIn(db, req.user!.id, (await ownBooking(req)).id)) })));

  /* ---------- customer: plans & credits (customers only browse, buy and use) ---------- */
  api.get('/me/wallet', cust, wrap(async (req, res) => res.json(await customerWallet(db, req.user!.id))));
  api.post('/plans/:id/buy', limits.payment, cust, wrap(async (req, res) => {
    const u = await db.one('SELECT email FROM users WHERE id=$1', [req.user!.id]);
    res.status(201).json(await initializePlanPurchase(db, req.user!.id, Number(req.params.id) || 0, u.email));
  }));
  // Re-check a plan purchase with the gateway (server-side verification; client claims are ignored)
  api.post('/plan-purchases/:id/verify', limits.payment, cust, wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const own = await db.maybeOne('SELECT id FROM plan_purchases WHERE id=$1 AND customer_id=$2', [id, req.user!.id]);
    if (!own) throw notFound('Plan purchase not found');
    let last: any = { result: 'no_payment' };
    for (const row of await db.many('SELECT reference FROM payments WHERE plan_purchase_id=$1 ORDER BY id DESC', [id])) { last = await processReference(db, row.reference); if (last.result === 'processed' || last.result === 'already_processed') break; }
    res.json({ result: last.result, purchase: await db.maybeOne('SELECT id, plan_name, status, sessions_total, sessions_used, expires_at FROM plan_purchases WHERE id=$1', [id]) });
  }));

  /* ---------- payments (public callbacks) ---------- */
  api.get('/payments/callback', limits.paymentCallback, wrap(async (req, res) => {
    const reference = String(req.query.reference || req.query.trxref || '').slice(0, 100);
    let bookingId: number | undefined; let planId: number | undefined; let result = 'unknown_reference';
    if (reference) {
      const r = await processReference(db, reference);
      result = r.result; bookingId = r.booking_id; planId = r.plan_purchase_id;
      await recordPaymentEvent(db, { source: 'CALLBACK', eventType: 'callback', reference, signatureValid: null, payload: JSON.stringify(req.query), result: r.result });
    }
    if (planId) return void res.redirect(`/#/wallet?plan=${encodeURIComponent(result)}&pp=${planId}`);
    res.redirect(`/#/booking/${bookingId ?? ''}?pay=${encodeURIComponent(result)}`);
  }));
  // MOCK mode only (never available when NODE_ENV=production)
  api.get('/payments/mock/:reference', wrap(async (req, res) => {
    if (!config.mockMode) throw notFound();
    const p = await db.maybeOne('SELECT p.*, COALESCE(b.service_name, pp.plan_name) AS service_name FROM payments p LEFT JOIN bookings b ON b.id=p.booking_id LEFT JOIN plan_purchases pp ON pp.id=p.plan_purchase_id WHERE p.reference=$1', [req.params.reference]);
    if (!p) throw notFound('Unknown reference');
    res.json({ reference: p.reference, amount_kobo: p.amount_kobo, service_name: p.service_name, booking_id: p.booking_id, status: p.status });
  }));
  api.post('/payments/mock/:reference/complete', limits.payment, wrap(async (req, res) => {
    await mockMarkPaid(db, req.params.reference);
    res.json({ ok: true, next: `/api/payments/callback?reference=${encodeURIComponent(req.params.reference)}` });
  }));

  /* ---------- reports / complaints (customers and barbers) ---------- */
  api.post('/reports', requireAuth, wrap(async (req, res) => {
    const d = parse(z.object({ category: z.enum(['NO_SHOW', 'BEHAVIOUR', 'PAYMENT', 'QUALITY', 'SAFETY', 'OTHER']), message: z.string().trim().min(5, 'Tell us a bit more (at least 5 characters)').max(1000), booking_id: z.coerce.number().int().positive().optional(), target_user_id: z.coerce.number().int().positive().optional() }), req.body);
    const me = req.user!; let target: number | null = d.target_user_id ?? null;
    if (d.booking_id) {
      const b = await db.maybeOne<any>('SELECT k.id, k.customer_id, bb.user_id AS barber_uid FROM bookings k JOIN barbers bb ON bb.id=k.barber_id WHERE k.id=$1', [d.booking_id]);
      if (!b || (b.customer_id !== me.id && b.barber_uid !== me.id)) throw notFound('Booking not found');
      target = me.id === b.customer_id ? b.barber_uid : b.customer_id;      // report the other side of your own booking
    }
    if (target === me.id) throw badRequest('You cannot report yourself.');
    if (target && !(await db.maybeOne('SELECT 1 FROM users WHERE id=$1', [target]))) throw notFound('User not found');
    if ((await db.one<any>(`SELECT COUNT(*)::int c FROM reports WHERE reporter_id=$1 AND created_at > now() - interval '1 day'`, [me.id])).c >= 10) throw new AppError(429, 'RATE_LIMITED', 'You have sent a lot of reports today. Please wait before sending more.');
    const r = await db.one<any>(`INSERT INTO reports (reporter_id, target_user_id, booking_id, category, message, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [me.id, target, d.booking_id ?? null, d.category, d.message, isoNow()]);
    await audit(db, d.booking_id ?? null, { id: me.id, role: me.role }, 'REPORT_FILED', { report_id: r.id, category: d.category, target_user_id: target });
    res.status(201).json({ id: r.id, message: 'Thanks - your report reached the TrimSlot team.' });
  }));

  /* ---------- barber area ---------- */
  const barberR = express.Router();
  barberR.use(requireRole('barber'));
  const bid = (req: Request) => req.user!.barberId!;

  /** What this barber owes the platform for bookings paid outside the app (netted automatically against the next in-app payments). */
  barberR.get('/ledger', wrap(async (req, res) => {
    const st = await getSettings(db); const id = bid(req);
    const entries = await db.many(`SELECT l.id, l.booking_id, l.kind, l.amount_kobo, l.remaining_kobo, l.status, l.note, l.created_at, l.settled_at FROM commission_ledger l WHERE l.barber_id=$1 ORDER BY l.id DESC LIMIT 100`, [id]);
    res.json({ enabled: st.commission_enabled, owed_kobo: await outstandingKobo(db, id), blocked: await ledgerBlocked(db, id, st), factor: st.commission_factor, entries });
  }));
  /** A rejected shop (or one asked for more info) fixes things and goes back to the review queue. */
  barberR.post('/resubmit', wrap(async (req, res) => {
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
    const out = await db.tx(async (t) => {
      const b = await t.maybeOne<any>('SELECT id, shop_name, review_status FROM barbers WHERE id=$1 FOR UPDATE', [bid(req)]);
      if (!b) throw notFound('Barber not found');
      if (b.review_status === 'PENDING') return { review_status: 'PENDING', changed: false };
      if (!['REJECTED', 'NEEDS_INFO'].includes(b.review_status)) throw conflict('NOT_RESUBMITTABLE', b.review_status === 'SUSPENDED' ? 'A suspended shop cannot be resubmitted. Contact support.' : 'Your shop is already approved.');
      await t.query(`UPDATE barbers SET review_status='PENDING', review_reason=NULL, resubmit_note=$2, resubmitted_at=$3 WHERE id=$1`, [b.id, note || null, isoNow()]);
      await audit(t, null, { id: req.user!.id, role: 'barber' }, 'BARBER_RESUBMITTED', { barber_id: b.id, from: b.review_status, note: note || null });
      return { review_status: 'PENDING', changed: true };
    });
    res.json({ ...out, ...(await barberReview(db, req.user!.id)) });
  }));

  barberR.get('/profile', wrap(async (req, res) => {
    const b = await db.one('SELECT b.*, u.name FROM barbers b JOIN users u ON u.id=b.user_id WHERE b.id=$1', [bid(req)]);
    const services = await db.many('SELECT id, name, price_kobo, duration_min, active FROM services WHERE barber_id=$1 AND active ORDER BY price_kobo, id', [bid(req)]);
    const schedule = (await db.many('SELECT * FROM barber_schedule WHERE barber_id=$1 ORDER BY weekday', [bid(req)])).map(fmtScheduleRow);
    const days_off = await db.many('SELECT id, date, reason FROM days_off WHERE barber_id=$1 AND date >= $2 ORDER BY date', [bid(req), lagosDate()]);
    res.json({ profile: { ...barberCard(b), payout: await payoutStatus(db, bid(req)), verified: !!b.verified, review_status: b.review_status, review_reason: b.review_status === 'VERIFIED' || b.review_status === 'PENDING' ? null : b.review_reason }, services, schedule, days_off });
  }));
  /* ---- payouts: bank list -> resolve account name -> create Paystack subaccount ---- */
  barberR.get('/payout', wrap(async (req, res) => res.json(await payoutStatus(db, bid(req)))));
  barberR.get('/payout/banks', wrap(async (_req, res) => res.json(await listBankInfo())));
  barberR.post('/payout/resolve', limits.payment, wrap(async (req, res) => {
    const d = parse(acctSchema, req.body);
    res.json({ account_name: await resolveAccount(d.bank_code, d.account_number) });
  }));
  barberR.post('/payout', limits.payment, wrap(async (req, res) => res.json(await savePayout(db, req.user!.id, bid(req), req.body))));
  barberR.put('/profile', wrap(async (req, res) => {
    const d = parse(V.profileSchema, req.body);
    await db.tx(async (t) => {
      if (d.name !== undefined) await t.query('UPDATE users SET name=$1 WHERE id=$2', [d.name, req.user!.id]);
      const map: Record<string, unknown> = { shop_name: d.shop_name, photo_url: d.photo_url, location: d.location, about: d.about };
      for (const [k, v] of Object.entries(map)) if (v !== undefined) await t.query(`UPDATE barbers SET ${k}=$1 WHERE id=$2`, [v === '' ? null : v, bid(req)]); // k is from the fixed map above
    });
    res.json({ ok: true });
  }));
  const proposedFrom = (cur: AvailState, days: V.ScheduleInput['days']): AvailState => {
    const m = new Map<number, Sched>(cur.schedule);
    for (const day of days) {
      const s = hhmmToMin(day.start), e = hhmmToMin(day.end);
      if (day.is_working && e <= s) throw badRequest(`Closing time must be after opening time (weekday ${day.weekday})`);
      let bs: number | null = null, be: number | null = null;
      if (day.break_start && day.break_end) {
        bs = hhmmToMin(day.break_start); be = hhmmToMin(day.break_end);
        if (be <= bs) throw badRequest('Break end must be after break start');
        if (day.is_working && (bs < s || be > e)) throw badRequest('Break must be inside working hours');
      } else if (day.break_start || day.break_end) throw badRequest('Provide both break start and end, or neither');
      m.set(day.weekday, { is_working: day.is_working, start_min: s, end_min: e, break_start_min: bs, break_end_min: be });
    }
    return { schedule: m, offDates: cur.offDates };
  };
  const barberIdentity = async (t: Db | import('./db').Tx, req: Request) => {
    const r = await t.one('SELECT b.shop_name, u.name FROM barbers b JOIN users u ON u.id=b.user_id WHERE b.id=$1', [bid(req)]);
    return { userId: req.user!.id, shop_name: r.shop_name as string, name: r.name as string };
  };
  /** Bookings are never changed. If the edit would leave customers' active bookings outside the new hours, the barber must confirm first (409 + count),
   *  and on confirm those customers get an in-app notification. */
  barberR.put('/schedule', wrap(async (req, res) => {
    const d = parse(V.scheduleSchema, req.body);
    const out = await db.tx(async (t) => {
      await t.query('SELECT id FROM barbers WHERE id=$1 FOR UPDATE', [bid(req)]); // serialises with createBooking
      const before = await loadAvailState(t, bid(req));
      const after = proposedFrom(before, d.days);
      const affected = await bookingsAffectedBy(t, bid(req), before, after);
      if (affected.some((a) => !a.incomplete) && !d.confirm) return { conflict: conflictDetails(affected) };
      for (const day of d.days) {
        const s = after.schedule.get(day.weekday)!;
        await t.query(`INSERT INTO barber_schedule (barber_id, weekday, is_working, start_min, end_min, break_start_min, break_end_min) VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (barber_id, weekday) DO UPDATE SET is_working=EXCLUDED.is_working, start_min=EXCLUDED.start_min, end_min=EXCLUDED.end_min, break_start_min=EXCLUDED.break_start_min, break_end_min=EXCLUDED.break_end_min`,
          [bid(req), day.weekday, s.is_working, s.start_min, s.end_min, s.break_start_min, s.break_end_min]);
      }
      const diff = scheduleDiff(before, after);
      if (diff) {
        await t.query('INSERT INTO availability_changes (barber_id, kind, note, created_at) VALUES ($1,$2,$3,$4)', [bid(req), 'HOURS', diff.summary, isoNow()]);
        if (affected.length) await notifyAffected(t, await barberIdentity(t, req), affected, diff.summary);
      }
      return { notified: affected.filter((a) => !a.incomplete).length };
    });
    if ('conflict' in out && out.conflict) throw new AppError(409, 'AVAILABILITY_CONFLICT', `This change affects ${out.conflict.count} upcoming booking${out.conflict.count === 1 ? '' : 's'}. Those customers will be notified (nothing is cancelled). Confirm to continue.`, out.conflict);
    res.json({ ok: true, notified_bookings: (out as any).notified ?? 0 }); // existing bookings are never touched by schedule edits
  }));
  barberR.post('/days-off', wrap(async (req, res) => {
    const d = parse(V.dayOffSchema, req.body);
    if (!isValidDate(d.date)) throw badRequest('date must be YYYY-MM-DD');
    if (d.date < lagosDate()) throw badRequest('Date is in the past');
    const out = await db.tx(async (t) => {
      await t.query('SELECT id FROM barbers WHERE id=$1 FOR UPDATE', [bid(req)]);
      const before = await loadAvailState(t, bid(req));
      if (before.offDates.has(d.date)) throw conflict('DUPLICATE', 'That day is already marked off.');
      const after: AvailState = { schedule: before.schedule, offDates: new Set([...before.offDates, d.date]) };
      const affected = await bookingsAffectedBy(t, bid(req), before, after, d.date);
      if (affected.some((a) => !a.incomplete) && !d.confirm) return { conflict: conflictDetails(affected) };
      await t.query('INSERT INTO days_off (barber_id, date, reason) VALUES ($1,$2,$3)', [bid(req), d.date, d.reason ?? null]);
      if (affected.length) await notifyAffected(t, await barberIdentity(t, req), affected, `closed on ${fmtDay(d.date)}${d.reason ? ` (${d.reason})` : ''}`);
      return { notified: affected.filter((a) => !a.incomplete).length };
    });
    if ('conflict' in out && out.conflict) throw new AppError(409, 'AVAILABILITY_CONFLICT', `This day off affects ${out.conflict.count} upcoming booking${out.conflict.count === 1 ? '' : 's'}. Those customers will be notified (nothing is cancelled). Confirm to continue.`, out.conflict);
    res.status(201).json({ ok: true, existing_bookings_that_day: (out as any).notified ?? 0, notified_bookings: (out as any).notified ?? 0 });
  }));
  barberR.delete('/photo', wrap(async (req, res) => {
    await db.tx(async (t) => { await t.query('DELETE FROM barber_photos WHERE barber_id=$1', [bid(req)]); await t.query('UPDATE barbers SET photo_url=NULL WHERE id=$1', [bid(req)]); });
    res.json({ ok: true });
  }));
  barberR.delete('/days-off/:id', wrap(async (req, res) => {
    const r = await db.query('DELETE FROM days_off WHERE id=$1 AND barber_id=$2', [Number(req.params.id) || 0, bid(req)]);
    if (!r.rowCount) throw notFound('Day off not found');
    res.json({ ok: true });
  }));
  barberR.post('/services', wrap(async (req, res) => {
    const d = parse(V.serviceSchema, req.body);
    const r = await db.one<{ id: number }>('INSERT INTO services (barber_id, name, price_kobo, duration_min, active, created_at) VALUES ($1,$2,$3,$4,TRUE,$5) RETURNING id', [bid(req), d.name, Math.round(d.price_naira * 100), d.duration_min, isoNow()]);
    res.status(201).json({ id: r.id });
  }));
  barberR.put('/services/:id', wrap(async (req, res) => {
    const d = parse(V.serviceSchema, req.body);
    // Only affects future bookings: existing bookings hold their own snapshot of name/price/duration.
    const r = await db.query('UPDATE services SET name=$1, price_kobo=$2, duration_min=$3 WHERE id=$4 AND barber_id=$5 AND active', [d.name, Math.round(d.price_naira * 100), d.duration_min, Number(req.params.id) || 0, bid(req)]);
    if (!r.rowCount) throw notFound('Service not found');
    res.json({ ok: true });
  }));
  barberR.delete('/services/:id', wrap(async (req, res) => {
    const r = await db.query('UPDATE services SET active=FALSE WHERE id=$1 AND barber_id=$2', [Number(req.params.id) || 0, bid(req)]); // soft delete keeps history
    if (!r.rowCount) throw notFound('Service not found');
    res.json({ ok: true });
  }));

  barberR.get('/plans', wrap(async (req, res) => res.json(await barberPlanOverview(db, bid(req)))));
  barberR.post('/plans', wrap(async (req, res) => {
    const id = await db.tx((t) => savePlan(t, bid(req), null, parse(planSchema, req.body)));
    res.status(201).json({ id });
  }));
  barberR.put('/plans/:id', wrap(async (req, res) => {
    await db.tx((t) => savePlan(t, bid(req), Number(req.params.id) || 0, parse(planSchema, req.body)));
    res.json({ ok: true });
  }));
  barberR.delete('/plans/:id', wrap(async (req, res) => {
    // Stops NEW sales only; customers who already bought keep their sessions until the plan ends.
    const r = await db.query('UPDATE plans SET active=FALSE WHERE id=$1 AND barber_id=$2 AND active', [Number(req.params.id) || 0, bid(req)]);
    if (!r.rowCount) throw notFound('Plan not found');
    res.json({ ok: true });
  }));

  barberR.get('/today', wrap(async (req, res) => {
    const date = lagosDate();
    const q = await orderedQueue(db, bid(req), date);
    const memo = newMemo();
    const dec = (b: BookingRow) => decorate(db, b, { forBarber: true, queue: q, memo });
    const serving = q.find((b) => b.status === 'IN_SERVICE');
    const rest = q.filter((b) => b.status !== 'IN_SERVICE');
    // Barbers never see unpaid Pay-now holds or their expired/abandoned ("Incomplete") leftovers - those are customer-side only.
    const doneRows = await db.many<BookingRow>(`SELECT * FROM bookings WHERE barber_id=$1 AND date=$2 AND status IN ('COMPLETED','NO_SHOW','NOT_SERVED','CANCELLED') AND ${barberVisible()} ORDER BY start_min`, [bid(req), date]);
    const completed = doneRows.filter((b) => b.status === 'COMPLETED');
    res.json({
      date, now: clock.now().toISOString(),
      now_serving: serving ? await dec(serving) : null,
      next: rest[0] ? await dec(rest[0]) : null,
      waiting: await Promise.all(rest.slice(1).map(async (b) => ({ ...(await dec(b)), arrived: b.status === 'ARRIVED' }))),
      pending_payment: [],   // kept for API compatibility: unpaid holds are intentionally never shown to barbers
      done: await Promise.all(doneRows.map(dec)),
      stats: { completed: completed.length, earned_kobo: completed.reduce((a, b) => a + b.price_kobo, 0), remaining: q.length },
    });
  }));
  barberR.get('/bookings', wrap(async (req, res) => {
    const date = String(req.query.date || '');
    const rows = (date && isValidDate(date)
      ? await db.many<BookingRow>(`SELECT * FROM bookings WHERE barber_id=$1 AND date=$2 AND ${barberVisible()} ORDER BY start_min`, [bid(req), date])
      : await db.many<BookingRow>(`SELECT * FROM bookings WHERE barber_id=$1 AND date>=$2 AND ${barberVisible()} ORDER BY date, start_min LIMIT 200`, [bid(req), lagosDate()]));
    const memo = newMemo();
    res.json({ bookings: await Promise.all(rows.map((b) => decorate(db, b, { forBarber: true, memo }))) });
  }));
  const ownedBarberBooking = async (req: Request) => {
    const id = Number(req.params.id);
    const b = Number.isInteger(id) ? await getBooking(db, id) : undefined;
    if (!b || b.barber_id !== bid(req) || isIncomplete(b)) throw notFound('Booking not found');
    return b;
  };
  barberR.get('/bookings/:id', wrap(async (req, res) => {
    const b = await ownedBarberBooking(req);
    const timeline = await db.many(`SELECT a.id, a.action, a.actor_role, a.details, a.created_at, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id=a.actor_user_id WHERE a.booking_id=$1 ORDER BY a.id`, [b.id]);
    res.json({ booking: await decorate(db, b, { forBarber: true }), timeline });
  }));
  barberR.post('/bookings/:id/:action', wrap(async (req, res) => {
    const action = req.params.action as BarberAction;
    const allowed = ['mark-present', 'start', 'complete', 'record-payment', 'no-show', 'skip', 'wait', 'not-served'];
    if (!allowed.includes(action)) throw notFound('Unknown action');
    const b = await barberAction(db, req.user!.id, bid(req), Number(req.params.id) || 0, action, req.body);
    res.json({ booking: await decorate(db, b, { forBarber: true }) });
  }));

  barberR.get('/customers', wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const rows = await db.many(`
      SELECT u.id, u.name, u.phone, u.email,
        COUNT(*) FILTER (WHERE b.status='COMPLETED')::int AS total_visits,
        MAX(b.date) FILTER (WHERE b.status='COMPLETED') AS last_visit,
        COUNT(*)::int AS total_bookings
      FROM bookings b JOIN users u ON u.id=b.customer_id
      WHERE b.barber_id=$1 AND ${barberVisible('b')}
      GROUP BY u.id ORDER BY MAX(b.date) FILTER (WHERE b.status='COMPLETED') DESC NULLS LAST, u.name`, [bid(req)]);
    const filtered = q ? rows.filter((r) => `${r.name} ${r.phone ?? ''} ${r.email ?? ''}`.toLowerCase().includes(q)) : rows;
    res.json({ customers: filtered });
  }));
  barberR.get('/customers/:id', wrap(async (req, res) => {
    const cid = Number(req.params.id);
    const has = Number.isInteger(cid) ? await db.maybeOne(`SELECT 1 FROM bookings WHERE barber_id=$1 AND customer_id=$2 AND ${barberVisible()} LIMIT 1`, [bid(req), cid]) : undefined;
    if (!has) throw notFound('Customer not found'); // barbers only see their own customers
    const u = await db.one('SELECT id, name, phone, email, created_at FROM users WHERE id=$1', [cid]);
    const hist = await db.many<BookingRow>(`SELECT * FROM bookings WHERE barber_id=$1 AND customer_id=$2 AND ${barberVisible()} ORDER BY date DESC, start_min DESC`, [bid(req), cid]);
    const completed = hist.filter((h) => h.status === 'COMPLETED');
    res.json({
      customer: { ...u, total_visits: completed.length, last_visit: completed[0]?.date ?? null, no_shows: hist.filter((h) => h.status === 'NO_SHOW').length, total_spent_kobo: completed.reduce((a, b) => a + b.price_kobo, 0) },
      insights: await getCustomerInsights(db, bid(req), cid),
      bookings: await Promise.all(hist.map((b) => decorate(db, b, { forBarber: true, memo: newMemo() }))),
    });
  }));
  registerSmart(api, barberR, db, wrap, (b, o) => decorate(db, b, o), limits);
  api.use('/barber', barberR);

  app.use('/api', api);
  app.use('/api', (_req, _res, next) => next(notFound('Unknown API route')));

  // Static frontend: on Vercel the CDN serves /public directly (express.static is ignored there); locally / in Docker Express serves it.
  if (!config.isVercel) app.use(express.static(config.publicDir, { extensions: ['html'], maxAge: config.isProd ? '5m' : 0, index: 'index.html' }));

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Request body too large' } });
    logger.error('unhandled_error', { rid: (_req as any).rid, path: _req.path, err: String(err?.message || err), code: err?.code, stack: config.isProd ? undefined : String(err?.stack || '').split('\n').slice(0, 5).join(' | ') });
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.' } });
  });
  return app;
}

function fmtScheduleRow(r: any) {
  return {
    weekday: r.weekday, is_working: !!r.is_working, start: minToHhmm(r.start_min), end: minToHhmm(r.end_min),
    break_start: r.break_start_min != null ? minToHhmm(r.break_start_min) : null,
    break_end: r.break_end_min != null ? minToHhmm(r.break_end_min) : null,
  };
}

const MAX_PHOTO_BYTES = 300 * 1024;
/** Detect the real image type from magic bytes (never trust the client's claim). */
function sniffImage(b: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
