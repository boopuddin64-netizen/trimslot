-- 010: remember whether the payout account name came from the bank lookup (TRUE) or was typed by the barber because the lookup was unavailable (FALSE).
ALTER TABLE barbers ADD COLUMN payout_name_verified BOOLEAN NOT NULL DEFAULT TRUE;
