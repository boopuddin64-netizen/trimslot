-- 025: plan refund rules (Nov 2026). Apply by hand in the Supabase SQL editor after 024.
-- New states: OTHER_DECLINED (the other side said no; admin reviews), TRANSFER_DUE (admin chose the bank transfer route; barber to send and record),
--             TRANSFER_SENT (barber recorded the transfer; customer to confirm), CLOSED_UNCONFIRMED (no confirmation after 7 days).
-- A request locks at CONFIRMED (the other side agreed) and can only be withdrawn while OPEN or FORWARDED.

ALTER TABLE plan_refund_requests DROP CONSTRAINT IF EXISTS plan_refund_requests_status_check;
ALTER TABLE plan_refund_requests ADD CONSTRAINT plan_refund_requests_status_check
  CHECK (status IN ('OPEN','FORWARDED','OTHER_DECLINED','CONFIRMED','REFUNDING','TRANSFER_DUE','TRANSFER_SENT','REFUNDED','CLOSED_UNCONFIRMED','WITHDRAWN','DECLINED_ADMIN','DECLINED_OTHER'));

ALTER TABLE plan_refund_requests ADD COLUMN IF NOT EXISTS refund_method TEXT CHECK (refund_method IN ('PAYSTACK','TRANSFER'));
ALTER TABLE plan_refund_requests ADD COLUMN IF NOT EXISTS transfer_reference TEXT;
ALTER TABLE plan_refund_requests ADD COLUMN IF NOT EXISTS transfer_amount_kobo BIGINT;
ALTER TABLE plan_refund_requests ADD COLUMN IF NOT EXISTS transfer_recorded_at TIMESTAMPTZ;
ALTER TABLE plan_refund_requests ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ;
ALTER TABLE plan_refund_requests ADD COLUMN IF NOT EXISTS customer_received_at TIMESTAMPTZ;
ALTER TABLE plan_refund_requests ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE plan_refund_requests ADD COLUMN IF NOT EXISTS close_reason TEXT;

-- one live request per plan (every state that is still going)
DROP INDEX IF EXISTS one_live_plan_refund;
CREATE UNIQUE INDEX one_live_plan_refund ON plan_refund_requests (plan_purchase_id)
  WHERE status IN ('OPEN','FORWARDED','OTHER_DECLINED','CONFIRMED','REFUNDING','TRANSFER_DUE','TRANSFER_SENT');
