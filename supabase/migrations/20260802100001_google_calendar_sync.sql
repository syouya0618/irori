-- ============================================================
-- Google カレンダー同期 (Phase D-1): 3 テーブル新設 + calendar_events ALTER
-- 計画: docs/plans/2026-07-08-childcare-ux-and-shared-calendar.md §7 D-2
--
-- 【calendar_events は CREATE しない】(V4)
--   Phase C の 20260709000002_calendar_events.sql が唯一の定義。ここでは Google
--   同期メタ列を ALTER で足すのみ。Google の description は既存 memo 列へ写す
--   (列を増やさない)。
--
-- 【トークンは暗号化しない】(advisor 裁定・計画書 664 行)
--   Supabase Vault の vault.decrypted_secrets は **grant を持つ者が平文を読める**
--   ため、RLS が正しくとも誤 grant 一つで漏れる。夫婦 2 人の家族専用インスタンス
--   には運用重量が過剰ゆえ、平文カラム + deny-all RLS + service role 限定を採る。
--   アプリ層 AES-256-GCM は鍵管理の同時設計が要るため将来の別 PR とする。
--
-- 【publication に 1 つも足さない】(V7)
--   google_calendar_subscriptions は sync_token / sync_lease_until という秘密を
--   持つ。Realtime に載せると「walrus の列フィルタが秘密を落とすこと」に安全性を
--   賭けることになり、それはローカルで実機検証できぬ。同期完了の通知は
--   last_synced_at のポーリング(D-4)で行う。
--   → 本ファイルに ALTER PUBLICATION は **意図的に存在しない**。
--
-- 【権限は既定に頼らず明示的に REVOKE → GRANT する】
--   実測(2026-08-02, supabase db reset 直後): postgres の default privileges は
--   public スキーマの新規テーブルに対し anon/authenticated へ `Dxtm`
--   (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN)しか与えぬ。一方 hosted では
--   `arwd` が既定で付く前提の設計になっておる(既存テーブルはそれで動いておる)。
--   どちらの環境でも **同じ ACL に収束**させるため、本 migration は各テーブルで
--   「REVOKE ALL FROM anon, authenticated」→「必要な GRANT だけ」を明示する。
--   この ACL は supabase/tests/google_calendar_sync_grants_rls.sql が固定する。
--   service_role からは REVOKE しない(同期エンジンの唯一の書込経路ゆえ)。
-- ============================================================

-- ------------------------------------------------------------
-- 1. google_connections (非機密: 設定カードに出す情報のみ)
-- ------------------------------------------------------------
-- 「誰の Google アカウントが、いま健康か」を持つ。トークンそのものは持たぬ
-- (google_tokens へ分離)ゆえ household の全員が SELECT できてよい。
-- 接続は **ユーザー単位**(夫婦が各自 1 つずつ持つ)。household_id は RLS の
-- スコープ用に非正規化する。
CREATE TABLE google_connections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id      UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  -- 接続した本人。profile 削除で接続とトークンを道連れにする(孤児トークンを残さぬ)。
  user_id           UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- Google の不変 ID (userinfo の `sub`)。email は改名されうるゆえ同一性の鍵はこちら。
  -- ⚠ D-4 への契約: これを得るには OAuth スコープに `openid email` が要る
  --    (calendar.readonly だけでは userinfo が引けぬ)。取れぬ構成にするなら
  --    primary カレンダーの id (= アカウントの email) を代わりに入れること。
  google_account_id TEXT NOT NULL,
  google_email      TEXT NOT NULL,
  -- 恒久失敗(invalid_grant)を UI の再連携導線へつなぐ状態。
  -- 未知値で画面を倒さぬよう、クライアント側は既知値以外を退化表示すること。
  connection_status TEXT NOT NULL DEFAULT 'active'
                      CHECK (connection_status IN ('active', 'needs_reauth')),
  -- 一過性の同期状態(D-5 のエラーモデルが 'error' の一時表示を要求する)。
  sync_status       TEXT NOT NULL DEFAULT 'idle'
                      CHECK (sync_status IN ('idle', 'syncing', 'error')),
  -- 直近の失敗の種別。UI の文言分岐用(恒久/一過性の判断は connection_status が持つ)。
  last_error_kind   TEXT
                      CHECK (last_error_kind IS NULL OR last_error_kind IN
                        ('invalid_grant', 'gone', 'quota', 'network', 'unknown')),
  -- 同期完了シグナル(V7: Realtime を使わずこの列をポーリングして前進を見る)。
  last_synced_at    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_google_connections_email
    CHECK (char_length(btrim(google_email)) BETWEEN 1 AND 320),
  CONSTRAINT chk_google_connections_account
    CHECK (char_length(btrim(google_account_id)) BETWEEN 1 AND 255),
  -- 再連携は同じ Google アカウントの行を上書きする(重複接続を作らぬ)。
  CONSTRAINT uq_google_connections_user_account UNIQUE (user_id, google_account_id),
  -- 下の google_calendar_subscriptions の複合 FK が参照する
  -- (購読の household_id が接続の household_id と食い違うことを DB で禁じるため)。
  CONSTRAINT uq_google_connections_id_household UNIQUE (id, household_id)
);

