-- 024: plan balance refunds go through admin review first. 022 is already applied in production, so this file changes it.
-- Flow: asked (OPEN, admin reviews) -> forwarded to the other party (FORWARDED) -> agreed (CONFIRMED) -> authorized (REFUNDING -> REFUNDED).
-- Ends early: DECLINED_ADMIN (admin said no), DECLINED_OTHER (the other party said no), WITHDRAWN (either party took it back).

ALTER TABLE plan_refund_requests DROP CONSTRAINT IF EXISTS plan_refund_requests_status_check;
ALTER TABLE plan_refund_requests ADD CONSTRAINT plan_refund_requests_status_check
  CHECK (status IN ('OPEN','FORWARDED','CONFIRMED','REFUNDING','REFUNDED','WITHDRAWN','DECLINED_ADMIN','DECLINED_OTHER'));

ALTER TABLE plan_refund_requests ADD COLUMN forwarded_at TIMESTAMPTZ;
ALTER TABLE plan_refund_requests ADD COLUMN admin_reviewed_at TIMESTAMPTZ;
ALTER TABLE plan_refund_requests ADD COLUMN decline_reason TEXT;

-- one live request per plan: waiting for review, waiting for the other party, agreed, or being sent
DROP INDEX IF EXISTS one_live_plan_refund;
CREATE UNIQUE INDEX one_live_plan_refund ON plan_refund_requests (plan_purchase_id)
  WHERE status IN ('OPEN','FORWARDED','CONFIRMED','REFUNDING');
