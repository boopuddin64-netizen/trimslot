-- 027: Supabase Auth identity foundation.
-- Additive only: retain public.users.id (integer), password_hash and all existing business rows.
-- This does NOT import auth.users, alter passwords, change existing RLS, or switch application auth.
-- Apply only after a verified production backup and a staging rehearsal.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS auth_user_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_auth_user_id_fkey'
      AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_auth_user_id_fkey
      FOREIGN KEY (auth_user_id)
      REFERENCES auth.users(id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_auth_user_id
  ON public.users (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

-- Admin identities are separate from customer/barber records. No public signup path.
CREATE TABLE IF NOT EXISTS public.admin_auth_users (
  auth_user_id UUID PRIMARY KEY
    REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_auth_user_id UUID
    REFERENCES auth.users(id) ON DELETE RESTRICT,
  revoked_at TIMESTAMPTZ,
  revoked_by_auth_user_id UUID
    REFERENCES auth.users(id) ON DELETE RESTRICT,
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  CHECK (
    (revoked_at IS NULL AND revoked_by_auth_user_id IS NULL)
    OR revoked_at IS NOT NULL
  )
);

ALTER TABLE public.admin_auth_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_auth_users FROM anon, authenticated;
