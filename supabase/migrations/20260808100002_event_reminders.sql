-- ============================================================
-- 予定への通知設定 (B-2)
--
-- 訴え②「予定を希望の時間で通知してほしい」の**設定**の器。配信キューと cron は
-- B-3 で別途足す。本 migration は 1 通も送らぬ。
--
-- ============================================================
-- 【設計の核 ①】通知列を calendar_events に足さぬ
-- ============================================================
--   `calendar_events` の UPDATE ポリシーは **source = 'native' 限定**じゃ
--   (20260709000002 の calendar_events_update)。UI も `isGoogle` で read-only にし、
--   `calendar/actions.ts` が `.eq("source","native")` で二重防御しておる。
--   主は Google カレンダーを取り込んでおり**予定の多くが source='google' 行**ゆえ、
--   そこへ通知を付けられねば機能が半分しか働かぬ。かといって native 限定の不変条件を
--   緩めるのは論外 — 「同期エンジンが google 行の唯一の書き手」という契約が崩れる。
--   → 別テーブル `event_reminders` へ出す。
--   副次的に `CALENDAR_EVENT_COLUMNS` を変えずに済み、それを共有する 4 箇所
--   (calendar/page.tsx, meals/page.tsx, use-month-events.ts, upcoming-events-card.tsx)
--   を巻き込む順序事故 — migration より先にコードが出た瞬間に 4 画面が同時に落ちる —
--   も消える。
--
-- ============================================================
-- 【設計の核 ②】行 id ではなく安定キー (event_uid) で結ぶ
-- ============================================================
--   `src/lib/google/sync.ts` の `resetForFullResync()` は 410 GONE のとき、その購読の
--   `source='google'` 行を **丸ごと DELETE してから入れ直す**。再挿入では新しい UUID が
--   振られる。ゆえに `event_id` を FK にすると:
--     * ON DELETE CASCADE  → 主が付けた通知が 410 のたびに**黙って全滅**
--     * ON DELETE SET NULL → 行は残るが宛先を失い**二度と紐づかぬ**
--   410 は sync_token の失効で日常的に起きる。「静かに消える」設計は出してはならぬ。
--
--   → `calendar_events` に**生成列** `event_uid` を 1 本足し、それをキーにする。
--     google 行は `(google_calendar_id, google_event_id)` が Google 側の同一性ゆえ
--     削除→再挿入をまたいで不変。native 行は id がそのまま不変。式は全て immutable
--     (uuid→text の I/O キャストが STORED 生成列で通ることは実 DB で確認済み)。
--     **生成列は既存コードが SELECT せぬゆえ `CALENDAR_EVENT_COLUMNS` は無変更でよい。**
--
-- ============================================================
-- 【設計の核 ③】FK が無いぶん「孤児」が出る。それが無害である理由を明文化する
-- ============================================================
--   FK を張らぬ以上、予定が本当に消えた後も event_reminders の行は残りうる。
--   **これは安全側の設計であって、B-3 が孤児を勝手に掃除してはならぬ。**
--   理由: 410 の再同期は「DELETE してから INSERT し直す」ゆえ、その**窓の中では
--   全ての google 予定が孤児に見える**。配信ジョブが孤児を削除する実装にすると、
--   410 の最中に走った 1 回で主の通知設定が消し飛ぶ — 核 ② で塞いだ穴を配信側から
--   開け直すことになる。
--
--   孤児は**放っておいても発火せぬ**: 通知の本文はタイトルと日時を要するゆえ、
--   B-3 は必ず `calendar_events` を `(household_id, event_uid)` で join せねば
--   通知を組み立てられぬ。join 相手が無い行は自然に skip される（構造的に不活性）。
--
--   「本物の削除」を知っておるのは削除した当人だけじゃ。ゆえに掃除は削除経路が担う:
--     * native の削除 → `calendar/actions.ts` の deleteCalendarEvent /
--                        deleteCalendarEventSeries が同一 Action 内で掃除する（本 PR）
--     * google の cancelled → `sync.ts` の deleteGoogleRows が担うべきじゃが、
--                        本 PR では同期エンジンへ手を入れぬ（1 PR = 1 関心事）。
--                        **B-3 の申し送り**。resetForFullResync（410）側では
--                        **絶対に掃除してはならぬ** — 上の理由による。
--
-- ============================================================
-- 【設計の核 ④】remind_at は BEFORE トリガが強制導出する
-- ============================================================
--   `calendar_events` には列 GRANT が無く (hosted 既定の arwd)、`event_reminders` も
--   素直に作れば同じになる。「Server Action が導出する」だけでは、**認証済みユーザーが
--   anon キーで PostgREST を直叩きして `remind_at` を任意に書ける**
--   (20260603000001_security_hardening_rls.sql の冒頭が名指しした脅威モデルそのもの)。
--   `remind_at` は `start_at` に依存する導出ゆえ CHECK では書けぬ
--   (AT TIME ZONE は STABLE で、CHECK は IMMUTABLE しか許さぬ)。
--   → 二段で締める:
--     (a) 列 GRANT: authenticated の INSERT/UPDATE 可能列から `remind_at` を外す
--     (b) BEFORE INSERT OR UPDATE トリガがクライアントの値を**無条件に上書き**する
--   (a) が外れても (b) が残る。pgTAP は両方を別々に固定する。
--
-- ============================================================
-- 【設計の核 ⑤】予定が動いたら remind_at も動く
-- ============================================================
--   event_reminders 側の BEFORE トリガだけでは、**予定が動いたときに追随せぬ**。
--   Google 同期は開始時刻の変更を日常的に upsert してくるゆえ、
--   「10分前」に設定した通知が**元の時刻のまま**残る — 核 ② が塞いだ「静かに壊れる」の
--   別型じゃ。→ `calendar_events` 側にも AFTER トリガを置き、start_at / start_date /
--   is_all_day が動いたら対応する reminder の remind_at を引き直す。
--   410 の再挿入 (INSERT) でも引き直すゆえ、「行は生き残ったが時刻は古い」も起きぬ。
--
--   このトリガは **SECURITY DEFINER 必須**じゃ。authenticated は `remind_at` への
--   UPDATE 権限を持たぬゆえ (核 ④(a))、invoker 権限のままでは native 予定の更新が
--   42501 で落ちる — しかも Server Action の単体テストは全て mock ゆえ緑のまま、
--   実アプリでしか出ぬ。
--
-- ============================================================
-- 【Realtime publication へは載せぬ】
-- ============================================================
--   通知設定の増減を他端末へ即時反映する要求は無く、載せれば walrus の負荷だけが増える。
--   → 本ファイルに `ALTER PUBLICATION` は **意図的に存在しない**（明文宣言）。
-- ============================================================


