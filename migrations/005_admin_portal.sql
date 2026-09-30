-- 005: admin portal. An admin can mark a flagged payment as refunded outside the gateway (bank transfer / Paystack dashboard).
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_refund_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_refund_status_check CHECK (refund_status IN ('NEEDS_REFUND','REFUND_REQUESTED','REFUNDED'));
