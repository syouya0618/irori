-- ============================================================
-- 予定の用途（ごみの日）と前日通知の既定  — 家事機能 A
--
-- ■ 何を足すか
--   1. 表 `public.event_purposes`
--        予定の「用途」を、予定の本体（calendar_events）とは別の表に持つ。
--        出どころ（native / google）と用途（通常 / ごみ）は別の軸じゃ。
--   2. RPC `public.save_event_purpose(...)`
--        分類・変更・この回だけ通常へ戻す・解除と、その時に利用者が選んだ通知の扱いを
--        1 トランザクションで書く唯一の入口。
--   3. RPC `public.delete_orphan_event_purpose(p_id)`
--        予定が見つからなくなった分類を、利用者が手で片付ける入口。
--   4. RPC `public.cleanup_deleted_event_purposes(p_event_ids, p_series_id)`
--        利用者が native の予定を削除した直後に、その予定の分類を片付ける入口。
--   5. トリガ 3 本（下の「通知との接続」）
--
-- ■ なぜ別表か / なぜ行 id で結ばぬか（event_reminders と同じ理由）
--   * `calendar_events` の UPDATE ポリシーは source='native' 限定。列を足しても
--     Google 由来の予定（ごみの日を Google カレンダーで管理する家庭は多い）へ付けられぬ。
--   * Google の 410 完全再同期は、その購読の google 行を **DELETE してから INSERT し直す**
--     （行 id が変わる）。行 id の FK で結ぶと、CASCADE なら分類が黙って全滅し、
--     SET NULL なら二度と紐づかぬ。
--   → 再同期をまたいで不変な鍵で結び、**FK は張らぬ**:
--        scope='event'  … `calendar_events.event_uid`（1 回の予定。シリーズの単回例外も）
--        scope='series' … native は `series_id::text`、google は
--                         `google_calendar_id || '|' || recurring_event_id`（シリーズ既定）
--     scope を鍵に含めるのは、native の `series_id` が初回の行の id（= その行の
--     event_uid）と同じ値になりうるためじゃ（同じ鍵空間に置くと衝突する）。
--   * `target_key` に長さの上限は付けぬ（Google の event id は最大 1024 文字。
--     `chk_event_reminders_event_uid` が上限を外した経緯と同じ）。
--
-- ■ 解決の順（画面側 `src/lib/domain/garbage.ts` の resolveEventPurpose と対）
--     event 行の purpose が非 NULL ならそれ（'normal' = この回だけ通常へ戻す例外）
--     → series 行 → 未分類
--
-- ■ 通知との接続（新しい cron・新しい通知種別は足さぬ。既存 event_reminders へ繋ぐ）
--   `event_reminders` は「OFF = 行の DELETE」ゆえ、未設定と明示 OFF を区別できぬ。
--   真値はこの表に持つ:
--     series 行の `remind_default`  … 'prev_day_20'（前日 20:00 JST を既定で付ける）/ 'none'
--     event 行の `reminder_opt_out` … この回の通知を明示的に止めた印
--   「シリーズ全体を止めた」と「この回だけ止めた」は別の操作として記録する:
--     シリーズ全体 … series 行の `remind_default = 'none'`（回ごとの印は作らぬ）。
--                    後でシリーズを前日通知へ戻せば、今日以降の回へ一様に付く
--     この回だけ   … event 行の `reminder_opt_out = true`。シリーズを前日通知へ戻しても付けぬ
--   トリガ:
--     (a) calendar_events AFTER INSERT / AFTER UPDATE OF start_date … 既定 ON のシリーズへ
--         後から入った「今日以降」の回、過ぎた日から今日以降へ動いた回に、前日 20:00 の通知を
--         足す（Google 同期で後から届く回・410 後の入れ直し・振替を含む）
--     (b) event_reminders AFTER DELETE（文単位）… ごみに分類したシリーズの回の通知が消された時、
--         1 文で同じシリーズの今日以降の 2 回以上が消されたなら「シリーズ全体の停止」として
--         series 行の既定を 'none' にし、1 回だけなら `reminder_opt_out` を立てる
--         （これで 410 の入れ直しが明示 OFF を上書きせぬ）
--     (c) event_reminders AFTER INSERT … 通知が付け直されたら `reminder_opt_out` を降ろす
--
-- ■ 変えぬもの
--   * `calendar_events` / `event_reminders` の列・CHECK・ポリシー・GRANT、`derive_event_remind_at`、
--     配信（notification_deliveries / cron）には一切触れぬ。二重送信の防止は既存のまま
--     （`uq_event_reminders_event` = 1 予定 1 通知設定、`uq_notification_deliveries`）。
--   * 既に在る通知設定の時刻は書き換えぬ（足す時は必ず ON CONFLICT DO NOTHING）。
--   * トリガは**既存の書込を失敗させぬ**: 対象外の行は早期 return（健診・予防接種の予定 =
--     medical_record_id 付きは無視、今日(JST)より前の回には足さぬ）。書込そのものは
--     例外ブロックで包み、万一の失敗は WARNING に落として予定の保存・Google 同期・
--     通知の解除を止めぬ。
--   * `shared_child_snapshot` に触れぬ・`child_shares` を述語に登場させぬ
--     （子どもだけの閲覧招待へ家事を公開せぬ）。
--   * Realtime publication へは載せぬ（他端末の変更は画面へ戻った時の再取得で回収する）。
--
-- ■ 掃除の条件（分類の行を消すのは次の 2 つだけ）
--   (1) 利用者の解除（save_event_purpose の p_action='clear'）
--   (2) 利用者による予定・シリーズの削除（cleanup_deleted_event_purposes。native のみ）
--   同期の 410 経路・配信経路では**消さぬ**（410 の窓では全ての google 予定が一時的に
--   見えなくなる。そこで掃除すると分類が全滅する）。予定が見つからぬ分類は、ごみの画面が
--   「予定が見つかりません（同期中の可能性があります）」として出し、利用者が
--   delete_orphan_event_purpose で片付ける（予定が 1 つでも在れば消さぬ）。
--
-- ■ 権限
--   authenticated は SELECT のみ（世帯の正規メンバーだけ）。書込は SECURITY DEFINER の RPC だけ。
--   世帯 id は引数で受けず auth.uid() から導く。anon には表も関数も開かぬ。
-- ============================================================


