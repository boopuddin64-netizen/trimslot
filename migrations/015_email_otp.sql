-- 015: email verification with a one-time code (6 digits, 10 minutes, 5 tries). Only a HASH of the code is stored.
-- Additive only. Nobody is locked out of login: existing accounts stay unverified until they verify; existing BARBER accounts are exempt
-- from the "verified email before the shop is bookable" rule (new barbers are not). Existing customers are prompted on their next first-time booking
-- (customers who already have a booking are never blocked).
ALTER TABLE users ADD COLUMN email_verified_at   TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN otp_hash            TEXT;
ALTER TABLE users ADD COLUMN otp_expires_at      TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN otp_attempts        INTEGER NOT NULL DEFAULT 0 CHECK (otp_attempts >= 0);
ALTER TABLE users ADD COLUMN email_verify_exempt BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE users SET email_verify_exempt = TRUE WHERE role = 'barber';
