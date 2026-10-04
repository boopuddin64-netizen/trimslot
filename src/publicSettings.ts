/** The numbers the public legal pages quote. Read from the admin settings so changing one never needs a code change.
 *  Served without authentication (it contains only the numbers the public policies quote, no fee or business settings, no personal or secret data). */
import { Conn } from './db';
import { getSettings, Settings } from './plans';

export function publicSettingsView(s: Settings) {
  // Only what a customer or barber needs to read in the policies: time windows, retention periods, the liability cap and document versions.
  // Plan limits, the plan refund setting and the loyalty reward are business settings too (the app shows them where they matter; admin reads them from /api/admin/settings).
  // Fees, the processing-fee split, charges, commission, payout floors, debt limits and the refund auto-approval time are business settings and are NOT published here.
  return {
    cancel_cutoff_min: s.cancel_cutoff_min, credit_expiry_days: s.credit_expiry_days, payment_hold_min: s.payment_hold_min,
    liability_cap_naira: s.liability_cap_kobo > 0 ? s.liability_cap_kobo / 100 : null,
    retention_events_days: s.retention_events_days, retention_bad_events_days: s.retention_bad_events_days, retention_notifications_days: s.retention_notifications_days,
    retention_push_stale_days: s.retention_push_stale_days, retention_deleted_days: s.retention_deleted_days, retention_checkout_days: s.retention_checkout_days,
    retention_rate_limit_hours: s.retention_rate_limit_hours, retention_admin_alerts_days: s.retention_admin_alerts_days,
    terms_version: s.terms_version, privacy_version: s.privacy_version, barber_agreement_version: s.barber_agreement_version,
  };
}
export const loadPublicSettings = async (c: Conn) => publicSettingsView(await getSettings(c));
