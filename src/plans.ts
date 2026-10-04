/** Subscriptions (barber plans / session packs), same-barber session credits and the admin-controlled platform rules. */
import { z } from 'zod';
import { Conn } from './db';
import { AppError, badRequest, conflict, notFound } from './errors';
import { audit, fmtWhen, naira, notify } from './helpers';
import { isoNow } from './time';

/* ---------------- platform settings (admin-controlled, single row) ---------------- */
export interface Settings {
  min_plan_price_kobo: number; max_plan_price_kobo: number; max_plan_validity_days: number; max_plan_sessions: number;
  platform_fee_percent: number; platform_fee_kobo: number; credit_expiry_days: number;
  credit_on_missed_session: boolean; credit_on_early_cancel_prepaid: boolean; plan_refund_policy: 'NONE' | 'MANUAL'; updated_at: string;
  maintenance_mode: boolean; maintenance_message: string; feature_plans: boolean; feature_credits: boolean; feature_pay_on_arrival: boolean;
  commission_enabled: boolean; commission_factor: number; min_barber_payout_percent: number; ledger_max_debt_kobo: number; ledger_max_age_days: number;
  feature_push: boolean; feature_favourites: boolean; feature_rebook: boolean; feature_reminders: boolean; feature_waitlist: boolean; feature_reviews: boolean; feature_barber_notes: boolean; feature_quick_actions: boolean; feature_reliability: boolean; feature_daily_summary: boolean; feature_booking_note: boolean; feature_loyalty: boolean;
  loyalty_every_n: number; loyalty_credit_kobo: number;
  cancel_cutoff_min: number; payment_hold_min: number; refund_auto_approve_hours: number; liability_cap_kobo: number;
  retention_events_days: number; retention_bad_events_days: number; retention_notifications_days: number; retention_push_stale_days: number; retention_deleted_days: number;
  retention_checkout_days: number; retention_rate_limit_hours: number; retention_admin_alerts_days: number; retention_last_run_at: string | null;
  terms_version: string; privacy_version: string; barber_agreement_version: string;
  fee_share_customer_pct: number; fee_share_barber_pct: number; fee_share_platform_pct: number;
  ps_percent: number; ps_flat_kobo: number; ps_flat_waived_below_kobo: number; ps_cap_kobo: number; ps_vat_percent: number;
  charge_percent: number; charge_flat_kobo: number; charge_min_kobo: number;
}
export async function getSettings(c: Conn): Promise<Settings> {
  const r = await c.one('SELECT * FROM platform_settings WHERE id=1');
  return { ...r, platform_fee_percent: Number(r.platform_fee_percent), commission_factor: Number(r.commission_factor), liability_cap_kobo: Number(r.liability_cap_kobo),
    fee_share_customer_pct: Number(r.fee_share_customer_pct), fee_share_barber_pct: Number(r.fee_share_barber_pct), fee_share_platform_pct: Number(r.fee_share_platform_pct),
    ps_percent: Number(r.ps_percent), ps_vat_percent: Number(r.ps_vat_percent), charge_percent: Number(r.charge_percent) };
}
/** Feature-flag reads on hot paths (every decorated booking): a 3-second per-database cache; any settings update invalidates all of it. */
let flagGen = 0;
const flagCache = new WeakMap<object, { at: number; gen: number; v: Settings }>();
export async function getSettingsCached(c: Conn & { pool?: unknown }): Promise<Settings> {
  const key = (c as any).pool ?? c; const hit = flagCache.get(key);
  if (hit && hit.gen === flagGen && Date.now() - hit.at < 3000) return hit.v;
  const v = await getSettings(c); flagCache.set(key, { at: Date.now(), gen: flagGen, v }); return v;
}
export const clearSettingsCache = (_c?: Conn) => { flagGen++; };
/** Admin-facing shape: prices in naira. */
export const settingsView = (s: Settings) => ({
  min_plan_price_naira: s.min_plan_price_kobo / 100, max_plan_price_naira: s.max_plan_price_kobo / 100,
  max_plan_validity_days: s.max_plan_validity_days, max_plan_sessions: s.max_plan_sessions,
  platform_fee_percent: s.platform_fee_percent, platform_fee_naira: s.platform_fee_kobo / 100,
  credit_expiry_days: s.credit_expiry_days, credit_on_missed_session: s.credit_on_missed_session,
  plan_refund_policy: s.plan_refund_policy, updated_at: s.updated_at,
  maintenance_mode: s.maintenance_mode, maintenance_message: s.maintenance_message, feature_plans: s.feature_plans, feature_credits: s.feature_credits, feature_pay_on_arrival: s.feature_pay_on_arrival,
  commission_enabled: s.commission_enabled, commission_factor: s.commission_factor, min_barber_payout_percent: s.min_barber_payout_percent,
  ledger_max_debt_naira: s.ledger_max_debt_kobo / 100, ledger_max_age_days: s.ledger_max_age_days,
  feature_push: s.feature_push, feature_favourites: s.feature_favourites, feature_rebook: s.feature_rebook, feature_reminders: s.feature_reminders, feature_waitlist: s.feature_waitlist, feature_reviews: s.feature_reviews, feature_barber_notes: s.feature_barber_notes, feature_quick_actions: s.feature_quick_actions, feature_reliability: s.feature_reliability, feature_daily_summary: s.feature_daily_summary, feature_booking_note: s.feature_booking_note, feature_loyalty: s.feature_loyalty,
  loyalty_every_n: s.loyalty_every_n, loyalty_credit_naira: s.loyalty_credit_kobo / 100,
  cancel_cutoff_min: s.cancel_cutoff_min, payment_hold_min: s.payment_hold_min, refund_auto_approve_hours: s.refund_auto_approve_hours, liability_cap_naira: s.liability_cap_kobo / 100,
  retention_events_days: s.retention_events_days, retention_bad_events_days: s.retention_bad_events_days, retention_notifications_days: s.retention_notifications_days, retention_push_stale_days: s.retention_push_stale_days,
  retention_deleted_days: s.retention_deleted_days, retention_checkout_days: s.retention_checkout_days, retention_rate_limit_hours: s.retention_rate_limit_hours, retention_admin_alerts_days: s.retention_admin_alerts_days,
  terms_version: s.terms_version, privacy_version: s.privacy_version, barber_agreement_version: s.barber_agreement_version,
  fee_share_customer_pct: s.fee_share_customer_pct, fee_share_barber_pct: s.fee_share_barber_pct, fee_share_platform_pct: s.fee_share_platform_pct,
  ps_percent: s.ps_percent, ps_flat_naira: s.ps_flat_kobo / 100, ps_flat_waived_below_naira: s.ps_flat_waived_below_kobo / 100, ps_cap_naira: s.ps_cap_kobo / 100, ps_vat_percent: s.ps_vat_percent,
  charge_percent: s.charge_percent, charge_flat_naira: s.charge_flat_kobo / 100, charge_min_naira: s.charge_min_kobo / 100,
});
export const SETTING_KEYS = ['min_plan_price_naira', 'max_plan_price_naira', 'max_plan_validity_days', 'max_plan_sessions',
  'credit_expiry_days', 'credit_on_missed_session', 'plan_refund_policy',
  'maintenance_mode', 'maintenance_message', 'feature_plans', 'feature_credits', 'feature_pay_on_arrival', 'commission_enabled', 'commission_factor', 'min_barber_payout_percent', 'ledger_max_debt_naira', 'ledger_max_age_days',
  'feature_push', 'feature_favourites', 'feature_rebook', 'feature_reminders', 'feature_waitlist', 'feature_reviews', 'feature_barber_notes', 'feature_quick_actions', 'feature_reliability', 'feature_daily_summary', 'feature_booking_note', 'feature_loyalty', 'loyalty_every_n', 'loyalty_credit_naira',
  'cancel_cutoff_min', 'payment_hold_min', 'refund_auto_approve_hours', 'liability_cap_naira', 'retention_events_days', 'retention_bad_events_days', 'retention_notifications_days', 'retention_push_stale_days',
  'retention_deleted_days', 'retention_checkout_days', 'retention_rate_limit_hours', 'retention_admin_alerts_days', 'terms_version', 'privacy_version', 'barber_agreement_version',
  'fee_share_customer_pct', 'fee_share_barber_pct', 'fee_share_platform_pct', 'ps_percent', 'ps_flat_naira', 'ps_flat_waived_below_naira', 'ps_cap_naira', 'ps_vat_percent', 'charge_percent', 'charge_flat_naira', 'charge_min_naira'] as const;
