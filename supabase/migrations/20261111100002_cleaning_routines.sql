-- =============================================================================
-- 掃除ルーティーン — 定義（cleaning_routines）と履歴（cleaning_logs）、書込 RPC
--
-- 方針（docs/plans/2026-11-10-household-chores/implementation-notes.md §0 / §B）
--   * 定義と履歴を分ける。前回実施日の正本は「有効な（取り消されていない）done の履歴」で、
--     定義側に写しを持たない。取り消し・訂正はそのまま再計算へ効く。
--   * 両表とも世帯単位。authenticated には SELECT だけを GRANT し、INSERT/UPDATE/DELETE の
--     GRANT もポリシーも作らない（= 直接 DML は 42501）。書込は下の SECURITY DEFINER RPC だけ。
--   * RPC は世帯 ID を引数で受けない。auth.uid() → profiles.household_id から導出し、
--     irori_private.is_household_editor() を「世帯ロックの前後」で 2 回検査する。
--   * 行 ID はクライアント採番 UUID（DEFAULT なし）。版は updated_at（RPC が clock_timestamp() を明示 SET）。
--   * 戻り値は jsonb の {status:'saved'|'replayed'|'conflict', ...}。record_cleaning_log だけは
--     {status:'already_closed', log: 既存行} も返す（同じ回を家族が先に閉じていた）。
--   * 同じ回の完了・スキップは、部分一意索引 (routine_id, occurrence) で有効行 1 行に確定する。
--     「どの日付がその回の鍵か」は周期計算（src/lib/domain/cleaning-schedule.ts）が決め、
--     Server Action が DB の最新から計算して渡す。DB は「同じ鍵の有効行は 1 行」「未来日の実施は
--     記録しない」「世帯をまたがない」「版が違えば上書きしない」を原子的に守る。
--   * 実施基準の鍵は予定日から逃げうる（早めの実施で次の予定日が閉じた鍵と重なると翌日へ）。スキップは
--     その回の予定日（scheduled_on）を DB が計算して残し、次回はそこから数える（B-07f。鍵からは復元できない）。
--   * 回の鍵は「周期の世代」（cadence_epoch）の中でだけ意味を持つ。周期（単位・間隔・方式・基準日）を
--     変えると定義の世代が 1 進み、履歴は閉じた時の世代を写しで持つ。鍵の一意性・「最後に閉じた回」・
--     「閉じ済みか」は同じ世代の中だけで判定する（変更前の格子で閉じた鍵が、新しい格子の予定日を
--     覆って予定を黙って飛ばさない）。前回実施日は世代に依らず全ての有効な done から取る。
--   * 子ども閲覧招待（child_shares）は述語に登場させない。shared_child_snapshot にも触れない。
--   * ENUM は作らず text + CHECK。Realtime publication には足さない。
--   * SQL 側の「今日」は (now() AT TIME ZONE 'Asia/Tokyo')::date。
--
-- 変えないもの: 既存の表・関数・ポリシー・publication。
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. 表
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE public.cleaning_routines (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  location text CHECK (char_length(btrim(location)) BETWEEN 1 AND 40),
  cadence_unit text NOT NULL CHECK (cadence_unit IN ('week','month','year')),
  cadence_interval smallint NOT NULL,
  -- fixed = 固定した曜日・日付（予定日は基準日から生成）/ after_done = 実施から一定期間後
  schedule_mode text NOT NULL CHECK (schedule_mode IN ('fixed','after_done')),
  -- fixed: 曜日・日付の基準。after_done: 履歴が無い間の最初の予定日。
  anchor_date date NOT NULL CHECK (anchor_date BETWEEN DATE '2000-01-01' AND DATE '2999-12-31'),
  -- 延期: 「どの回を」「いつまで」。必ず対で入る。次の回には及ばない。
  postponed_occurrence date CHECK (postponed_occurrence BETWEEN DATE '2000-01-01' AND DATE '2999-12-31'),
  postponed_until date CHECK (postponed_until BETWEEN DATE '2000-01-01' AND DATE '2999-12-31'),
  paused_at timestamptz CHECK (isfinite(paused_at)),
  -- この日より前の予定日は対象にしない（作成・周期変更・再開の日）。作成前・休止中の回を期限超過として積まない。
  resume_floor date CHECK (resume_floor BETWEEN DATE '2000-01-01' AND DATE '2999-12-31'),
  -- 周期の世代。周期（単位・間隔・方式・基準日）を変えるたびに 1 進む。回の鍵はこの世代の中でだけ意味を持つ。
  cadence_epoch integer NOT NULL DEFAULT 0 CHECK (cadence_epoch >= 0),
  archived boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- 履歴側の複合 FK 用（世帯またぎの routine_id を構造的に拒む）。
  CONSTRAINT cleaning_routines_household_id_key UNIQUE (household_id, id),
  CONSTRAINT cleaning_routines_interval_range CHECK (
    (cadence_unit = 'week' AND cadence_interval BETWEEN 1 AND 52)
    OR (cadence_unit = 'month' AND cadence_interval BETWEEN 1 AND 24)
    OR (cadence_unit = 'year' AND cadence_interval BETWEEN 1 AND 10)
  ),
  CONSTRAINT cleaning_routines_postpone_pair CHECK ((postponed_occurrence IS NULL) = (postponed_until IS NULL))
);
CREATE INDEX cleaning_routines_household ON public.cleaning_routines(household_id, created_at, id);

