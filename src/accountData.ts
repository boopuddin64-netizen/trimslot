/** Account data rights: acceptance log (terms / privacy / barber agreement), JSON export, self-service deletion + anonymisation.
 *  Rules: financial records (bookings, payments, ledger, audit) are KEPT but anonymised - the person is removed from them, the money trail is not. */
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { Conn, Db } from './db';
import { adminEvent, flushAdminPush } from './adminNotify';
import { AppError, badRequest } from './errors';
import { audit } from './helpers';
import { getSettings, Settings } from './plans';
import { isoNow, lagosDate } from './time';
import { outstandingKobo } from './ledger';

type H = (req: Request, res: Response) => Promise<any>;
export type DocKey = 'terms' | 'privacy' | 'barber_agreement';
export const DOC_PAGES: Record<DocKey, { title: string; url: string }> = {
  terms: { title: 'Terms of Service', url: '/terms.html' },
  privacy: { title: 'Privacy Policy', url: '/privacy.html' },
  barber_agreement: { title: 'Barber Agreement', url: '/barber-agreement.html' },
};
export const docsFor = (role: string): DocKey[] => (role === 'barber' ? ['terms', 'privacy', 'barber_agreement'] : ['terms', 'privacy']);
export const versionOf = (s: Settings, d: DocKey) => (d === 'terms' ? s.terms_version : d === 'privacy' ? s.privacy_version : s.barber_agreement_version);

