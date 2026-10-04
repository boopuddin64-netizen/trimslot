-- 015: customers can move an upcoming booking to another free time with the same barber and service (while cancelling is still allowed).
-- Additive only: counters on the booking. Payment, plan session and credit links are never touched by a move.
ALTER TABLE bookings ADD COLUMN reschedule_count INTEGER NOT NULL DEFAULT 0 CHECK (reschedule_count >= 0);
ALTER TABLE bookings ADD COLUMN rescheduled_at   TIMESTAMPTZ;
