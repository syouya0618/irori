-- ============================================================
-- 授乳: 秒精度の記録時間 duration_sec を追加
-- ============================================================

-- 従来 duration_min（分単位）でのみ保存していた授乳時間を、秒精度でも残せるようにする。
-- duration_min は後方互換（Flutter・既存集計・timeline 表示が参照）のため round(sec/60)
-- で併記し続ける。書き込みは recordFeeding の1経路に集約して両列の drift を防ぐ。
-- ENUM に依存しないため単一マイグレーションでよい。
ALTER TABLE baby_logs ADD COLUMN IF NOT EXISTS duration_sec SMALLINT;

ALTER TABLE baby_logs DROP CONSTRAINT IF EXISTS chk_duration_sec;
ALTER TABLE baby_logs ADD CONSTRAINT chk_duration_sec
  CHECK (duration_sec IS NULL OR (log_type = 'feeding' AND duration_sec BETWEEN 0 AND 10800));