export const settingsPatchSchema = z.object({
  min_plan_price_naira: z.coerce.number().min(0).max(100_000_000),
  max_plan_price_naira: z.coerce.number().min(0).max(100_000_000),
  max_plan_validity_days: z.coerce.number().int().min(1).max(730),
  max_plan_sessions: z.coerce.number().int().min(1).max(500),
  credit_expiry_days: z.coerce.number().int().min(1).max(365),
  credit_on_missed_session: z.boolean(),
  credit_on_early_cancel_prepaid: z.boolean(),   // deprecated and ignored: an in-time cancellation of a prepaid booking is always a (pending) refund, never a credit
  plan_refund_policy: z.enum(['NONE', 'MANUAL']),
  maintenance_mode: z.boolean(), maintenance_message: z.string().trim().min(3).max(200),
  feature_plans: z.boolean(), feature_credits: z.boolean(), feature_pay_on_arrival: z.boolean(), commission_enabled: z.boolean(),
  commission_factor: z.coerce.number().min(0).max(1), min_barber_payout_percent: z.coerce.number().int().min(0).max(100),
  ledger_max_debt_naira: z.coerce.number().min(0).max(100_000_000), ledger_max_age_days: z.coerce.number().int().min(0).max(3650),
  feature_push: z.boolean(), feature_favourites: z.boolean(), feature_rebook: z.boolean(), feature_reminders: z.boolean(), feature_waitlist: z.boolean(), feature_reviews: z.boolean(), feature_barber_notes: z.boolean(), feature_quick_actions: z.boolean(), feature_reliability: z.boolean(), feature_daily_summary: z.boolean(), feature_booking_note: z.boolean(), feature_loyalty: z.boolean(),
  loyalty_every_n: z.coerce.number().int().min(2).max(100), loyalty_credit_naira: z.coerce.number().min(0).max(1_000_000),
  cancel_cutoff_min: z.coerce.number().int().min(0).max(1440), payment_hold_min: z.coerce.number().int().min(1).max(180),
  refund_auto_approve_hours: z.coerce.number().int().min(0).max(168), liability_cap_naira: z.coerce.number().min(0).max(1_000_000_000),
  retention_events_days: z.coerce.number().int().min(30).max(3650), retention_bad_events_days: z.coerce.number().int().min(1).max(3650),
  retention_notifications_days: z.coerce.number().int().min(7).max(3650), retention_push_stale_days: z.coerce.number().int().min(7).max(3650),
  retention_deleted_days: z.coerce.number().int().min(1).max(3650), retention_checkout_days: z.coerce.number().int().min(1).max(365),
  retention_rate_limit_hours: z.coerce.number().int().min(1).max(720), retention_admin_alerts_days: z.coerce.number().int().min(7).max(3650),
  terms_version: z.string().trim().min(1).max(30), privacy_version: z.string().trim().min(1).max(30), barber_agreement_version: z.string().trim().min(1).max(30),
  fee_share_customer_pct: z.coerce.number().min(0).max(100), fee_share_barber_pct: z.coerce.number().min(0).max(100), fee_share_platform_pct: z.coerce.number().min(0).max(100),
  ps_percent: z.coerce.number().min(0).max(20), ps_flat_naira: z.coerce.number().min(0).max(100_000), ps_flat_waived_below_naira: z.coerce.number().min(0).max(10_000_000), ps_cap_naira: z.coerce.number().min(0).max(10_000_000), ps_vat_percent: z.coerce.number().min(0).max(50),
  charge_percent: z.coerce.number().min(0).max(50), charge_flat_naira: z.coerce.number().min(0).max(1_000_000), charge_min_naira: z.coerce.number().min(0).max(1_000_000),
}).partial().strict();

