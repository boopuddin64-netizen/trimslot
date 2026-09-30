-- Guard #3: no two live bookings for the same barber may OVERLAP in time (stronger than the same-start unique index).
-- Needs the btree_gist extension (available on Supabase and stock Postgres). If the role cannot create extensions the
-- migration does NOT fail: the app-level check (row-locked, inside the booking transaction) and unique indexes from 001 still apply,
-- and a NOTICE is raised so you know the extra safety net is missing.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS btree_gist;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'btree_gist unavailable (%): skipping bookings_no_overlap exclusion constraint', SQLERRM;
    RETURN;
  END;
  ALTER TABLE bookings
    ADD CONSTRAINT bookings_no_overlap
    EXCLUDE USING gist (barber_id WITH =, tstzrange(scheduled_at, ends_at) WITH &&)
    WHERE (status IN ('PENDING_PAYMENT','CONFIRMED','ARRIVED','IN_SERVICE','COMPLETED'));
END
$$;
