import { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import rateLimit, { Options } from 'express-rate-limit';
import { Db } from './db';
import { config } from './config';
import { logger } from './logger';

const off = () => process.env.NODE_ENV === 'test';
const tooMany = (res: Response, message: string, retryAfterSec: number) => {
  res.setHeader('Retry-After', String(Math.max(1, retryAfterSec)));
  res.status(429).json({ error: { code: 'RATE_LIMITED', message } });
};

/**
 * DB-BACKED fixed-window limiter (table rate_limits), shared by ALL serverless instances - used for the endpoints where
 * abuse matters (signup, login, payments). One atomic upsert per request. If the limiter itself fails (DB hiccup) it FAILS OPEN
 * and logs, so a limiter problem never takes the site down (the request would fail on its own DB access anyway if the DB is really down).
 */
export function dbLimiter(db: Db, o: { name: string; windowMs: number; limit: number; message: string; key?: (req: Request) => string }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (off()) return next();
    try {
      const now = Date.now();
      const windowStart = new Date(Math.floor(now / o.windowMs) * o.windowMs).toISOString();
      const key = `${o.name}:${o.key ? o.key(req) : req.ip}`;
      const r = await db.one<{ hits: number }>(
        `INSERT INTO rate_limits (key, window_start, hits) VALUES ($1,$2,1)
         ON CONFLICT (key, window_start) DO UPDATE SET hits = rate_limits.hits + 1 RETURNING hits`, [key, windowStart]);
      if (r.hits > o.limit) return tooMany(res, o.message, Math.ceil((new Date(windowStart).getTime() + o.windowMs - now) / 1000));
    } catch (e: any) { logger.warn('rate_limiter_failed_open', { name: o.name, err: e.message }); }
    next();
  };
}

/** Failed-login guard per account: only FAILED attempts count (call recordFailedLogin from the login handler). */
const ACCOUNT_WINDOW_MS = 15 * 60_000, ACCOUNT_LIMIT = 8;
const acctKey = (identifier: string) => `login_fail:${identifier.trim().toLowerCase().slice(0, 100)}`;
const acctWindow = () => new Date(Math.floor(Date.now() / ACCOUNT_WINDOW_MS) * ACCOUNT_WINDOW_MS).toISOString();
export async function assertLoginNotLocked(db: Db, identifier: string): Promise<number | null> {
  if (off()) return null;
  try {
    const r = await db.maybeOne<{ hits: number }>('SELECT hits FROM rate_limits WHERE key=$1 AND window_start=$2', [acctKey(identifier), acctWindow()]);
    if (r && r.hits >= ACCOUNT_LIMIT) return Math.ceil((new Date(acctWindow()).getTime() + ACCOUNT_WINDOW_MS - Date.now()) / 1000);
  } catch (e: any) { logger.warn('rate_limiter_failed_open', { name: 'login_fail', err: e.message }); }
  return null;
}
export async function recordFailedLogin(db: Db, identifier: string) {
  if (off()) return;
  try {
    await db.query(`INSERT INTO rate_limits (key, window_start, hits) VALUES ($1,$2,1) ON CONFLICT (key, window_start) DO UPDATE SET hits = rate_limits.hits + 1`, [acctKey(identifier), acctWindow()]);
  } catch (e: any) { logger.warn('rate_limiter_failed_open', { name: 'login_fail', err: e.message }); }
}
export const LOGIN_LOCK_MESSAGE = 'Too many wrong log-in tries on this account. Wait 15 minutes, then try again.';

/** Cheap IN-MEMORY limiter for low-value, high-volume routes (general API, webhook). LIMITATION: counters are per serverless instance
 *  and reset on cold start, so this is only a coarse flood brake - the security-relevant limits above are DB-backed. */
function memLimiter(opts: Partial<Options> & { windowMs: number; limit: number; message: string }) {
  const { message, ...rest } = opts;
  return rateLimit({
    standardHeaders: 'draft-7', legacyHeaders: false, skip: off,
    handler: (_req, res) => { res.status(429).json({ error: { code: 'RATE_LIMITED', message } }); },
    validate: { xForwardedForHeader: false, trustProxy: false }, // trust proxy is configured explicitly via TRUST_PROXY
    ...rest,
  });
}

export function makeLimits(db: Db) {
  return {
    signup: dbLimiter(db, { name: 'signup', windowMs: 15 * 60_000, limit: 10, message: 'Too many sign-ups from this network. Try again in a few minutes.' }),
    login: dbLimiter(db, { name: 'login', windowMs: 15 * 60_000, limit: 40, message: 'Too many log-in tries. Wait a few minutes, then try again.' }),
    payment: dbLimiter(db, { name: 'payment', windowMs: 60_000, limit: 20, message: 'Too many payment tries. Please slow down.' }),
    paymentCallback: memLimiter({ windowMs: 60_000, limit: 60, message: 'Too many tries. Please slow down.' }),
    webhook: memLimiter({ windowMs: 60_000, limit: 600, message: 'Too many webhook calls.' }),
    shareLink: dbLimiter(db, { name: 'sharelink', windowMs: 60_000, limit: 40, message: 'Too many tries. Please wait a minute.' }),
    api: memLimiter({ windowMs: 60_000, limit: 300, message: 'Too many tries. Please slow down.' }),
  };
}

/**
 * Cross-origin control. Default: same-origin only (no CORS headers at all).
 * Allowed extra origins come from CORS_ORIGINS. Additionally, state-changing API requests that carry an
 * Origin header must come from this app or an allowed origin (defence in depth on top of SameSite=Lax + JSON-only).
 */
export function corsAndOriginGuard(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  const allowed = config.corsOrigins;
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') return void res.status(204).end();
  }
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  if (mutating && origin && !allowed.includes(origin)) {
    let host = '';
    try { host = new URL(origin).host; } catch { /* invalid */ }
    let baseHost = '';
    try { baseHost = new URL(config.appBaseUrl).host; } catch { /* ignore */ }
    if (!host || (host !== req.headers.host && host !== baseHost)) {
      return void res.status(403).json({ error: { code: 'BAD_ORIGIN', message: 'We blocked this request. It came from another site.' } });
    }
  }
  next();
}

/** Constant-time check of "Authorization: Bearer <CRON_SECRET>" (Vercel Cron and cron-job.org both send it). */
const bearer = (req: Request) => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : ''; };
/** Constant-time equality; a length mismatch is compared against itself so timing does not depend on where the strings differ. */
function safeEqual(got: string, secret: string): boolean {
  const a = Buffer.from(got), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function cronAuth(req: Request): boolean {
  const secret = config.cronSecret;
  return !!secret && safeEqual(bearer(req), secret);
}
/** Admin portal / API: accepts ADMIN_KEY (if set) OR CRON_SECRET (fallback). Both compares always run. The cron endpoint still accepts only CRON_SECRET. */
export function adminAuth(req: Request): boolean {
  const got = bearer(req), ak = config.adminKey, cs = config.cronSecret;
  const a = !!ak && safeEqual(got, ak), c = !!cs && safeEqual(got, cs);
  return a || c;
}
