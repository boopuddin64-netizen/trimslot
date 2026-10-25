-- 019: revoke all legacy barber share-code aliases.
-- Public share-link resolution now accepts only barbers.share_code; keeping alias rows would be misleading and risks accidental reactivation.
DROP TABLE IF EXISTS barber_share_code_aliases;
