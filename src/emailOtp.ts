/** Email verification by one-time code. 6 digits, valid 10 minutes, 5 wrong tries, at most 3 codes per email and 10 per network per hour.
 *  Only an HMAC of the code is stored (never the code). Codes are compared in constant time. */
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { Conn, Db } from './db';
import { config } from './config';
import { AppError, badRequest } from './errors';
import { isoNow, clock } from './time';
import { sendMail } from './mailer';
import { barberVisible } from './bookingService';
import { audit } from './helpers';

export const OTP_TTL_MIN = 10;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_SENDS_PER_HOUR = 3;
export const OTP_SENDS_PER_IP_HOUR = 10;
const HOUR = 3600_000;

/** Dev/test convenience: a fixed code, only outside production and only when no real mail provider is configured. */
export const fixedDevCode = () => !config.isProd && !process.env.RESEND_API_KEY;
const makeCode = () => (fixedDevCode() ? '123456' : String(randomInt(0, 1_000_000)).padStart(6, '0'));
export const hashCode = (userId: number, email: string, code: string) => createHmac('sha256', config.jwtSecret).update(`otp:${userId}:${email.toLowerCase()}:${code}`).digest('hex');
const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
export const maskEmail = (e: string) => e.replace(/^(.).*(@.*)$/, (_m, a, d) => a + '***' + d);

/** Count one hit in the shared rate_limits table (not switched off in tests: these limits are part of the rules). Returns false when over the limit. */
async function hit(db: Conn, key: string, windowMs: number, limit: number): Promise<boolean> {
  const now = Date.now(), windowStart = new Date(Math.floor(now / windowMs) * windowMs).toISOString();
  const r = await db.one<{ hits: number }>(`INSERT INTO rate_limits (key, window_start, hits) VALUES ($1,$2,1) ON CONFLICT (key, window_start) DO UPDATE SET hits = rate_limits.hits + 1 RETURNING hits`, [key.slice(0, 200), windowStart]);
  return r.hits <= limit;
}

const paused = () => new AppError(409, 'EMAIL_VERIFICATION_OFF', 'Email checking is switched off for now. You do not need a code.');

export async function sendEmailOtp(db: Db, userId: number, ip: string) {
  if (!config.emailVerificationRequired) throw paused();   // paused: nothing is sent
  const u = await db.one<any>('SELECT id, email, email_verified_at FROM users WHERE id=$1', [userId]);
  if (!u.email) throw new AppError(400, 'EMAIL_REQUIRED', 'Add your email first. Then we can send you a code.');
  if (u.email_verified_at) return { already_verified: true };
  if (!(await hit(db, `otp_send:email:${u.email.toLowerCase()}`, HOUR, OTP_SENDS_PER_HOUR))) throw new AppError(429, 'RATE_LIMITED', 'You asked for too many codes. Try again in an hour.');
  if (!(await hit(db, `otp_send:ip:${ip}`, HOUR, OTP_SENDS_PER_IP_HOUR))) throw new AppError(429, 'RATE_LIMITED', 'Too many codes were asked from this network. Try again in an hour.');
  const code = makeCode();
  await db.query('UPDATE users SET otp_hash=$1, otp_expires_at=$2, otp_attempts=0 WHERE id=$3', [hashCode(u.id, u.email, code), new Date(clock.now().getTime() + OTP_TTL_MIN * 60000).toISOString(), u.id]);
  try {
    await sendMail({ to: u.email, subject: `Your TrimSlot code: ${code}`, text: `Your TrimSlot code is ${code}.\n\nIt works for ${OTP_TTL_MIN} minutes. Do not share it with anyone.\n\nIf you did not ask for this code, you can ignore this email.` });
  } catch (e) { await db.query('UPDATE users SET otp_hash=NULL, otp_expires_at=NULL WHERE id=$1', [u.id]); throw e; }
  return { sent: true, email: maskEmail(u.email), expires_in_min: OTP_TTL_MIN };
}

