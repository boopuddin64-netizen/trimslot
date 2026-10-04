/** Automatic retention clean-up. Every period is an admin setting (platform_settings.retention_*) and matches the Privacy Policy.
 *  Runs from the cron sweep at most once an hour (atomic claim), or on demand from the admin (PIN). Financial records are never deleted here:
 *  accounts that have successful payments are ANONYMISED instead of erased. */
import { Db } from './db';
import { anonymiseUser } from './accountData';
import { purgeCore } from './adminDelete';
import { getSettings, Settings } from './plans';
import { clock, isoNow } from './time';
import { audit } from './helpers';
import { logger } from './logger';

export interface RetentionResult {
  rate_limits: number; bad_payment_events: number; old_payment_events: number; notifications: number; stale_push: number; stale_admin_push: number; admin_alerts: number;
  stale_plan_checkouts_skipped_for_gateway_check: number; deleted_users_erased: number; deleted_users_anonymised: number; deleted_plans: number; deleted_reviews: number; deleted_reports: number;
}
const ago = (days: number) => new Date(clock.now().getTime() - days * 86400000).toISOString();
const agoH = (h: number) => new Date(clock.now().getTime() - h * 3600000).toISOString();

export async function runRetention(db: Db, s?: Settings): Promise<RetentionResult> {
  const set = s ?? await getSettings(db);
  const n = async (sql: string, p: unknown[]) => (await db.query(sql, p)).rowCount ?? 0;
  const r: RetentionResult = {
    rate_limits: await n(`DELETE FROM rate_limits WHERE window_start < $1`, [agoH(set.retention_rate_limit_hours)]),
    bad_payment_events: await n(`DELETE FROM payment_events WHERE signature_valid = FALSE AND created_at < $1`, [ago(set.retention_bad_events_days)]),
    old_payment_events: await n(`DELETE FROM payment_events WHERE created_at < $1`, [ago(set.retention_events_days)]),
    notifications: await n(`DELETE FROM notifications WHERE created_at < $1`, [ago(set.retention_notifications_days)]),
    stale_push: await n(`DELETE FROM push_subscriptions WHERE COALESCE(last_ok_at, created_at) < $1`, [ago(set.retention_push_stale_days)]),
    stale_admin_push: await n(`DELETE FROM admin_push_subscriptions WHERE COALESCE(last_ok_at, created_at) < $1`, [ago(set.retention_push_stale_days)]),
    admin_alerts: await n(`DELETE FROM admin_notifications WHERE created_at < $1`, [ago(set.retention_admin_alerts_days)]),
    stale_plan_checkouts_skipped_for_gateway_check: 0, deleted_users_erased: 0, deleted_users_anonymised: 0, deleted_plans: 0, deleted_reviews: 0, deleted_reports: 0,
  };
  const cutoff = ago(set.retention_deleted_days);
  // Soft-deleted accounts past their restore window: erased completely when there is no money trail, otherwise anonymised in place (never deleted).
  const users = await db.many<{ id: number; role: string; paid: number; barber_id: number | null }>(
    `SELECT u.id, u.role, b.id AS barber_id, (SELECT COUNT(*) FROM payments p LEFT JOIN bookings k ON k.id=p.booking_id LEFT JOIN plan_purchases pp ON pp.id=p.plan_purchase_id
        WHERE p.status='SUCCESS' AND (k.customer_id=u.id OR pp.customer_id=u.id OR p.barber_id=b.id))::int AS paid
       FROM users u LEFT JOIN barbers b ON b.user_id=u.id WHERE u.deleted_at IS NOT NULL AND u.deleted_at < $1 AND u.anonymised_at IS NULL ORDER BY u.id LIMIT 50`, [cutoff]);
  for (const u of users) {
    try {
      await db.tx(async (t) => {
        if (!u.paid) { await purgeCore(t, { users: [u.id], barbers: u.barber_id ? [u.barber_id] : [] }, false); r.deleted_users_erased++; }
        else { if (await anonymiseUser(t, u.id, 'retention: soft-delete window ended')) r.deleted_users_anonymised++; }
      });
    } catch (e: any) {
      // e.g. a row we did not anticipate still references the user: fall back to anonymising so the person is gone either way
      try { await db.tx((t) => anonymiseUser(t, u.id, 'retention: soft-delete window ended').then((x) => { if (x) r.deleted_users_anonymised++; })); } catch { logger.warn('retention_user_failed', { uid: u.id, err: String(e?.message).slice(0, 100) }); }
    }
  }
  r.deleted_reviews = await n(`DELETE FROM reviews WHERE deleted_at IS NOT NULL AND deleted_at < $1`, [cutoff]);
  r.deleted_reports = await n(`DELETE FROM reports WHERE deleted_at IS NOT NULL AND deleted_at < $1`, [cutoff]);
  const plans = await db.many<{ id: number }>(`SELECT p.id FROM plans p WHERE p.deleted_at IS NOT NULL AND p.deleted_at < $1 AND NOT EXISTS (SELECT 1 FROM plan_purchases pp WHERE pp.plan_id=p.id) LIMIT 100`, [cutoff]);
  for (const p of plans) { try { await db.tx((t) => purgeCore(t, { plans: [p.id] }, false)); r.deleted_plans++; } catch { /* kept */ } }
  const touched = Object.entries(r).filter(([, v]) => v > 0);
  if (touched.length) await audit(db, null, { id: null, role: 'system' }, 'RETENTION_RUN', Object.fromEntries(touched));
  return r;
}

/** Cron entry point: at most once an hour across all instances (atomic claim on platform_settings.retention_last_run_at). */
export async function runRetentionIfDue(db: Db): Promise<RetentionResult | null> {
  const claim = await db.maybeOne(`UPDATE platform_settings SET retention_last_run_at=$1 WHERE id=1 AND (retention_last_run_at IS NULL OR retention_last_run_at < $2) RETURNING id`, [isoNow(), agoH(1) ]);
  if (!claim) return null;
  return runRetention(db);
}
