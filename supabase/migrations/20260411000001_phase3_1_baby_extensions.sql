-- ============================================================
-- Phase 3.1: フリクション削減 + 育児ログ拡張
-- ============================================================

-- 1. デフォルトページ設定 (profiles)
ALTER TABLE profiles ADD COLUMN default_page TEXT DEFAULT 'meals';

ALTER TABLE profiles ADD CONSTRAINT chk_default_page
  CHECK (default_page IN ('meals', 'shopping', 'stock', 'baby'));

-- 2. baby_log_type ENUM 拡張
-- NOTE: ALTER TYPE ... ADD VALUE はトランザクション内で実行不可。
-- Supabase CLI は各ステートメントを個別に実行するため問題なし。
ALTER TYPE baby_log_type ADD VALUE 'temperature';
ALTER TYPE baby_log_type ADD VALUE 'growth';
ALTER TYPE baby_log_type ADD VALUE 'memo';

-- 3. baby_logs 新カラム
ALTER TABLE baby_logs ADD COLUMN temperature NUMERIC(3,1);
ALTER TABLE baby_logs ADD COLUMN weight_g INTEGER;
ALTER TABLE baby_logs ADD COLUMN height_cm NUMERIC(4,1);
ALTER TABLE baby_logs ADD COLUMN duration_min SMALLINT;

-- 4. CHECK 制約
ALTER TABLE baby_logs ADD CONSTRAINT chk_temperature
  CHECK (log_type != 'temperature' OR temperature IS NOT NULL);
ALTER TABLE baby_logs ADD CONSTRAINT chk_growth
  CHECK (log_type != 'growth' OR (weight_g IS NOT NULL OR height_cm IS NOT NULL));
ALTER TABLE baby_logs ADD CONSTRAINT chk_duration_min
  CHECK (duration_min IS NULL OR (log_type = 'feeding' AND duration_min BETWEEN 0 AND 180));
ALTER TABLE baby_logs ADD CONSTRAINT chk_temperature_range
  CHECK (temperature IS NULL OR temperature BETWEEN 34.0 AND 42.0);
ALTER TABLE baby_logs ADD CONSTRAINT chk_weight_g_range
  CHECK (weight_g IS NULL OR weight_g BETWEEN 0 AND 30000);
ALTER TABLE baby_logs ADD CONSTRAINT chk_height_cm_range
  CHECK (height_cm IS NULL OR height_cm BETWEEN 0.0 AND 150.0);
