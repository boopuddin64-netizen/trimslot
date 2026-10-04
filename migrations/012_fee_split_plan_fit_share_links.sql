-- 012: (A) Paystack fee split three ways + platform charge, (B) plans explicitly linked to services (review flag + per-session value),
--      (C) private barber share links and the customer's "My barbers" list.
-- Additive only: new columns with defaults, new tables, backfills that only fill EMPTY links / create new rows. No drops, no rewrites of existing values.

/* ---------- A: fee model settings (all admin-editable) ---------- */
-- Who bears the Paystack processing fee. Three shares that add up to 100 (equal thirds by default; the platform share takes the odd 0.0001).
ALTER TABLE platform_settings ADD COLUMN fee_share_customer_pct NUMERIC(7,4) NOT NULL DEFAULT 33.3333 CHECK (fee_share_customer_pct BETWEEN 0 AND 100);
ALTER TABLE platform_settings ADD COLUMN fee_share_barber_pct   NUMERIC(7,4) NOT NULL DEFAULT 33.3333 CHECK (fee_share_barber_pct   BETWEEN 0 AND 100);
ALTER TABLE platform_settings ADD COLUMN fee_share_platform_pct NUMERIC(7,4) NOT NULL DEFAULT 33.3334 CHECK (fee_share_platform_pct BETWEEN 0 AND 100);
ALTER TABLE platform_settings ADD CONSTRAINT fee_shares_sum_100 CHECK (abs(fee_share_customer_pct + fee_share_barber_pct + fee_share_platform_pct - 100) < 0.001);
-- Paystack's published rate, kept as settings so a change at Paystack never needs a deploy.
ALTER TABLE platform_settings ADD COLUMN ps_percent             NUMERIC(6,3) NOT NULL DEFAULT 1.5   CHECK (ps_percent BETWEEN 0 AND 20);
ALTER TABLE platform_settings ADD COLUMN ps_flat_kobo           INTEGER      NOT NULL DEFAULT 10000 CHECK (ps_flat_kobo BETWEEN 0 AND 10000000);
ALTER TABLE platform_settings ADD COLUMN ps_flat_waived_below_kobo INTEGER   NOT NULL DEFAULT 250000 CHECK (ps_flat_waived_below_kobo BETWEEN 0 AND 1000000000);
ALTER TABLE platform_settings ADD COLUMN ps_cap_kobo            INTEGER      NOT NULL DEFAULT 200000 CHECK (ps_cap_kobo BETWEEN 0 AND 1000000000);
ALTER TABLE platform_settings ADD COLUMN ps_vat_percent         NUMERIC(5,2) NOT NULL DEFAULT 7.5   CHECK (ps_vat_percent BETWEEN 0 AND 50);
-- The platform's own charge on each booking: percent + flat, but never less than the minimum.
ALTER TABLE platform_settings ADD COLUMN charge_percent         NUMERIC(6,3) NOT NULL DEFAULT 2     CHECK (charge_percent BETWEEN 0 AND 50);
ALTER TABLE platform_settings ADD COLUMN charge_flat_kobo       INTEGER      NOT NULL DEFAULT 0     CHECK (charge_flat_kobo BETWEEN 0 AND 100000000);
ALTER TABLE platform_settings ADD COLUMN charge_min_kobo        INTEGER      NOT NULL DEFAULT 5000  CHECK (charge_min_kobo BETWEEN 0 AND 100000000);

