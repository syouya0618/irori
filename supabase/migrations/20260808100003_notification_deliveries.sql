-- ============================================================
-- 配信キュー と 心拍 (B-3)
--
-- 訴え②「予定を希望の時間で通知してほしい」の**配達**の器。B-1 が購読を、
-- B-2 が設定を作った。ここは「時刻が来た通知を実際に届ける」を担う。
--
-- ============================================================
-- 【なぜキューか】撃ちっぱなしは 3 通りに壊れる
-- ============================================================
--   Vercel も pg_cron も「落ちる・重複する」ことを公式に認めておる:
--     * "Cron job delivery is best effort... your function does not execute,
--        and no runtime log is created"
--     * "Vercel will not retry an invocation if a cron job fails."
--     * "Cron delivery can also occasionally invoke the same scheduled run
--        more than once."
--   ゆえに「その瞬間に該当する予定を SELECT して送る」だけの実装は、
--     (1) 取りこぼし  … その 1 回が落ちれば通知は永久に来ぬ
--     (2) 二重起動    … 2 プロセスが同じ予定を送り、2 回鳴る
--     (3) 遅配の雪崩  … 30 分止まった後の 1 回で溜まった通知が全部鳴る
--   の 3 つを同時に抱える。行を先に作って状態機械として扱えば、
--     (1) は次の実行が拾い（catch-up）、
--     (2) は UNIQUE と claim（sent_at への条件付き UPDATE）が殺し、
--     (3) は grace window（期限切れは送らず skipped にする）が止める。
--
--   (3) は Safari 対策でもある。Apple 公式:
--     "Safari doesn't support invisible push notifications. ... If you don't
--      [present immediately], Safari revokes the push notification permission
--      for your site."
--   遅れた通知をまとめて出せば可視通知が雪崩れ、主は権限ごと切る。
--
-- ============================================================
-- 【設計の核 ①】RLS の錨は household_id を**非正規化して持つ**
-- ============================================================
--   世帯スコープを `push_subscriptions` 経由の EXISTS で書いてはならぬ。
--   あちらの SELECT ポリシーは `user_id = auth.uid()` ゆえ、**ポリシー式から
--   参照した先にも RLS が効き**、配偶者の配信行が黙って 0 件になる
--   （「世帯に開いたつもりが自分のみ」の縮退）。しかも 1 人 seed の pgTAP では
--   永久に緑じゃ。→ household_id を列として持ち、それだけを錨にする。
--
-- ============================================================
-- 【設計の核 ②】event_key に FK を張らぬ / subscription_id は SET NULL
-- ============================================================
--   `event_key` は `event_reminders.event_uid` の不変コピーで、FK は張らぬ。
--   410 フル再同期は google 行を DELETE してから入れ直すゆえ、行 id を握ると
--   配信履歴が消える（B-2 の核 ② と同じ筋）。
--
--   `subscription_id` を **ON DELETE CASCADE にしてはならぬ**。端末を 1 台
--   失効させた瞬間にその購読の**過去の sent_at 行が全て消え、`MAX(sent_at)` が
--   過去へ巻き戻る**。設定カードの「最終配信」が古い時刻を指し、主は
--   「通知基盤が死んだ」と誤読する。さらに `skip_reason='gone'` を立てた行が
--   その DELETE で消えるため **'gone' は原理的に一度も観測できぬ**。→ SET NULL。
--
-- ============================================================
-- 【設計の核 ③】⚠️ 一意キーに subscription_id を**入れてはならぬ**
-- ============================================================
--   計画は `UNIQUE NULLS NOT DISTINCT (kind, event_key, subscription_id, dedupe_day)`
--   と書いておったが、**これは核 ② の SET NULL と噛み合わぬ**。実測（ローカル
--   PG 17）:
--     夫の端末と妻の端末に同じ予定の配信行が 1 本ずつ在る（= 夫婦の日常）。
--     1 台目を失効 → その行の subscription_id が NULL になる（ここは通る）。
--     2 台目を失効 → SET NULL が **1 台目の NULL 行と衝突**して 23505 になり、
--     **DELETE そのものが中断する**:
--       ERROR: duplicate key value violates unique constraint "uq"
--       CONTEXT: SQL statement "UPDATE ONLY "public"."t_del" SET "sub_id" = NULL ..."
--   すなわち「この端末の通知をやめる」が恒久的に失敗し、cron 側の 410 掃除も
--   道連れになる。NULLS NOT DISTINCT が正しいからこそ起きる事故じゃ。
--
--   → 冪等キーには **`subscription_key`（購読 id の不変コピー・NOT NULL）** を使い、
--     `subscription_id` は「今も生きておる購読への指し先」に徹させる。
--     event_key を FK 無しのコピーにしたのと**同じ型**の解じゃ。
--     pgTAP `notification_deliveries_rls.sql` の C 群がこの 2 段階 DELETE を撃つ。
--
--   `NULLS NOT DISTINCT` 自体は**外してはならぬ**。既定の NULLS DISTINCT では
--   NULL を含む行が何行でも共存し、`ON CONFLICT DO NOTHING` が効かぬ。
--   B-5 のダイジェスト行は `event_key IS NULL` ゆえ、外した瞬間に
--   **毎朝ダイジェストが 5 分ごとに鳴る**。このリポは同じ罠を
--   20260709000002_calendar_events.sql の chk_calendar_google_meta 周りで
--   既に文書化しておる。PG 17 ゆえ使える（supabase/config.toml: major_version = 17）。
--
-- ============================================================
-- 【設計の核 ④】scheduled_at を一意キーに入れるな / dedupe_day は scheduled_at 由来
-- ============================================================
--   scheduled_at を鍵に入れると「予定の時刻を編集 → remind_at が動く → 別
--   scheduled_at で新行」となり、旧行（未送信・grace 内）と新行の**両方が発火**する。
--
--   逆に `dedupe_day` を「実行した日」から取ってもならぬ。23:58 の通知が失敗し
--   00:04 の実行が拾い直すと**別の日付になって新しい行が生まれ、2 回鳴る**。
--   ゆえに dedupe_day は **scheduled_at の JST 暦日**じゃ（配信ジョブが導出して書く）。
--   CHECK で縛れぬのは `AT TIME ZONE` が STABLE ゆえ（CHECK は IMMUTABLE のみ）。
--
-- ============================================================
-- 【Realtime publication へは載せぬ】
-- ============================================================
--   配信履歴を他端末へ即時反映する要求は無く、載せれば walrus の負荷だけが増える。
--   → 本ファイルに `ALTER PUBLICATION` は **意図的に存在しない**（明文宣言）。
-- ============================================================


