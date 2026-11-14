-- 025: password recovery codes are isolated from email-verification OTPs; session_version revokes old tokens after a credential change.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_attempts INTEGER NOT NULL DEFAULT 0 CHECK (password_reset_attempts >= 0);
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version >= 1);
