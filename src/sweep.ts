import { Db } from './db';
import { expireHolds } from './bookingService';
import { requestRefund, processReference } from './paystack';
import { config } from './config';
import { sendLedgerReminders } from './ledger';
import { runSmartTick } from './smart';
import { flushPush } from './push';

/** Periodic housekeeping, safe to run at any frequency and from several callers at once (all statements are idempotent). */
export async function runSweep(db: Db): Promise<{ smart: { reminders: number; waitlist: number }; push: { claimed: number; sent: number; removed: number }; ledger_reminders: number; holds_released: number; rate_limit_rows_purged: number; expired_events_purged: number; refunds_retried: number }> {
  const holds_released = await expireHolds(db);
  const rl = await db.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '2 hours'`);
  // Payment events are audit data - kept for 400 days, but exact-duplicate INVALID-signature junk is not worth keeping long
  const ev = await db.query(`DELETE FROM payment_events WHERE signature_valid = FALSE AND created_at < now() - interval '30 days'`);
  // Payments flagged NEEDS_REFUND whose gateway refund call failed earlier get another try; abandoned never-paid plan checkouts are dropped after 2 days.
  const due = await db.many<{ reference: string }>(`SELECT reference FROM payments WHERE refund_status='NEEDS_REFUND' LIMIT 20`);
  let refunds_retried = 0;
  for (const d of due) if ((await requestRefund(db, d.reference)) === 'requested') refunds_retried++;
  // Abandoned never-paid plan checkouts are dropped after 2 days - but NEVER one the gateway may have charged:
  // (1) ask the gateway first (a late/mismatched charge is then confirmed or flagged for refund instead of silently vanishing),
  // (2) keep any purchase that has a signed charge event on record, so the money trail is not lost.
  const staleBase = `FROM plan_purchases pp WHERE pp.status='PENDING' AND pp.created_at < now() - interval '2 days' AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.plan_purchase_id=pp.id AND p.status='SUCCESS')`;
  if (!config.mockMode) {
    const refs = await db.many<{ reference: string }>(`SELECT p.reference FROM payments p JOIN plan_purchases pp ON pp.id=p.plan_purchase_id WHERE p.status='INITIATED' AND pp.status='PENDING' AND pp.created_at < now() - interval '2 days' AND pp.created_at > now() - interval '30 days' LIMIT 10`).catch(() => []);
    for (const r of refs) await processReference(db, r.reference).catch(() => undefined);
  }
  const stale = `SELECT pp.id ${staleBase} AND NOT EXISTS (SELECT 1 FROM payments p JOIN payment_events e ON e.reference=p.reference WHERE p.plan_purchase_id=pp.id AND e.signature_valid IS TRUE)`;
  await db.query(`DELETE FROM payments WHERE plan_purchase_id IN (${stale})`).catch(() => {});
  await db.query(`DELETE FROM plan_purchases WHERE id IN (${stale})`).catch(() => {});
  const ledger_reminders = await db.tx((t) => sendLedgerReminders(t)).catch(() => 0);
  const smart = await runSmartTick(db, true).catch(() => ({ reminders: 0, waitlist: 0 }));
  const push = await flushPush(db, 200).catch(() => ({ claimed: 0, sent: 0, removed: 0 }));
  return { smart, push, ledger_reminders, refunds_retried, holds_released, rate_limit_rows_purged: rl.rowCount, expired_events_purged: ev.rowCount };
}