COMMENT ON TABLE google_connections IS
  'Google カレンダー接続(ユーザー単位・非機密)。トークンは google_tokens へ分離。';

CREATE INDEX idx_google_connections_household
  ON google_connections(household_id);

CREATE TRIGGER trg_google_connections_updated_at
  BEFORE UPDATE ON google_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS: SELECT / DELETE のみ分離定義(FOR ALL 禁止)。
-- **INSERT / UPDATE のポリシーは意図的に作らぬ** = service role だけが書ける。
-- (Postgres は「ポリシーが無い操作」を拒否する。GRANT も併せて与えぬ二段構え。)
ALTER TABLE google_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "google_connections_select" ON google_connections
  FOR SELECT USING (household_id = get_my_household_id());

-- 切断は本人のみ(配偶者の接続を勝手に切れぬ)。
CREATE POLICY "google_connections_delete" ON google_connections
  FOR DELETE USING (user_id = auth.uid());

REVOKE ALL ON public.google_connections FROM anon, authenticated;
GRANT SELECT, DELETE ON public.google_connections TO authenticated;

-- ------------------------------------------------------------
-- 2. google_tokens (機密: deny-all)
-- ------------------------------------------------------------
-- refresh_token は「その Google アカウントのカレンダーを読む鍵」そのもの。
-- RLS を有効にしたうえで **ポリシーを 1 本も作らぬ** = 誰にも行が見えぬ
-- (service_role は BYPASSRLS ゆえ通る)。さらに GRANT も全て剥がす多層防御。
CREATE TABLE google_tokens (
  -- 1 接続 = 1 トークン行。接続削除で必ず道連れ(RI トリガは RLS/GRANT を経由せぬ)。
  connection_id           UUID PRIMARY KEY
                            REFERENCES google_connections(id) ON DELETE CASCADE,
  refresh_token           TEXT NOT NULL,
  access_token            TEXT,
  access_token_expires_at TIMESTAMPTZ,
  -- 実際に同意されたスコープ。calendar.readonly 欠落を検知するため保存する。
  scope                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE google_tokens IS
  'Google OAuth トークン(機密・平文)。RLS 有効かつポリシー 0 本 = deny-all。'
  ' 読み書きは service role のみ。ポリシーを足すな。';

CREATE TRIGGER trg_google_tokens_updated_at
  BEFORE UPDATE ON google_tokens
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE google_tokens ENABLE ROW LEVEL SECURITY;
-- ここにポリシーを書いてはならぬ(deny-all がこのテーブルの設計そのもの)。

REVOKE ALL ON public.google_tokens FROM anon, authenticated;

-- ------------------------------------------------------------
-- 3. google_calendar_subscriptions (混在: 非機密列 + 秘密列)
-- ------------------------------------------------------------
-- Google 側のカレンダー一覧と、その購読 ON/OFF、そして増分同期の状態。
-- sync_token / sync_lease_until は **秘密**(前者は他人のカレンダー差分を引ける
-- 資格、後者は二重同期防止のリース)ゆえ、列 GRANT から外す。
-- profiles の H1-b(20260603000001) と同型の「行 RLS × 列 GRANT」二段防御。
CREATE TABLE google_calendar_subscriptions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id      UUID NOT NULL,
  -- RLS のスコープ用に非正規化。接続と食い違わぬことは下の複合 FK が保証する。
  household_id       UUID NOT NULL,
  google_calendar_id TEXT NOT NULL,
  -- Google のカレンダー表示名。**nullable**(欠落しても同期を落とさぬ fail-soft。
  -- UI は NULL/空なら google_calendar_id へフォールバックすること)。
  summary            TEXT,
  is_selected        BOOLEAN NOT NULL DEFAULT false,
  -- ── 以下 2 列は秘密。authenticated には SELECT / UPDATE とも与えぬ ──
  sync_token         TEXT,
  sync_lease_until   TIMESTAMPTZ,
  -- ── ここまで秘密 ──
  last_synced_at     TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_google_subscriptions_calendar_id
    CHECK (char_length(btrim(google_calendar_id)) BETWEEN 1 AND 1024),
  CONSTRAINT chk_google_subscriptions_summary
    CHECK (summary IS NULL OR char_length(summary) <= 500),
  CONSTRAINT uq_google_subscriptions_connection_calendar
    UNIQUE (connection_id, google_calendar_id),
  -- 複合 FK: 購読の household_id は必ず接続の household_id と一致する。
  -- ON UPDATE CASCADE は、将来 google_connections.household_id が動いた際に
  -- 購読側を追随させるため(profiles.household_id は accept_invitation 等で動く)。
  CONSTRAINT fk_google_subscriptions_connection
    FOREIGN KEY (connection_id, household_id)
    REFERENCES google_connections(id, household_id)
    ON UPDATE CASCADE ON DELETE CASCADE
);

