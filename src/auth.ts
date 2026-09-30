import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Db } from './db';
import { config } from './config';
import { AppError, forbidden } from './errors';
import { expireHolds } from './bookingService';
import { isoNow } from './time';

export interface AuthUser { id: number; role: 'customer' | 'barber'; name: string; email?: string | null; phone?: string | null; barberId?: number; verified?: boolean }
declare global { namespace Express { interface Request { user?: AuthUser; db: Db } } }

export const COOKIE = 'trimslot_token';

export function signToken(u: { id: number; role: string }): string {
  return jwt.sign({ sub: u.id, role: u.role }, config.jwtSecret, { expiresIn: '7d' });
}

export function setAuthCookie(res: Response, token: string) {
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 7 * 24 * 3600 * 1000, path: '/' });
}

/** Loads the user from the DB on every request (so role/existence is never taken from the token alone), then lazily releases
 *  that user's expired unpaid holds so what they see is always correct even if the cron sweeper never runs. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const h = req.headers.authorization;
    const token = req.cookies?.[COOKIE] || (h && h.startsWith('Bearer ') ? h.slice(7) : null);
    if (!token) return next();
    let p: any;
    try { p = jwt.verify(token, config.jwtSecret); } catch { return next(); } // invalid token => anonymous
    // ONE round trip: user + barber profile + "does this user have an expired unpaid hold to release?"
    const u = await req.db.maybeOne<{ id: number; role: 'customer' | 'barber'; name: string; email: string | null; phone: string | null; barber_id: number | null; verified: boolean | null; stale: boolean }>(
      `SELECT u.id, u.role, u.name, u.email, u.phone, b.id AS barber_id, b.verified,
              (   (u.role='customer' AND EXISTS (SELECT 1 FROM bookings k WHERE k.customer_id=u.id AND k.status='PENDING_PAYMENT' AND k.hold_expires_at < $2))
               OR (b.id IS NOT NULL AND EXISTS (SELECT 1 FROM bookings k WHERE k.barber_id=b.id AND k.status='PENDING_PAYMENT' AND k.hold_expires_at < $2))) AS stale
         FROM users u LEFT JOIN barbers b ON b.user_id=u.id WHERE u.id=$1`, [Number(p.sub), isoNow()]);
    if (u) {
      const user: AuthUser = { id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone };
      if (u.role === 'barber') { user.barberId = u.barber_id ?? undefined; user.verified = !!u.verified; }
      if (u.stale) await expireHolds(req.db, u.role === 'barber' ? (u.barber_id ? { barberId: u.barber_id } : {}) : { customerId: u.id });
      req.user = user;
    }
    next();
  } catch (e) { next(e); }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new AppError(401, 'UNAUTHENTICATED', 'Please log in to continue.'));
  next();
}
export function requireRole(role: 'customer' | 'barber') {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(401, 'UNAUTHENTICATED', 'Please log in to continue.'));
    if (req.user.role !== role) return next(forbidden(`This action is for ${role}s only.`));
    if (role === 'barber' && !req.user.barberId) return next(forbidden('Barber profile missing.'));
    next();
  };
}
