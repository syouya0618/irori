-- ============================================================
-- 育児日記（ぴよログ流の1日1本テキスト）: baby_diaries
--
-- 設計: 日記は「世帯 × JST 暦日」で一意の自由記述1本（UNIQUE で強制）。
--       タイムラインの記録（baby_logs）とは独立した概念で、memo log_type
--       （タイムライン上の時刻付きメモ）とも別物。日付キーゆえ過去日の
--       日記も作成・編集できる（baby_logs の「当日 now 前提」制約を受けない）。
--       書き込みは upsert（INSERT ... ON CONFLICT (household_id, diary_date)）
--       1経路で、空文字への保存はアプリ側で行 DELETE に落とす（空行を残さない）。
-- ============================================================
CREATE TABLE baby_diaries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  -- JST の暦日バケット（YYYY-MM-DD）。時刻は持たない（1日1本）。
  diary_date    DATE NOT NULL,
  content       TEXT NOT NULL,
  -- 最終更新者（システム自動処理は書かないユーザー操作カラム）。
  updated_by    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_baby_diaries_household_date UNIQUE (household_id, diary_date),
  -- 空日記の行は作らない（消す時はアプリが DELETE する）。上限は日記らしい longform を許す 5000 字。
  CONSTRAINT chk_baby_diaries_content CHECK (char_length(btrim(content)) BETWEEN 1 AND 5000)
);

COMMENT ON TABLE baby_diaries IS
  '育児日記（1世帯・1日につき1本の自由記述）。タイムラインの baby_logs/memo とは独立。';

-- 一覧（日付降順）と upsert の一意判定は UNIQUE 制約の index が担う。
-- 追加 index は不要（household_id, diary_date の複合が唯一のアクセスパターン）。

CREATE TRIGGER trg_baby_diaries_updated_at
  BEFORE UPDATE ON baby_diaries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS: SELECT / INSERT / UPDATE / DELETE 分離（FOR ALL 禁止）。世帯単位で完全分離。
ALTER TABLE baby_diaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "baby_diaries_select" ON baby_diaries
  FOR SELECT USING (household_id = get_my_household_id());

CREATE POLICY "baby_diaries_insert" ON baby_diaries
  FOR INSERT WITH CHECK (household_id = get_my_household_id());

CREATE POLICY "baby_diaries_update" ON baby_diaries
  FOR UPDATE USING (household_id = get_my_household_id());

CREATE POLICY "baby_diaries_delete" ON baby_diaries
  FOR DELETE USING (household_id = get_my_household_id());
