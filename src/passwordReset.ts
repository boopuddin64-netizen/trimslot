/** Password recovery by one-time email code. Only an HMAC of each code is stored. */
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Conn, Db } from './db';
import { config } from './config';
import { AppError, badRequest } from './errors';
import { clock } from './time';
import { sendMail } from './mailer';
import { audit } from './helpers';

const CODE_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const HOUR = 60 * 60_000;
const GENERIC_SENT = 'If an account uses that email address, a reset code has been sent.';
const INVALID_CODE = 'That code could not reset the password. Check it or request a new code.';
const codeKey = () => createHmac('sha256', config.jwtSecret).update('trimslot:password-reset:v1').digest();
const hashCode = (userId: number, email: string, code: string) => createHmac('sha256', codeKey()).update(`reset:${userId}:${email.toLowerCase()}:${code}`).digest('hex');
const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const makeCode = () => (!config.isProd && !process.env.RESEND_API_KEY ? '123456' : String(randomInt(0, 1_000_000)).padStart(6, '0'));
const emailSchema = z.string().trim().email().max(254).transform((s) => s.toLowerCase());
const resetSchema = z.object({
  email: emailSchema,
  code: z.string().trim().regex(/^\d{6}$/),
  new_password: z.string().min(8).max(200),
});

/** Shared DB-backed limits: 60 requests per network and 3 codes per address per hour. */
async function hit(db: Conn, key: string, windowMs: number, limit: number) {
  const now = Date.now(), start = new Date(Math.floor(now / windowMs) * windowMs).toISOString();
  const r = await db.one<{ hits: number }>(`INSERT INTO rate_limits (key, window_start, hits) VALUES ($1,$2,1)
    ON CONFLICT (key, window_start) DO UPDATE SET hits=rate_limits.hits+1 RETURNING hits`, [key.slice(0, 200), start]);
  return r.hits <= limit;
}

export async function requestPasswordReset(db: Db, rawEmail: unknown, ip: string) {
  const parsed = emailSchema.safeParse(rawEmail);
  if (!parsed.success) throw badRequest('Enter a valid email address.');
  const email = parsed.data;
  if (!(await hit(db, `password_reset_ip:${String(ip || 'unknown').slice(0, 64)}`, HOUR, 60))) {
    throw new AppError(429, 'RATE_LIMITED', 'Too many reset requests. Try again in an hour.');
  }
  const u = await db.maybeOne<{ id: number; email: string }>(
    "SELECT id, email FROM users WHERE lower(email)=$1 AND account_status='ACTIVE'", [email]);
  if (!u || !(await hit(db, `password_reset_email:${email}`, HOUR, 3))) return { message: GENERIC_SENT };

  const code = makeCode();
  const digest = hashCode(u.id, u.email, code);
  await db.query(`UPDATE users SET password_reset_hash=$1, password_reset_expires_at=$2, password_reset_attempts=0 WHERE id=$3`,
    [digest, new Date(clock.now().getTime() + CODE_TTL_MIN * 60_000).toISOString(), u.id]);
  try {
    await sendMail({ to: u.email, subject: 'Reset your TrimSlot password', text: `We received a request to reset your TrimSlot password.\n\nYour 6-digit code is ${code}. It works for ${CODE_TTL_MIN} minutes. Do not share it with anyone.\n\nIf you did not ask for this, you can ignore this email.` });
  } catch {
    await db.query('UPDATE users SET password_reset_hash=NULL, password_reset_expires_at=NULL, password_reset_attempts=0 WHERE id=$1 AND password_reset_hash=$2', [u.id, digest]);
    // Keep the same response for unknown addresses and mail delivery failures.
  }
  return { message: GENERIC_SENT };
}

export async function completePasswordReset(db: Db, input: unknown) {
  const parsed = resetSchema.safeParse(input);
  if (!parsed.success) throw badRequest('Enter your email, 6-digit code, and a password of at least 8 characters.');
  const d = parsed.data;
  const out = await db.tx(async (t) => {
    const u = await t.maybeOne<any>(`SELECT id, role, email, password_reset_hash, password_reset_expires_at, password_reset_attempts
      FROM users WHERE lower(email)=$1 AND account_status='ACTIVE' FOR UPDATE`, [d.email]);
    if (!u || !u.password_reset_hash || !u.password_reset_expires_at || new Date(u.password_reset_expires_at).getTime() < clock.now().getTime()) {
      return { err: new AppError(400, 'RESET_CODE_INVALID', INVALID_CODE) };
    }
    if (u.password_reset_attempts >= MAX_ATTEMPTS) return { err: new AppError(429, 'RESET_CODE_LOCKED', 'Too many wrong codes. Request a new reset code.') };
    if (!safeEq(u.password_reset_hash, hashCode(u.id, u.email, d.code))) {
      await t.query('UPDATE users SET password_reset_attempts=password_reset_attempts+1 WHERE id=$1', [u.id]);
      return { err: new AppError(400, 'RESET_CODE_INVALID', INVALID_CODE) };
    }
    const passwordHash = bcrypt.hashSync(d.new_password, config.bcryptRounds);
    await t.query(`UPDATE users SET password_hash=$1, session_version=session_version+1,
      password_reset_hash=NULL, password_reset_expires_at=NULL, password_reset_attempts=0 WHERE id=$2`, [passwordHash, u.id]);
    await audit(t, null, { id: u.id, role: u.role }, 'PASSWORD_RESET', {});
    return { ok: true as const };
  });
  if ('err' in out) throw out.err;
  return { reset: true };
}