COMMENT ON TABLE google_calendar_subscriptions IS
  'Google カレンダーの購読状態。sync_token / sync_lease_until は秘密ゆえ列 GRANT から除外。'
  ' authenticated から select("*") は 42501 で落ちる — 列を明示して SELECT すること。';

-- V9 のミラー掃除(「他に同一 google_calendar_id を選択中の購読が無いか」)の索引。
CREATE INDEX idx_google_subscriptions_selected
  ON google_calendar_subscriptions(household_id, google_calendar_id)
  WHERE is_selected;

CREATE TRIGGER trg_google_subscriptions_updated_at
  BEFORE UPDATE ON google_calendar_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS: SELECT / UPDATE のみ分離定義(FOR ALL 禁止)。
-- INSERT / DELETE のポリシーは作らぬ(カレンダー一覧の投入・掃除は service role)。
-- UPDATE の行スコープは世帯、列スコープは下の GRANT (is_selected のみ)。
ALTER TABLE google_calendar_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "google_calendar_subscriptions_select" ON google_calendar_subscriptions
  FOR SELECT USING (household_id = get_my_household_id());

CREATE POLICY "google_calendar_subscriptions_update" ON google_calendar_subscriptions
  FOR UPDATE USING (household_id = get_my_household_id());

REVOKE ALL ON public.google_calendar_subscriptions FROM anon, authenticated;
-- SELECT は非機密列のみ(sync_token / sync_lease_until を **列挙から外す**)。
GRANT SELECT (
  id, connection_id, household_id, google_calendar_id,
  summary, is_selected, last_synced_at, created_at, updated_at
) ON public.google_calendar_subscriptions TO authenticated;
-- ユーザーが触ってよいのはトグルだけ。
GRANT UPDATE (is_selected) ON public.google_calendar_subscriptions TO authenticated;

-- ------------------------------------------------------------
-- 4. calendar_events への ALTER (Google 同期メタ)
-- ------------------------------------------------------------
ALTER TABLE calendar_events
  -- V9【データ消失シェイプ】CASCADE にしてはならぬ。
  --   calendar_events の UNIQUE キーは (household_id, google_calendar_id,
  --   google_event_id) = **世帯スコープ**。夫婦が同一の共有 Google カレンダーを
  --   各自購読すると、connection_id は別でも行は 1 つに収斂し、subscription_id は
  --   last-writer のものになる。CASCADE だと片方の購読解除で **もう片方の予定まで
  --   消え**、増分同期(syncToken)は削除を検知せぬため 410 か再連携まで
  --   **永久に復活せぬ**。SET NULL なら行は残り、次のフル/増分同期で
  --   subscription_id が張り直される。
  ADD COLUMN subscription_id    UUID REFERENCES google_calendar_subscriptions(id) ON DELETE SET NULL,
  -- どの配偶者の接続経由で入った行か(表示の出し分け・監査用)。
  ADD COLUMN source_user_id     UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN location           TEXT,
  ADD COLUMN html_link          TEXT,
  -- 繰り返しの親 id(singleEvents=true で展開された各回に付く)。
  ADD COLUMN recurring_event_id TEXT,
  -- Google 側の updated(競合判定・デバッグ用)。
  ADD COLUMN google_updated     TIMESTAMPTZ,
  ADD COLUMN synced_at          TIMESTAMPTZ;

COMMENT ON COLUMN calendar_events.subscription_id IS
  'V9: ON DELETE SET NULL 固定。CASCADE にすると二重購読の片方解除で予定が消え、'
  ' 増分同期のため永久に復活せぬ。supabase/tests/google_calendar_sync_grants_rls.sql が固定。';

-- 410 GONE のフル再同期は subscription_id で当該ミラーを掃除する。
CREATE INDEX idx_calendar_events_subscription
  ON calendar_events(subscription_id)
  WHERE subscription_id IS NOT NULL;

-- 新列は同期エンジン(service role)だけが書く。既存の calendar_events の
-- RLS ポリシー(IUD は source='native' 限定)がそのまま効くため追加のポリシーは不要。
-- publication も触らぬ(V7)。