-- ------------------------------------------------------------
-- 1. calendar_events.event_uid — 削除→再挿入をまたぐ安定キー
-- ------------------------------------------------------------
-- STORED 生成列ゆえテーブル書き換えが 1 回走る（この規模では一瞬）。
--
-- ⚠️ **`COALESCE` を外すな。** 素の `a || '|' || b` は片方が NULL なら全体が NULL に
-- なり、NOT NULL 違反（23502）が `chk_calendar_google_meta`（23514）**より先に**
-- 報告される。すると「google 行なのに calendar_id が欠けておる」という V6 の重大な
-- 穴（UNIQUE が効かず同期のたび重複が積もる）が、**誰も知らぬ生成列の not-null
-- エラーに化けて**診断できなくなる。実際 `calendar_events_rls.sql` と
-- `calendar_events_google_row_contract.sql` の 2 本が赤くなって発覚した。
-- COALESCE で NULL を潰しておけば、不正な行は従来どおり CHECK が名前つきで弾く
-- （その行は挿入できぬゆえ、`'|x'` のような値が実在することは無い）。
--
-- NOT NULL が意味を持つ根拠:
--   * google 行: chk_calendar_google_meta が両 google 列の NOT NULL を保証する
--   * native 行: id は PK ゆえ NOT NULL
ALTER TABLE calendar_events
  ADD COLUMN event_uid TEXT NOT NULL
    GENERATED ALWAYS AS (
      CASE WHEN source = 'google'
           THEN COALESCE(google_calendar_id, '') || '|' || COALESCE(google_event_id, '')
           ELSE id::text END
    ) STORED;

