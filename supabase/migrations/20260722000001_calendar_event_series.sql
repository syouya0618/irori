-- ============================================================
-- 繰り返し予定の materialize 方式サポート: calendar_events.series_id
--
-- 設計: 繰り返し予定は「1 行 = 1 開催日」に展開(materialize)して物理保存し、
--       同一シリーズの行を共通の series_id(UUID)で束ねる。月/日表示クエリは
--       既存の start_date/end_date 重なり判定のまま無変更で動く(繰り返し展開の
--       ロジックを表示側に持ち込まない)。シリーズ一括削除は series_id で束ねて
--       DELETE する。
--
-- カラム仕様:
--   * series_id (UUID, NULL 可, FK なし): 単発予定は NULL。繰り返し作成時のみ
--     採番した共通 UUID を全開催日行に付与する。households/profiles への FK は
--     張らない(series は論理グルーピングであり参照整合の対象ではない。
--     household 分離は既存の household_id + RLS が担保する)。
--
-- 既存行への影響: NULL 可の追加のみ。既存の単発予定は series_id = NULL のまま。
-- RLS / CHECK / 既存 index は一切変更しない。
-- ============================================================
ALTER TABLE calendar_events ADD COLUMN series_id UUID;

COMMENT ON COLUMN calendar_events.series_id IS
  '繰り返し予定のシリーズ識別子(UUID)。単発予定は NULL。同一シリーズの各開催日行を束ね、シリーズ一括削除に使う。FK なし・household 分離は household_id + RLS が担保。';

-- シリーズ一括削除(household_id = X AND series_id = Y AND source = native)の
-- 絞り込み用。series_id IS NULL(単発予定)は index に載せない partial index。
CREATE INDEX idx_calendar_events_series
  ON calendar_events(household_id, series_id)
  WHERE series_id IS NOT NULL;
