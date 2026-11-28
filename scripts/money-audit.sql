-- TrimSlot money audit. READ-ONLY: every statement is a SELECT. Safe to run against production.
-- Run in the Supabase SQL editor or with psql against the production database. Each block is labelled.
-- Expected result: every "difference" column is 0, and every "problem" block returns no rows.
-- Re-run at any time and compare with docs/money-audit-2026-11-28.md.

-- 1. Customer money identity for every in-app payment with a breakdown.
--    paid = amount + gateway fee passed to customer; amount = price + booking fee;
--    payout + barber fee + platform charge + booking fee + netted debt = amount.
SELECT id, reference,
  paid_kobo - amount_kobo - COALESCE(gateway_fee_kobo,0)                             AS paid_difference,
  price_kobo + booking_fee_kobo - amount_kobo                                         AS price_difference,
  payout_kobo + barber_fee_kobo + fee_kobo + booking_fee_kobo + debt_netted_kobo - amount_kobo AS split_difference
FROM payments
WHERE status = 'SUCCESS' AND price_kobo IS NOT NULL
ORDER BY id;

-- 2. Commission ledger: remaining = amount - applied (NETTED, MANUAL_SETTLE, WAIVE) + reversed (NETTED_REVERSED).
SELECT l.id, l.barber_id, l.kind, l.amount_kobo, l.remaining_kobo,
  l.amount_kobo - l.remaining_kobo - COALESCE((
    SELECT SUM(CASE WHEN a.kind IN ('NETTED','MANUAL_SETTLE','WAIVE') THEN a.amount_kobo
                    WHEN a.kind = 'NETTED_REVERSED' THEN -a.amount_kobo ELSE 0 END)
    FROM ledger_applications a WHERE a.ledger_id = l.id), 0) AS ledger_difference
FROM commission_ledger l
ORDER BY l.id;

-- 3. Netting: every payment that netted debt has exactly that much applied to the ledger (and reversed if refunded).
SELECT p.id, p.reference, p.status, p.refund_status, p.debt_netted_kobo,
  COALESCE((SELECT SUM(a.amount_kobo) FROM ledger_applications a WHERE a.payment_id = p.id AND a.kind = 'NETTED'), 0)          AS netted_applied,
  COALESCE((SELECT SUM(a.amount_kobo) FROM ledger_applications a WHERE a.payment_id = p.id AND a.kind = 'NETTED_REVERSED'), 0) AS netted_reversed
FROM payments p
WHERE p.debt_netted_kobo > 0 OR EXISTS (SELECT 1 FROM ledger_applications a WHERE a.payment_id = p.id)
ORDER BY p.id;

-- 4. Problem: a confirmed-paid online booking with no successful payment (money not proven).
SELECT b.id, b.payment_status, b.status FROM bookings b
WHERE b.payment_option = 'ONLINE' AND b.payment_status = 'PAID'
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id AND p.status = 'SUCCESS');

-- 5. Problem: a successful payment whose booking is in a state that does not match it.
SELECT p.id AS payment_id, p.reference, b.id AS booking_id, b.payment_status
FROM payments p JOIN bookings b ON b.id = p.booking_id
WHERE p.status = 'SUCCESS' AND b.payment_status NOT IN ('PAID','REFUNDED','CREDITED','VOID','REFUND_PENDING','REFUND_DECLINED');

-- 6. Problem: a booking marked REFUNDED with no refund recorded on its payment.
SELECT b.id, b.payment_status FROM bookings b
WHERE b.payment_status = 'REFUNDED'
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id AND p.refund_status IN ('REFUNDED','REFUND_REQUESTED','NEEDS_REFUND'));

-- 7. Session credits: unused value still owed to customers (a liability until used or expired).
SELECT status, COUNT(*) AS n, SUM(value_kobo) AS value_kobo,
  SUM(CASE WHEN used_booking_id IS NULL THEN value_kobo ELSE 0 END) AS unused_value_kobo
FROM session_credits GROUP BY status ORDER BY status;

-- 8. Plans: every purchase with its payment. A purchase with no breakdown cannot be audited for the barber's share.
SELECT pp.id, pp.status, pp.price_kobo, pp.payout_kobo, pp.platform_charge_kobo, pp.barber_fee_kobo, pp.booking_fee_kobo,
  (SELECT string_agg(p.status || ':' || p.amount_kobo || ':paid=' || COALESCE(p.paid_kobo::text,'-') || ':' || COALESCE(p.refund_status,'-'), ' | ')
     FROM payments p WHERE p.plan_purchase_id = pp.id) AS payments
FROM plan_purchases pp ORDER BY pp.id;

-- 9. Totals for the report (all in kobo; divide by 100 for naira).
SELECT 'in_app_successful_payments' AS item, COUNT(*) AS n, SUM(paid_kobo) AS kobo FROM payments WHERE status = 'SUCCESS'
UNION ALL SELECT 'refunded_payments', COUNT(*), SUM(paid_kobo) FROM payments WHERE status = 'SUCCESS' AND refund_status = 'REFUNDED'
UNION ALL SELECT 'gateway_fee_charged_to_customer', COUNT(*), SUM(gateway_fee_kobo) FROM payments WHERE status = 'SUCCESS' AND gateway_fee_kobo > 0
UNION ALL SELECT 'paystack_fee_recorded', COUNT(*), SUM(ps_fee_actual_kobo) FROM payments WHERE status = 'SUCCESS' AND ps_fee_actual_kobo IS NOT NULL
UNION ALL SELECT 'legacy_payments_without_breakdown', COUNT(*), SUM(paid_kobo) FROM payments WHERE status = 'SUCCESS' AND price_kobo IS NULL
UNION ALL SELECT 'commission_debt_outstanding', COUNT(*), SUM(remaining_kobo) FROM commission_ledger WHERE status = 'ACCRUED';
