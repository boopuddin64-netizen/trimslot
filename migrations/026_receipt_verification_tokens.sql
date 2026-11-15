-- Receipt QR verification is a separate opaque capability; the human receipt number is never used for lookup.
CREATE TABLE receipt_verification_tokens (
  payment_id INTEGER PRIMARY KEY REFERENCES payments(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{43}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

ALTER TABLE receipt_verification_tokens ENABLE ROW LEVEL SECURITY;
