import { Db } from './db';
import { expireHolds } from './bookingService';
import { requestRefund } from './paystack';
import { sendLedgerReminders } from './ledger';

/** Periodic housekeeping, safe to run at any frequency and from several callers at once (all statements are idempotent). */
export async function runSweep(db: Db): Promise<{ ledger_reminders: number; holds_released: number; rate_limit_rows_purged: number; expired_events_purged: number; refunds_retried: number }> {
  const holds_released = await expireHolds(db);
  const rl = await db.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '2 hours'`);
  // Payment events are audit data - kept for 400 days, but exact-duplicate INVALID-signature junk is not worth keeping long
  const ev = await db.query(`DELETE FROM payment_events WHERE signature_valid = FALSE AND created_at < now() - interval '30 days'`);
  // Payments flagged NEEDS_REFUND whose gateway refund call failed earlier get another try; abandoned never-paid plan checkouts are dropped after 2 days.
  const due = await db.many<{ reference: string }>(`SELECT reference FROM payments WHERE refund_status='NEEDS_REFUND' LIMIT 20`);
  let refunds_retried = 0;
  for (const d of due) if ((await requestRefund(db, d.reference)) === 'requested') refunds_retried++;
  const stale = `SELECT pp.id FROM plan_purchases pp WHERE pp.status='PENDING' AND pp.created_at < now() - interval '2 days' AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.plan_purchase_id=pp.id AND p.status='SUCCESS')`;
  await db.query(`DELETE FROM payments WHERE plan_purchase_id IN (${stale})`).catch(() => {});
  await db.query(`DELETE FROM plan_purchases WHERE id IN (${stale})`).catch(() => {});
  const ledger_reminders = await db.tx((t) => sendLedgerReminders(t)).catch(() => 0);
  return { ledger_reminders, refunds_retried, holds_released, rate_limit_rows_purged: rl.rowCount, expired_events_purged: ev.rowCount };
}
