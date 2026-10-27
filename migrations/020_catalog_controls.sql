-- 020: admin controls for barber catalog limits and plan approval.
-- Additive only: existing services, plans, purchases and bookings are preserved.

ALTER TABLE platform_settings
  ADD COLUMN catalog_limits_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN default_service_limit INTEGER NOT NULL DEFAULT 5 CHECK (default_service_limit BETWEEN 1 AND 100),
  ADD COLUMN default_plan_limit INTEGER NOT NULL DEFAULT 5 CHECK (default_plan_limit BETWEEN 1 AND 100),
  ADD COLUMN plan_approval_required BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE plans
  ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'APPROVED' CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED')),
  ADD COLUMN approval_reason TEXT,
  ADD COLUMN approved_at TIMESTAMPTZ;

CREATE INDEX idx_plans_approval ON plans (barber_id, approval_status) WHERE active;

ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