CREATE TABLE public.cleaning_logs (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  routine_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('done','skip')),
  -- 実施日（done だけが持つ）。未来日は RPC が拒む（CHECK は now() を参照できない）。
  done_on date CHECK (done_on BETWEEN DATE '2000-01-01' AND DATE '2999-12-31'),
  -- 閉じた回の鍵。過去日の追記は NULL（現在の回を閉じない）。
  occurrence date CHECK (occurrence BETWEEN DATE '2000-01-01' AND DATE '2999-12-31'),
  -- スキップした回の予定日（延期前）。skip だけが持ち、record_cleaning_log がロックの下で計算して入れる
  -- （クライアントの申告を受けない）。実施基準の鍵は予定日から逃げうる（早めの実施で次の予定日が閉じた鍵と
  -- 重なると翌日へ）ゆえ、スキップの後の次回はこの予定日から数える。鍵からは復元できない。
  scheduled_on date CHECK (scheduled_on BETWEEN DATE '2000-01-01' AND DATE '2999-12-31'),
  -- 記録した時の定義の世代（cleaning_routines.cadence_epoch の写し。RPC が入れる）。
  cadence_epoch integer NOT NULL DEFAULT 0 CHECK (cadence_epoch >= 0),
  note text CHECK (char_length(btrim(note)) BETWEEN 1 AND 200),
  -- 取り消し。行は消さない（履歴として残し、有効行だけを計算に使う）。
  voided_at timestamptz CHECK (isfinite(voided_at)),
  voided_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- 世帯またぎの routine 指定を DB が拒む。
  CONSTRAINT cleaning_logs_routine_fkey FOREIGN KEY (household_id, routine_id)
    REFERENCES public.cleaning_routines(household_id, id) ON DELETE CASCADE,
  -- done は実施日を必ず持ち、予定日は持たない（次回の起点は実施日）。skip は実施日を持たず、必ず回を閉じ、
  -- その回の予定日を持つ（鍵は予定日以後 = 予定日が閉じた鍵と重なった時だけ後ろへ逃げる）。
  CONSTRAINT cleaning_logs_kind_shape CHECK (
    (kind = 'done' AND done_on IS NOT NULL AND scheduled_on IS NULL)
    OR (kind = 'skip' AND done_on IS NULL AND occurrence IS NOT NULL
        AND scheduled_on IS NOT NULL AND scheduled_on <= occurrence)
  )
);
-- 同じ回を閉じる有効な履歴は 1 行だけ（家族の同時完了を 1 回分に確定する）。取り消せば再び閉じられる。
-- 鍵は周期の世代ごと: 周期を変えた後の格子が、変更前に閉じた日付と重なっても、その回は閉じられる。
CREATE UNIQUE INDEX cleaning_logs_one_per_occurrence ON public.cleaning_logs(routine_id, cadence_epoch, occurrence)
  WHERE occurrence IS NOT NULL AND voided_at IS NULL;
