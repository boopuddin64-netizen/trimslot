-- 018: personalized seven-character barber share codes.
-- Preserve each existing code as an alias so previously shared links keep working until the barber regenerates their link.
CREATE TABLE barber_share_code_aliases (
  code TEXT PRIMARY KEY,
  barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO barber_share_code_aliases (code, barber_id)
SELECT share_code, id FROM barbers WHERE share_code IS NOT NULL
ON CONFLICT (code) DO NOTHING;

-- Convert existing primary codes to SHOP-prefix + four random hexadecimal characters.
-- Retry candidates against both current codes and legacy aliases to guarantee uniqueness.
DO $$
DECLARE
  r RECORD;
  prefix TEXT;
  candidate TEXT;
  attempt INTEGER;
BEGIN
  FOR r IN SELECT id, shop_name FROM barbers ORDER BY id LOOP
    prefix := left(lpad(COALESCE(NULLIF(regexp_replace(upper(r.shop_name), '[^A-Z0-9]', '', 'g'), ''), 'SHP'), 3, 'X'), 3);
    attempt := 0;
    LOOP
      candidate := prefix || left(upper(md5(random()::text || clock_timestamp()::text || r.id::text || attempt::text)), 4);
      EXIT WHEN NOT EXISTS (SELECT 1 FROM barbers b WHERE b.share_code = candidate AND b.id <> r.id)
        AND NOT EXISTS (SELECT 1 FROM barber_share_code_aliases a WHERE a.code = candidate);
      attempt := attempt + 1;
      IF attempt > 1000 THEN RAISE EXCEPTION 'Unable to generate unique share code for barber %', r.id; END IF;
    END LOOP;
    UPDATE barbers SET share_code = candidate WHERE id = r.id;
  END LOOP;
END $$;
