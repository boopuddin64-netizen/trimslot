# TrimSlot — Supabase Auth migration plan

## Status
- Work branch: feature/supabase-auth-foundation
- Current production authentication remains unchanged.
- No production migration has been applied by this work.
- Existing legacy users and business records are preserved.
- Production backup/restore verification is a hard gate before any live schema or identity migration.

## Verified architecture
TrimSlot currently uses Express, PostgreSQL, bcryptjs, jsonwebtoken and an HttpOnly cookie named trimslot_token. The API authenticates a legacy integer users.id from a signed JWT, then reloads the user and current role from PostgreSQL on each request. session_version invalidates old sessions after password changes. Customer and barber sign-up/login routes are in src/app.ts; authorization middleware is in src/auth.ts.

The database has six legacy users (four customers, two barbers). Their integer IDs are referenced by bookings, barber profiles and other business tables. The schema must not convert or replace those IDs.

Admin authentication is separate today: the admin portal uses a dedicated server key (ADMIN_KEY, with documented CRON_SECRET fallback), while irreversible actions require the existing scrypt-hashed four-digit PIN (admin_pin) with a five-attempt / 15-minute lockout. Preserve this PIN hash and lockout state.

## Target identity model
- Supabase Auth becomes the credential and identity provider.
- Keep public.users.id as the immutable integer primary key used by all existing foreign keys.
- Link a customer/barber to Supabase with nullable, unique public.users.auth_user_id UUID REFERENCES auth.users(id).
- Use a separate server-only public.admin_auth_users allowlist for administrators. Admin membership is never granted through editable user_metadata or public signup.
- Keep role, account status, barber approval, and business authorization in trusted database records.
- Keep the admin PIN as a second gate for destructive/high-risk actions. Do not remove its existing lockout or audit behavior.
- Keep cron authentication separate from human user authentication.

## Migration 027
The additive SQL in this branch:
1. Adds nullable users.auth_user_id.
2. Adds a unique partial index so one Auth identity cannot be linked to multiple legacy users.
3. Adds an FK to auth.users with ON DELETE RESTRICT, preventing accidental deletion of a linked Auth identity.
4. Adds the separate admin allowlist with revocation metadata.
5. Enables RLS and revokes browser-role privileges on the admin allowlist.

It does not import identities, modify passwords, create an administrator, change existing RLS policies, or switch the application.

## Existing password migration
Existing passwords are bcryptjs hashes. Supabase Auth supports importing supported password hashes through its Admin API, but compatibility must be proven against the exact stored hash format and cost. Before any live import:
1. Inspect hash prefixes and cost metadata without exporting hashes or credentials into logs.
2. Create a disposable staging account with the same bcrypt format and cost.
3. Import it into a non-production Auth project using the documented Admin API.
4. Verify successful password login and verify a deliberately wrong password is rejected.
5. If the exact hash cannot be imported, use Supabase's secure password-reset flow. Never attempt plaintext recovery or copy plaintext passwords.

Do not migrate or delete any legacy password hashes until all users have confirmed successful Supabase login and a rollback window has elapsed.

## Application cutover sequence
1. Backup gate: create an encrypted logical backup, verify its checksum, restore it into an isolated database, and compare critical row counts and constraints.
2. Staging schema: apply migration 027 to an isolated staging database and verify the nullable mapping, FK, unique index, RLS and browser-role denial.
3. Identity bridge: implement a server-only Supabase Auth adapter. Verify Auth JWTs server-side; do not trust client-decoded JWT claims. Keep the existing HttpOnly cookie approach and avoid localStorage token storage.
4. Role resolution: map Auth UUID to the existing users row, then derive customer/barber role, status and barber profile from PostgreSQL on each authenticated request.
5. Customer and barber onboarding: preserve current signup validation, consent logging, email-verification behavior, barber review/approval and payout requirements.
6. Admin onboarding: provision administrator Auth identities out-of-band; allowlist them server-side; require Auth plus the existing PIN for sensitive actions.
7. Compatibility window: keep old JWT verification available behind a controlled feature flag until migrated accounts and active sessions are accounted for. Do not allow an old token to elevate a user or bypass current account status.
8. Regression and security: test ownership boundaries, session revocation, suspended users, password reset, webhook processing, bookings, payments, receipts, refunds and barber payouts.
9. Production rollout: apply the tested additive migration, deploy compatible code, migrate accounts in small batches, monitor authentication failures, then retire legacy JWT issuance only after the agreed transition window.

## RLS and database access note
The public tables have RLS enabled, but the current Express application connects directly to PostgreSQL using a privileged database connection. RLS does not replace Express authorization for that connection. Do not apply blanket policies or revoke broad grants as part of this authentication migration. Inventory every exposed table and each access path separately before any RLS redesign.

## Rollback
- Before cutover: revert the application deployment; leave the additive mapping schema in place.
- During the compatibility window: route users back to legacy JWT authentication only if the legacy credential remains valid and account status/session version checks still pass.
- Never restore an old database over newer production writes as an application rollback.
- Never delete imported Auth users or legacy users as a rollback shortcut.
- If an Auth identity is compromised, revoke/disable that identity and invalidate its sessions; preserve the legacy business row and audit trail.

## Acceptance criteria
- All six existing accounts retain their legacy integer IDs and all related rows.
- Existing bcrypt credentials work where import compatibility is proven; otherwise secure reset is available.
- Customer and barber roles are derived from trusted server-side records.
- A customer cannot access another customer's records.
- A barber can access only their own barber profile and assigned bookings/customer relationships.
- Suspended/banned/deleted accounts cannot authenticate or use existing sessions.
- Admin requires a provisioned Supabase Auth identity and the existing PIN for protected actions.
- Five wrong PIN attempts still lock PIN checks for 15 minutes.
- Cron and Paystack webhook authentication remain independent and unchanged.
- Booking, payment, refund, receipt, payout and audit behavior is unchanged.
- Backup restore has been rehearsed before production migration.
