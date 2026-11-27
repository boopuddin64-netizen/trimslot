-- 029: Server-side admin sessions so a browser session can be revoked (logout, "sign out everywhere").
-- Only a SHA-256 of the session nonce is stored, never the cookie. Additive; RLS on, no API-role access.
CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions (expires_at);
ALTER TABLE admin_sessions ENABLE ROW LEVEL SECURITY;
