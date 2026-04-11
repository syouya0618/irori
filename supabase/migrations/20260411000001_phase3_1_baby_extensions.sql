-- ============================================================
-- Phase 3.1: フリクション削減 + 育児ログ拡張（パート1: ENUM拡張 + カラム追加）
-- ============================================================

-- 1. デフォルトページ設定 (profiles)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS default_page TEXT DEFAULT 'meals';

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS chk_default_page;
ALTER TABLE profiles ADD CONSTRAINT chk_default_page
  CHECK (default_page IN ('meals', 'shopping', 'stock', 'baby'));

-- 2. baby_log_type ENUM 拡張
-- NOTE: ALTER TYPE ... ADD VALUE はトランザクション外で実行される。
-- 同一トランザクションで新しい値を参照するCHECK制約は次のマイグレーションに分離。
ALTER TYPE baby_log_type ADD VALUE IF NOT EXISTS 'temperature';
ALTER TYPE baby_log_type ADD VALUE IF NOT EXISTS 'growth';
ALTER TYPE baby_log_type ADD VALUE IF NOT EXISTS 'memo';

-- 3. baby_logs 新カラム
ALTER TABLE baby_logs ADD COLUMN IF NOT EXISTS temperature NUMERIC(3,1);
ALTER TABLE baby_logs ADD COLUMN IF NOT EXISTS weight_g INTEGER;
ALTER TABLE baby_logs ADD COLUMN IF NOT EXISTS height_cm NUMERIC(4,1);
ALTER TABLE baby_logs ADD COLUMN IF NOT EXISTS duration_min SMALLINT;
