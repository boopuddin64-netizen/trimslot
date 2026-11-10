-- 023: row level security on the public tables the app uses. Supabase's advisor flags public tables with RLS off,
-- because the public API (anon and authenticated roles) can reach them.
-- No policies are added. The app connects with its own database role, which owns these tables or bypasses RLS,
-- and it already works this way for the tables that have RLS on. The public API gets no access.
-- ENABLE is idempotent, so this is safe to run again.

ALTER TABLE admin_notification_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE barber_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE barbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE days_off ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- plan_refund_requests comes from migration 022 (on its own branch). Guarded, so this file also runs where that table does not exist yet.
DO $$ BEGIN
  IF to_regclass('public.plan_refund_requests') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.plan_refund_requests ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;