CREATE INDEX cleaning_logs_routine ON public.cleaning_logs(household_id, routine_id, created_at DESC, id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. RLS と権限（hosted / local の既定 GRANT の差に依存しないよう、明示的に同じ ACL へ収束させる）
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.cleaning_routines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cleaning_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.cleaning_routines, public.cleaning_logs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cleaning_routines, public.cleaning_logs TO authenticated;
GRANT ALL ON public.cleaning_routines, public.cleaning_logs TO service_role;

-- SELECT のみ。INSERT / UPDATE / DELETE は GRANT もポリシーも無い（= 拒否）。
CREATE POLICY cleaning_routines_select ON public.cleaning_routines FOR SELECT TO authenticated
  USING (irori_private.is_household_editor(household_id));
CREATE POLICY cleaning_logs_select ON public.cleaning_logs FOR SELECT TO authenticated
  USING (irori_private.is_household_editor(household_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. 内部ヘルパ（irori_private。誰にも GRANT しない = DEFINER RPC の内側専用）
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION irori_private.cleaning_today() RETURNS date
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT (now() AT TIME ZONE 'Asia/Tokyo')::date;
$$;

-- 呼び手の世帯。正規メンバー（承認済みの owner / member）でなければ 42501。
CREATE FUNCTION irori_private.cleaning_household() RETURNS uuid
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE h uuid;
BEGIN
  SELECT p.household_id INTO h FROM public.profiles p WHERE p.id = (SELECT auth.uid());
  IF h IS NULL OR NOT irori_private.is_household_editor(h) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  RETURN h;
END;
$$;

-- 認可 → 世帯単位の advisory lock → ロック待ちの後に認可を再評価。掃除の書込 RPC は全てここから始める。
-- 世帯単位で直列にするので、「同じ回が閉じているか」の確認と INSERT の間に別の完了が割り込まない。
CREATE FUNCTION irori_private.cleaning_begin() RETURNS uuid
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE h uuid;
BEGIN
  h := irori_private.cleaning_household();
  PERFORM pg_advisory_xact_lock(hashtextextended('cleaning:' || h::text, 0));
  IF irori_private.cleaning_household() IS DISTINCT FROM h THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  RETURN h;
END;
$$;

-- 表示用の短い文字列。前後の空白を除き、空・長すぎ・制御文字を拒む。
CREATE FUNCTION irori_private.cleaning_text(s text, maxlen integer, nullable boolean, what text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE t text := btrim(s);
BEGIN
  IF t IS NULL OR t = '' THEN
    IF nullable THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'invalid %', what USING ERRCODE = '22023';
  END IF;
  IF char_length(t) > maxlen OR t ~ '[\x01-\x1f\x7f]' THEN
    RAISE EXCEPTION 'invalid %', what USING ERRCODE = '22023';
  END IF;
  RETURN t;
END;
$$;

CREATE FUNCTION irori_private.cleaning_valid_date(d date) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT d IS NOT NULL AND d BETWEEN DATE '2000-01-01' AND DATE '2999-12-31';
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. 定義の作成・編集・アーカイブ
-- ─────────────────────────────────────────────────────────────────────────────

-- 判定順: 認可 → 入力検証(22023) → 行ロック → 他世帯の ID(42501) → 同内容(replayed) → 版違い(conflict) → 書込。
-- 周期（単位・間隔・方式・基準日）を変えたとき・アーカイブから戻したときは、延期を消し、
-- 固定周期は対象開始日を今日にする（変更前の予定日を「期限超過」として数え直さない）。
-- 周期を変えたときは、さらに周期の世代を 1 進める: 変更前の格子で閉じた鍵（早めの完了・先の回の
-- スキップ）を、新しい格子の「最後に閉じた回」として数えない。数えると、新しい予定日がその鍵に
-- 覆われて、予定にも期限超過にも一度も出ないまま飛ぶ。そのとき、今日すでに実施した記録が在る項目だけは
-- 対象開始日を明日にする（掃除を済ませた当日の回を、新しい格子でもう一度求めない）。スキップは
-- 引き継がない（今日が新しい格子の予定日なら、もう一度出る = 黙って飛ばさない側へ倒す）。
-- アーカイブから戻すだけなら世代は進めない（格子は同じゆえ、閉じた回は閉じたまま）。
CREATE FUNCTION public.save_cleaning_routine(
  p_id uuid, p_version timestamptz, p_name text, p_location text,
  p_cadence_unit text, p_cadence_interval integer, p_schedule_mode text, p_anchor_date date, p_archived boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  h uuid; r public.cleaning_routines; v_name text; v_location text;
  v_today date := irori_private.cleaning_today(); v_restart boolean; v_unarchive boolean;
  v_recadence boolean; v_floor date;
BEGIN
  h := irori_private.cleaning_begin();
  IF p_id IS NULL OR p_archived IS NULL THEN
    RAISE EXCEPTION 'invalid routine' USING ERRCODE = '22023';
  END IF;
  v_name := irori_private.cleaning_text(p_name, 60, false, 'name');
  v_location := irori_private.cleaning_text(p_location, 40, true, 'location');
  IF p_cadence_unit IS NULL OR p_cadence_interval IS NULL OR p_schedule_mode IS NULL
     OR p_schedule_mode NOT IN ('fixed','after_done')
     OR NOT irori_private.cleaning_valid_date(p_anchor_date)
     OR NOT ((p_cadence_unit = 'week' AND p_cadence_interval BETWEEN 1 AND 52)
          OR (p_cadence_unit = 'month' AND p_cadence_interval BETWEEN 1 AND 24)
          OR (p_cadence_unit = 'year' AND p_cadence_interval BETWEEN 1 AND 10)) THEN
    RAISE EXCEPTION 'invalid schedule' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO r FROM public.cleaning_routines t WHERE t.id = p_id FOR UPDATE;
  IF FOUND THEN
    IF r.household_id <> h THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
    IF (r.name, r.location, r.cadence_unit, r.cadence_interval::integer, r.schedule_mode, r.anchor_date, r.archived)
       IS NOT DISTINCT FROM (v_name, v_location, p_cadence_unit, p_cadence_interval, p_schedule_mode, p_anchor_date, p_archived) THEN
      RETURN jsonb_build_object('status', 'replayed', 'routine', to_jsonb(r));
    END IF;
    IF p_version IS NULL OR r.updated_at <> p_version THEN
      RETURN jsonb_build_object('status', 'conflict', 'routine', to_jsonb(r));
    END IF;
    v_unarchive := r.archived AND NOT p_archived;
    v_recadence := (r.cadence_unit, r.cadence_interval::integer, r.schedule_mode, r.anchor_date)
         IS DISTINCT FROM (p_cadence_unit, p_cadence_interval, p_schedule_mode, p_anchor_date);
    v_restart := v_unarchive OR v_recadence;
    v_floor := v_today;
    IF v_recadence AND EXISTS (
      SELECT 1 FROM public.cleaning_logs l
      WHERE l.routine_id = r.id AND l.voided_at IS NULL AND l.kind = 'done' AND l.done_on = v_today
    ) THEN
      v_floor := v_today + 1;
    END IF;
    UPDATE public.cleaning_routines t SET
      name = v_name, location = v_location,
      cadence_unit = p_cadence_unit, cadence_interval = p_cadence_interval,
      schedule_mode = p_schedule_mode, anchor_date = p_anchor_date, archived = p_archived,
      resume_floor = CASE WHEN v_restart AND (p_schedule_mode = 'fixed' OR v_unarchive) THEN v_floor ELSE t.resume_floor END,
      cadence_epoch = CASE WHEN v_recadence THEN t.cadence_epoch + 1 ELSE t.cadence_epoch END,
      postponed_occurrence = CASE WHEN v_restart THEN NULL ELSE t.postponed_occurrence END,
      postponed_until = CASE WHEN v_restart THEN NULL ELSE t.postponed_until END,
      updated_by = auth.uid(), updated_at = clock_timestamp()
    WHERE t.id = p_id RETURNING * INTO r;
  ELSE
    -- 版つきで届いたのに行が無い = 自世帯の行ではない（定義は消さず、アーカイブするだけ）。
    IF p_version IS NOT NULL THEN RAISE EXCEPTION 'routine unavailable' USING ERRCODE = '42501'; END IF;
    IF p_archived THEN RAISE EXCEPTION 'invalid routine' USING ERRCODE = '22023'; END IF;
    IF (SELECT count(*) FROM public.cleaning_routines t WHERE t.household_id = h AND NOT t.archived) >= 200 THEN
      RAISE EXCEPTION 'too many routines' USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.cleaning_routines(
      id, household_id, name, location, cadence_unit, cadence_interval, schedule_mode, anchor_date,
      resume_floor, created_by, updated_by)
    VALUES (
      p_id, h, v_name, v_location, p_cadence_unit, p_cadence_interval, p_schedule_mode, p_anchor_date,
      -- 固定周期は作成日より前の予定日を数えない。実施基準は利用者が選んだ最初の予定日をそのまま使う。
      CASE WHEN p_schedule_mode = 'fixed' THEN v_today ELSE NULL END, auth.uid(), auth.uid())
    RETURNING * INTO r;
  END IF;
  RETURN jsonb_build_object('status', 'saved', 'routine', to_jsonb(r));
END;
$$;

-- 休止 / 再開 / 延期 / 延期の取り消し。
-- 既に求めた状態なら版を見ずに replayed（応答を失った自分の再送）。それ以外は版が違えば conflict。
-- p_occurrence / p_until は postpone のときだけ渡す。延期は「現在の回の期限」だけを動かし、基準日は変えない。
CREATE FUNCTION public.set_cleaning_routine_state(
  p_id uuid, p_version timestamptz, p_action text, p_occurrence date, p_until date
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE h uuid; r public.cleaning_routines; v_today date := irori_private.cleaning_today();
BEGIN
  h := irori_private.cleaning_begin();
  IF p_id IS NULL OR p_action IS NULL OR p_action NOT IN ('pause','resume','postpone','clear_postpone') THEN
    RAISE EXCEPTION 'invalid action' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'postpone' THEN
    IF NOT irori_private.cleaning_valid_date(p_occurrence) OR NOT irori_private.cleaning_valid_date(p_until) THEN
      RAISE EXCEPTION 'invalid postpone' USING ERRCODE = '22023';
    END IF;
  ELSIF p_occurrence IS NOT NULL OR p_until IS NOT NULL THEN
    RAISE EXCEPTION 'invalid action' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO r FROM public.cleaning_routines t WHERE t.id = p_id AND t.household_id = h FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'routine unavailable' USING ERRCODE = '42501'; END IF;

  IF (p_action = 'pause' AND r.paused_at IS NOT NULL)
     OR (p_action = 'resume' AND r.paused_at IS NULL)
     OR (p_action = 'clear_postpone' AND r.postponed_occurrence IS NULL)
     OR (p_action = 'postpone'
         AND (r.postponed_occurrence, r.postponed_until) IS NOT DISTINCT FROM (p_occurrence, p_until)) THEN
    RETURN jsonb_build_object('status', 'replayed', 'routine', to_jsonb(r));
  END IF;
  IF p_version IS NULL OR r.updated_at <> p_version THEN
    RETURN jsonb_build_object('status', 'conflict', 'routine', to_jsonb(r));
  END IF;
  IF r.archived THEN RAISE EXCEPTION 'routine archived' USING ERRCODE = '23514'; END IF;

  IF p_action = 'pause' THEN
    UPDATE public.cleaning_routines t SET paused_at = clock_timestamp(), updated_by = auth.uid(), updated_at = clock_timestamp()
    WHERE t.id = p_id RETURNING * INTO r;
  ELSIF p_action = 'resume' THEN
    -- 再開日より前の予定日は対象にしない（休止中の回を期限超過として積まない）。
    UPDATE public.cleaning_routines t SET paused_at = NULL, resume_floor = v_today, updated_by = auth.uid(), updated_at = clock_timestamp()
    WHERE t.id = p_id RETURNING * INTO r;
  ELSIF p_action = 'clear_postpone' THEN
    UPDATE public.cleaning_routines t SET postponed_occurrence = NULL, postponed_until = NULL, updated_by = auth.uid(), updated_at = clock_timestamp()
    WHERE t.id = p_id RETURNING * INTO r;
  ELSE
    IF r.paused_at IS NOT NULL THEN RAISE EXCEPTION 'routine paused' USING ERRCODE = '23514'; END IF;
    -- 延期先は明日以降・1 年以内。
    IF p_until <= v_today OR p_until > v_today + 366 THEN
      RAISE EXCEPTION 'invalid postpone' USING ERRCODE = '22023';
    END IF;
    -- 既に閉じた回は延期できない（家族が先に完了・スキップした）。上書きせず最新を返す。
    -- 「閉じ済み」は今の周期の世代の中だけで見る（変更前の格子の同じ日付は別の回）。
    IF EXISTS (SELECT 1 FROM public.cleaning_logs l
               WHERE l.routine_id = r.id AND l.cadence_epoch = r.cadence_epoch
                 AND l.occurrence = p_occurrence AND l.voided_at IS NULL) THEN
      RETURN jsonb_build_object('status', 'conflict', 'routine', to_jsonb(r));
    END IF;
    UPDATE public.cleaning_routines t SET postponed_occurrence = p_occurrence, postponed_until = p_until, updated_by = auth.uid(), updated_at = clock_timestamp()
    WHERE t.id = p_id RETURNING * INTO r;
  END IF;
  RETURN jsonb_build_object('status', 'saved', 'routine', to_jsonb(r));
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. 履歴の記録・訂正・取り消し
-- ─────────────────────────────────────────────────────────────────────────────

-- 完了（done）・スキップ（skip）・過去日の追記（done で p_occurrence が NULL）。
--   * 同じ p_id が既に在れば、内容が同じなら replayed（取り消し済みなら conflict）、違えば 23505。
--   * routine の版が違えば conflict（周期が変わっていれば、クライアントが見ていた回は別の回かもしれない）。
--   * p_occurrence の回を閉じる有効な履歴が既に在れば、行を作らず already_closed と既存行を返す。
--   * done_on は今日（JST）以前だけ。未来の日を実施履歴にしない。
--   * skip は閉じる回の予定日（scheduled_on）を、ロックの下で有効な履歴から計算して残す（引数では受けない。
--     RPC を直に呼ばれても同じ値になる）。再送（同じ p_id）は既存行を返すだけで、予定日を計算し直さない。
CREATE FUNCTION public.record_cleaning_log(
  p_id uuid, p_routine_id uuid, p_routine_version timestamptz, p_kind text,
  p_done_on date, p_occurrence date, p_note text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  h uuid; r public.cleaning_routines; l public.cleaning_logs; v_note text;
  v_today date := irori_private.cleaning_today(); v_span interval;
  v_scheduled date; v_last_done date; v_max_occ date; v_max_skip date; v_skip_scheduled date;
  v_base date; v_due date;
BEGIN
  h := irori_private.cleaning_begin();
  IF p_id IS NULL OR p_routine_id IS NULL OR p_kind IS NULL OR p_kind NOT IN ('done','skip') THEN
    RAISE EXCEPTION 'invalid log' USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'done' THEN
    IF NOT irori_private.cleaning_valid_date(p_done_on) THEN
      RAISE EXCEPTION 'invalid done_on' USING ERRCODE = '22023';
    END IF;
    IF p_done_on > v_today THEN
      RAISE EXCEPTION 'done_on in the future' USING ERRCODE = '22023';
    END IF;
  ELSIF p_done_on IS NOT NULL OR p_occurrence IS NULL THEN
    RAISE EXCEPTION 'invalid skip' USING ERRCODE = '22023';
  END IF;
  IF p_occurrence IS NOT NULL AND NOT irori_private.cleaning_valid_date(p_occurrence) THEN
    RAISE EXCEPTION 'invalid occurrence' USING ERRCODE = '22023';
  END IF;
  v_note := irori_private.cleaning_text(p_note, 200, true, 'note');

  SELECT * INTO r FROM public.cleaning_routines t WHERE t.id = p_routine_id AND t.household_id = h FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'routine unavailable' USING ERRCODE = '42501'; END IF;

  SELECT * INTO l FROM public.cleaning_logs t WHERE t.id = p_id FOR UPDATE;
  IF FOUND THEN
    IF l.household_id <> h OR l.routine_id <> p_routine_id OR l.created_by IS DISTINCT FROM auth.uid()
       OR (l.kind, l.done_on, l.occurrence, l.note) IS DISTINCT FROM (p_kind, p_done_on, p_occurrence, v_note) THEN
      RAISE EXCEPTION 'request id conflict' USING ERRCODE = '23505';
    END IF;
    -- 自分の記録を、応答を待つ間に誰かが取り消していた。成功とは返さない。
    IF l.voided_at IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'conflict', 'log', to_jsonb(l), 'routine', to_jsonb(r));
    END IF;
    RETURN jsonb_build_object('status', 'replayed', 'log', to_jsonb(l), 'routine', to_jsonb(r));
  END IF;

  IF r.archived THEN RAISE EXCEPTION 'routine archived' USING ERRCODE = '23514'; END IF;
  IF p_routine_version IS NULL OR r.updated_at <> p_routine_version THEN
    RETURN jsonb_build_object('status', 'conflict', 'routine', to_jsonb(r));
  END IF;

  IF p_occurrence IS NOT NULL THEN
    IF r.paused_at IS NOT NULL THEN RAISE EXCEPTION 'routine paused' USING ERRCODE = '23514'; END IF;
    -- 鍵の正気の範囲。固定周期は基準日より前の回を持たない。どちらの方式も、今日（基準日が未来なら
    -- 基準日）から 2 周期より先の回は閉じられない（遠い未来の鍵で項目を黙らせない）。
    v_span := CASE r.cadence_unit
      WHEN 'week' THEN make_interval(weeks => r.cadence_interval::integer)
      WHEN 'month' THEN make_interval(months => r.cadence_interval::integer)
      ELSE make_interval(years => r.cadence_interval::integer) END;
    IF (r.schedule_mode = 'fixed' AND p_occurrence < r.anchor_date)
       OR p_occurrence > (greatest(v_today, r.anchor_date) + v_span * 2)::date THEN
      RAISE EXCEPTION 'occurrence out of range' USING ERRCODE = '22023';
    END IF;
    -- 「同じ回」は今の周期の世代の中だけで見る（変更前の格子の同じ日付は別の回）。
    SELECT * INTO l FROM public.cleaning_logs t
    WHERE t.routine_id = r.id AND t.cadence_epoch = r.cadence_epoch
      AND t.occurrence = p_occurrence AND t.voided_at IS NULL;
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'already_closed', 'log', to_jsonb(l), 'routine', to_jsonb(r));
    END IF;

    -- スキップは、閉じる回の予定日（延期前）を残す。固定周期の鍵は格子の予定日そのもの。実施基準の予定日は
    -- 有効な履歴から計算する（src/lib/domain/cleaning-schedule.ts の routineStatusFromMarks と同じ規則。
    -- 集計は cleaning_log_marks と同じ。前回実施日は全ての世代から、閉じた鍵は今の世代だけから）:
    --   起点   = 最後の閉鎖がスキップなら max(前回実施日, そのスキップの予定日)、そうでなければ前回実施日
    --   予定日 = max(起点 + 周期（起点が無ければ基準日）, 対象開始日)
    --   鍵     = max(予定日, 閉じた最大の鍵 + 1 日)
    -- 計算した鍵が p_occurrence と一致する時だけ、その予定日を入れる。一致しない（今の回ではない鍵を直に
    -- 閉じた）時は鍵そのものを入れる（無関係な予定日を植えない）。
    IF p_kind = 'skip' THEN
      v_scheduled := p_occurrence;
      IF r.schedule_mode = 'after_done' THEN
        SELECT max(t.done_on) FILTER (WHERE t.kind = 'done'),
               max(t.occurrence) FILTER (WHERE t.cadence_epoch = r.cadence_epoch),
               max(t.occurrence) FILTER (WHERE t.kind <> 'done' AND t.cadence_epoch = r.cadence_epoch)
          INTO v_last_done, v_max_occ, v_max_skip
        FROM public.cleaning_logs t
        WHERE t.routine_id = r.id AND t.voided_at IS NULL;
        IF v_max_skip IS NOT NULL AND v_max_skip = v_max_occ THEN
          SELECT t.scheduled_on INTO v_skip_scheduled FROM public.cleaning_logs t
          WHERE t.routine_id = r.id AND t.cadence_epoch = r.cadence_epoch
            AND t.occurrence = v_max_skip AND t.voided_at IS NULL;
          v_base := greatest(v_last_done, coalesce(v_skip_scheduled, v_max_skip));
        ELSE
          v_base := v_last_done;
        END IF;
        -- 月・年の加算は暦で行い、無い日は月末へ寄せる（1/31 + 1 か月 = 2/28、2/29 + 1 年 = 平年 2/28）
        v_due := greatest(
          CASE WHEN v_base IS NULL THEN r.anchor_date ELSE (v_base + v_span)::date END,
          r.resume_floor);
        IF greatest(v_due, v_max_occ + 1) = p_occurrence THEN
          v_scheduled := v_due;
        END IF;
      END IF;
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.cleaning_logs(id, household_id, routine_id, kind, done_on, occurrence, scheduled_on, cadence_epoch, note, created_by)
    VALUES (p_id, h, r.id, p_kind, p_done_on, p_occurrence, v_scheduled, r.cadence_epoch, v_note, auth.uid())
    RETURNING * INTO l;
  EXCEPTION WHEN unique_violation THEN
    -- 世帯ロックの下では起きないはずだが、一意索引が最後の番人。二重行にせず既存行を返す。
    SELECT * INTO l FROM public.cleaning_logs t
    WHERE t.routine_id = r.id AND t.cadence_epoch = r.cadence_epoch
      AND t.occurrence = p_occurrence AND t.voided_at IS NULL;
    IF NOT FOUND THEN RAISE; END IF;
    RETURN jsonb_build_object('status', 'already_closed', 'log', to_jsonb(l), 'routine', to_jsonb(r));
  END;
  RETURN jsonb_build_object('status', 'saved', 'log', to_jsonb(l), 'routine', to_jsonb(r));
END;
$$;

-- 過去の訂正（実施日・メモ）。閉じた回の鍵（occurrence）は変えない。未来日は拒む。
CREATE FUNCTION public.update_cleaning_log(
  p_id uuid, p_version timestamptz, p_done_on date, p_note text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE h uuid; l public.cleaning_logs; v_note text; v_today date := irori_private.cleaning_today();
BEGIN
  h := irori_private.cleaning_begin();
  IF p_id IS NULL THEN RAISE EXCEPTION 'invalid log' USING ERRCODE = '22023'; END IF;
  v_note := irori_private.cleaning_text(p_note, 200, true, 'note');
  SELECT * INTO l FROM public.cleaning_logs t WHERE t.id = p_id AND t.household_id = h FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'log unavailable' USING ERRCODE = '42501'; END IF;
  IF l.kind = 'done' THEN
    IF NOT irori_private.cleaning_valid_date(p_done_on) THEN
      RAISE EXCEPTION 'invalid done_on' USING ERRCODE = '22023';
    END IF;
    IF p_done_on > v_today THEN
      RAISE EXCEPTION 'done_on in the future' USING ERRCODE = '22023';
    END IF;
  ELSIF p_done_on IS NOT NULL THEN
    RAISE EXCEPTION 'invalid done_on' USING ERRCODE = '22023';
  END IF;
  -- 取り消し済みの履歴は訂正しない（別の端末が取り消した）。最新を返す。
  IF l.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'conflict', 'log', to_jsonb(l));
  END IF;
  IF (l.done_on, l.note) IS NOT DISTINCT FROM (p_done_on, v_note) THEN
    RETURN jsonb_build_object('status', 'replayed', 'log', to_jsonb(l));
  END IF;
  IF p_version IS NULL OR l.updated_at <> p_version THEN
    RETURN jsonb_build_object('status', 'conflict', 'log', to_jsonb(l));
  END IF;
  UPDATE public.cleaning_logs t SET done_on = p_done_on, note = v_note, updated_at = clock_timestamp()
  WHERE t.id = p_id RETURNING * INTO l;
  RETURN jsonb_build_object('status', 'saved', 'log', to_jsonb(l));
END;
$$;

-- 取り消し。行は残し voided_at を立てる（その回は再び完了できるようになる）。
CREATE FUNCTION public.void_cleaning_log(p_id uuid, p_version timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE h uuid; l public.cleaning_logs;
BEGIN
  h := irori_private.cleaning_begin();
  IF p_id IS NULL THEN RAISE EXCEPTION 'invalid log' USING ERRCODE = '22023'; END IF;
  SELECT * INTO l FROM public.cleaning_logs t WHERE t.id = p_id AND t.household_id = h FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'log unavailable' USING ERRCODE = '42501'; END IF;
  IF l.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'replayed', 'log', to_jsonb(l));
  END IF;
  IF p_version IS NULL OR l.updated_at <> p_version THEN
    RETURN jsonb_build_object('status', 'conflict', 'log', to_jsonb(l));
  END IF;
  UPDATE public.cleaning_logs t SET voided_at = clock_timestamp(), voided_by = auth.uid(), updated_at = clock_timestamp()
  WHERE t.id = p_id RETURNING * INTO l;
  RETURN jsonb_build_object('status', 'saved', 'log', to_jsonb(l));
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. 読み取り: 有効な履歴の要約（周期計算に要る最大値だけ）
-- ─────────────────────────────────────────────────────────────────────────────

-- 全履歴を運ばずに「前回実施日」「最後に閉じた回」「最後にスキップした回」とその予定日を得る。
-- SECURITY INVOKER = cleaning_logs / cleaning_routines の RLS がそのまま効く（正規メンバーの世帯の行だけ）。
-- 前回実施日は全ての世代の有効な done から。閉じた回の鍵は**今の周期の世代**の履歴だけから取る
-- （周期を変える前の格子で閉じた鍵を数えると、新しい格子の予定日が覆われて黙って飛ぶ）。
-- last_skip_scheduled_on は max_skip_occurrence の回（今の世代の有効な行は一意索引で 1 行）の予定日。
-- 実施基準でスキップが最後の閉鎖なら、次回はこの予定日から数える（record_cleaning_log と同じ規則）。
CREATE FUNCTION public.cleaning_log_marks(p_routine_id uuid DEFAULT NULL)
RETURNS TABLE (routine_id uuid, last_done_on date, max_occurrence date, max_skip_occurrence date, last_skip_scheduled_on date)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT l.routine_id,
         max(l.done_on) FILTER (WHERE l.kind = 'done'),
         max(l.occurrence) FILTER (WHERE l.cadence_epoch = r.cadence_epoch),
         max(l.occurrence) FILTER (WHERE l.kind <> 'done' AND l.cadence_epoch = r.cadence_epoch),
         (array_agg(l.scheduled_on ORDER BY l.occurrence DESC)
            FILTER (WHERE l.kind <> 'done' AND l.cadence_epoch = r.cadence_epoch AND l.occurrence IS NOT NULL))[1]
  FROM public.cleaning_logs l
  JOIN public.cleaning_routines r ON r.household_id = l.household_id AND r.id = l.routine_id
  WHERE l.voided_at IS NULL
    AND l.household_id = (SELECT public.get_my_household_id())
    AND (p_routine_id IS NULL OR l.routine_id = p_routine_id)
  GROUP BY l.routine_id;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. EXECUTE 権限（シグネチャ完全一致で REVOKE → GRANT。anon には何も与えない）
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION irori_private.cleaning_today() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.cleaning_household() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.cleaning_begin() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.cleaning_text(text, integer, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.cleaning_valid_date(date) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.save_cleaning_routine(uuid, timestamptz, text, text, text, integer, text, date, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_cleaning_routine_state(uuid, timestamptz, text, date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_cleaning_log(uuid, uuid, timestamptz, text, date, date, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_cleaning_log(uuid, timestamptz, date, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.void_cleaning_log(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleaning_log_marks(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.save_cleaning_routine(uuid, timestamptz, text, text, text, integer, text, date, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_cleaning_routine_state(uuid, timestamptz, text, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_cleaning_log(uuid, uuid, timestamptz, text, date, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_cleaning_log(uuid, timestamptz, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_cleaning_log(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cleaning_log_marks(uuid) TO authenticated;