-- ------------------------------------------------------------
-- 1. シリーズの鍵（SQL 側の唯一の実装。TS 側の写しは garbage.ts の seriesKeyOf）
-- ------------------------------------------------------------
-- native: series_id の text / google: google_calendar_id|recurring_event_id / 単発は NULL。
-- 区切りの '|' は calendar_events.event_uid と同じ規約。
CREATE FUNCTION irori_private.event_series_key(
  p_source text,
  p_series_id uuid,
  p_google_calendar_id text,
  p_recurring_event_id text
) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN p_source = 'google' THEN
      CASE
        WHEN p_recurring_event_id IS NULL OR p_recurring_event_id = '' THEN NULL
        ELSE COALESCE(p_google_calendar_id, '') || '|' || p_recurring_event_id
      END
    ELSE p_series_id::text
  END;
$$;
REVOKE ALL ON FUNCTION irori_private.event_series_key(text, uuid, text, text)
  FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- 2. event_purposes
-- ------------------------------------------------------------
CREATE TABLE public.event_purposes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id     uuid NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,

  -- 'series' = シリーズ既定 / 'event' = 1 回の予定（単発の分類・シリーズの単回例外・通知の明示 OFF）
  scope            text NOT NULL,
  -- calendar_events と結ぶ鍵。**FK は張らぬ**（冒頭の理由）。長さの上限も付けぬ。
  target_key       text NOT NULL,

  -- 'garbage' / 'normal'（この回だけ通常へ戻す）/ NULL（用途は持たず、通知の明示 OFF だけを持つ行）
  purpose          text,
  -- ごみの名称（「燃えるごみ」等。利用者が選ぶ・入力する 1〜20 文字）
  garbage_kind     text,
  -- series だけが持つ。今後の回へ前日 20:00 の通知を既定で付けるか
  remind_default   text,
  -- event だけが意味を持つ。この回の通知を明示的に止めた印
  reminder_opt_out boolean NOT NULL DEFAULT false,

  created_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),

  -- index ではなく constraint で置く（ON CONFLICT ON CONSTRAINT で名指しする）
  CONSTRAINT uq_event_purposes_target UNIQUE (household_id, scope, target_key),

  CONSTRAINT chk_event_purposes_scope CHECK (scope IN ('series', 'event')),
  -- ⚠️ 上限を書き足すな（Google の event id は最大 1024 文字）
  CONSTRAINT chk_event_purposes_target_key CHECK (char_length(btrim(target_key)) >= 1),
  CONSTRAINT chk_event_purposes_purpose
    CHECK (purpose IS NULL OR purpose IN ('garbage', 'normal')),
  -- 双方向: ごみなら名称が要り、ごみでなければ名称を持ってはならぬ
  CONSTRAINT chk_event_purposes_kind_pairing
    CHECK ((purpose IS NOT DISTINCT FROM 'garbage') = (garbage_kind IS NOT NULL)),
  CONSTRAINT chk_event_purposes_kind_text
    CHECK (garbage_kind IS NULL
           OR (garbage_kind = btrim(garbage_kind) AND char_length(garbage_kind) BETWEEN 1 AND 20)),
  CONSTRAINT chk_event_purposes_remind_default
    CHECK (remind_default IS NULL OR remind_default IN ('prev_day_20', 'none')),
  -- series 行は必ず「ごみ」で、通知の既定を持つ（通常へ戻す既定は行を消すことで表す）
  CONSTRAINT chk_event_purposes_series_shape
    CHECK (scope <> 'series'
           OR (purpose IS NOT DISTINCT FROM 'garbage'
               AND remind_default IS NOT NULL
               AND NOT reminder_opt_out)),
  -- event 行は通知の既定を持たず、用途か明示 OFF のどちらかを必ず持つ（意味の無い行を残さぬ）
  CONSTRAINT chk_event_purposes_event_shape
    CHECK (scope <> 'event'
           OR (remind_default IS NULL AND (purpose IS NOT NULL OR reminder_opt_out)))
);

COMMENT ON TABLE public.event_purposes IS
  '予定の用途（ごみの日）と前日通知の既定。calendar_events とは event_uid / シリーズの鍵で結び FK は張らぬ（Google の 410 完全再同期の DELETE→INSERT を跨ぐため）。書込は save_event_purpose 等の RPC だけ。行を消すのは利用者の解除・予定の削除・手動の整理だけで、同期や配信の経路では消さぬ。';
COMMENT ON COLUMN public.event_purposes.target_key IS
  'scope=event は calendar_events.event_uid、scope=series は native の series_id::text または google の google_calendar_id|recurring_event_id。長さの上限は付けぬ。';
