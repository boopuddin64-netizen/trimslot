-- 026: account grace period. A customer who asks to delete the account is frozen (PENDING_DELETION) for 7 days instead of being removed at once.
-- Logging in during those 7 days keeps the account. After 7 days the sweep removes the personal details (same result as an immediate deletion).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_status_check;
ALTER TABLE users ADD CONSTRAINT users_account_status_check CHECK (account_status IN ('ACTIVE','PENDING_DELETION','SUSPENDED','BANNED','DELETED'));