export async function verifyEmailOtp(db: Db, userId: number, codeRaw: unknown) {
  if (!config.emailVerificationRequired) throw paused();
  const code = typeof codeRaw === 'string' ? codeRaw.trim() : '';
  if (!/^\d{6}$/.test(code)) throw badRequest('Type the 6 numbers from the email.');
  const out = await db.tx(async (t) => {
    const u = await t.one<any>('SELECT id, email, email_verified_at, otp_hash, otp_expires_at, otp_attempts FROM users WHERE id=$1 FOR UPDATE', [userId]);
    if (u.email_verified_at) return { ok: true as const };
    if (!u.email) return { err: new AppError(400, 'EMAIL_REQUIRED', 'Add your email first. Then we can send you a code.') };
    if (!u.otp_hash || !u.otp_expires_at || new Date(u.otp_expires_at).getTime() < clock.now().getTime()) return { err: new AppError(400, 'OTP_EXPIRED', 'That code has ended. Ask for a new code.') };
    if (u.otp_attempts >= OTP_MAX_ATTEMPTS) return { err: new AppError(429, 'OTP_LOCKED', 'Too many wrong tries. Ask for a new code.') };
    if (!safeEq(u.otp_hash, hashCode(u.id, u.email, code))) {
      await t.query('UPDATE users SET otp_attempts = otp_attempts + 1 WHERE id=$1', [u.id]);       // saved even though we answer with an error
      const left = OTP_MAX_ATTEMPTS - (u.otp_attempts + 1);
      return { err: new AppError(400, 'OTP_WRONG', left > 0 ? `That code is wrong. You have ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong tries. Ask for a new code.') };
    }
    await t.query('UPDATE users SET email_verified_at=$1, otp_hash=NULL, otp_expires_at=NULL, otp_attempts=0 WHERE id=$2', [isoNow(), u.id]);
    await audit(t, null, { id: u.id, role: 'system' }, 'EMAIL_VERIFIED', { user_id: u.id });
    return { ok: true as const };
  });
  if ('err' in out) throw out.err;
  return { verified: true };
}

/** A changed email is unverified again; any pending code is thrown away. */
export const resetEmailVerification = (c: Conn, userId: number) => c.query('UPDATE users SET email_verified_at=NULL, otp_hash=NULL, otp_expires_at=NULL, otp_attempts=0 WHERE id=$1', [userId]);

const needMsg = (hasEmail: boolean, what: string) => hasEmail ? `Verify your email ${what}. We send you a 6-digit code.` : `Add your email ${what}. We send you a 6-digit code to check it.`;

/** Customers: a verified email is needed before their FIRST booking. Anyone who already has a real booking is not blocked (existing users keep working). */
export async function assertCustomerMayBook(c: Conn, customerId: number) {
  if (!config.emailVerificationRequired) return;
  const u = await c.maybeOne<any>('SELECT email, email_verified_at FROM users WHERE id=$1', [customerId]);
  if (!u || u.email_verified_at) return;
  if (await c.maybeOne(`SELECT 1 FROM bookings WHERE customer_id=$1 AND ${barberVisible()} LIMIT 1`, [customerId])) return;
  throw new AppError(403, 'EMAIL_NOT_VERIFIED', needMsg(!!u.email, 'before your first booking'), { needs_email: !u.email });
}
/** The emergency action always needs a verified email (no grandfathering). */
export async function assertEmailVerified(c: Conn, userId: number, what: string) {
  if (!config.emailVerificationRequired) return;
  const u = await c.maybeOne<any>('SELECT email, email_verified_at FROM users WHERE id=$1', [userId]);
  if (!u || u.email_verified_at) return;
  throw new AppError(403, 'EMAIL_NOT_VERIFIED', needMsg(!!u.email, what), { needs_email: !u.email });
}
/** A barber shop is bookable once the barber's email is verified (barbers who joined before this rule are exempt). */
export const barberEmailReadySql = (barberAlias = 'b') => !config.emailVerificationRequired ? 'TRUE' : `EXISTS (SELECT 1 FROM users bu WHERE bu.id = ${barberAlias}.user_id AND (bu.email_verified_at IS NOT NULL OR bu.email_verify_exempt))`;
