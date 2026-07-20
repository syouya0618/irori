-- ============================================================
-- 搾乳間隔（設定）: households.pumping_interval_min を追加
-- ============================================================

-- 「次の搾乳の目安」を最後の搾乳＋この間隔で算出する。世帯ごとに設定変更可能。
-- 既定 180 分（3 時間）。OOTB で目安を表示できるよう NOT NULL DEFAULT にする。
ALTER TABLE households
  ADD COLUMN IF NOT EXISTS pumping_interval_min SMALLINT NOT NULL DEFAULT 180;

ALTER TABLE households DROP CONSTRAINT IF EXISTS chk_pumping_interval_min;
ALTER TABLE households ADD CONSTRAINT chk_pumping_interval_min
  CHECK (pumping_interval_min BETWEEN 30 AND 720);