const FEATS = ['push', 'favourites', 'rebook', 'reminders', 'waitlist', 'reviews', 'barber_notes', 'quick_actions', 'reliability', 'daily_summary', 'booking_note', 'loyalty'] as const;
export const FEATURE_NAMES = FEATS;
export async function updateSettings(c: Conn, patch: unknown) {
  const parsed = settingsPatchSchema.safeParse(patch);
  if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => `${i.path.join('.') || 'settings'}: ${i.message}`).join('; '));
  const p = parsed.data; const cur = settingsView(await getSettings(c)); const next: any = { ...cur, ...p };
  if (next.min_plan_price_naira > next.max_plan_price_naira) throw badRequest('The lowest plan price cannot be more than the highest plan price.');
  { const sum = Number(next.fee_share_customer_pct) + Number(next.fee_share_barber_pct) + Number(next.fee_share_platform_pct);
    if (Math.abs(sum - 100) > 0.0005) throw badRequest(`The three fee shares (customer, barber, platform) must add up to 100%. Now they add up to ${Math.round(sum * 10000) / 10000}%.`); }
  await c.query(`UPDATE platform_settings SET min_plan_price_kobo=$1, max_plan_price_kobo=$2, max_plan_validity_days=$3, max_plan_sessions=$4, platform_fee_percent=$5,
      platform_fee_kobo=$6, credit_expiry_days=$7, credit_on_missed_session=$8, plan_refund_policy=$9, updated_at=$10,
      maintenance_mode=$11, maintenance_message=$12, feature_plans=$13, feature_credits=$14, feature_pay_on_arrival=$15, commission_enabled=$16, commission_factor=$17,
      min_barber_payout_percent=$18, ledger_max_debt_kobo=$19, ledger_max_age_days=$20 WHERE id=1`,
    [Math.round(next.min_plan_price_naira * 100), Math.round(next.max_plan_price_naira * 100), next.max_plan_validity_days, next.max_plan_sessions, next.platform_fee_percent,
      Math.round(next.platform_fee_naira * 100), next.credit_expiry_days, next.credit_on_missed_session, next.plan_refund_policy, isoNow(),
      next.maintenance_mode, next.maintenance_message, next.feature_plans, next.feature_credits, next.feature_pay_on_arrival, next.commission_enabled, next.commission_factor,
      next.min_barber_payout_percent, Math.round(next.ledger_max_debt_naira * 100), next.ledger_max_age_days]);
  await c.query(`UPDATE platform_settings SET ${FEATS.map((f, i) => `feature_${f}=$${i + 1}`).join(', ')}, loyalty_every_n=$${FEATS.length + 1}, loyalty_credit_kobo=$${FEATS.length + 2} WHERE id=1`,
    [...FEATS.map((f) => next['feature_' + f]), next.loyalty_every_n, Math.round(next.loyalty_credit_naira * 100)]);
  await c.query(`UPDATE platform_settings SET cancel_cutoff_min=$1, payment_hold_min=$2, refund_auto_approve_hours=$3, liability_cap_kobo=$4, retention_events_days=$5, retention_bad_events_days=$6,
      retention_notifications_days=$7, retention_push_stale_days=$8, retention_deleted_days=$9, retention_checkout_days=$10, retention_rate_limit_hours=$11, retention_admin_alerts_days=$12,
      terms_version=$13, privacy_version=$14, barber_agreement_version=$15 WHERE id=1`,
    [next.cancel_cutoff_min, next.payment_hold_min, next.refund_auto_approve_hours, Math.round(next.liability_cap_naira * 100), next.retention_events_days, next.retention_bad_events_days,
      next.retention_notifications_days, next.retention_push_stale_days, next.retention_deleted_days, next.retention_checkout_days, next.retention_rate_limit_hours, next.retention_admin_alerts_days,
      next.terms_version, next.privacy_version, next.barber_agreement_version]);
  await c.query(`UPDATE platform_settings SET fee_share_customer_pct=$1, fee_share_barber_pct=$2, fee_share_platform_pct=$3, ps_percent=$4, ps_flat_kobo=$5, ps_flat_waived_below_kobo=$6, ps_cap_kobo=$7, ps_vat_percent=$8,
      charge_percent=$9, charge_flat_kobo=$10, charge_min_kobo=$11 WHERE id=1`,
    [next.fee_share_customer_pct, next.fee_share_barber_pct, next.fee_share_platform_pct, next.ps_percent, Math.round(next.ps_flat_naira * 100), Math.round(next.ps_flat_waived_below_naira * 100), Math.round(next.ps_cap_naira * 100), next.ps_vat_percent,
      next.charge_percent, Math.round(next.charge_flat_naira * 100), Math.round(next.charge_min_naira * 100)]);
  clearSettingsCache(c);
  // audit: before/after of every changed key (the audit log is the record of who changed a published number and from what)
  const before: Record<string, unknown> = {}; for (const k of Object.keys(p)) before[k] = (cur as any)[k];
  await audit(c, null, { id: null, role: 'admin' }, 'SETTINGS_UPDATED', { changed: Object.keys(p), values: p, before });
  return settingsView(await getSettings(c));
}

