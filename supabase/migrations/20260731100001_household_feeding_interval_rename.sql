-- ============================================================
-- 授乳間隔（設定）: households.pumping_interval_min → feeding_interval_min へリネーム
--
-- 「次の◯◯の目安」の起点を搾乳（feeding_type='pumped'）から授乳（母乳/ミルク/
-- 離乳食）へ変えたため、設定列の名も実体に合わせる。搾乳は赤子に与えておらず
-- 目安をリセットしない、という契約の DB 側ミラー。
--
-- 値は移行しない（RENAME ゆえ設定済みの分数はそのまま活きる）。
-- CHECK 制約の**式**は RENAME COLUMN が自動追随する（依存式は attnum 参照）が、
-- **制約名**は追随しないため ALTER TABLE ... RENAME CONSTRAINT で揃える。
--
-- 冪等性: RENAME COLUMN / RENAME CONSTRAINT には IF EXISTS が無いため、
-- カタログを見てから実行する（再適用・部分適用済み DB でも落ちない）。
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'households'
      AND column_name = 'pumping_interval_min'
  ) THEN
    ALTER TABLE households
      RENAME COLUMN pumping_interval_min TO feeding_interval_min;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.households'::regclass
      AND conname = 'chk_pumping_interval_min'
  ) THEN
    ALTER TABLE households
      RENAME CONSTRAINT chk_pumping_interval_min TO chk_feeding_interval_min;
  END IF;
END $$;

COMMENT ON COLUMN households.feeding_interval_min IS
  '授乳間隔（分）。最後の授乳の開始 + この間隔を「次の授乳の目安」に表示する（30〜720・既定180）';
