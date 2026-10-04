/** The numbers the public legal pages quote. Read from the admin settings so changing one never needs a code change.
 *  Served without authentication (it contains only published policy numbers, no personal or secret data). */
import { Conn } from './db';
import { getSettings, Settings } from './plans';

export function publicSettingsView(s: Settings) {
  const pct = (n: number) => Math.round(n * 1000) / 1000;
  return {
    cancel_cutoff_min: s.cancel_cutoff_min, credit_expiry_days: s.credit_expiry_days, payment_hold_min: s.payment_hold_min,
    refund_auto_approve_hours: s.refund_auto_approve_hours,
    platform_charge_percent: pct(s.charge_percent), platform_charge_flat_naira: s.charge_flat_kobo / 100, platform_charge_min_naira: s.charge_min_kobo / 100,
    fee_share_customer_percent: pct(s.fee_share_customer_pct), fee_share_barber_percent: pct(s.fee_share_barber_pct), fee_share_platform_percent: pct(s.fee_share_platform_pct),
    ps_percent: pct(s.ps_percent), ps_flat_naira: s.ps_flat_kobo / 100, ps_flat_waived_below_naira: s.ps_flat_waived_below_kobo / 100, ps_cap_naira: s.ps_cap_kobo / 100, ps_vat_percent: pct(s.ps_vat_percent),
    commission_enabled: s.commission_enabled, commission_percent: pct(s.commission_factor * 100), min_barber_payout_percent: s.min_barber_payout_percent,
    ledger_max_debt_naira: s.ledger_max_debt_kobo / 100, ledger_max_age_days: s.ledger_max_age_days,
    min_plan_price_naira: s.min_plan_price_kobo / 100, max_plan_price_naira: s.max_plan_price_kobo / 100, max_plan_validity_days: s.max_plan_validity_days, max_plan_sessions: s.max_plan_sessions,
    plan_refund_policy: s.plan_refund_policy,
    liability_cap_naira: s.liability_cap_kobo > 0 ? s.liability_cap_kobo / 100 : null,
    retention_events_days: s.retention_events_days, retention_bad_events_days: s.retention_bad_events_days, retention_notifications_days: s.retention_notifications_days,
    retention_push_stale_days: s.retention_push_stale_days, retention_deleted_days: s.retention_deleted_days, retention_checkout_days: s.retention_checkout_days,
    retention_rate_limit_hours: s.retention_rate_limit_hours,
    terms_version: s.terms_version, privacy_version: s.privacy_version, barber_agreement_version: s.barber_agreement_version,
  };
}
export const loadPublicSettings = async (c: Conn) => publicSettingsView(await getSettings(c));
