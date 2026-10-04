-- 013: cron heartbeat. The cron endpoint stamps these on every authorised hit so the admin can see the 1-minute timer is really running.
-- Additive only: three nullable columns on platform_settings, no data rewritten.
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS cron_last_run_at TIMESTAMPTZ;      -- last time an authorised call reached /api/cron/sweep
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS cron_last_ok_at  TIMESTAMPTZ;      -- last time that call finished without an error
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS cron_last_error  TEXT;             -- short text of the last failure (cleared on success)