-- Per-booking money snapshot, frozen when the booking is made (later setting changes never rewrite history). Zeros on every old row.
ALTER TABLE bookings ADD COLUMN booking_fee_kobo      INTEGER NOT NULL DEFAULT 0 CHECK (booking_fee_kobo >= 0);       -- the customer's share, added to the price at checkout
ALTER TABLE bookings ADD COLUMN ps_fee_est_kobo       INTEGER NOT NULL DEFAULT 0 CHECK (ps_fee_est_kobo >= 0);        -- estimated Paystack fee on the amount charged
ALTER TABLE bookings ADD COLUMN barber_fee_kobo       INTEGER NOT NULL DEFAULT 0 CHECK (barber_fee_kobo >= 0);        -- barber's share of that fee
ALTER TABLE bookings ADD COLUMN platform_charge_kobo  INTEGER NOT NULL DEFAULT 0 CHECK (platform_charge_kobo >= 0);   -- the platform's own charge (pay-now and pay-on-arrival)
ALTER TABLE bookings ADD COLUMN payout_kobo           INTEGER CHECK (payout_kobo >= 0);                               -- pay-now only: price - barber_fee - platform_charge
ALTER TABLE plan_purchases ADD COLUMN booking_fee_kobo     INTEGER NOT NULL DEFAULT 0 CHECK (booking_fee_kobo >= 0);
ALTER TABLE plan_purchases ADD COLUMN ps_fee_est_kobo      INTEGER NOT NULL DEFAULT 0 CHECK (ps_fee_est_kobo >= 0);
ALTER TABLE plan_purchases ADD COLUMN barber_fee_kobo      INTEGER NOT NULL DEFAULT 0 CHECK (barber_fee_kobo >= 0);
ALTER TABLE plan_purchases ADD COLUMN platform_charge_kobo INTEGER NOT NULL DEFAULT 0 CHECK (platform_charge_kobo >= 0);
ALTER TABLE plan_purchases ADD COLUMN payout_kobo          INTEGER CHECK (payout_kobo >= 0);
-- Per payment: the same numbers plus the real Paystack fee once verify reports it. fee_kobo keeps meaning "the platform's own charge".
ALTER TABLE payments ADD COLUMN price_kobo           INTEGER;                       -- price before the booking fee (NULL on old rows)
ALTER TABLE payments ADD COLUMN booking_fee_kobo     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN barber_fee_kobo      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN ps_fee_est_kobo      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN ps_fee_actual_kobo   INTEGER;                       -- what Paystack reported on verify (NULL until then / in mock mode)
ALTER TABLE payments ADD COLUMN payout_kobo          INTEGER;

/* ---------- B: plans tied to services ---------- */
ALTER TABLE plans ADD COLUMN needs_review BOOLEAN NOT NULL DEFAULT FALSE;           -- set when the links were filled in by the system; the barber should check them
ALTER TABLE plan_purchases ADD COLUMN session_value_kobo INTEGER;                   -- price / sessions at purchase time (NULL on old purchases)
-- Old plans with no service link: link every active service of that barber priced at or below the per-session value, and flag for review.
WITH unlinked AS (
  SELECT p.id, p.barber_id, p.price_kobo / p.sessions AS per_session FROM plans p
  WHERE NOT EXISTS (SELECT 1 FROM plan_services ps WHERE ps.plan_id = p.id)
), ins AS (
  INSERT INTO plan_services (plan_id, service_id)
  SELECT u.id, s.id FROM unlinked u JOIN services s ON s.barber_id = u.barber_id AND s.active AND s.price_kobo <= u.per_session
  ON CONFLICT DO NOTHING RETURNING plan_id
)
UPDATE plans SET needs_review = TRUE WHERE id IN (SELECT id FROM unlinked);
-- Same for already-bought plans whose snapshot has no services (they could never be used). Purchases that already have services are untouched.
UPDATE plan_purchases pp SET service_ids = COALESCE((SELECT array_agg(s.id ORDER BY s.id) FROM services s WHERE s.barber_id = pp.barber_id AND s.active AND s.price_kobo <= pp.price_kobo / pp.sessions_total), '{}')
WHERE COALESCE(array_length(pp.service_ids, 1), 0) = 0;

/* ---------- C: barber share links + My barbers ---------- */
ALTER TABLE barbers ADD COLUMN share_code TEXT;
ALTER TABLE barbers ADD COLUMN share_code_rotated_at TIMESTAMPTZ;
UPDATE barbers SET share_code = substr(replace(gen_random_uuid()::text, '-', ''), 1, 12) WHERE share_code IS NULL;
CREATE UNIQUE INDEX uq_barbers_share_code ON barbers (share_code);
-- Which barbers a customer may see and book. added = on their "My barbers" list; a row with added = FALSE just means "opened the link".
CREATE TABLE customer_barbers (
  customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  barber_id   INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  added       BOOLEAN NOT NULL DEFAULT TRUE,
  source      TEXT NOT NULL DEFAULT 'link' CHECK (source IN ('link','booking','favourite')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, barber_id)
);
CREATE INDEX idx_customer_barbers_barber ON customer_barbers (barber_id);
ALTER TABLE customer_barbers ENABLE ROW LEVEL SECURITY;
-- Customers who already booked or favourited a barber keep them.
INSERT INTO customer_barbers (customer_id, barber_id, added, source)
SELECT DISTINCT customer_id, barber_id, TRUE, 'booking' FROM bookings ON CONFLICT DO NOTHING;
INSERT INTO customer_barbers (customer_id, barber_id, added, source)
SELECT customer_id, barber_id, TRUE, 'favourite' FROM favourites ON CONFLICT DO NOTHING;
