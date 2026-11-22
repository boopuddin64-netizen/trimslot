-- 028: Restrict the Supabase Data API roles to no direct access to application tables.
-- TrimSlot's browser talks only to the Express API; the server connects with the dedicated
-- trimslot_app database role. Keep trimslot_app and service_role privileges unchanged.
-- RLS remains enabled as defence in depth. This removes the unused anon/authenticated
-- table, sequence and function grants that otherwise expose a broad database surface.

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

-- Prevent future objects created by postgres migrations from inheriting browser-role grants.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;

-- Supabase-managed supabase_admin default privileges are not altered here.
-- Any future object created by that role must explicitly revoke browser-role grants.
