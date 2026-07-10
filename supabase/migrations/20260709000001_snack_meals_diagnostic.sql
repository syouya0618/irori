-- ============================================================
-- 「間食(snack)」の不可視データ診断 (2026-07-09)
--
-- meal_type='snack' は以前フォームで選べたが週ビュー(朝昼夕の3枠)に表示されず、
-- UNIQUE(household_id, date, meal_type) と組み合わさって「既に登録されています」の
-- 原因不明エラーを起こしていた。フォームの選択肢を3種に絞る修正と対で、既に作られた
-- snack 行が無いかを検出する。
--
-- ⚠️ データは削除しない。web UI からは表示・削除できないため、存在する場合は
--    運用者が手動で判断する(SELECT で確認 → 必要なら手動 DELETE)。
-- ============================================================
DO $$
DECLARE
  cnt INTEGER;
BEGIN
  SELECT count(*) INTO cnt FROM meals WHERE meal_type = 'snack';
  IF cnt > 0 THEN
    RAISE WARNING
      '[snack-diagnostic] 週ビューに表示されない間食(snack)データが % 件あります。SELECT * FROM meals WHERE meal_type = ''snack''; で確認してください。',
      cnt;
  END IF;
END $$;
