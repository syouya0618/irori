-- ============================================================
-- 夫婦の共有カレンダー: calendar_events
-- 設計: 単一テーブル / JST 非正規化 DATE バケット + 時刻付きは TIMESTAMPTZ
--       source(native/google) で mutation を RLS スコープ
--
-- 日付モデル:
--   * start_date / end_date (DATE, NOT NULL, JST 暦日, end は「包含的」):
--       all-day / timed を問わず必ず埋める。月グリッド範囲クエリの主軸。
--       単日は end_date = start_date、多日は end_date > start_date。
--   * is_all_day = true  : start_at / end_at は NULL(終日)
--     is_all_day = false : start_at 必須, end_at は任意
--   * start_date ↔ start_at の整合は書き込み側(Server Action / 同期エンジン)が
--     JST で計算して保証する。AT TIME ZONE は STABLE ゆえ CHECK 化できない。
--
-- Google 同期契約(source='google' 行は将来 service_role で upsert される):
--   * Google API の end.date は「排他的」。本テーブルの end_date は「包含的」。
--     同期エンジンは end.date - 1 日へ変換すること。
--   * start_date / end_date は JST(Asia/Tokyo) で計算すること。
--   * google_event_id / google_calendar_id を必ず設定すること(片方 NULL 不可)。
-- ============================================================
CREATE TABLE calendar_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id       UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,

  title              TEXT NOT NULL,
  memo               TEXT,

  is_all_day         BOOLEAN NOT NULL DEFAULT true,
  start_date         DATE NOT NULL,               -- JST 暦日(バケット)
  end_date           DATE NOT NULL,               -- JST 暦日(包含的)
  start_at           TIMESTAMPTZ,                 -- 時刻付きのみ
  end_at             TIMESTAMPTZ,

  source             TEXT NOT NULL DEFAULT 'native'
                       CHECK (source IN ('native', 'google')),

  -- Google 同期メタ(native 行では NULL。Phase D で subscription_id 等を ALTER 追加)
  google_event_id    TEXT,
  google_calendar_id TEXT,
  etag               TEXT,
  ical_uid           TEXT,

  -- 作成者(native = 作成した配偶者 / google = NULL)。
  -- プロフィール削除で共有予定を巻き込まないよう SET NULL。
  created_by         UUID REFERENCES profiles(id) ON DELETE SET NULL,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_calendar_title CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT chk_calendar_memo CHECK (memo IS NULL OR char_length(memo) <= 1000),
  CONSTRAINT chk_calendar_date_order CHECK (end_date >= start_date),
  CONSTRAINT chk_calendar_all_day CHECK (
    (is_all_day AND start_at IS NULL AND end_at IS NULL)
    OR (NOT is_all_day AND start_at IS NOT NULL)
  ),
  CONSTRAINT chk_calendar_time_order CHECK (
    end_at IS NULL OR (start_at IS NOT NULL AND end_at >= start_at)
  ),
  -- google 行は google_event_id **と google_calendar_id の両方**が NOT NULL。
  -- 片方でも NULL だと下の UNIQUE index が NULLS DISTINCT 既定で一意化せず、
  -- .upsert() が ON CONFLICT を推論できず INSERT に落ちて同期のたび重複が積もる。
  CONSTRAINT chk_calendar_google_meta CHECK (
    source = 'native'
    OR (google_event_id IS NOT NULL AND google_calendar_id IS NOT NULL)
  ),
  -- native 行は google 列を持たない → 通常 UNIQUE index が partial index と同義になる。
  CONSTRAINT chk_calendar_native_no_google CHECK (
    source = 'google' OR (google_event_id IS NULL AND google_calendar_id IS NULL)
  )
);

-- 月グリッド範囲クエリ: household_id = X
--   AND start_date <= grid_end AND end_date >= grid_start(重なり判定)
CREATE INDEX idx_calendar_events_household_range
  ON calendar_events(household_id, start_date, end_date);

-- Google upsert の冪等性。通常 UNIQUE(NULLS DISTINCT 既定)により native 行
-- (NULL, NULL) は無限に共存でき、google 行だけが (household, calendar, event) で
-- 一意化される。PostgREST の on_conflict は列名しか出せないため、partial index では
-- .upsert() が 42P10 で失敗する。通常 UNIQUE + 上の CHECK で partial と同義にする。
CREATE UNIQUE INDEX idx_calendar_events_google_unique
  ON calendar_events(household_id, google_calendar_id, google_event_id);

-- RLS: SELECT / INSERT / UPDATE / DELETE 分離(FOR ALL 禁止)。
-- SELECT は native / google 両方を閲覧可。IUD は source='native' 限定 =
-- ユーザーは同期由来(google)行を anon キー直叩きでも改変・削除できない。
-- UPDATE の WITH CHECK は省略 = Postgres は USING を流用するため、新行も
-- source='native' かつ自世帯に拘束され、google 化・世帯移動は不可。
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "calendar_events_select" ON calendar_events
  FOR SELECT USING (household_id = get_my_household_id());

CREATE POLICY "calendar_events_insert" ON calendar_events
  FOR INSERT WITH CHECK (household_id = get_my_household_id() AND source = 'native');

CREATE POLICY "calendar_events_update" ON calendar_events
  FOR UPDATE USING (household_id = get_my_household_id() AND source = 'native');

CREATE POLICY "calendar_events_delete" ON calendar_events
  FOR DELETE USING (household_id = get_my_household_id() AND source = 'native');

CREATE TRIGGER trg_calendar_events_updated_at
  BEFORE UPDATE ON calendar_events
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Realtime。REPLICA IDENTITY FULL は付けない:
--   Supabase docs: "You can't filter Delete events when tracking Postgres Changes."
--   "When RLS is enabled and replica identity is set to full, the old record
--    contains only the primary key(s)."
--   → DELETE の反映は楽観更新 + visibilitychange refetch で担保する(issue #91)。
ALTER PUBLICATION supabase_realtime ADD TABLE calendar_events;