-- ------------------------------------------------------------
-- 1. notification_deliveries — 配信キュー兼、配信履歴
-- ------------------------------------------------------------
CREATE TABLE notification_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- **RLS の唯一の錨**（核 ①）。世帯が消えれば履歴も消えてよい。
  household_id    UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,

  -- 'event' = 予定通知（B-3）／'digest' = 毎朝ダイジェスト（B-5 が書く）。
  -- 'digest' を先に許してあるのは、B-5 が CHECK の変更を伴わずに済むようにするため。
  -- 現時点で 'digest' を書く経路は無い。
  kind            TEXT NOT NULL,

  -- `event_reminders.event_uid` の**不変コピー**。FK は張らぬ（核 ②）。
  -- ダイジェスト行は予定 1 件に紐づかぬゆえ NULL。
  event_key       TEXT,

  -- 送り先の購読。**CASCADE 禁止**（核 ②）。失効後も履歴は残す。
  subscription_id UUID REFERENCES push_subscriptions(id) ON DELETE SET NULL,

  -- 冪等キー用の**不変コピー**（核 ③）。subscription_id が NULL に落ちても動かぬ。
  subscription_key TEXT NOT NULL,

  -- scheduled_at の **JST 暦日**（核 ④）。配信ジョブが導出して書く。
  dedupe_day      DATE NOT NULL,

  -- 本来この通知が鳴るべき時刻（= event_reminders.remind_at の写し）。
  scheduled_at    TIMESTAMPTZ NOT NULL,

  -- sent_at は **claim 兼 送信済み印**（route 側のコメントを見よ）。
  sent_at         TIMESTAMPTZ,
  skipped_at      TIMESTAMPTZ,
  skip_reason     TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ⚠️ **この UNIQUE が二重通知を殺す唯一の仕掛けじゃ。**
  -- `NULLS NOT DISTINCT` を外すと B-5 のダイジェスト行（event_key IS NULL）が
  -- 何行でも共存し、`ON CONFLICT DO NOTHING` が効かなくなる（核 ③）。
  -- index ではなく **constraint** として置くのは、PostgREST の
  -- `.upsert({ onConflict })` が推論できる形にするため（partial index だと 42P10。
  -- 20260709000002 の教訓）。
  CONSTRAINT uq_notification_deliveries
    UNIQUE NULLS NOT DISTINCT (kind, event_key, subscription_key, dedupe_day),

  CONSTRAINT chk_notification_deliveries_kind
    CHECK (kind IN ('event', 'digest')),
  -- 予定通知は必ず宛先の予定を持つ。ダイジェストは持たぬ（NULL 可）。
  CONSTRAINT chk_notification_deliveries_event_key
    CHECK (kind <> 'event' OR event_key IS NOT NULL),
  -- ⚠️ **上限を書き足すな。** event_key は `calendar_events.event_uid`（生成列）が
  -- 生む値の受け皿ゆえ、定義域が生成器の値域より狭いと「予定は在るのに配信行だけ
  -- 作れぬ」が恒久的に成立する（B-2 の chk_event_reminders_event_uid と同じ轍）。
  CONSTRAINT chk_notification_deliveries_event_key_len
    CHECK (event_key IS NULL OR char_length(btrim(event_key)) >= 1),
  CONSTRAINT chk_notification_deliveries_subscription_key
    CHECK (char_length(btrim(subscription_key)) >= 1),

  -- 終端は**排他**。410 で握り潰した行が sent_at を持ったままだと
  -- 「最終配信」（MAX(sent_at)）が届いておらぬ通知を届いたと数える。
  CONSTRAINT chk_notification_deliveries_terminal
    CHECK (sent_at IS NULL OR skipped_at IS NULL),
  -- 双方向。理由なき skip も、skip なき理由も許さぬ。
  CONSTRAINT chk_notification_deliveries_skip_pairing
    CHECK ((skipped_at IS NULL) = (skip_reason IS NULL)),
  -- 理由は allowlist。増やすときは配信ジョブ側の型（DeliverySkipReason）と対で足すこと。
  CONSTRAINT chk_notification_deliveries_skip_reason
    CHECK (skip_reason IS NULL
           OR skip_reason IN ('expired', 'event_started', 'gone', 'rescheduled'))
);

