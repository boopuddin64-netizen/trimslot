/** Provider-agnostic mail sending. Keys are read from the environment ONLY (never stored in the repo or the database).
 *  - RESEND_API_KEY (+ MAIL_FROM, e.g. "TrimSlot <no-reply@yourdomain.com>")  -> sent through Resend's HTTPS API.
 *  - no key, not production                                                   -> printed to the server log (development only).
 *  - no key, production                                                       -> refuses with a plain message (nothing is sent, nothing is logged).
 *  Tests never reach a real provider: they use setMailTransport() or the log transport. */
import { config } from './config';
import { AppError } from './errors';
import { logger } from './logger';

export interface Mail { to: string; subject: string; text: string }
export type MailTransport = (m: Mail) => Promise<void>;

let override: MailTransport | null = null;
export const setMailTransport = (t: MailTransport | null) => { override = t; };

export const mailerMode = (): 'custom' | 'resend' | 'log' | 'none' =>
  override ? 'custom' : process.env.NODE_ENV !== 'test' && process.env.RESEND_API_KEY ? 'resend' : config.isProd ? 'none' : 'log';

async function viaResend(m: Mail) {
  const from = process.env.MAIL_FROM;
  if (!from) { logger.error('mail_not_configured', { why: 'MAIL_FROM is not set' }); throw new AppError(503, 'EMAIL_NOT_CONFIGURED', 'We cannot send emails right now. Please try again later.'); }
  let r: Response;
  try {
    r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text }), signal: AbortSignal.timeout(8000),
    });
  } catch { throw new AppError(503, 'EMAIL_FAILED', 'We could not send the email. Try again in a minute.'); }
  if (!r.ok) { logger.warn('mail_send_failed', { status: r.status }); throw new AppError(503, 'EMAIL_FAILED', 'We could not send the email. Try again in a minute.'); }
}

export async function sendMail(m: Mail): Promise<void> {
  switch (mailerMode()) {
    case 'custom': return override!(m);
    case 'resend': return viaResend(m);
    case 'log': logger.info('mail_dev_log', { to: m.to, subject: m.subject, text: m.text }); return;
    default: logger.error('mail_not_configured', { why: 'RESEND_API_KEY is not set' }); throw new AppError(503, 'EMAIL_NOT_CONFIGURED', 'We cannot send emails right now. Please try again later.');
  }
}