export async function recordConsent(c: Conn, userId: number, docs: DocKey[], s: Settings, source: 'signup' | 'reaccept', ip: string | undefined, ua: string | undefined) {
  for (const d of docs) {
    await c.query('INSERT INTO consent_log (user_id, document, version, accepted_at, source, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [userId, d, versionOf(s, d), isoNow(), source, (ip || '').slice(0, 64) || null, (ua || '').slice(0, 200) || null]);
  }
}
/** Documents the user has not yet accepted at the CURRENT version (new documents, or a bumped version => re-accept prompt). */
export async function consentRequired(c: Conn, user: { id: number; role: string }, s?: Settings) {
  const set = s ?? await getSettings(c);
  const rows = await c.many<{ document: string; version: string }>('SELECT DISTINCT document, version FROM consent_log WHERE user_id=$1', [user.id]);
  const have = new Set(rows.map((r) => r.document + '@' + r.version));
  return docsFor(user.role).filter((d) => !have.has(d + '@' + versionOf(set, d))).map((d) => ({ document: d, version: versionOf(set, d), title: DOC_PAGES[d].title, url: DOC_PAGES[d].url }));
}
export const consentHistory = (c: Conn, userId: number) =>
  c.many(`SELECT document, version, accepted_at, source, ip, user_agent FROM consent_log WHERE user_id=$1 ORDER BY id DESC LIMIT 50`, [userId]);

/* ---------------- erase / anonymise ---------------- */
const RM = (id: number) => `deleted-${id}@deleted.invalid`;
/** Removes the person from an account but keeps the rows financial records point at. Idempotent. The caller owns the transaction. */
export async function anonymiseUser(t: Conn, userId: number, why: string) {
  const u = await t.maybeOne<any>('SELECT id, role, anonymised_at FROM users WHERE id=$1 FOR UPDATE', [userId]);
  if (!u || u.anonymised_at) return false;
  const now = isoNow();
  await t.query(`UPDATE users SET name=$2, email=$3, phone=NULL, password_hash=$4, account_status='DELETED', deleted_at=COALESCE(deleted_at,$5), deleted_prev_status=COALESCE(deleted_prev_status,account_status),
      delete_reason=COALESCE(delete_reason,$6), anonymised_at=$5, status_at=$5, avatar_url=NULL, deletion_requested_at=NULL WHERE id=$1`,
    [userId, u.role === 'barber' ? 'Deleted barber' : 'Deleted customer', RM(userId), '!' + crypto.randomBytes(24).toString('hex'), now, why]);
  const q = (sql: string, ...p: unknown[]) => t.query(sql, p);
  await q('DELETE FROM user_avatars WHERE user_id=$1', userId);
  await q('DELETE FROM push_subscriptions WHERE user_id=$1', userId);
  await q('DELETE FROM notifications WHERE user_id=$1', userId);
  await q('DELETE FROM favourites WHERE customer_id=$1', userId);
  await q('DELETE FROM waitlist WHERE customer_id=$1', userId);
  await q('DELETE FROM barber_customer_notes WHERE customer_id=$1', userId);
  await q('DELETE FROM broadcasts WHERE user_id=$1', userId);
  await q('UPDATE reviews SET comment=NULL WHERE customer_id=$1', userId);
  await q('UPDATE bookings SET note_to_barber=NULL WHERE customer_id=$1', userId);
  await q('UPDATE consent_log SET ip=NULL, user_agent=NULL WHERE user_id=$1', userId);
  if (u.role === 'barber') {
    const b = await t.maybeOne<{ id: number }>('SELECT id FROM barbers WHERE user_id=$1 FOR UPDATE', [userId]);
    if (b) {
      await q('DELETE FROM barber_photos WHERE barber_id=$1', b.id);
      await q('DELETE FROM barber_customer_notes WHERE barber_id=$1', b.id);
      await q(`UPDATE barbers SET shop_name='Removed shop', location=NULL, about=NULL, photo_url=NULL, verified=FALSE, review_status='SUSPENDED', booking_paused=TRUE,
          payout_account_name=NULL, payout_account_last4=NULL WHERE id=$1`, b.id);
      await q('UPDATE services SET active=FALSE WHERE barber_id=$1', b.id);
      await q('UPDATE plans SET active=FALSE WHERE barber_id=$1', b.id);
    }
  }
  return true;
}

/* ---------------- export ---------------- */
export async function buildExport(db: Db, user: { id: number; role: string }) {
  const u = await db.one<any>('SELECT id, role, name, email, phone, created_at, account_status, avatar_url FROM users WHERE id=$1', [user.id]);
  const out: any = { exported_at: isoNow(), note: 'Your TrimSlot data. Passwords and security keys are never included. Notes that barbers keep privately about you are not included.', account: u };
  out.documents_accepted = await consentHistory(db, user.id);
  out.notifications = await db.many('SELECT type, title, body, created_at, is_read FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 1000', [user.id]);
  out.push_devices = (await db.one<{ c: number }>('SELECT COUNT(*)::int c FROM push_subscriptions WHERE user_id=$1', [user.id])).c;
  out.reports_you_filed = await db.many('SELECT category, message, status, created_at FROM reports WHERE reporter_id=$1 AND deleted_at IS NULL ORDER BY id DESC', [user.id]);
  if (user.role === 'customer') {
    out.bookings = await db.many(`SELECT k.id, k.date, k.scheduled_at, k.service_name, k.price_kobo, k.status, k.payment_option, k.payment_status, k.paid_at, k.cancelled_at, k.created_at, k.note_to_barber, b.shop_name
        FROM bookings k JOIN barbers b ON b.id=k.barber_id WHERE k.customer_id=$1 ORDER BY k.id DESC`, [user.id]);
    out.payments = await db.many(`SELECT p.reference, p.amount_kobo, p.status, p.refund_status, p.refund_reason, p.created_at, p.verified_at FROM payments p
        LEFT JOIN bookings k ON k.id=p.booking_id LEFT JOIN plan_purchases pp ON pp.id=p.plan_purchase_id WHERE k.customer_id=$1 OR pp.customer_id=$1 ORDER BY p.id DESC`, [user.id]);
    out.plans = await db.many(`SELECT plan_name, price_kobo, sessions_total, sessions_used, status, paid_at, expires_at FROM plan_purchases WHERE customer_id=$1 AND status='ACTIVE' ORDER BY id DESC`, [user.id]);
    out.credits = await db.many(`SELECT value_kobo, reason, status, expires_at, created_at FROM session_credits WHERE customer_id=$1 ORDER BY id DESC`, [user.id]);
    out.reviews = await db.many('SELECT rating, comment, created_at FROM reviews WHERE customer_id=$1 AND deleted_at IS NULL ORDER BY id DESC', [user.id]);
    out.favourites = await db.many('SELECT b.shop_name FROM favourites f JOIN barbers b ON b.id=f.barber_id WHERE f.customer_id=$1', [user.id]);
    out.waitlist = await db.many('SELECT date, status, created_at FROM waitlist WHERE customer_id=$1 ORDER BY id DESC LIMIT 200', [user.id]);
  } else {
    const b = await db.maybeOne<any>('SELECT * FROM barbers WHERE user_id=$1', [user.id]);
    if (b) {
      out.shop = { shop_name: b.shop_name, location: b.location, about: b.about, review_status: b.review_status, verified: b.verified, payout_bank: b.payout_bank_name, payout_account_last4: b.payout_account_last4, payout_account_name: b.payout_account_name, created_at: b.created_at };
      out.services = await db.many('SELECT name, price_kobo, duration_min, active FROM services WHERE barber_id=$1', [b.id]);
      out.schedule = await db.many('SELECT weekday, is_working, start_min, end_min, break_start_min, break_end_min FROM barber_schedule WHERE barber_id=$1 ORDER BY weekday', [b.id]);
      out.plans_offered = await db.many('SELECT name, price_kobo, sessions, validity_days, active FROM plans WHERE barber_id=$1 AND deleted_at IS NULL', [b.id]);
      out.bookings = await db.many(`SELECT k.id, k.date, k.scheduled_at, k.service_name, k.price_kobo, k.status, k.payment_option, k.payment_status, u.name AS customer_name
          FROM bookings k JOIN users u ON u.id=k.customer_id WHERE k.barber_id=$1 AND NOT (k.payment_option='ONLINE' AND k.paid_at IS NULL AND (k.status='PENDING_PAYMENT' OR (k.status='CANCELLED' AND k.payment_status='VOID'))) ORDER BY k.id DESC LIMIT 5000`, [b.id]);
      out.payments = await db.many('SELECT reference, amount_kobo, fee_kobo, debt_netted_kobo, status, refund_status, created_at FROM payments WHERE barber_id=$1 ORDER BY id DESC LIMIT 5000', [b.id]);
      out.commission_ledger = await db.many('SELECT amount_kobo, remaining_kobo, status, note, created_at FROM commission_ledger WHERE barber_id=$1 ORDER BY id DESC LIMIT 5000', [b.id]);
      out.your_notes_about_customers = await db.many('SELECT u.name AS customer_name, n.note, n.updated_at FROM barber_customer_notes n JOIN users u ON u.id=n.customer_id WHERE n.barber_id=$1', [b.id]);
      out.reviews_received = await db.many('SELECT rating, comment, reply, created_at FROM reviews WHERE barber_id=$1 AND deleted_at IS NULL AND NOT hidden ORDER BY id DESC LIMIT 1000', [b.id]);
    }
  }
  return out;
}

/* ---------------- deletion ---------------- */
async function blockers(c: Conn, u: { id: number; role: string }) {
  const out: { code: string; message: string; count?: number }[] = [];
  if (u.role === 'customer') {
    const n = (await c.one<{ n: number }>(`SELECT COUNT(*)::int n FROM bookings WHERE customer_id=$1 AND status IN ('CONFIRMED','ARRIVED','IN_SERVICE') AND date >= $2`, [u.id, lagosDate()])).n;
    if (n) out.push({ code: 'HAS_UPCOMING', count: n, message: `You have ${n} upcoming booking${n === 1 ? '' : 's'}. Cancel ${n === 1 ? 'it' : 'them'} first (refund and credit rules apply as normal), then delete your account.` });
  } else {
    const b = await c.maybeOne<{ id: number }>('SELECT id FROM barbers WHERE user_id=$1', [u.id]);
    if (b) {
      const n = (await c.one<{ n: number }>(`SELECT COUNT(*)::int n FROM bookings WHERE barber_id=$1 AND status IN ('CONFIRMED','ARRIVED','IN_SERVICE') AND date >= $2`, [b.id, lagosDate()])).n;
      if (n) out.push({ code: 'HAS_UPCOMING', count: n, message: `${n} customer booking${n === 1 ? ' is' : 's are'} still upcoming.` });
      const owed = await outstandingKobo(c, b.id);
      if (owed > 0) out.push({ code: 'BALANCE_OWED', message: 'A cash-commission balance is still owed to TrimSlot.' });
      const pl = (await c.one<{ n: number }>(`SELECT COUNT(*)::int n FROM plan_purchases WHERE barber_id=$1 AND status='ACTIVE' AND sessions_used < sessions_total AND expires_at > $2`, [b.id, isoNow()])).n;
      if (pl) out.push({ code: 'PLANS_ACTIVE', count: pl, message: `${pl} customer plan${pl === 1 ? ' still has' : 's still have'} unused sessions you must honour.` });
    }
  }
  return out;
}

const deleteSchema = z.object({ password: z.string().min(1).max(200), confirm: z.literal('DELETE'), acknowledge_forfeit: z.boolean().optional() });

export function registerAccountData(api: Router, db: Db, wrap: (fn: H) => any, requireAuth: any, onSignedOut: (res: Response) => void) {
  /** Only the plain list of what the user must accept right now (the app shows this as a blocking prompt). */
  api.get('/me/consent', requireAuth, wrap(async (req, res) => res.json({ required: await consentRequired(db, req.user!), history: await consentHistory(db, req.user!.id) })));
  api.post('/me/consent', requireAuth, wrap(async (req, res) => {
    const d = z.object({ accept: z.literal(true) }).safeParse(req.body);
    if (!d.success) throw badRequest('Tick the box to accept.');
    const s = await getSettings(db);
    const need = await consentRequired(db, req.user!, s);
    await db.tx((t) => recordConsent(t, req.user!.id, need.map((n) => n.document as DocKey), s, 'reaccept', req.ip, req.headers['user-agent'] as string | undefined));
    res.json({ ok: true, required: [] });
  }));

  api.get('/me/export', requireAuth, wrap(async (req, res) => {
    const data = await buildExport(db, req.user!);
    await audit(db, null, { id: req.user!.id, role: req.user!.role }, 'DATA_EXPORTED', {});
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="trimslot-my-data-${lagosDate()}.json"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(data, null, 2));
  }));

  /** Delete my account. Customers: immediate once no upcoming bookings remain. Barbers: immediate when nothing is owed/pending, otherwise a request the admin handles. */
  api.post('/me/delete', requireAuth, wrap(async (req, res) => {
    const d = deleteSchema.safeParse(req.body);
    if (!d.success) throw badRequest('Enter your password and type DELETE to confirm.');
    const me = await db.one<any>('SELECT id, role, password_hash FROM users WHERE id=$1', [req.user!.id]);
    if (!bcrypt.compareSync(d.data.password, me.password_hash)) throw new AppError(403, 'BAD_PASSWORD', 'That password is not correct.');
    const outcome = await db.tx(async (t) => {
      const bl = await blockers(t, me);
      if (me.role === 'customer') {
        if (bl.length) throw new AppError(409, 'CANNOT_DELETE_YET', bl[0].message, { blockers: bl });
        const lost = await t.one<{ plans: number; credits: number }>(`SELECT
            (SELECT COUNT(*) FROM plan_purchases WHERE customer_id=$1 AND status='ACTIVE' AND sessions_used < sessions_total AND expires_at > $2)::int AS plans,
            (SELECT COUNT(*) FROM session_credits WHERE customer_id=$1 AND status='AVAILABLE' AND expires_at > $2)::int AS credits`, [me.id, isoNow()]);
        if ((lost.plans || lost.credits) && !d.data.acknowledge_forfeit) throw new AppError(409, 'FORFEIT_NEEDS_OK', `You still have ${lost.plans} plan${lost.plans === 1 ? '' : 's'} with unused sessions and ${lost.credits} credit${lost.credits === 1 ? '' : 's'}. They have no cash value and are lost when the account is deleted. Tick the box to continue.`, lost);
        await anonymiseUser(t, me.id, 'self-service');
        await audit(t, null, { id: me.id, role: 'customer' }, 'ACCOUNT_SELF_DELETED', { forfeited: lost });
        return { deleted: true as const };
      }
      if (bl.length) {
        await t.query('UPDATE users SET deletion_requested_at=$2, deletion_request_note=$3 WHERE id=$1', [me.id, isoNow(), bl.map((b) => b.message).join(' ').slice(0, 500)]);
        await audit(t, null, { id: me.id, role: 'barber' }, 'ACCOUNT_DELETION_REQUESTED', { blockers: bl.map((b) => b.code) });
        await adminEvent(t, 'DELETION_REQUEST', 'Barber asked to delete their account', `A barber asked to delete their account but ${bl.map((b) => b.message).join(' ')} Review it in Barbers.`, { link: '/admin.html#/barbers', refKey: 'user:' + me.id });
        return { deleted: false as const, requested: true as const, blockers: bl };
      }
      await anonymiseUser(t, me.id, 'self-service');
      await audit(t, null, { id: me.id, role: 'barber' }, 'ACCOUNT_SELF_DELETED', {});
      return { deleted: true as const };
    });
    if (outcome.deleted) onSignedOut(res);
    else await flushAdminPush(db).catch(() => {});
    res.status(outcome.deleted ? 200 : 202).json(outcome);
  }));
  api.post('/me/delete/cancel', requireAuth, wrap(async (req, res) => {
    await db.query('UPDATE users SET deletion_requested_at=NULL, deletion_request_note=NULL WHERE id=$1 AND anonymised_at IS NULL', [req.user!.id]);
    res.json({ ok: true });
  }));
}