COMMENT ON COLUMN public.event_purposes.remind_default IS
  'series 行だけが持つ。prev_day_20 = 今日以降の回へ前日 20:00 JST の通知を既定で付ける / none = 付けぬ。';
COMMENT ON COLUMN public.event_purposes.reminder_opt_out IS
  'event 行だけが意味を持つ。この回の通知を明示的に止めた印（event_reminders は OFF を行の DELETE で表すため、未設定と区別する真値をここに持つ）。';

ALTER TABLE public.event_purposes ENABLE ROW LEVEL SECURITY;

-- 既定の権限に頼らず、両環境で同じ ACL へ収束させる。
REVOKE ALL ON public.event_purposes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.event_purposes TO authenticated;
GRANT ALL ON public.event_purposes TO service_role;

-- 読めるのは世帯の正規メンバー（owner / member・承認済み）だけ。viewer（子どもだけの閲覧招待）と
-- 別世帯は 0 行。INSERT / UPDATE / DELETE は GRANT もポリシーも置かぬ = 直接の書込は拒否。
CREATE POLICY event_purposes_select ON public.event_purposes
  FOR SELECT TO authenticated
  USING (irori_private.is_household_editor(household_id));


-- ------------------------------------------------------------
-- 3. 内部ヘルパ: その鍵を持つ予定が世帯に 1 つも無いか（整理の門）
-- ------------------------------------------------------------
CREATE FUNCTION irori_private.event_purpose_is_orphan(
  p_household_id uuid,
  p_scope text,
  p_target_key text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN p_scope = 'event' THEN NOT EXISTS (
      SELECT 1 FROM public.calendar_events c
       WHERE c.household_id = p_household_id AND c.event_uid = p_target_key)
    WHEN p_scope = 'series' THEN NOT EXISTS (
      SELECT 1 FROM public.calendar_events c
       WHERE c.household_id = p_household_id
         AND irori_private.event_series_key(
               c.source, c.series_id, c.google_calendar_id, c.recurring_event_id) = p_target_key)
    -- 未知の scope は「孤児ではない」（= 消さぬ側）へ倒す
    ELSE false
  END;
$$;
REVOKE ALL ON FUNCTION irori_private.event_purpose_is_orphan(uuid, text, text)
  FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- 4. save_event_purpose — 分類と通知の扱いを書く唯一の入口
-- ------------------------------------------------------------
-- 引数:
--   p_event_id     … 操作の起点にした予定の行 id。鍵（event_uid / シリーズの鍵）は**サーバが引く**
--   p_scope        … 'event'（この回だけ）/ 'series'（シリーズ全体。繰り返しの回からだけ選べる）
--   p_action       … 'garbage'（ごみにする・名称を変える）
--                    'normal' （この回だけ通常の予定へ戻す。event のみ。シリーズ既定が在る時だけ意味を持つ）
--                    'clear'  （分類を解除 = 行を消す。event なら単回例外の取り消し = シリーズ既定へ戻る）
--   p_garbage_kind … 'garbage' の時だけ。前後の空白を除いて 1〜20 文字
--   p_reminder     … 今回の保存で通知をどう扱うか（フォームに明示した選択）
--                    'prev_day_20' 通知が未設定の回へ前日 20:00 JST を足す。**設定済みの回は変えぬ**。
--                                  series なら今日以降の全ての回へ（明示 OFF の回と通常へ戻した回は除く）
--                                  かつ今後入ってくる回にも付ける（remind_default）
--                    'off'         通知を消す。event はその回、series は今日以降の全ての回
--                    'keep'        通知設定に触れぬ
--   p_seen_series  … 画面がこの操作を組んだ時に見ておった series 行の版（`updated_at`）。
--                    行が無かった（未分類・単発）なら NULL
--   p_seen_event   … 同じく event 行（この回だけの分類・通知の明示 OFF の行）の版。無ければ NULL
-- 戻り値: { status: 'saved' | 'replayed' | 'conflict', purpose: <対象の行> | null }
--   saved    … 今回の要求で何かを書いた（分類の行、または通知設定の追加・削除）
--   replayed … 同じ内容が既に保存済みだった（応答を失った再送。分類も通知も 1 行も書いておらぬ）
--   conflict … 何も書いておらぬ。次のどちらか:
--              * 'normal' を求めたが、シリーズ既定が既に無い（別の端末が先に解除した）
--              * 画面が見ておった版と今の版が違い、かつ適用すると何かが変わる
--                （別の端末が先に分類・通知の既定を変えた。古い画面・古い控えの再送で、
--                  家族の新しい分類と通知を黙って消さぬ）。purpose は今の行
-- 版の照合:
--   * series の操作は series 行の版だけ、event の操作は series 行と event 行の両方を比べる
--   * 版が違っても、求める状態が既に成り立っておれば replayed（応答を失った自分の再送は、
--     自分の最初の送信で版が進んでおる。それを conflict と言わぬ）。「適用すると何かが変わるか」は
--     実際に適用して確かめ、変わったなら subtransaction ごと巻き戻す
--   * 同時操作は advisory lock で直列になる（鍵ごとに 1 行 = UNIQUE）
CREATE FUNCTION public.save_event_purpose(
  p_event_id uuid,
  p_scope text,
  p_action text,
  p_garbage_kind text,
  p_reminder text,
  p_seen_series timestamptz,
  p_seen_event timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  h            uuid;
  ev           public.calendar_events;
  v_series_key text;
  v_kind       text;
  v_today      date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  series_row   public.event_purposes;
  series_found boolean := false;
  event_row    public.event_purposes;
  event_found  boolean := false;
  out_row      public.event_purposes;
  out_exists   boolean := false;
  changed      boolean := false;
  stale        boolean := false;
  new_default  text;
  new_purpose  text;
  new_opt_out  boolean;
  n            integer;
BEGIN
  -- ① 認可（世帯は引数で受けぬ）
  SELECT household_id INTO h FROM public.profiles WHERE id = auth.uid();
  IF h IS NULL OR NOT irori_private.is_household_editor(h) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;

  -- ② 入力の検証
  IF p_event_id IS NULL
     OR p_scope IS NULL OR p_scope NOT IN ('series', 'event')
     OR p_action IS NULL OR p_action NOT IN ('garbage', 'normal', 'clear')
     OR p_reminder IS NULL OR p_reminder NOT IN ('prev_day_20', 'off', 'keep')
     OR (p_action = 'normal' AND p_scope <> 'event')
     OR (p_action = 'clear' AND p_reminder = 'prev_day_20')
  THEN
    RAISE EXCEPTION 'invalid event purpose input' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'garbage' THEN
    v_kind := btrim(p_garbage_kind);
    IF v_kind IS NULL OR char_length(v_kind) NOT BETWEEN 1 AND 20 THEN
      RAISE EXCEPTION 'invalid garbage kind' USING ERRCODE = '22023';
    END IF;
  ELSIF p_garbage_kind IS NOT NULL THEN
    RAISE EXCEPTION 'garbage kind is only for garbage' USING ERRCODE = '22023';
  END IF;

  -- ③ 起点の予定を自世帯から引く（別世帯の id・存在せぬ id は同じ応答 = 存在を漏らさぬ）
  SELECT * INTO ev FROM public.calendar_events WHERE id = p_event_id AND household_id = h;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'event unavailable' USING ERRCODE = '42501';
  END IF;
  -- 健診・予防接種の予定は医療記録の側で管理する（ここからは分類せぬ）
  IF ev.medical_record_id IS NOT NULL THEN
    RAISE EXCEPTION 'medical events cannot be classified' USING ERRCODE = '22023';
  END IF;
  v_series_key := irori_private.event_series_key(
    ev.source, ev.series_id, ev.google_calendar_id, ev.recurring_event_id);
  IF p_scope = 'series' AND v_series_key IS NULL THEN
    RAISE EXCEPTION 'event is not part of a series' USING ERRCODE = '22023';
  END IF;

  -- ④ 同じシリーズ（単発は同じ予定）への操作を直列にし、待った後で認可と予定を読み直す
  PERFORM pg_advisory_xact_lock(
    hashtextextended('event-purpose:' || h::text || ':' || COALESCE(v_series_key, ev.event_uid), 0));
  IF NOT irori_private.is_household_editor(h) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO ev FROM public.calendar_events WHERE id = p_event_id AND household_id = h;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'event unavailable' USING ERRCODE = '42501';
  END IF;

  IF v_series_key IS NOT NULL THEN
    SELECT * INTO series_row FROM public.event_purposes
     WHERE household_id = h AND scope = 'series' AND target_key = v_series_key
       FOR UPDATE;
    series_found := FOUND;
  END IF;
  SELECT * INTO event_row FROM public.event_purposes
   WHERE household_id = h AND scope = 'event' AND target_key = ev.event_uid
     FOR UPDATE;
  event_found := FOUND;

  -- ⑤ 画面が見ておった版と今の版（行が無ければどちらも NULL）
  stale := (CASE WHEN series_found THEN series_row.updated_at END) IS DISTINCT FROM p_seen_series
           OR (p_scope = 'event'
               AND (CASE WHEN event_found THEN event_row.updated_at END) IS DISTINCT FROM p_seen_event);

  -- ⑥ 適用する。版が違い、かつ何かが変わった時は、このブロックごと巻き戻して conflict を返す
  BEGIN
  IF p_scope = 'series' THEN
    -- ══════════ シリーズ全体 ══════════
    IF p_action = 'garbage' THEN
      new_default := CASE p_reminder
        WHEN 'prev_day_20' THEN 'prev_day_20'
        WHEN 'off' THEN 'none'
        -- keep: 既に在る既定はそのまま。新しく分類する時は「付けぬ」から始める
        ELSE COALESCE(series_row.remind_default, 'none')
      END;
      IF NOT series_found THEN
        INSERT INTO public.event_purposes(
          household_id, scope, target_key, purpose, garbage_kind, remind_default, created_by)
        VALUES (h, 'series', v_series_key, 'garbage', v_kind, new_default, auth.uid())
        RETURNING * INTO series_row;
        changed := true;
      ELSIF (series_row.garbage_kind, series_row.remind_default)
              IS DISTINCT FROM (v_kind, new_default) THEN
        UPDATE public.event_purposes
           SET garbage_kind = v_kind, remind_default = new_default, updated_at = clock_timestamp()
         WHERE id = series_row.id
        RETURNING * INTO series_row;
        changed := true;
      END IF;
      out_row := series_row;
      out_exists := true;
    ELSE
      -- clear: シリーズ既定を消す。**通知を消すより先に**消す（下の DELETE で (b) のトリガが
      -- 全ての回へ明示 OFF を立てぬように）。
      IF series_found THEN
        DELETE FROM public.event_purposes WHERE id = series_row.id;
        changed := true;
        -- シリーズ既定が無くなれば「この回だけ通常へ戻す」例外は意味を失う。今在る回のぶんを畳む
        -- （通知の明示 OFF の印は残す。再びシリーズを分類した時に OFF が上書きされぬよう）。
        DELETE FROM public.event_purposes x
         WHERE x.household_id = h AND x.scope = 'event' AND x.purpose = 'normal'
           AND NOT x.reminder_opt_out
           AND x.target_key IN (
             SELECT c.event_uid FROM public.calendar_events c
              WHERE c.household_id = h
                AND irori_private.event_series_key(
                      c.source, c.series_id, c.google_calendar_id, c.recurring_event_id) = v_series_key);
        UPDATE public.event_purposes x
           SET purpose = NULL, updated_at = clock_timestamp()
         WHERE x.household_id = h AND x.scope = 'event' AND x.purpose = 'normal'
           AND x.reminder_opt_out
           AND x.target_key IN (
             SELECT c.event_uid FROM public.calendar_events c
              WHERE c.household_id = h
                AND irori_private.event_series_key(
                      c.source, c.series_id, c.google_calendar_id, c.recurring_event_id) = v_series_key);
      END IF;
    END IF;

    -- 通知（今日以降の回だけ。過ぎた回には触れぬ）
    IF p_reminder = 'prev_day_20' THEN
      INSERT INTO public.event_reminders(
        household_id, event_uid, remind_kind, remind_minutes_before, created_by)
      SELECT h, c.event_uid, 'prev_day_20', NULL, auth.uid()
        FROM public.calendar_events c
       WHERE c.household_id = h
         AND irori_private.event_series_key(
               c.source, c.series_id, c.google_calendar_id, c.recurring_event_id) = v_series_key
         AND c.start_date >= v_today
         AND c.medical_record_id IS NULL
         -- 明示 OFF の回と、この回だけ通常へ戻した回には足さぬ
         AND NOT EXISTS (
           SELECT 1 FROM public.event_purposes x
            WHERE x.household_id = h AND x.scope = 'event' AND x.target_key = c.event_uid
              AND (x.reminder_opt_out OR x.purpose IS NOT DISTINCT FROM 'normal'))
      -- 既に在る通知設定（別の時刻を含む）は書き換えぬ
      ON CONFLICT ON CONSTRAINT uq_event_reminders_event DO NOTHING;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN changed := true; END IF;
    ELSIF p_reminder = 'off' THEN
      -- シリーズ全体の停止。既定は上で 'none' にしてある（または行ごと消した）。ここの DELETE を
      -- (b) のトリガに「この回だけ止めた」と記録させぬよう、この文の間だけ印を立てる
      -- （通知が 1 回にしか残っておらぬシリーズでも、回ごとの明示 OFF を作らぬ）。
      -- 個別に止めてあった回の印には触れぬ（シリーズを戻しても、その回は止めたまま）。
      PERFORM set_config('irori.event_purpose_series_op', 'on', true);
      DELETE FROM public.event_reminders r
       USING public.calendar_events c
       WHERE r.household_id = h AND c.household_id = h AND r.event_uid = c.event_uid
         AND irori_private.event_series_key(
               c.source, c.series_id, c.google_calendar_id, c.recurring_event_id) = v_series_key
         AND c.start_date >= v_today
         AND c.medical_record_id IS NULL;
      GET DIAGNOSTICS n = ROW_COUNT;
      PERFORM set_config('irori.event_purpose_series_op', 'off', true);
      IF n > 0 THEN changed := true; END IF;
    END IF;
  ELSE
    -- ══════════ この回だけ ══════════
    IF p_action = 'normal' THEN
      IF NOT series_found THEN
        -- 戻す元のシリーズ既定が無い（別の端末が先に解除した）。何も書かず、今の行を返す
        RETURN jsonb_build_object(
          'status', 'conflict',
          'purpose', CASE WHEN event_found THEN to_jsonb(event_row) ELSE NULL END);
      END IF;
      new_purpose := 'normal';
    ELSIF p_action = 'garbage' THEN
      new_purpose := 'garbage';
    ELSE
      new_purpose := NULL;
    END IF;

    new_opt_out := CASE p_reminder
      WHEN 'prev_day_20' THEN false
      -- 解除と同時に止める時は、ごみに分類したシリーズの回だけ印を残す（既定が今は 'none' でも、
      -- 後でシリーズを前日通知へ切り替えた時にこの回へ付け直さぬため）。
      -- シリーズ既定の無い予定では印を残す意味が無い（足す者が居らぬ）
      WHEN 'off' THEN (new_purpose IS NOT NULL OR series_found)
      ELSE COALESCE(event_row.reminder_opt_out, false)
    END;

    IF new_purpose IS NULL AND NOT new_opt_out THEN
      IF event_found THEN
        DELETE FROM public.event_purposes WHERE id = event_row.id;
        changed := true;
      END IF;
    ELSIF NOT event_found THEN
      INSERT INTO public.event_purposes(
        household_id, scope, target_key, purpose, garbage_kind, reminder_opt_out, created_by)
      VALUES (h, 'event', ev.event_uid, new_purpose, v_kind, new_opt_out, auth.uid())
      RETURNING * INTO event_row;
      changed := true;
      out_row := event_row;
      out_exists := true;
    ELSE
      IF (event_row.purpose, event_row.garbage_kind, event_row.reminder_opt_out)
           IS DISTINCT FROM (new_purpose, v_kind, new_opt_out) THEN
        UPDATE public.event_purposes
           SET purpose = new_purpose, garbage_kind = v_kind, reminder_opt_out = new_opt_out,
               updated_at = clock_timestamp()
         WHERE id = event_row.id
        RETURNING * INTO event_row;
        changed := true;
      END IF;
      out_row := event_row;
      out_exists := true;
    END IF;

    IF p_reminder = 'prev_day_20' THEN
      -- 過ぎた回には足さぬ。既に在る通知設定は書き換えぬ
      IF ev.start_date >= v_today THEN
        INSERT INTO public.event_reminders(
          household_id, event_uid, remind_kind, remind_minutes_before, created_by)
        VALUES (h, ev.event_uid, 'prev_day_20', NULL, auth.uid())
        ON CONFLICT ON CONSTRAINT uq_event_reminders_event DO NOTHING;
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n > 0 THEN changed := true; END IF;
      END IF;
    ELSIF p_reminder = 'off' THEN
      DELETE FROM public.event_reminders
       WHERE household_id = h AND event_uid = ev.event_uid;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN changed := true; END IF;
    END IF;

    -- 通知の付け外しでトリガが印を動かした後の行を返す
    IF out_exists THEN
      SELECT * INTO out_row FROM public.event_purposes WHERE id = out_row.id;
      out_exists := FOUND;
    END IF;
  END IF;

  IF stale AND changed THEN
    RAISE EXCEPTION 'stale event purpose' USING ERRCODE = 'IRP01';
  END IF;
  EXCEPTION WHEN SQLSTATE 'IRP01' THEN
    -- このブロックの書込（分類の行・通知設定・トリガが動かした印）は全て巻き戻っておる。
    -- 変数は巻き戻らぬゆえ、今の行を読み直して返す
    IF p_scope = 'series' THEN
      SELECT * INTO out_row FROM public.event_purposes
       WHERE household_id = h AND scope = 'series' AND target_key = v_series_key;
    ELSE
      SELECT * INTO out_row FROM public.event_purposes
       WHERE household_id = h AND scope = 'event' AND target_key = ev.event_uid;
    END IF;
    RETURN jsonb_build_object(
      'status', 'conflict',
      'purpose', CASE WHEN FOUND THEN to_jsonb(out_row) ELSE NULL END);
  END;

  RETURN jsonb_build_object(
    'status', CASE WHEN changed THEN 'saved' ELSE 'replayed' END,
    'purpose', CASE WHEN out_exists THEN to_jsonb(out_row) ELSE NULL END);
END;
$$;
REVOKE ALL ON FUNCTION public.save_event_purpose(uuid, text, text, text, text, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_event_purpose(uuid, text, text, text, text, timestamptz, timestamptz)
  TO authenticated;


-- ------------------------------------------------------------
-- 5. delete_orphan_event_purpose — 予定が見つからぬ分類の手動整理
-- ------------------------------------------------------------
-- その鍵を持つ予定が世帯に 1 つも無い時だけ消す。
-- 戻り値: { status }
--   saved    … 消した
--   replayed … 既に無い（消し終えた操作の再送。別世帯の id もここへ寄せ、存在を漏らさぬ）
--   conflict … 予定が見つかった（同期が戻した等）。消しておらぬ
CREATE FUNCTION public.delete_orphan_event_purpose(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  h uuid;
  r public.event_purposes;
BEGIN
  SELECT household_id INTO h FROM public.profiles WHERE id = auth.uid();
  IF h IS NULL OR NOT irori_private.is_household_editor(h) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'invalid event purpose input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO r FROM public.event_purposes WHERE id = p_id AND household_id = h FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'replayed');
  END IF;
  IF NOT irori_private.event_purpose_is_orphan(h, r.scope, r.target_key) THEN
    RETURN jsonb_build_object('status', 'conflict');
  END IF;
  DELETE FROM public.event_purposes WHERE id = r.id;
  RETURN jsonb_build_object('status', 'saved');
END;
$$;
REVOKE ALL ON FUNCTION public.delete_orphan_event_purpose(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_orphan_event_purpose(uuid) TO authenticated;


-- ------------------------------------------------------------
-- 6. cleanup_deleted_event_purposes — 利用者が予定を削除した直後の掃除（native のみ）
-- ------------------------------------------------------------
-- 「本物の削除」を知っておるのは削除した当人の経路だけじゃ（calendar/actions.ts の
-- deleteCalendarEvent / deleteCalendarEventSeries が、予定を消した**後**に呼ぶ）。
-- 引数を uuid にしてあるのは、native の鍵（行 id / series_id）だけを対象にするため —
-- google の鍵（'|' を含む）はここから消せぬ（410 の窓で分類を失わぬ）。
-- どの行も「その鍵を持つ予定が 1 つも無い」時だけ消す（消し損ねた予定の分類は残る）。
-- 戻り値: 消した行数
CREATE FUNCTION public.cleanup_deleted_event_purposes(
  p_event_ids uuid[],
  p_series_id uuid
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  h uuid;
  removed integer := 0;
  n integer;
BEGIN
  SELECT household_id INTO h FROM public.profiles WHERE id = auth.uid();
  IF h IS NULL OR NOT irori_private.is_household_editor(h) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(cardinality(p_event_ids), 0) > 1000 THEN
    RAISE EXCEPTION 'too many events' USING ERRCODE = '22023';
  END IF;

  IF COALESCE(cardinality(p_event_ids), 0) > 0 THEN
    DELETE FROM public.event_purposes x
     WHERE x.household_id = h AND x.scope = 'event'
       AND x.target_key IN (SELECT e::text FROM unnest(p_event_ids) AS e WHERE e IS NOT NULL)
       AND irori_private.event_purpose_is_orphan(h, 'event', x.target_key);
    GET DIAGNOSTICS n = ROW_COUNT;
    removed := removed + n;
  END IF;
  IF p_series_id IS NOT NULL THEN
    DELETE FROM public.event_purposes x
     WHERE x.household_id = h AND x.scope = 'series' AND x.target_key = p_series_id::text
       AND irori_private.event_purpose_is_orphan(h, 'series', x.target_key);
    GET DIAGNOSTICS n = ROW_COUNT;
    removed := removed + n;
  END IF;
  RETURN removed;
END;
$$;
REVOKE ALL ON FUNCTION public.cleanup_deleted_event_purposes(uuid[], uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_deleted_event_purposes(uuid[], uuid) TO authenticated;


-- ------------------------------------------------------------
-- 7. トリガ (a): 既定 ON のシリーズへ後から入った回に前日通知を足す
-- ------------------------------------------------------------
-- calendar_events の INSERT は、利用者の予定作成・Google 同期（後から届く回・410 後の入れ直し）・
-- 医療記録の RPC から起きる。**どれも失敗させぬ**:
--   * 対象外（健診・予防接種 / 単発 / 過ぎた回 / シリーズ既定が ON でない / 明示 OFF /
--     この回だけ通常）は早期 return
--   * 足す時は ON CONFLICT DO NOTHING（410 をまたいで残った通知設定の時刻を書き換えぬ）
--   * 書込そのものは例外ブロックで包む（万一の失敗は WARNING。予定の INSERT は通す）
-- SECURITY DEFINER: authenticated は event_purposes を世帯の行しか読めず、同期は service role
-- で走る。呼び出し元の権限に結果を左右させぬ。
--
-- UPDATE でも呼ぶ（`start_date` が変わった時だけ）: 分類した時点で過ぎておった回には通知を
-- 足しておらぬ。その回が今日以降へ動けば（Google 側の振替は同期の upsert の DO UPDATE で届く。
-- native の日付の編集も UPDATE）、後から INSERT された回と同じく既定の通知を足す。
-- **過ぎた日から今日以降へ動いた時だけ**じゃ — 今日以降どうしの移動では足さぬ（その回に通知が
-- 無いのは、利用者がそう選んだ結果でありうる。日付を直しただけで通知を付けぬ）。
CREATE FUNCTION irori_private.calendar_events_apply_purpose_default() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  k text;
  v_today date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
BEGIN
  -- UPDATE: 日付が変わっておらぬ行（同期の upsert は全列を SET に並べる）と、今日以降どうしの
  -- 移動は対象外。大多数の UPDATE はここで終わる
  IF TG_OP = 'UPDATE'
     AND (OLD.start_date IS NOT DISTINCT FROM NEW.start_date OR OLD.start_date >= v_today) THEN
    RETURN NULL;
  END IF;
  IF NEW.medical_record_id IS NOT NULL THEN RETURN NULL; END IF;
  k := irori_private.event_series_key(
    NEW.source, NEW.series_id, NEW.google_calendar_id, NEW.recurring_event_id);
  IF k IS NULL THEN RETURN NULL; END IF;
  IF NEW.start_date < v_today THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.event_purposes p
     WHERE p.household_id = NEW.household_id AND p.scope = 'series' AND p.target_key = k
       AND p.remind_default = 'prev_day_20'
  ) THEN RETURN NULL; END IF;
  IF EXISTS (
    SELECT 1 FROM public.event_purposes x
     WHERE x.household_id = NEW.household_id AND x.scope = 'event' AND x.target_key = NEW.event_uid
       AND (x.reminder_opt_out OR x.purpose IS NOT DISTINCT FROM 'normal')
  ) THEN RETURN NULL; END IF;

  BEGIN
    INSERT INTO public.event_reminders(household_id, event_uid, remind_kind, remind_minutes_before)
    VALUES (NEW.household_id, NEW.event_uid, 'prev_day_20', NULL)
    ON CONFLICT ON CONSTRAINT uq_event_reminders_event DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'event purpose: default reminder skipped (sqlstate %)', SQLSTATE;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION irori_private.calendar_events_apply_purpose_default()
  FROM PUBLIC, anon, authenticated;
-- INSERT と「start_date を SET に含む UPDATE」の 1 本（INSERT を含むトリガの WHEN は OLD を
-- 参照できぬゆえ、「日付が実際に変わったか・過ぎた日からか」は関数の冒頭で絞る）
CREATE TRIGGER trg_calendar_events_purpose_default
  AFTER INSERT OR UPDATE OF start_date ON public.calendar_events
  FOR EACH ROW EXECUTE FUNCTION irori_private.calendar_events_apply_purpose_default();


-- ------------------------------------------------------------
-- 8. トリガ (b): ごみに分類したシリーズの回の通知が消されたら、止めた範囲を記録する
-- ------------------------------------------------------------
-- event_reminders は「OFF = 行の DELETE」ゆえ、DELETE を見て利用者の意図を記録する。
-- **文単位**（transition table）で見るのは、「この回だけ止めた」と「シリーズ全体を止めた」を
-- 分けるためじゃ — 行単位では、予定シートの「シリーズ全体・なし」（その世帯のシリーズの全ての回の
-- 通知を 1 文で消す。`calendar/actions.ts` の setEventReminder）が、全ての回の「個別の明示 OFF」
-- に化ける。そうなると、後でシリーズを前日通知へ戻しても 1 件も付かぬ:
--   * 1 文で、同じシリーズの今日以降の回の通知が **2 件以上** 消えた → シリーズ全体の停止。
--     series 行の既定を 'none' にする（回ごとの印は作らぬ）
--   * 1 件だけ消えた → その回の個別の停止。`reminder_opt_out` を立てる
--     （シリーズの既定が 'none' でも記録する — 後でシリーズを前日通知へ切り替えた時に、
--       個別に止めた回へ付け直さぬため）
--   既知の限界: 今日以降に通知の付いた回が 1 つしか無いシリーズを「シリーズ全体・なし」に
--   すると、個別の停止と区別できぬ（個別の停止として記録する = 通知を勝手に戻さぬ側）。
--   100 回を超えるシリーズは削除が複数の文に割れ、端数が 1 件の文も同じ扱いになる。
--
-- event_reminders の DELETE は、利用者が通知を「なし」にした時・予定を削除した後の掃除・
-- 医療記録の RPC・世帯の削除（CASCADE）から起きる。**どれも失敗させぬ**:
--   * 消えた通知の世帯に、ごみに分類したシリーズが無ければ即 return（大多数はここで終わる）
--   * 予定が既に無い（削除後の掃除）・健診・過ぎた回・単発・分類しておらぬシリーズは対象外
--   * 世帯そのものが消える途中（CASCADE）では書かぬ（FK 違反で世帯の削除を止めぬ）
--   * save_event_purpose がシリーズの通知をまとめて消す間（`irori.event_purpose_series_op`）は
--     何も記録せぬ（シリーズ全体の停止は RPC 自身が series 行へ書く）
--   * 書込そのものは例外ブロックで包む（万一の失敗は WARNING。通知の解除は通す）
CREATE FUNCTION irori_private.event_reminders_record_opt_out() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  g record;
BEGIN
  IF current_setting('irori.event_purpose_series_op', true) IS NOT DISTINCT FROM 'on' THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM deleted_reminders d
      JOIN public.event_purposes p ON p.household_id = d.household_id AND p.scope = 'series'
  ) THEN RETURN NULL; END IF;

  FOR g IN
    SELECT d.household_id, p.id AS series_purpose_id, count(*) AS n, min(d.event_uid) AS one_uid
      FROM deleted_reminders d
      JOIN public.households hh ON hh.id = d.household_id
      JOIN public.calendar_events c
        ON c.household_id = d.household_id AND c.event_uid = d.event_uid
      JOIN public.event_purposes p
        ON p.household_id = d.household_id AND p.scope = 'series'
       AND p.target_key = irori_private.event_series_key(
             c.source, c.series_id, c.google_calendar_id, c.recurring_event_id)
     WHERE c.medical_record_id IS NULL AND c.start_date >= v_today
     GROUP BY d.household_id, p.id
  LOOP
    BEGIN
      IF g.n >= 2 THEN
        UPDATE public.event_purposes
           SET remind_default = 'none', updated_at = clock_timestamp()
         WHERE id = g.series_purpose_id AND remind_default IS DISTINCT FROM 'none';
      ELSE
        INSERT INTO public.event_purposes(
          household_id, scope, target_key, purpose, garbage_kind, remind_default,
          reminder_opt_out, created_by)
        VALUES (g.household_id, 'event', g.one_uid, NULL, NULL, NULL, true, auth.uid())
        ON CONFLICT ON CONSTRAINT uq_event_purposes_target DO UPDATE
           SET reminder_opt_out = true, updated_at = clock_timestamp()
         WHERE NOT public.event_purposes.reminder_opt_out;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'event purpose: reminder stop not recorded (sqlstate %)', SQLSTATE;
    END;
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION irori_private.event_reminders_record_opt_out()
  FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_event_reminders_purpose_opt_out
  AFTER DELETE ON public.event_reminders
  REFERENCING OLD TABLE AS deleted_reminders
  FOR EACH STATEMENT EXECUTE FUNCTION irori_private.event_reminders_record_opt_out();


-- ------------------------------------------------------------
-- 9. トリガ (c): 通知が付け直されたら、明示 OFF の印を降ろす
-- ------------------------------------------------------------
-- 印の無い予定（大多数）は最初の EXISTS で終わる。用途を持たず印だけの行は、印を降ろすと
-- 意味を失う（chk_event_purposes_event_shape）ゆえ行ごと消す。
CREATE FUNCTION irori_private.event_reminders_clear_opt_out() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.event_purposes x
     WHERE x.household_id = NEW.household_id AND x.scope = 'event'
       AND x.target_key = NEW.event_uid AND x.reminder_opt_out
  ) THEN RETURN NULL; END IF;

  BEGIN
    DELETE FROM public.event_purposes x
     WHERE x.household_id = NEW.household_id AND x.scope = 'event'
       AND x.target_key = NEW.event_uid AND x.reminder_opt_out AND x.purpose IS NULL;
    UPDATE public.event_purposes x
       SET reminder_opt_out = false, updated_at = clock_timestamp()
     WHERE x.household_id = NEW.household_id AND x.scope = 'event'
       AND x.target_key = NEW.event_uid AND x.reminder_opt_out;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'event purpose: opt-out not cleared (sqlstate %)', SQLSTATE;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION irori_private.event_reminders_clear_opt_out()
  FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_event_reminders_purpose_opt_in
  AFTER INSERT ON public.event_reminders
  FOR EACH ROW EXECUTE FUNCTION irori_private.event_reminders_clear_opt_out();