COMMENT ON COLUMN calendar_events.event_uid IS
  '削除→再挿入(410 フル再同期)をまたいで不変な同一性キー。google 行は google_calendar_id|google_event_id、native 行は id。event_reminders の結合キー（FK は張らぬ = 核 ②）。区切りの "|" は Google の event id の文字集合(base32hex: a-v, 0-9 と "_")に含まれず、calendar id(メールアドレス形)にも現れぬため単射。';

-- (household_id, event_uid) の一意性。google 側は idx_calendar_events_google_unique が
-- 既に保証しておるが、event_reminders の 1:1 対応と、下の導出関数が「ちょうど 1 行」を
-- 引けることを DB で固定するために明示する。
CREATE UNIQUE INDEX uq_calendar_events_uid
  ON calendar_events(household_id, event_uid);

-- ------------------------------------------------------------
-- 2. derive_event_remind_at — 導出規則の**唯一の実装**
-- ------------------------------------------------------------
-- 2 つのトリガ（event_reminders 側 / calendar_events 側）が共有する。
-- 2 箇所に書けば必ずずれるゆえ、関数 1 本に閉じる。
--
-- 導出規則:
--   * remind_kind='minutes'    : 時刻付き予定なら start_at から逆算。
--                                終日予定なら start_date の **00:00 JST** から逆算
--   * remind_kind='prev_day_20': start_date の **前日 20:00 JST**
--   * 対応する calendar_events 行が無ければ例外（孤児を作らせぬ）
--
-- SECURITY DEFINER + SET search_path = public:
--   RLS を迂回して calendar_events を引くために要る。**世帯スコープは引数の
--   household_id が担う** — 呼び出し側は必ず NEW.household_id を渡し、
--   他世帯の予定を宛先にできぬようにする（RLS の INSERT ポリシーが
--   household_id = get_my_household_id() を強制するため、他世帯の event_uid を
--   指定しても自世帯側で行が見つからず例外になる）。
CREATE OR REPLACE FUNCTION derive_event_remind_at(
  p_household_id UUID,
  p_event_uid    TEXT,
  p_remind_kind  TEXT,
  p_minutes      INTEGER
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_all_day BOOLEAN;
  v_start_date DATE;
  v_start_at   TIMESTAMPTZ;
BEGIN
  SELECT is_all_day, start_date, start_at
    INTO v_is_all_day, v_start_date, v_start_at
    FROM calendar_events
   WHERE household_id = p_household_id
     AND event_uid = p_event_uid;

  IF NOT FOUND THEN
    -- 孤児の新規作成を禁ずる（既存の孤児が「残る」ことは核 ③ のとおり許す）。
    RAISE EXCEPTION 'calendar event not found for reminder (event_uid=%)', p_event_uid
      USING ERRCODE = '23503';
  END IF;

  IF p_remind_kind = 'prev_day_20' THEN
    RETURN (((v_start_date - 1) + TIME '20:00') AT TIME ZONE 'Asia/Tokyo');
  END IF;

  IF p_minutes IS NULL THEN
    -- CHECK 制約と同じ契約の二重防御（CHECK は BEFORE トリガより後に効くため）。
    RAISE EXCEPTION 'remind_minutes_before is required when remind_kind = minutes'
      USING ERRCODE = '23514';
  END IF;

  -- 終日予定は「その日の 00:00 JST」を起点にする（start_at は NULL）。
  IF v_is_all_day OR v_start_at IS NULL THEN
    RETURN (v_start_date::timestamp AT TIME ZONE 'Asia/Tokyo')
           - make_interval(mins => p_minutes);
  END IF;

  RETURN v_start_at - make_interval(mins => p_minutes);
END;
$$;

-- 呼ぶのはトリガ（= owner 権限）だけ。クライアントには一切開かぬ。
REVOKE ALL ON FUNCTION derive_event_remind_at(UUID, TEXT, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. event_reminders
-- ------------------------------------------------------------
-- **世帯単位**（ユーザー単位ではない）。夫が付けた通知は妻にも届く。
-- ゆえに RLS の錨は household_id であり、created_by は「誰が設定したか」の
-- 監査情報に過ぎぬ（配信対象の決定には使わぬ）。
CREATE TABLE event_reminders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- calendar_events.event_uid と対応。**FK は張らぬ**（核 ②）。
  event_uid     TEXT NOT NULL,
  household_id  UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,

  remind_kind   TEXT NOT NULL,
  -- 'minutes' のときのみ非 NULL。SMALLINT ではなく INTEGER なのは意図的
  -- （SMALLINT の上限 32767 < 40320 = 28 日ゆえ、上限 CHECK が到達不能になり、
  --   越えた値は CHECK 違反ではなく 22003 numeric_value_out_of_range で落ちる）。
  remind_minutes_before INTEGER,

  -- **BEFORE トリガが常に導出して上書きする**（核 ④）。クライアントの値は捨てる。
  remind_at     TIMESTAMPTZ NOT NULL,

  -- 誰が設定したか。トリガが auth.uid() で埋めるゆえ列 GRANT からは外す（詐称防止）。
  created_by    UUID REFERENCES profiles(id) ON DELETE SET NULL,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 1 予定 1 通知設定。PostgREST の .upsert({onConflict}) が推論できるよう
  -- **index ではなく constraint** として置く（partial index だと 42P10 で落ちる、
  -- という 20260709000002 の教訓と同根）。
  CONSTRAINT uq_event_reminders_event UNIQUE (household_id, event_uid),

  CONSTRAINT chk_event_reminders_kind
    CHECK (remind_kind IN ('minutes', 'prev_day_20')),
  -- 双方向。'minutes' なら分が要り、'minutes' でなければ分を持ってはならぬ。
  CONSTRAINT chk_event_reminders_minutes_pairing
    CHECK ((remind_kind = 'minutes') = (remind_minutes_before IS NOT NULL)),
  CONSTRAINT chk_event_reminders_minutes_range
    CHECK (remind_minutes_before IS NULL
           OR (remind_minutes_before BETWEEN 0 AND 40320)),
  CONSTRAINT chk_event_reminders_event_uid
    CHECK (char_length(btrim(event_uid)) BETWEEN 1 AND 512)
);

-- 配信ジョブ（B-3）の主クエリ: remind_at <= now() AND 未送信。
CREATE INDEX idx_event_reminders_remind_at ON event_reminders(remind_at);
-- 予定の削除・掃除は世帯 + uid で引く。
CREATE INDEX idx_event_reminders_household_uid
  ON event_reminders(household_id, event_uid);

ALTER TABLE event_reminders ENABLE ROW LEVEL SECURITY;

-- RLS: FOR ALL は使わぬ。SELECT / INSERT / UPDATE / DELETE を分離する。
CREATE POLICY "event_reminders_select" ON event_reminders
  FOR SELECT USING (household_id = get_my_household_id());

CREATE POLICY "event_reminders_insert" ON event_reminders
  FOR INSERT WITH CHECK (household_id = get_my_household_id());

-- WITH CHECK を明示する: 省略すると USING が流用されるが、upsert の
-- ON CONFLICT DO UPDATE で household_id を書き換える経路があるため明示して固定する。
CREATE POLICY "event_reminders_update" ON event_reminders
  FOR UPDATE USING (household_id = get_my_household_id())
             WITH CHECK (household_id = get_my_household_id());

CREATE POLICY "event_reminders_delete" ON event_reminders
  FOR DELETE USING (household_id = get_my_household_id());

-- 権限は既定に頼らず明示する（hosted は arwd 既定・ローカルは Dxtm 既定ゆえ、
-- 両環境で同じ ACL へ収束させる）。
REVOKE ALL ON public.event_reminders FROM anon, authenticated;

-- SELECT は全列可（秘密を持たぬ）。remind_at を読めることは UI の表示に要る。
GRANT SELECT ON public.event_reminders TO authenticated;

-- 書ける列は 4 つだけ。**remind_at / created_by / created_at / updated_at は含めぬ**
-- （remind_at はトリガの領分 = 核 ④、created_by は詐称防止）。
-- INSERT と UPDATE で同じ列集合を与えるのは PostgREST の upsert のためじゃ:
-- `INSERT ... ON CONFLICT DO UPDATE SET <送った列>` を発行するため、UPDATE 側の
-- 列 GRANT が INSERT 側より狭いと衝突時だけ 42501 で落ちる（成功経路では出ぬ罠）。
GRANT INSERT (event_uid, household_id, remind_kind, remind_minutes_before)
  ON public.event_reminders TO authenticated;
GRANT UPDATE (event_uid, household_id, remind_kind, remind_minutes_before)
  ON public.event_reminders TO authenticated;

-- 通知を外す（「なし」に戻す）ために要る。行 RLS が自世帯に限る。
GRANT DELETE ON public.event_reminders TO authenticated;

COMMENT ON TABLE event_reminders IS
  '予定への通知設定（世帯単位・1 予定 1 件）。calendar_events とは event_uid で結び FK は張らぬ（410 フル再同期の DELETE→INSERT を跨ぐため）。remind_at は BEFORE トリガが導出する唯一の真値。';
COMMENT ON COLUMN event_reminders.remind_at IS
  'BEFORE INSERT OR UPDATE トリガが derive_event_remind_at() で導出して上書きする。クライアントの送信値は無条件に捨てられる。';

-- ------------------------------------------------------------
-- 4. event_reminders 側の BEFORE トリガ
-- ------------------------------------------------------------
-- remind_at を強制導出し、created_by / created_at / updated_at を守る。
-- SECURITY DEFINER + SET search_path = public（CLAUDE.md の必須則）。
CREATE OR REPLACE FUNCTION event_reminders_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- service role / postgres からの投入では auth.uid() が NULL ゆえ、
    -- 呼び出し側が明示した値を保つ（COALESCE の向きに意味がある）。
    NEW.created_by := COALESCE(auth.uid(), NEW.created_by);
    NEW.created_at := now();
  ELSE
    -- 監査情報は書き換えさせぬ（upsert の DO UPDATE 経路で最後の編集者に
    -- すり替わるのを防ぐ）。
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  END IF;

  NEW.updated_at := now();

  -- **クライアントが送った remind_at は無条件に捨てる**（核 ④(b)）。
  NEW.remind_at := derive_event_remind_at(
    NEW.household_id, NEW.event_uid, NEW.remind_kind, NEW.remind_minutes_before
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_event_reminders_before_write
  BEFORE INSERT OR UPDATE ON event_reminders
  FOR EACH ROW EXECUTE FUNCTION event_reminders_before_write();

-- ------------------------------------------------------------
-- 5. calendar_events 側の AFTER トリガ — 予定が動いたら通知も動く（核 ⑤）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION calendar_events_sync_remind_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 対応する reminder が無ければ 0 行 UPDATE（安く済む）。
  -- event_reminders 側の BEFORE トリガも走り同じ値を導くが、そちらに委ねず
  -- ここで明示的に導出するのは、将来 BEFORE 側の条件が変わっても
  -- 「calendar_events が動けば remind_at も動く」が壊れぬようにするためじゃ。
  UPDATE event_reminders r
     SET remind_at = derive_event_remind_at(
           r.household_id, r.event_uid, r.remind_kind, r.remind_minutes_before
         )
   WHERE r.household_id = NEW.household_id
     AND r.event_uid = NEW.event_uid;

  RETURN NULL; -- AFTER トリガの戻り値は無視される
END;
$$;

-- INSERT: 410 フル再同期の**入れ直し**で古い remind_at を引き直す。
CREATE TRIGGER trg_calendar_events_sync_remind_at_ins
  AFTER INSERT ON calendar_events
  FOR EACH ROW EXECUTE FUNCTION calendar_events_sync_remind_at();

-- UPDATE: 起点が実際に動いたときだけ。Google 同期は毎回全列を SET してくるゆえ、
-- `UPDATE OF` だけでは同期のたびに空撃ちする。WHEN で値の変化を見る。
CREATE TRIGGER trg_calendar_events_sync_remind_at_upd
  AFTER UPDATE ON calendar_events
  FOR EACH ROW
  WHEN (OLD.start_at   IS DISTINCT FROM NEW.start_at
     OR OLD.start_date IS DISTINCT FROM NEW.start_date
     OR OLD.is_all_day IS DISTINCT FROM NEW.is_all_day)
  EXECUTE FUNCTION calendar_events_sync_remind_at();

-- ------------------------------------------------------------
-- 6. notification_preferences（B-5 の設定カードと B-2 の既定値が使う）
-- ------------------------------------------------------------
-- こちらは**ユーザー単位**じゃ（「わっちは 30 分前が好み」は個人の設定ゆえ）。
-- event_reminders が世帯単位なのと対照的だが、意図的な非対称じゃ:
-- 「いつ通知を出すか」は世帯の合意、「既定でどれを選ぶか」は個人の好み。
CREATE TABLE notification_preferences (
  user_id               UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  -- 予定作成時に既定で選ばれる分数。NULL = 既定は「なし」。
  event_default_minutes INTEGER,
  -- 毎朝ダイジェストの配信時刻。NULL = 無効。
  digest_time           TIME,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_notification_prefs_default_minutes
    CHECK (event_default_minutes IS NULL
           OR (event_default_minutes BETWEEN 0 AND 40320))
);

COMMENT ON COLUMN notification_preferences.digest_time IS
  '⚠️ TZ を持たぬ TIME ゆえ、**JST(Asia/Tokyo) の壁時計時刻として解釈する契約**じゃ。読む側は必ず ''(CURRENT_DATE + digest_time) AT TIME ZONE ''''Asia/Tokyo'''''' の形で timestamptz へ起こすこと。素で now()::time と比べると、TZ=UTC で回る Vercel の cron と DB で **9 時間ずれる**。';
COMMENT ON COLUMN notification_preferences.event_default_minutes IS
  '予定作成時に既定で選ばれる「N 分前」。NULL = 既定なし。UI が提示する値の集合は src/lib/domain/event-reminder.ts の EVENT_REMINDER_MINUTES が正本。';

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

-- SELECT / INSERT / UPDATE を分離して置く（FOR ALL は使わぬ）。
-- **UPDATE を必ず置く**のが要点じゃ: 設定カードから繰り返し編集する表ゆえ、
-- UPDATE を塞ぐと初回 INSERT の後は二度と変えられなくなる（しかも
-- 「保存した気になって変わらぬ」という最も気付きにくい壊れ方をする）。
CREATE POLICY "notification_preferences_select" ON notification_preferences
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "notification_preferences_insert" ON notification_preferences
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "notification_preferences_update" ON notification_preferences
  FOR UPDATE USING (user_id = auth.uid())
             WITH CHECK (user_id = auth.uid());

-- DELETE ポリシーは**意図的に置かぬ**: 設定の解除は NULL を書く UPDATE で足り、
-- 行を消す操作は要らぬ。profiles 削除時は ON DELETE CASCADE が掃除する。

CREATE TRIGGER trg_notification_preferences_updated_at
  BEFORE UPDATE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

REVOKE ALL ON public.notification_preferences FROM anon, authenticated;
GRANT SELECT ON public.notification_preferences TO authenticated;
-- upsert（onConflict=user_id）を通すため INSERT / UPDATE の列集合を揃える。
GRANT INSERT (user_id, event_default_minutes, digest_time)
  ON public.notification_preferences TO authenticated;
GRANT UPDATE (user_id, event_default_minutes, digest_time)
  ON public.notification_preferences TO authenticated;

COMMENT ON TABLE notification_preferences IS
  '通知の個人設定（ユーザー単位）。digest_time は JST 壁時計として解釈する契約（列 COMMENT を見よ）。Realtime publication へは載せぬ。';
