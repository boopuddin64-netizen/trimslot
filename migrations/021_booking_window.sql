-- 021: admin choice for how far ahead customers can book (14 or 30 days). Additive only; existing bookings are untouched.

ALTER TABLE platform_settings
  ADD COLUMN booking_window_days INTEGER NOT NULL DEFAULT 14 CHECK (booking_window_days IN (14, 30));
