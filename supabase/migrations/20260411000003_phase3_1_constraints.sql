-- ============================================================
-- Phase 3.1: パート2 — CHECK制約（ENUM拡張後に実行）
-- ============================================================

-- 新しいENUM値を使うCHECK制約は、ADD VALUE と別トランザクションで適用する必要がある
ALTER TABLE baby_logs DROP CONSTRAINT IF EXISTS chk_temperature;
ALTER TABLE baby_logs ADD CONSTRAINT chk_temperature
  CHECK (log_type != 'temperature' OR temperature IS NOT NULL);

ALTER TABLE baby_logs DROP CONSTRAINT IF EXISTS chk_growth;
ALTER TABLE baby_logs ADD CONSTRAINT chk_growth
  CHECK (log_type != 'growth' OR (weight_g IS NOT NULL OR height_cm IS NOT NULL));

ALTER TABLE baby_logs DROP CONSTRAINT IF EXISTS chk_duration_min;
ALTER TABLE baby_logs ADD CONSTRAINT chk_duration_min
  CHECK (duration_min IS NULL OR (log_type = 'feeding' AND duration_min BETWEEN 0 AND 180));

ALTER TABLE baby_logs DROP CONSTRAINT IF EXISTS chk_temperature_range;
ALTER TABLE baby_logs ADD CONSTRAINT chk_temperature_range
  CHECK (temperature IS NULL OR temperature BETWEEN 34.0 AND 42.0);

ALTER TABLE baby_logs DROP CONSTRAINT IF EXISTS chk_weight_g_range;
ALTER TABLE baby_logs ADD CONSTRAINT chk_weight_g_range
  CHECK (weight_g IS NULL OR weight_g BETWEEN 0 AND 30000);

ALTER TABLE baby_logs DROP CONSTRAINT IF EXISTS chk_height_cm_range;
ALTER TABLE baby_logs ADD CONSTRAINT chk_height_cm_range
  CHECK (height_cm IS NULL OR height_cm BETWEEN 0.0 AND 150.0);
