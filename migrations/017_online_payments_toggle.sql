-- 017: admin-controlled online payment availability. Default ON to preserve existing behaviour after migration.
ALTER TABLE platform_settings ADD COLUMN feature_online_payments BOOLEAN NOT NULL DEFAULT TRUE;
