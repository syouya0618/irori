-- ============================================================
-- Phase 2: 育児ログ (Baby Log)
-- 設計: 単一テーブル + 型付きNULLableカラム + CHECK制約
-- ============================================================

-- ============================================================
-- 1. ENUM Types
-- ============================================================

CREATE TYPE baby_log_type AS ENUM (
  'feeding',   -- 授乳・ミルク・離乳食
  'diaper',    -- おむつ交換
  'sleep'      -- 睡眠（開始〜終了）
);

CREATE TYPE feeding_type AS ENUM (
  'breast_left',   -- 母乳（左）
  'breast_right',  -- 母乳（右）
  'bottle',        -- ミルク
  'solid'          -- 離乳食
);

CREATE TYPE diaper_type AS ENUM (
  'pee',   -- おしっこ
  'poop',  -- うんち
  'both'   -- 両方
);

-- ============================================================
-- 2. Table
-- ============================================================

CREATE TABLE baby_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id    UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  log_type        baby_log_type NOT NULL,
  logged_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  logged_by       UUID NOT NULL REFERENCES profiles(id),

  -- 授乳カラム（feeding以外はNULL）
  feeding_type    feeding_type,
  amount_ml       SMALLINT CHECK (amount_ml IS NULL OR amount_ml BETWEEN 0 AND 999),

  -- おむつカラム（diaper以外はNULL）
  diaper_type     diaper_type,

  -- 睡眠カラム（sleep以外はNULL）
  ended_at        TIMESTAMPTZ,

  -- 共通メモ
  memo            TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- CHECK制約: ログタイプと対応カラムの整合性を保証
  CONSTRAINT chk_feeding CHECK (
    log_type != 'feeding' OR feeding_type IS NOT NULL
  ),
  CONSTRAINT chk_diaper CHECK (
    log_type != 'diaper' OR diaper_type IS NOT NULL
  ),
  CONSTRAINT chk_ended_at CHECK (
    ended_at IS NULL OR log_type = 'sleep'
  ),
  CONSTRAINT chk_amount_ml CHECK (
    amount_ml IS NULL OR feeding_type IN ('bottle', 'solid')
  )
);

-- タイムライン取得（世帯×日付降順）
CREATE INDEX idx_baby_logs_household_time
  ON baby_logs(household_id, logged_at DESC);

-- ダッシュボード集計（タイプ別×日付降順）
CREATE INDEX idx_baby_logs_type_time
  ON baby_logs(household_id, log_type, logged_at DESC);

-- 進行中の睡眠セッション検索（partial index）
CREATE INDEX idx_baby_logs_active_sleep
  ON baby_logs(household_id)
  WHERE log_type = 'sleep' AND ended_at IS NULL;

-- 世帯あたり1つのアクティブ睡眠セッションを保証
CREATE UNIQUE INDEX idx_one_active_sleep
  ON baby_logs(household_id)
  WHERE log_type = 'sleep' AND ended_at IS NULL;

-- ============================================================
-- 3. RLS（SELECT/INSERT/UPDATE/DELETE 分離）
-- ============================================================

ALTER TABLE baby_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "baby_logs_select" ON baby_logs
  FOR SELECT USING (household_id = get_my_household_id());

CREATE POLICY "baby_logs_insert" ON baby_logs
  FOR INSERT WITH CHECK (household_id = get_my_household_id());

CREATE POLICY "baby_logs_update" ON baby_logs
  FOR UPDATE USING (household_id = get_my_household_id());

CREATE POLICY "baby_logs_delete" ON baby_logs
  FOR DELETE USING (household_id = get_my_household_id());

-- ============================================================
-- 4. updated_at 自動更新（既存の update_updated_at() を再利用）
-- ============================================================

CREATE TRIGGER trg_baby_logs_updated_at
  BEFORE UPDATE ON baby_logs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- 5. Realtime 有効化
-- ============================================================

ALTER PUBLICATION supabase_realtime ADD TABLE baby_logs;