/* ---------------- barber plans ---------------- */
export const planSchema = z.object({
  name: z.string().trim().min(2, 'That name is too short.').max(60),
  price_naira: z.coerce.number().positive('The price must be more than zero.').max(100_000_000),
  sessions: z.coerce.number().int().min(1, 'Add at least 1 session.').max(500),
  validity_days: z.coerce.number().int().min(1, 'Add at least 1 day.').max(730),
  service_ids: z.array(z.coerce.number().int().positive()).min(1, 'Pick at least one service for this plan.').max(50),
});

/** Barbers cannot go outside the platform rules; every limit is enforced server-side. */
export async function validatePlanInput(c: Conn, barberId: number, d: z.infer<typeof planSchema>) {
  const s = await getSettings(c);
  const kobo = Math.round(d.price_naira * 100);
  const errs: string[] = [];
  if (kobo < s.min_plan_price_kobo) errs.push(`The plan price must be at least ${naira(s.min_plan_price_kobo)}.`);
  if (kobo > s.max_plan_price_kobo) errs.push(`The plan price cannot be more than ${naira(s.max_plan_price_kobo)}.`);
  if (d.validity_days > s.max_plan_validity_days) errs.push(`A plan can last at most ${s.max_plan_validity_days} days.`);
  if (d.sessions > s.max_plan_sessions) errs.push(`A plan can have at most ${s.max_plan_sessions} sessions.`);
  const ids = [...new Set(d.service_ids)];
  const own = await c.many<{ id: number }>('SELECT id FROM services WHERE barber_id=$1 AND active AND id = ANY($2::int[])', [barberId, ids]);
  if (own.length !== ids.length) errs.push('Pick only your own active services.');
  else {
    // Secondary sanity check (the real rule is the explicit service list): one session must be worth at least the dearest included service.
    const perSession = Math.floor(kobo / d.sessions);
    const dear = await c.many<{ name: string; price_kobo: number }>('SELECT name, price_kobo FROM services WHERE id = ANY($1::int[]) AND price_kobo > $2 ORDER BY price_kobo DESC', [ids, perSession]);
    if (dear.length) errs.push(`Each session is worth ${naira(perSession)} (plan price ÷ sessions), but ${dear.map((x) => `${x.name} costs ${naira(x.price_kobo)}`).join(', ')}. Raise the plan price, use fewer sessions, or leave that service out.`);
  }
  if (errs.length) throw new AppError(400, 'PLAN_RULES', errs.join(' '), { limits: limitsOf(s) });
  return { kobo, ids, settings: s };
}
export const limitsOf = (s: Settings) => ({
  min_price_kobo: s.min_plan_price_kobo, max_price_kobo: s.max_plan_price_kobo, max_validity_days: s.max_plan_validity_days, max_sessions: s.max_plan_sessions,
  credit_expiry_days: s.credit_expiry_days, refund_policy: s.plan_refund_policy,
});