-- 配信ジョブの主クエリ: 世帯ごとの「未送信・未 skip」を scheduled_at 順に見る。
-- 期限切れ掃除も同じ形（scheduled_at < now - GRACE）ゆえ 1 本で足りる。
CREATE INDEX idx_notification_deliveries_pending
  ON notification_deliveries(household_id, scheduled_at)
  WHERE sent_at IS NULL AND skipped_at IS NULL;

-- 設定カードの「最終配信」（世帯の MAX(sent_at)）。
CREATE INDEX idx_notification_deliveries_sent
  ON notification_deliveries(household_id, sent_at DESC)
  WHERE sent_at IS NOT NULL;

-- FK 列に索引が無いと、購読 1 件の DELETE が配信履歴の全走査になる。
CREATE INDEX idx_notification_deliveries_subscription
  ON notification_deliveries(subscription_id);

ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;

-- RLS: **SELECT のみ**世帯内に開く。FOR ALL は使わぬ（CLAUDE.md の禁止事項）。
-- INSERT / UPDATE / DELETE のポリシーを**意図的に置かぬ**のがこの表の設計そのもの
-- （書き手は service role の配信ジョブただ 1 つ）。B-1 の push_subscriptions が
-- 「書込は RPC のみ」を無ポリシーで表しておるのと同じ型じゃ。
CREATE POLICY "notification_deliveries_select" ON notification_deliveries
  FOR SELECT USING (household_id = get_my_household_id());

-- 権限は既定に頼らず明示する（hosted は arwd 既定・ローカルは Dxtm 既定ゆえ、
-- 両環境で同じ ACL へ収束させる）。
REVOKE ALL ON public.notification_deliveries FROM anon, authenticated;

