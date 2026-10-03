-- 009: payment fee pass-through fix, barber payout setup, admin PIN, soft delete (30-day restore window).

/* ---------- payments: record what the customer really paid (Paystack can add its fee on top of the price) ---------- */
ALTER TABLE payments ADD COLUMN paid_kobo        INTEGER;
ALTER TABLE payments ADD COLUMN gateway_fee_kobo INTEGER NOT NULL DEFAULT 0;

/* ---------- barber payout details (the full account number is never stored; Paystack holds it on the subaccount) ---------- */
ALTER TABLE barbers ADD COLUMN payout_bank_code     TEXT;
ALTER TABLE barbers ADD COLUMN payout_bank_name     TEXT;
ALTER TABLE barbers ADD COLUMN payout_account_last4 TEXT;
ALTER TABLE barbers ADD COLUMN payout_account_name  TEXT;
ALTER TABLE barbers ADD COLUMN payout_set_at        TIMESTAMPTZ;

/* ---------- soft delete (restorable for 30 days; hard delete only with the admin PIN) ---------- */
ALTER TABLE users ADD COLUMN deleted_at          TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN deleted_prev_status TEXT;
ALTER TABLE users ADD COLUMN delete_reason       TEXT;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_status_check;
ALTER TABLE users ADD CONSTRAINT users_account_status_check CHECK (account_status IN ('ACTIVE','SUSPENDED','BANNED','DELETED'));
ALTER TABLE barbers ADD COLUMN deleted_prev_review TEXT;
ALTER TABLE plans   ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE plans   ADD COLUMN deleted_prev_active BOOLEAN;
ALTER TABLE reviews ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE reviews ADD COLUMN deleted_prev_hidden BOOLEAN;
ALTER TABLE reports ADD COLUMN deleted_at TIMESTAMPTZ;
CREATE INDEX idx_users_deleted   ON users (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_plans_deleted   ON plans (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_reviews_deleted ON reviews (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_reports_deleted ON reports (deleted_at) WHERE deleted_at IS NOT NULL;

/* ---------- admin PIN (one row; scrypt hash + per-PIN salt; lockout state) ---------- */
CREATE TABLE admin_pin (
  id           SMALLINT PRIMARY KEY CHECK (id = 1),
  salt         TEXT NOT NULL,
  hash         TEXT NOT NULL,
  set_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  fail_count   INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_fail_at TIMESTAMPTZ
);
ALTER TABLE admin_pin ENABLE ROW LEVEL SECURITY;