const PLAN_SELECT = `SELECT p.id, p.name, p.price_kobo, p.sessions, p.validity_days, p.active, p.needs_review,
  COALESCE((SELECT array_agg(ps.service_id ORDER BY ps.service_id) FROM plan_services ps WHERE ps.plan_id=p.id), '{}') AS service_ids FROM plans p`;
/** Active plans of one barber (one query: included service ids are aggregated). */
export const publicPlans = (c: Conn, barberId: number) => c.many(`${PLAN_SELECT} WHERE p.barber_id=$1 AND p.active ORDER BY p.price_kobo, p.id`, [barberId]);

export async function savePlan(c: Conn, barberId: number, planId: number | null, d: z.infer<typeof planSchema>) {
  const { kobo, ids } = await validatePlanInput(c, barberId, d);
  let id = planId;
  if (id == null) id = (await c.one<{ id: number }>('INSERT INTO plans (barber_id, name, price_kobo, sessions, validity_days, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [barberId, d.name, kobo, d.sessions, d.validity_days, isoNow()])).id;
  else {
    // Existing purchases keep their own snapshot: editing only affects future buyers.
    const r = await c.query('UPDATE plans SET name=$1, price_kobo=$2, sessions=$3, validity_days=$4, needs_review=FALSE WHERE id=$5 AND barber_id=$6 AND active', [d.name, kobo, d.sessions, d.validity_days, id, barberId]);
    if (!r.rowCount) throw notFound('We could not find that plan.');
    await c.query('DELETE FROM plan_services WHERE plan_id=$1', [id]);
  }
  await c.query('INSERT INTO plan_services (plan_id, service_id) SELECT $1, unnest($2::int[])', [id, ids]);
  return id;
}

/** Barber dashboard: plans + who bought them (paid only - pending checkouts are invisible) + outstanding credits. */
export async function barberPlanOverview(c: Conn, barberId: number) {
  const s = await getSettings(c);
  const plans = await c.many(`${PLAN_SELECT} WHERE p.barber_id=$1 AND p.active ORDER BY p.id`, [barberId]);
  const purchases = await c.many(`SELECT pp.id, pp.plan_id, pp.plan_name, pp.price_kobo, pp.sessions_total, pp.sessions_used, pp.paid_at, pp.expires_at, u.id AS customer_id, u.name AS customer_name,
      (pp.expires_at > $2 AND pp.sessions_used < pp.sessions_total) AS live
    FROM plan_purchases pp JOIN users u ON u.id=pp.customer_id WHERE pp.barber_id=$1 AND pp.status='ACTIVE' ORDER BY pp.paid_at DESC LIMIT 100`, [barberId, isoNow()]);
  const credits = await c.many(`SELECT sc.id, sc.reason, sc.status, sc.expires_at, sc.created_at, sc.used_at, sc.value_kobo, u.id AS customer_id, u.name AS customer_name,
      (sc.status='AVAILABLE' AND sc.expires_at > $2) AS live
    FROM session_credits sc JOIN users u ON u.id=sc.customer_id WHERE sc.barber_id=$1 ORDER BY sc.created_at DESC LIMIT 100`, [barberId, isoNow()]);
  const byPlan = new Map<number, { buyers: number; revenue_kobo: number; sessions_used: number }>();
  for (const p of purchases) { const e = byPlan.get(p.plan_id) ?? { buyers: 0, revenue_kobo: 0, sessions_used: 0 }; e.buyers++; e.revenue_kobo += p.price_kobo; e.sessions_used += p.sessions_used; byPlan.set(p.plan_id, e); }
  return { limits: limitsOf(s), plans: plans.map((p) => ({ ...p, ...(byPlan.get(p.id) ?? { buyers: 0, revenue_kobo: 0, sessions_used: 0 }) })), purchases, credits };
}

/* ---------------- customer wallet ---------------- */
export async function customerWallet(c: Conn, customerId: number) {
  const now = isoNow();
  const s = await getSettings(c);
  const plans = await c.many(`SELECT pp.id, pp.barber_id, pp.plan_name, pp.sessions_total, pp.sessions_used, pp.paid_at, pp.expires_at, pp.service_ids,
      (pp.sessions_total - pp.sessions_used) AS sessions_left, (pp.expires_at > $2 AND pp.sessions_used < pp.sessions_total) AS live, b.shop_name,
      COALESCE((SELECT array_agg(sv.name ORDER BY sv.name) FROM services sv WHERE sv.id = ANY(pp.service_ids)), '{}') AS service_names
    FROM plan_purchases pp JOIN barbers b ON b.id=pp.barber_id WHERE pp.customer_id=$1 AND pp.status='ACTIVE' ORDER BY live DESC, pp.expires_at DESC LIMIT 50`, [customerId, now]);
  const credits = await c.many(`SELECT sc.id, sc.barber_id, sc.reason, sc.status, sc.expires_at, sc.value_kobo, sc.created_at, b.shop_name,
      (sc.status='AVAILABLE' AND sc.expires_at > $2) AS live
    FROM session_credits sc JOIN barbers b ON b.id=sc.barber_id WHERE sc.customer_id=$1 AND sc.status<>'REVOKED' AND (sc.status='AVAILABLE' OR sc.created_at > now() - interval '60 days') ORDER BY live DESC, sc.expires_at LIMIT 50`, [customerId, now]);
  return { rules: limitsOf(s), plans, credits };
}

/** What this customer can spend at ONE barber right now (only unexpired). Used by the booking wizard. */
export async function entitlementsFor(c: Conn, customerId: number, barberId: number) {
  const now = isoNow();
  const plans = await c.many(`SELECT id, plan_id, plan_name, sessions_total, sessions_used, (sessions_total - sessions_used) AS sessions_left, expires_at, service_ids FROM plan_purchases
      WHERE customer_id=$1 AND barber_id=$2 AND status='ACTIVE' AND expires_at > $3 AND sessions_used < sessions_total ORDER BY expires_at`, [customerId, barberId, now]);
  const credits = await c.many(`SELECT id, value_kobo, expires_at, reason FROM session_credits WHERE customer_id=$1 AND barber_id=$2 AND status='AVAILABLE' AND expires_at > $3 ORDER BY expires_at`, [customerId, barberId, now]);
  return { plans, credits };
}

/* ---------------- spending (inside the booking transaction) ---------------- */
export interface Claimed { option: 'PLAN' | 'CREDIT'; plan_purchase_id: number | null; credit_id: number | null; label: string }

/** Atomically spend one plan session / one credit. Throws a clear 409 when nothing valid is available. The conditional UPDATEs make double-spend impossible. */
export async function claimEntitlement(t: Conn, o: { customerId: number; barberId: number; serviceId: number; priceKobo: number; startAt: Date; option: 'PLAN' | 'CREDIT'; id?: number }): Promise<Claimed> {
  { const fs = await getSettings(t);
    if (o.option === 'PLAN' && !fs.feature_plans) throw new AppError(409, 'FEATURE_OFF', 'Plans are off right now.');
    if (o.option === 'CREDIT' && !fs.feature_credits) throw new AppError(409, 'FEATURE_OFF', 'Session credits are off right now.'); }
  if (o.option === 'PLAN') {
    const params: unknown[] = [o.customerId, o.barberId, o.serviceId, o.startAt.toISOString(), isoNow()];
    let idSql = ''; if (o.id) { params.push(o.id); idSql = ` AND id=$${params.length}`; }
    const r = await t.maybeOne<{ id: number; plan_name: string }>(`UPDATE plan_purchases SET sessions_used = sessions_used + 1 WHERE id = (
        SELECT id FROM plan_purchases WHERE customer_id=$1 AND barber_id=$2 AND status='ACTIVE' AND $3 = ANY(service_ids) AND sessions_used < sessions_total
          AND expires_at >= $4 AND expires_at > $5${idSql} ORDER BY expires_at, id LIMIT 1 FOR UPDATE)
      RETURNING id, plan_name`, params);
    if (!r) throw new AppError(409, 'NO_PLAN_SESSION', 'You have no plan session for this service and date. Use plan sessions before the plan ends.');
    return { option: 'PLAN', plan_purchase_id: r.id, credit_id: null, label: r.plan_name };
  }
  const params: unknown[] = [o.customerId, o.barberId, o.priceKobo, o.startAt.toISOString(), isoNow()];
  let idSql = ''; if (o.id) { params.push(o.id); idSql = ` AND id=$${params.length}`; }
  const r = await t.maybeOne<{ id: number }>(`UPDATE session_credits SET status='USED', used_at=$5 WHERE id = (
      SELECT id FROM session_credits WHERE customer_id=$1 AND barber_id=$2 AND status='AVAILABLE' AND value_kobo >= $3 AND expires_at >= $4 AND expires_at > $5${idSql}
      ORDER BY expires_at, id LIMIT 1 FOR UPDATE) RETURNING id`, params);
  if (!r) throw new AppError(409, 'NO_CREDIT', 'You have no session credit for this barber, service and date. A credit works only with the barber who gave it. Use it before it ends. The service price must not be more than the credit.');
  return { option: 'CREDIT', plan_purchase_id: null, credit_id: r.id, label: 'Session credit' };
}

/** Give the spent plan session / credit back (customer cancelled in time, or the barber could not serve them). */
export async function restoreEntitlement(t: Conn, b: { plan_purchase_id: number | null; credit_id: number | null }) {
  if (b.plan_purchase_id) await t.query('UPDATE plan_purchases SET sessions_used = GREATEST(sessions_used - 1, 0) WHERE id=$1', [b.plan_purchase_id]);
  if (b.credit_id) await t.query(`UPDATE session_credits SET status='AVAILABLE', used_booking_id=NULL, used_at=NULL WHERE id=$1`, [b.credit_id]);
}

/** A paid session that was missed: no refund, ONE credit with the SAME barber, not cashable, expires after `credit_expiry_days`. Idempotent per booking. */
export async function issueCredit(t: Conn, b: { id: number; customer_id: number; barber_id: number; price_kobo: number; service_name: string; date: string; start_min: number }, reason: 'NO_SHOW' | 'LATE_CANCEL' | 'EARLY_CANCEL', settings?: Settings) {
  const s = settings ?? await getSettings(t);
  // One outcome per booking: a booking that has (or had) a refund never also gets a credit.
  if (await t.maybeOne(`SELECT 1 FROM payments WHERE booking_id=$1 AND refund_status IN ('PENDING_APPROVAL','NEEDS_REFUND','REFUND_REQUESTED','REFUNDED')`, [b.id])) return null;
  const expires = new Date(new Date(isoNow()).getTime() + s.credit_expiry_days * 86400000).toISOString();
  const r = await t.maybeOne<{ id: number }>(`INSERT INTO session_credits (customer_id, barber_id, source_booking_id, reason, value_kobo, expires_at, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (source_booking_id) DO NOTHING RETURNING id`, [b.customer_id, b.barber_id, b.id, reason, b.price_kobo, expires, isoNow()]);
  if (!r) return null;
  await audit(t, b.id, { id: null, role: 'system' }, 'CREDIT_ISSUED', { credit_id: r.id, reason, expires_at: expires, note: 'no refund; one same-barber session credit' });
  const exp = new Date(expires);
  await notify(t, b.customer_id, 'CREDIT_ISSUED', 'Session credit added',
    `Your ${b.service_name} session on ${fmtWhen(b.date, b.start_min)} was missed, so we cannot refund it. But you now have 1 session credit with this barber. You cannot cash it out. It works until ${exp.toISOString().slice(0, 10)}. We use it on your next booking with this barber.`, b.id);
  return { id: r.id, expires_at: expires };
}

/* ---------------- plan purchase payment (called after server-side gateway verification, inside the caller's transaction) ---------------- */
export async function applyPlanPayment(t: Conn, purchaseId: number): Promise<'activated' | 'already_active'> {
  const p = await t.maybeOne<any>('SELECT * FROM plan_purchases WHERE id=$1 FOR UPDATE', [purchaseId]);
  if (!p) throw notFound('We could not find that plan purchase.');
  if (p.status === 'ACTIVE') return 'already_active';
  const now = isoNow();
  const exp = new Date(new Date(now).getTime() + p.validity_days * 86400000).toISOString();
  await t.query(`UPDATE plan_purchases SET status='ACTIVE', paid_at=$1, expires_at=$2 WHERE id=$3`, [now, exp, p.id]);
  await audit(t, null, { id: null, role: 'system' }, 'PLAN_PURCHASED', { purchase_id: p.id, plan: p.plan_name, price_kobo: p.price_kobo, expires_at: exp });
  await notify(t, p.customer_id, 'PLAN_PURCHASED', 'Plan bought', `${p.plan_name}: ${p.sessions_total} session${p.sessions_total === 1 ? '' : 's'}, valid until ${exp.slice(0, 10)}. Choose "Use plan session" when you book.`);
  const bu = await t.one<{ user_id: number }>('SELECT user_id FROM barbers WHERE id=$1', [p.barber_id]);
  const cu = await t.one<{ name: string }>('SELECT name FROM users WHERE id=$1', [p.customer_id]);
  await notify(t, bu.user_id, 'PLAN_SOLD', 'Plan sold', `${cu.name} bought "${p.plan_name}" (${naira(p.price_kobo)}, ${p.sessions_total} sessions).`);
  return 'activated';
}
