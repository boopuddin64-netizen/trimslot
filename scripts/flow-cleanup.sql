-- Removes ALL throwaway data created by scripts/flow-multi.ts (and the older smoke tests): users like smoketest+…@example.com and everything hanging off them.
-- Run via the Supabase SQL connector / psql as the DB owner. Touches nothing else.
CREATE TEMP TABLE _u AS SELECT id FROM users WHERE email LIKE 'smoketest+%@example.com';
CREATE TEMP TABLE _b AS SELECT id FROM barbers WHERE user_id IN (SELECT id FROM _u);
CREATE TEMP TABLE _bk AS SELECT id FROM bookings WHERE customer_id IN (SELECT id FROM _u) OR barber_id IN (SELECT id FROM _b);
DELETE FROM payments WHERE booking_id IN (SELECT id FROM _bk) OR plan_purchase_id IN (SELECT id FROM plan_purchases WHERE customer_id IN (SELECT id FROM _u) OR barber_id IN (SELECT id FROM _b));
UPDATE session_credits SET used_booking_id=NULL WHERE used_booking_id IN (SELECT id FROM _bk);
UPDATE bookings SET credit_id=NULL, plan_purchase_id=NULL WHERE id IN (SELECT id FROM _bk);
DELETE FROM session_credits WHERE customer_id IN (SELECT id FROM _u) OR barber_id IN (SELECT id FROM _b);
DELETE FROM notifications WHERE user_id IN (SELECT id FROM _u) OR booking_id IN (SELECT id FROM _bk);
DELETE FROM audit_log WHERE booking_id IN (SELECT id FROM _bk) OR actor_user_id IN (SELECT id FROM _u);
DELETE FROM bookings WHERE id IN (SELECT id FROM _bk);
DELETE FROM plan_purchases WHERE customer_id IN (SELECT id FROM _u) OR barber_id IN (SELECT id FROM _b);
-- plan_services, availability_changes and barber_photos cascade from plans/barbers
DELETE FROM plans WHERE barber_id IN (SELECT id FROM _b);
DELETE FROM days_off WHERE barber_id IN (SELECT id FROM _b);
DELETE FROM services WHERE barber_id IN (SELECT id FROM _b);
DELETE FROM barber_schedule WHERE barber_id IN (SELECT id FROM _b);
DELETE FROM barbers WHERE id IN (SELECT id FROM _b);
DELETE FROM users WHERE id IN (SELECT id FROM _u);
-- rate-limit rows created by the run are harmless and expire by themselves (the sweeper purges them after 2 h)
SELECT (SELECT count(*) FROM users WHERE email LIKE 'smoketest+%') AS smoke_users_left;
