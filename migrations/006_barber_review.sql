-- 006: barber review workflow. review_status is the source of truth for the workflow; `verified` stays as the fast boolean every query already uses
-- and is kept in sync by a trigger (so the CLI `UPDATE barbers SET verified=...`, tests and old code paths keep working).
ALTER TABLE barbers ADD COLUMN review_status   TEXT NOT NULL DEFAULT 'PENDING' CHECK (review_status IN ('PENDING','NEEDS_INFO','VERIFIED','REJECTED','SUSPENDED'));
ALTER TABLE barbers ADD COLUMN review_reason   TEXT;          -- reason (reject / suspend) or message (needs info), shown to the barber
ALTER TABLE barbers ADD COLUMN reviewed_at     TIMESTAMPTZ;
ALTER TABLE barbers ADD COLUMN resubmit_note   TEXT;          -- what the barber wrote when resubmitting
ALTER TABLE barbers ADD COLUMN resubmitted_at  TIMESTAMPTZ;
UPDATE barbers SET review_status = CASE WHEN verified THEN 'VERIFIED' ELSE 'PENDING' END;
CREATE INDEX idx_barbers_review_status ON barbers (review_status);

CREATE OR REPLACE FUNCTION barbers_sync_review() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.verified AND NEW.review_status = 'PENDING' THEN NEW.review_status := 'VERIFIED'; END IF;
    NEW.verified := (NEW.review_status = 'VERIFIED');
  ELSIF NEW.review_status IS DISTINCT FROM OLD.review_status THEN
    NEW.verified := (NEW.review_status = 'VERIFIED');
  ELSIF NEW.verified IS DISTINCT FROM OLD.verified THEN
    IF NEW.verified THEN NEW.review_status := 'VERIFIED';
    ELSIF OLD.review_status = 'VERIFIED' THEN NEW.review_status := 'SUSPENDED';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER trg_barbers_sync_review BEFORE INSERT OR UPDATE ON barbers FOR EACH ROW EXECUTE FUNCTION barbers_sync_review();