-- SELECT は全列可。この表は**能力（送信できる力）を一切持たぬ** —
-- endpoint / p256dh / auth はここに無く、あるのは購読の id と予定の uid だけじゃ。
-- ゆえに B-1 のような列 GRANT は要らぬ（要らぬことを明示しておく）。
GRANT SELECT ON public.notification_deliveries TO authenticated;

COMMENT ON TABLE notification_deliveries IS
  '通知の配信キュー兼履歴。書き手は service role の配信ジョブのみ（IUD ポリシー無し）。冪等キーは (kind, event_key, subscription_key, dedupe_day) の UNIQUE NULLS NOT DISTINCT。';
COMMENT ON COLUMN notification_deliveries.subscription_key IS
  '購読 id の不変コピー。冪等キーはこちらを使う — subscription_id を鍵に入れると ON DELETE SET NULL が 2 台目の失効時に 23505 で DELETE ごと中断させる（migration 冒頭の核 ③・実測済み）。';
COMMENT ON COLUMN notification_deliveries.sent_at IS
  'claim 兼 送信済み印。配信ジョブは `UPDATE ... SET sent_at = now() WHERE id = ? AND sent_at IS NULL` で先に claim してから送る（重複起動の直列化）。ゆえに claim 後・送信前に落ちたその 1 通は恒久喪失する（at-most-once の割り切り）。';
COMMENT ON COLUMN notification_deliveries.dedupe_day IS
  'scheduled_at の JST 暦日。**実行日から取ってはならぬ** — 23:58 の通知を 00:04 が拾い直すと別の日付になり、同じ通知が 2 回鳴る（migration 冒頭の核 ④）。';
COMMENT ON COLUMN notification_deliveries.skip_reason IS
  'expired = grace を過ぎた / event_started = 予定が始まっておった / gone = 購読が 410・404 で失効 / rescheduled = 指しておった通知設定・予定が消えたか別の時刻へ動いた。';

-- ------------------------------------------------------------
-- 2. notification_heartbeat — 1 行だけの心拍
-- ------------------------------------------------------------
-- 「最終配信」（MAX(sent_at)）だけでは**故障と無風を区別できぬ**。送るものが
-- 無かった日も MAX(sent_at) は進まぬゆえ、パイプライン停止と平穏が同じ画面になる。
-- 「いつ走ったか」を別に持つことでしか、その 2 つは分かれぬ。
CREATE TABLE notification_heartbeat (
  -- 1 行しか存在してはならぬ。PK + CHECK で「2 行目」を DB が拒む。
  id            SMALLINT PRIMARY KEY,
  ran_at        TIMESTAMPTZ NOT NULL,
  sent_count    INTEGER NOT NULL,
  skipped_count INTEGER NOT NULL,
  failed_count  INTEGER NOT NULL,

  CONSTRAINT chk_notification_heartbeat_singleton CHECK (id = 1),
  CONSTRAINT chk_notification_heartbeat_counts
    CHECK (sent_count >= 0 AND skipped_count >= 0 AND failed_count >= 0)
);

-- 初期行は**置かぬ**。行が無いこと自体が「まだ一度も走っておらぬ」の正直な表現じゃ
-- （偽の ran_at を置くと、動いておらぬ配信基盤が動いておるように見える）。

ALTER TABLE notification_heartbeat ENABLE ROW LEVEL SECURITY;

-- ⚠️ **ポリシーを書き忘れると RLS 有効 + ポリシー 0 本 = deny-all** になり、
-- 画面が常に空になる（しかも「まだ走っておらぬ」と区別がつかぬ = 最悪の壊れ方）。
-- 世帯を跨ぐ値ではない（配信基盤は 1 つ）ゆえ、認証済みなら誰でも読んでよい。
-- 書き込みポリシーは置かぬ = service role 専用。
CREATE POLICY "notification_heartbeat_select" ON notification_heartbeat
  FOR SELECT USING (auth.uid() IS NOT NULL);

REVOKE ALL ON public.notification_heartbeat FROM anon, authenticated;
GRANT SELECT ON public.notification_heartbeat TO authenticated;

COMMENT ON TABLE notification_heartbeat IS
  '配信ジョブの心拍（1 行固定）。MAX(sent_at) だけでは「故障」と「送るものが無かった」を区別できぬために在る。書き手は service role のみ。Realtime publication へは載せぬ。';
