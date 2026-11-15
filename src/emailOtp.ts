/** Email verification by one-time code. 6 digits, valid 10 minutes, 5 wrong tries, at most 3 codes per email and 60 per network per hour.
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
export const OTP_SENDS_PER_IP_HOUR = 60;
const HOUR = 3600_000;

/** Dev/test convenience: a fixed code, only outside production and only when no real mail provider is configured. */
export const fixedDevCode = () => !config.isProd && !process.env.RESEND_API_KEY;
const makeCode = () => (fixedDevCode() ? '123456' : String(randomInt(0, 1_000_000)).padStart(6, '0'));
/** The code hash uses its own key, derived from the app secret for this one purpose (a leaked code hash tells nothing about the login secret, and the login secret is never used as an HMAC key here). */
const otpKey = () => createHmac('sha256', config.jwtSecret).update('trimslot:email-otp:v1').digest();
export const hashCode = (userId: number, email: string, code: string) => createHmac('sha256', otpKey()).update(`otp:${userId}:${email.toLowerCase()}:${code}`).digest('hex');
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
  const u = await db.one<any>('SELECT id, role, email, email_verified_at FROM users WHERE id=$1', [userId]);
  if (!config.emailVerificationRequired && u.role !== 'barber') throw paused();   // optional customer checks are paused; barber pre-launch checks remain active
  if (!u.email) throw new AppError(400, 'EMAIL_REQUIRED', 'Add your email first. Then we can send you a code.');
  if (u.email_verified_at) return { already_verified: true };
  if (!(await hit(db, `otp_send:email:${u.email.toLowerCase()}`, HOUR, OTP_SENDS_PER_HOUR))) throw new AppError(429, 'RATE_LIMITED', 'You asked for too many codes. Try again in an hour.');
  if (!(await hit(db, `otp_send:ip:${ip}`, HOUR, OTP_SENDS_PER_IP_HOUR))) throw new AppError(429, 'RATE_LIMITED', 'Too many codes were asked from this network. Try again in an hour.');
  const code = makeCode();
  await db.query('UPDATE users SET otp_hash=$1, otp_expires_at=$2, otp_attempts=0 WHERE id=$3', [hashCode(u.id, u.email, code), new Date(clock.now().getTime() + OTP_TTL_MIN * 60000).toISOString(), u.id]);
  try {
    const textBody = `Your TrimSlot code is ${code}.\n\nIt works for ${OTP_TTL_MIN} minutes. Do not share it with anyone.\n\nIf you did not ask for this code, you can ignore this email.`;
    const htmlBody = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:28px 12px;background:#f3f6fb;font-family:Arial,Helvetica,sans-serif;color:#17243b">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5eaf2;border-radius:18px;overflow:hidden">
<tr><td style="background:#0b1730;padding:26px 30px;text-align:center">
<a href="https://trimslot.com.ng" style="text-decoration:none;color:#fff">
<img src="https://trimslot.com.ng/favicon.svg" width="48" height="48" alt="TrimSlot logo" style="display:block;width:48px;height:48px;margin:0 auto 12px;border:0">
<span style="font-size:23px;font-weight:700;letter-spacing:.2px;color:#fff">Trim<span style="color:#66a5ff">Slot</span></span>
</a></td></tr>
<tr><td style="padding:34px 30px 30px">
<p style="margin:0 0 8px;color:#55708f;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase">SECURITY VERIFICATION</p>
<h1 style="margin:0 0 12px;font-size:25px;line-height:1.25;color:#14213a">Your one-time code</h1>
<p style="margin:0 0 22px;color:#526178;font-size:15px;line-height:1.6">Use the code below to verify your TrimSlot email address.</p>
<div style="background:#f1f6ff;border:1px solid #d8e6ff;border-radius:12px;padding:20px;text-align:center">
<div style="font-size:34px;line-height:1.3;font-weight:700;letter-spacing:9px;color:#2459c5">${code}</div>
</div>
<p style="margin:20px 0 0;color:#33445d;font-size:14px;line-height:1.6"><strong>This code expires in ${OTP_TTL_MIN} minutes.</strong> Do not share it with anyone, including TrimSlot staff.</p>
<p style="margin:18px 0 0;color:#718096;font-size:13px;line-height:1.6">If you did not request this code, you can safely ignore this email.</p>
</td></tr>
<tr><td style="padding:18px 30px;background:#f7f9fc;border-top:1px solid #e8edf4;text-align:center;color:#7b8798;font-size:12px;line-height:1.6">© TrimSlot · <a href="https://trimslot.com.ng" style="color:#315fc4;text-decoration:none">trimslot.com.ng</a><br>Appointment booking, made simple.</td></tr>
</table></body></html>`;
    await sendMail({ to: u.email, subject: `Your TrimSlot code: ${code}`, text: textBody, html: htmlBody });
  } catch (e) { await db.query('UPDATE users SET otp_hash=NULL, otp_expires_at=NULL WHERE id=$1', [u.id]); throw e; }
  return { sent: true, email: maskEmail(u.email), expires_in_min: OTP_TTL_MIN };
}

export async function verifyEmailOtp(db: Db, userId: number, codeRaw: unknown) {
  const who = await db.maybeOne<{ role: string }>('SELECT role FROM users WHERE id=$1', [userId]);
  if (!config.emailVerificationRequired && who?.role !== 'barber') throw paused();
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
/** A new barber must verify an email before staff can put the shop live. Existing pre-rule barbers keep their exemption. */
export async function assertBarberEmailVerifiedForGoLive(c: Conn, userId: number) {
  const u = await c.maybeOne<any>('SELECT email, email_verified_at, email_verify_exempt FROM users WHERE id=$1', [userId]);
  if (!u || u.email_verified_at || u.email_verify_exempt) return;
  throw new AppError(403, 'EMAIL_NOT_VERIFIED', needMsg(!!u.email, 'before your shop can go live'), { needs_email: !u.email });
}
/** A barber shop is bookable once the barber's email is verified (barbers who joined before this rule are exempt). */
export const barberEmailReadySql = (barberAlias = 'b') => `EXISTS (SELECT 1 FROM users bu WHERE bu.id = ${barberAlias}.user_id AND (bu.email_verified_at IS NOT NULL OR bu.email_verify_exempt))`;
