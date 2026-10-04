import { Db } from './db';
import { expireHolds } from './bookingService';
import { requestRefund, processReference, reconcileRecentPayments } from './paystack';
import { config } from './config';
import { sendLedgerReminders } from './ledger';
import { runSmartTick } from './smart';
import { flushPush } from './push';
import { autoApproveDueRefunds } from './refundFlow';
import { flushAdminPush } from './adminNotify';
import { runRetentionIfDue } from './retention';
import { getSettings } from './plans';

/** Periodic housekeeping, safe to run at any frequency and from several callers at once (all statements are idempotent). */
export async function runSweep(db: Db): Promise<{ payments_reconciled: { checked: number; confirmed: number; refunds: number }; smart: { reminders: number; waitlist: number }; push: { claimed: number; sent: number; removed: number }; ledger_reminders: number; holds_released: number; rate_limit_rows_purged: number; expired_events_purged: number; refunds_retried: number; refunds_auto_approved: number; admin_push: { claimed: number; sent: number; removed: number; held: boolean }; retention: unknown }> {
  const holds_released = await expireHolds(db, {}, { budgetMs: 25000 });
  // A payment whose webhook never reached us (and whose browser was closed) is found here, within 24 hours: confirmed if the time is still free, otherwise refunded.
  const reconciled = await reconcileRecentPayments(db).catch(() => ({ checked: 0, confirmed: 0, refunds: 0 }));
  // Prepaid refunds nobody decided within the admin's hold time are approved here and sent to Paystack.
  const auto = await autoApproveDueRefunds(db).catch(() => ({ approved: 0, failed: 0 }));
  // Retention (rate-limit rows, old webhook payloads, stale push devices, soft-deleted records ...) with the periods the admin set; at most hourly.
  const retention = await runRetentionIfDue(db).catch(() => null);
  const rl = { rowCount: retention?.rate_limits ?? 0 }; const ev = { rowCount: (retention?.bad_payment_events ?? 0) + (retention?.old_payment_events ?? 0) };
  // Payments flagged NEEDS_REFUND whose gateway refund call failed earlier get another try; abandoned never-paid plan checkouts are dropped after 2 days.
  const due = await db.many<{ reference: string }>(`SELECT reference FROM payments WHERE refund_status='NEEDS_REFUND' AND COALESCE(refund_reason,'') <> 'Amount mismatch' LIMIT 20`);
  let refunds_retried = 0;
  for (const d of due) if ((await requestRefund(db, d.reference)) === 'requested') refunds_retried++;
  // Abandoned never-paid plan checkouts are dropped after 2 days - but NEVER one the gateway may have charged:
  // (1) ask the gateway first (a late/mismatched charge is then confirmed or flagged for refund instead of silently vanishing),
  // (2) keep any purchase that has a signed charge event on record, so the money trail is not lost.
  const ckDays = Math.max(1, Math.floor((await getSettings(db)).retention_checkout_days));
  const staleBase = `FROM plan_purchases pp WHERE pp.status='PENDING' AND pp.created_at < now() - make_interval(days => ${ckDays}) AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.plan_purchase_id=pp.id AND p.status='SUCCESS')`;
  if (!config.mockMode) {
    const refs = await db.many<{ reference: string }>(`SELECT p.reference FROM payments p JOIN plan_purchases pp ON pp.id=p.plan_purchase_id WHERE p.status='INITIATED' AND pp.status='PENDING' AND pp.created_at < now() - make_interval(days => $1) AND pp.created_at > now() - interval '30 days' LIMIT 10`, [ckDays]).catch(() => []);
    for (const r of refs) await processReference(db, r.reference).catch(() => undefined);
  }
  const stale = `SELECT pp.id ${staleBase} AND NOT EXISTS (SELECT 1 FROM payments p JOIN payment_events e ON e.reference=p.reference WHERE p.plan_purchase_id=pp.id AND e.signature_valid IS TRUE)`;
  await db.query(`DELETE FROM payments WHERE plan_purchase_id IN (${stale})`).catch(() => {});
  await db.query(`DELETE FROM plan_purchases WHERE id IN (${stale})`).catch(() => {});
  const ledger_reminders = await db.tx((t) => sendLedgerReminders(t)).catch(() => 0);
  const smart = await runSmartTick(db, true).catch(() => ({ reminders: 0, waitlist: 0 }));
  const push = await flushPush(db, 200).catch(() => ({ claimed: 0, sent: 0, removed: 0 }));
  const admin_push = await flushAdminPush(db, 50).catch(() => ({ claimed: 0, sent: 0, removed: 0, held: false }));
  return { payments_reconciled: reconciled, smart, push, ledger_reminders, refunds_retried, refunds_auto_approved: auto.approved, admin_push, retention, holds_released, rate_limit_rows_purged: rl.rowCount, expired_events_purged: ev.rowCount };
}
