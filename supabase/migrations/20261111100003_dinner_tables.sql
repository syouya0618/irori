-- =============================================================================
-- ごはん（献立・在庫・買い物）— 世帯単位の表と書込 RPC
--
-- 方針（docs/plans/2026-11-10-household-chores/implementation-notes.md §0 / §C）
--   * 全表が世帯単位。authenticated には SELECT だけを GRANT し、INSERT/UPDATE/DELETE の
--     GRANT もポリシーも作らない（= 直接 DML は 42501）。書込は下の SECURITY DEFINER RPC だけ。
--   * RPC は世帯 ID を引数で受けない。auth.uid() → profiles.household_id から導出し、
--     irori_private.is_household_editor() を「世帯ロックの前後」で 2 回検査する。
--   * 行 ID はクライアント採番 UUID（DEFAULT なし）。版は updated_at（RPC が clock_timestamp() を明示 SET）。
--   * 戻り値は jsonb の {status:'saved'|'replayed'|'conflict', ...}。判定順は
--     認可 → 入力検証(22023) → 行ロック → 他世帯の ID(42501) → 同内容(replayed) → 版違い(conflict) → 書込。
--     版つきで送られた行が既に無いとき（別端末が削除・献立の作り直しで置換）は
--     {status:'conflict', <entity>:{id, deleted:true}}。エラーにしないのは、応答を失った保存の再送が
--     「拒否」に見えて端末の控えが解消できなくなるのを避けるため（conflict は控えを消してよい応答）。
--   * 子ども閲覧招待（child_shares）は述語に登場させない。shared_child_snapshot にも触れない。
--   * 旧テーブル名・旧 ENUM 名（meals / shopping_items / stock_items 等）は再利用しない。ENUM は作らず text + CHECK。
--   * カタログ ID（食材・レシピ・アレルゲン・タグ）は ^[a-z0-9_-]{1,64}$。'|' や ',' を含められないので
--     grocery_items.item_key（食材ID|単位族）と staples の検査が曖昧にならない。
--
-- 変えないもの: 既存の表・関数・ポリシー・publication（Realtime には足さない）。
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. 表
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE public.dinner_settings (
  household_id uuid PRIMARY KEY REFERENCES public.households(id) ON DELETE CASCADE,
  servings smallint NOT NULL DEFAULT 2 CHECK (servings BETWEEN 1 AND 12),
  include_soup boolean NOT NULL DEFAULT false,
  max_cook_minutes smallint CHECK (max_cook_minutes BETWEEN 5 AND 180),
  -- 常備品の食材 ID。RPC が重複を除き昇順で保存する。
  staples text[] NOT NULL DEFAULT '{}',
  -- child_id → 保護者が設定した食事段階。鍵が世帯の子であることは RPC が検証する。
  child_stages jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(child_stages) = 'object'),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT dinner_settings_staples_shape CHECK (coalesce(array_ndims(staples), 1) = 1 AND cardinality(staples) <= 200),
  CONSTRAINT dinner_settings_staples_ids CHECK (
    array_position(staples, NULL) IS NULL
    AND array_to_string(staples, ',') ~ '^([a-z0-9_-]{1,64}(,[a-z0-9_-]{1,64})*)?$'
  )
);

CREATE TABLE public.pantry_items (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  -- 食材辞書へ解決できたときだけ入る。NULL は未解決（名前のまま扱う）。
  ingredient_id text CHECK (ingredient_id ~ '^[a-z0-9_-]{1,64}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  quantity numeric(9,2) CHECK (quantity > 0),
  unit text CHECK (char_length(unit) BETWEEN 1 AND 12),
  status text NOT NULL DEFAULT 'have' CHECK (status IN ('have','low','out')),
  use_soon boolean NOT NULL DEFAULT false,
  storage text CHECK (storage IN ('fridge','freezer','pantry')),
  expires_on date CHECK (isfinite(expires_on)),
  confirmed_on date NOT NULL CHECK (isfinite(confirmed_on)),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pantry_items_quantity_needs_unit CHECK (quantity IS NULL OR unit IS NOT NULL)
);
CREATE INDEX pantry_items_household ON public.pantry_items(household_id, created_at, id);

CREATE TABLE public.food_exclusions (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  subject_kind text NOT NULL CHECK (subject_kind IN ('household','member','child')),
  -- 同じ世帯の profile であることは RPC が検証する（profiles に (household_id,id) の一意制約が無い）。
  subject_profile_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  subject_child_id uuid,
  reason text NOT NULL CHECK (reason IN ('allergy','dislike')),
  target_kind text NOT NULL CHECK (target_kind IN ('allergen','ingredient','custom')),
  target_id text CHECK (target_id ~ '^[a-z0-9_-]{1,64}$'),
  custom_label text CHECK (char_length(btrim(custom_label)) BETWEEN 1 AND 30),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- 「誰の・どの理由の・何を」の同一性。reason を鍵に含めるのは、苦手として登録済みの対象へ
  -- 後からアレルギーを登録できなくなる（= 安全側の情報が落ちる）のを避けるため。
  dedupe_key text GENERATED ALWAYS AS (
    subject_kind || ':' || coalesce(subject_profile_id::text, subject_child_id::text, '')
    || '|' || reason || '|' || target_kind || ':' || coalesce(target_id, lower(btrim(custom_label)), '')
  ) STORED,
  -- 世帯またぎの子指定を DB が拒む。
  FOREIGN KEY (household_id, subject_child_id) REFERENCES public.children(household_id, id) ON DELETE CASCADE,
  CONSTRAINT food_exclusions_subject_shape CHECK (
    (subject_kind = 'household' AND subject_profile_id IS NULL AND subject_child_id IS NULL)
    OR (subject_kind = 'member' AND subject_profile_id IS NOT NULL AND subject_child_id IS NULL)
    OR (subject_kind = 'child' AND subject_profile_id IS NULL AND subject_child_id IS NOT NULL)
  ),
  CONSTRAINT food_exclusions_target_shape CHECK (
    (target_kind IN ('allergen','ingredient') AND target_id IS NOT NULL AND custom_label IS NULL)
    OR (target_kind = 'custom' AND target_id IS NULL AND custom_label IS NOT NULL)
  ),
  CONSTRAINT food_exclusions_dedupe UNIQUE (household_id, dedupe_key)
);
CREATE INDEX food_exclusions_child ON public.food_exclusions(household_id, subject_child_id) WHERE subject_child_id IS NOT NULL;

CREATE TABLE public.food_preferences (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  -- household = 家族共通として明示したもの / personal = 本人だけが変更できる。
  scope text NOT NULL CHECK (scope IN ('household','personal')),
  profile_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  target_kind text NOT NULL CHECK (target_kind IN ('recipe','ingredient','tag')),
  target_id text NOT NULL CHECK (target_id ~ '^[a-z0-9_-]{1,64}$'),
  sentiment text NOT NULL CHECK (sentiment IN ('like','dislike')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT food_preferences_owner_shape CHECK ((scope = 'personal') = (profile_id IS NOT NULL)),
  -- household 行は profile_id が NULL。NULL 同士も重複として扱う。
  CONSTRAINT food_preferences_target UNIQUE NULLS NOT DISTINCT (household_id, scope, profile_id, target_kind, target_id)
);

CREATE TABLE public.dish_feedback (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  -- 評価した本人（= auth.uid() 固定）。集約しても失わない。
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  recipe_id text CHECK (recipe_id ~ '^[a-z0-9_-]{1,64}$'),
  dish_title text NOT NULL CHECK (char_length(btrim(dish_title)) BETWEEN 1 AND 60),
  eaten_on date NOT NULL CHECK (isfinite(eaten_on)),
  taste smallint CHECK (taste BETWEEN 1 AND 3),
  effort smallint CHECK (effort BETWEEN 1 AND 3),
  again boolean,
  exclude_from_learning boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dish_key text GENERATED ALWAYS AS (coalesce('r:' || recipe_id, 't:' || lower(btrim(dish_title)))) STORED,
  CONSTRAINT dish_feedback_once UNIQUE (household_id, profile_id, dish_key, eaten_on)
);
CREATE INDEX dish_feedback_household_date ON public.dish_feedback(household_id, eaten_on DESC, id);

CREATE TABLE public.dinner_plan_state (
  household_id uuid PRIMARY KEY REFERENCES public.households(id) ON DELETE CASCADE,
  -- 献立全体の版。献立を変える RPC が成功するたびに +1。行が無い世帯は 0 として扱う。
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  last_operation_id uuid,
  last_request_hash text,
  -- 買い物の自動項目を最後に同期した操作と、そのとき基にした献立の版。
  grocery_operation_id uuid,
  grocery_request_hash text,
  grocery_revision bigint,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.dinner_plan_entries (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  plan_date date NOT NULL CHECK (isfinite(plan_date)),
  role text NOT NULL CHECK (role IN ('main','side','staple','soup')),
  position smallint NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 9),
  recipe_id text CHECK (recipe_id ~ '^[a-z0-9_-]{1,64}$'),
  recipe_version smallint CHECK (recipe_version >= 1),
  custom_title text CHECK (char_length(btrim(custom_title)) BETWEEN 1 AND 60),
  -- 手動料理の材料（アプリの RecipeIngredient[]）。NULL は「買い物の自動計算の対象外」。
  custom_ingredients jsonb CHECK (jsonb_typeof(custom_ingredients) = 'array'),
  servings smallint NOT NULL CHECK (servings BETWEEN 1 AND 12),
  pinned boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed','cooked','skipped')),
  -- 「作った」「作らなかった」にする直前の状態（取り消しで戻す先）。遷移の時に save_dinner_entry が保持する
  -- （payload からは受けない）。cooked と skipped の間の行き来では保ち、提案・確定へ戻ると消す。
  prior_status text CHECK (prior_status IN ('proposed','confirmed')),
  origin text NOT NULL CHECK (origin IN ('auto','manual','ai_assisted')),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- カタログのレシピか手動料理のどちらか一方。レシピは必ず版を伴う。
  CONSTRAINT dinner_plan_entries_dish CHECK (
    (recipe_id IS NOT NULL AND recipe_version IS NOT NULL AND custom_title IS NULL AND custom_ingredients IS NULL)
    OR (recipe_id IS NULL AND recipe_version IS NULL AND custom_title IS NOT NULL)
  ),
  CONSTRAINT dinner_plan_entries_prior_status CHECK (prior_status IS NULL OR status IN ('cooked','skipped')),
  CONSTRAINT dinner_plan_entries_slot UNIQUE (household_id, plan_date, role, position)
);

CREATE TABLE public.grocery_items (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  origin text NOT NULL CHECK (origin IN ('auto','manual')),
  -- auto: 食材ID|単位族（再計算で同じ鍵へ upsert）/ manual: 'manual|' || id。
  item_key text NOT NULL CHECK (char_length(item_key) BETWEEN 3 AND 100),
  ingredient_id text CHECK (ingredient_id ~ '^[a-z0-9_-]{1,64}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  -- 利用者による売場の上書き。NULL は食材辞書の既定。
  section text CHECK (section ~ '^[a-z_]{1,20}$'),
  required_quantity numeric(12,3) CHECK (required_quantity > 0),
  unit text CHECK (char_length(unit) BETWEEN 1 AND 12),
  -- 「適量」「少々」など数値化しなかった分。
  required_note text CHECK (char_length(required_note) BETWEEN 1 AND 200),
  needs_stock_check boolean NOT NULL DEFAULT false,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sources) = 'array'),
  -- 購入の事実。書くのは利用者の購入の操作（set_grocery_purchase）だけ。必要量が後から増えても、
  -- 「作った」・同期でも書き換えない。purchased は数値化しない項目の印（量の項目では「買った時点で残り 0 か」）。
  purchased_quantity numeric(12,3) NOT NULL DEFAULT 0 CHECK (purchased_quantity >= 0),
  purchased boolean NOT NULL DEFAULT false,
  purchased_at timestamptz,
  purchased_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- 購入の事実（量・印）か、その意味（品名・単位）を最後に変えた時刻（= その時の updated_at）。NULL は一度も変えていない。
  -- set_grocery_purchase は版をこれと照らす: 送られた版がこれ以後なら、画面は今の購入の事実とその意味を見ていた
  -- （その後に変わったのが必要量・出所・充当・補充・メモだけなら、購入の合計を上書きしても家族の購入を消さない）。
  -- 品名・単位を変える書込（手動の項目の編集・同期で単位が変わる自動の項目）もこれを進める（「2 本」を「2 ml」にしない）。
  purchase_updated_at timestamptz,
  -- 在庫へ補充した量（購入とは別の事実）。restock_ids は反映済みの在庫行 ID（同じ ID の再送を二重に足さない）。
  restocked_quantity numeric(12,3) NOT NULL DEFAULT 0 CHECK (restocked_quantity >= 0),
  restock_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(restock_ids) <= 50),
  -- 実消費の台帳: 作った（または確定のまま日が過ぎた）料理へ充当した購入。書くのは irori_private.dinner_grocery_settle
  -- だけ（同期・「作った」などの献立の状態の変更・購入・補充の各 RPC が、書く前に呼ぶ）。
  --   要素 {k: 枠 ID | 'settled', q: 量（項目の単位）, m: 数値化しない印のまとまりに入っているか, d: 枠の日付,
  --         on: 充当中か, pc: 眠らせた時に印を戻したか}。
  --   on=false は「眠り」: 作らなかった・取り消し等で数えるのをやめた記録と、消費されずに必要量から外れた枠の需要。
  --   枠がまた消費済み（必要量には載らない）になれば、min(q, 充てられる量) で起こす（過ぎた日の枠の取り消しで充当を失わない）。
  --   'settled' は取り消せなくなった充当（枠の削除・日付の古い枠・枠の無い出所）を畳んだ 1 件。
  --   consumed_quantity は on の記録の q の合計（CHECK で一致を保つ。下の §3 の irori_private.dinner_ledger_total）。
  -- 今の必要に充てられる購入 = purchased_quantity − restocked_quantity − consumed_quantity（0 未満にしない）。
  -- 残り（不足）= required_quantity − その量。
  consumptions jsonb NOT NULL DEFAULT '[]'::jsonb,
  consumed_quantity numeric(12,3) NOT NULL DEFAULT 0 CHECK (consumed_quantity >= 0),
  -- 購入の印（purchased）を、作った料理で使い終えたか。画面の印 = purchased AND NOT purchase_consumed。
  -- 次の購入の操作で false に戻る（使い終えた後の買い直しは新しい事実）。
  purchase_consumed boolean NOT NULL DEFAULT false,
  note text CHECK (char_length(note) BETWEEN 1 AND 200),
  plan_revision bigint,
  -- false = 献立からは不要になったが、購入・メモ・補充の記録があるので残している自動項目。
  still_needed boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT grocery_items_key UNIQUE (household_id, item_key),
  CONSTRAINT grocery_items_purchase_consumed CHECK (NOT purchase_consumed OR purchased),
  CONSTRAINT grocery_items_key_shape CHECK (
    (origin = 'manual' AND item_key = 'manual|' || id::text)
    OR (origin = 'auto' AND ingredient_id IS NOT NULL
        AND item_key ~ '^[a-z0-9_-]{1,64}\|[a-z0-9_:-]{1,24}$'
        AND starts_with(item_key, ingredient_id || '|')
        AND NOT starts_with(item_key, 'manual|'))
  )
);

-- AI 補助の回数計上（世帯 × UTC 日）と、無料枠の枯渇による全体停止。RPC 経由のみ（deny-all）。
CREATE TABLE public.dinner_ai_usage (
  household_id uuid NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  usage_day date NOT NULL CHECK (isfinite(usage_day)),
  calls smallint NOT NULL CHECK (calls BETWEEN 1 AND 10),
  PRIMARY KEY (household_id, usage_day)
);
CREATE TABLE public.dinner_ai_provider_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  exhausted_until timestamptz CHECK (isfinite(exhausted_until)),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.dinner_ai_provider_state(id) VALUES (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. RLS と権限（hosted / local の既定 GRANT の差に依存しないよう、明示的に同じ ACL へ収束させる）
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.dinner_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pantry_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.food_exclusions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.food_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dish_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dinner_plan_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dinner_plan_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grocery_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dinner_ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dinner_ai_provider_state ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON
  public.dinner_settings, public.pantry_items, public.food_exclusions, public.food_preferences,
  public.dish_feedback, public.dinner_plan_state, public.dinner_plan_entries, public.grocery_items,
  public.dinner_ai_usage, public.dinner_ai_provider_state
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON
  public.dinner_settings, public.pantry_items, public.food_exclusions, public.food_preferences,
  public.dish_feedback, public.dinner_plan_state, public.dinner_plan_entries, public.grocery_items
TO authenticated;

GRANT ALL ON
  public.dinner_settings, public.pantry_items, public.food_exclusions, public.food_preferences,
  public.dish_feedback, public.dinner_plan_state, public.dinner_plan_entries, public.grocery_items,
  public.dinner_ai_usage, public.dinner_ai_provider_state
TO service_role;

-- SELECT のみ。INSERT / UPDATE / DELETE は GRANT もポリシーも無い（= 拒否）。
-- 個人の好み・食後評価も「読むのは世帯の正規メンバー全員」。書けるのは本人だけ（RPC が検証）。
CREATE POLICY dinner_settings_select ON public.dinner_settings FOR SELECT TO authenticated
  USING (irori_private.is_household_editor(household_id));
CREATE POLICY pantry_items_select ON public.pantry_items FOR SELECT TO authenticated
  USING (irori_private.is_household_editor(household_id));
CREATE POLICY food_exclusions_select ON public.food_exclusions FOR SELECT TO authenticated
  USING (irori_private.is_household_editor(household_id));
CREATE POLICY food_preferences_select ON public.food_preferences FOR SELECT TO authenticated
  USING (irori_private.is_household_editor(household_id));
CREATE POLICY dish_feedback_select ON public.dish_feedback FOR SELECT TO authenticated
  USING (irori_private.is_household_editor(household_id));
CREATE POLICY dinner_plan_state_select ON public.dinner_plan_state FOR SELECT TO authenticated
  USING (irori_private.is_household_editor(household_id));
CREATE POLICY dinner_plan_entries_select ON public.dinner_plan_entries FOR SELECT TO authenticated
  USING (irori_private.is_household_editor(household_id));
CREATE POLICY grocery_items_select ON public.grocery_items FOR SELECT TO authenticated
  USING (irori_private.is_household_editor(household_id));
-- dinner_ai_usage / dinner_ai_provider_state はポリシー 0 本・GRANT なし = deny-all。

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. 内部ヘルパ（irori_private。誰にも GRANT しない = DEFINER RPC の内側専用）
-- ─────────────────────────────────────────────────────────────────────────────

-- 呼び手の世帯。正規メンバー（承認済みの owner / member）でなければ 42501。
CREATE FUNCTION irori_private.dinner_household() RETURNS uuid
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

-- 認可 → 世帯単位の advisory lock → ロック待ちの後に認可を再評価。ごはんの書込 RPC は全てここから始める。
CREATE FUNCTION irori_private.dinner_begin() RETURNS uuid
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE h uuid;
BEGIN
  h := irori_private.dinner_household();
  PERFORM pg_advisory_xact_lock(hashtextextended('dinner:' || h::text, 0));
  IF irori_private.dinner_household() IS DISTINCT FROM h THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  RETURN h;
END;
$$;

-- 「版つきで届いたが行が既に無い」（別の端末が削除・献立の作り直しで置き換えた）ときに conflict へ載せる印。
-- 行の代わりに {id, deleted:true} を返す（null にしない: 呼び出し側の共通 parser は行が object であることを要求する）。
CREATE FUNCTION irori_private.dinner_gone(p_id uuid) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_build_object('id', p_id, 'deleted', true);
$$;

-- 表示用の短い文字列。前後の空白を除き、空・長すぎ・制御文字を拒む。
CREATE FUNCTION irori_private.dinner_label(s text, maxlen integer, nullable boolean, what text) RETURNS text
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

-- jsonb の object から型つきで取り出す。型・範囲・null が合わなければ 22023。
CREATE FUNCTION irori_private.dinner_j_keys(p jsonb, allowed text[]) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'invalid payload' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p) k WHERE NOT (k = ANY(allowed))) THEN
    RAISE EXCEPTION 'unknown field' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE FUNCTION irori_private.dinner_j_text(p jsonb, k text, pat text, nullable boolean) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v jsonb := p -> k; s text;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN
    IF nullable THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'invalid %', k USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v) <> 'string' THEN RAISE EXCEPTION 'invalid %', k USING ERRCODE = '22023'; END IF;
  s := v #>> '{}';
  IF s !~ pat THEN RAISE EXCEPTION 'invalid %', k USING ERRCODE = '22023'; END IF;
  RETURN s;
END;
$$;

CREATE FUNCTION irori_private.dinner_j_label(p jsonb, k text, maxlen integer, nullable boolean) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v jsonb := p -> k;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN RETURN irori_private.dinner_label(NULL, maxlen, nullable, k); END IF;
  IF jsonb_typeof(v) <> 'string' THEN RAISE EXCEPTION 'invalid %', k USING ERRCODE = '22023'; END IF;
  RETURN irori_private.dinner_label(v #>> '{}', maxlen, nullable, k);
END;
$$;

CREATE FUNCTION irori_private.dinner_j_int(p jsonb, k text, lo integer, hi integer, nullable boolean) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v jsonb := p -> k; n numeric;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN
    IF nullable THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'invalid %', k USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v) <> 'number' THEN RAISE EXCEPTION 'invalid %', k USING ERRCODE = '22023'; END IF;
  n := (v #>> '{}')::numeric;
  IF n <> trunc(n) OR n < lo OR n > hi THEN RAISE EXCEPTION 'invalid %', k USING ERRCODE = '22023'; END IF;
  RETURN n::integer;
END;
$$;

-- 正の数量。scale 桁へ丸めた後に 0 < n <= maxv を要求する。
CREATE FUNCTION irori_private.dinner_qty(n numeric, maxv numeric, scale integer, what text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE r numeric;
BEGIN
  IF n IS NULL THEN RETURN NULL; END IF;
  IF n = 'NaN'::numeric OR n > maxv OR n < 0 THEN RAISE EXCEPTION 'invalid %', what USING ERRCODE = '22023'; END IF;
  r := round(n, scale);
  IF r <= 0 THEN RAISE EXCEPTION 'invalid %', what USING ERRCODE = '22023'; END IF;
  RETURN r;
END;
$$;

CREATE FUNCTION irori_private.dinner_j_qty(p jsonb, k text, maxv numeric, scale integer) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v jsonb := p -> k;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(v) <> 'number' THEN RAISE EXCEPTION 'invalid %', k USING ERRCODE = '22023'; END IF;
  RETURN irori_private.dinner_qty((v #>> '{}')::numeric, maxv, scale, k);
END;
$$;

CREATE FUNCTION irori_private.dinner_j_bool(p jsonb, k text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v jsonb := p -> k;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) <> 'boolean' THEN RAISE EXCEPTION 'invalid %', k USING ERRCODE = '22023'; END IF;
  RETURN (v #>> '{}')::boolean;
END;
$$;

-- YYYY-MM-DD だけを受ける（'today' 'infinity' や暦に無い日を拒む）。
CREATE FUNCTION irori_private.dinner_j_date(p jsonb, k text, nullable boolean) RETURNS date
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v jsonb := p -> k; d date;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN
    IF nullable THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'invalid %', k USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v) <> 'string' OR (v #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'invalid %', k USING ERRCODE = '22023';
  END IF;
  BEGIN
    d := (v #>> '{}')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid %', k USING ERRCODE = '22023';
  END;
  RETURN d;
END;
$$;

CREATE FUNCTION irori_private.dinner_j_uuid(p jsonb, k text) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v jsonb := p -> k;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) <> 'string'
     OR (v #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid %', k USING ERRCODE = '22023';
  END IF;
  RETURN (v #>> '{}')::uuid;
END;
$$;

-- アプリの Quantity（{amount: 正の数 | null, unit: 文字列}）。
CREATE FUNCTION irori_private.dinner_valid_quantity(q jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF q IS NULL OR jsonb_typeof(q) <> 'object' THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(q) k WHERE k NOT IN ('amount','unit')) THEN RETURN false; END IF;
  IF jsonb_typeof(q -> 'unit') IS DISTINCT FROM 'string' OR char_length(q ->> 'unit') NOT BETWEEN 1 AND 12 THEN RETURN false; END IF;
  IF jsonb_typeof(q -> 'amount') = 'number' THEN
    RETURN (q ->> 'amount')::numeric > 0 AND (q ->> 'amount')::numeric <= 9999999;
  END IF;
  RETURN jsonb_typeof(q -> 'amount') IS NOT DISTINCT FROM 'null';
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

-- 手動料理の材料（アプリの RecipeIngredient[]）。
CREATE FUNCTION irori_private.dinner_valid_ingredients(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE q jsonb;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) <> 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(v) > 40 THEN RETURN false; END IF;
  FOR q IN SELECT e.value FROM jsonb_array_elements(v) e LOOP
    IF jsonb_typeof(q) <> 'object' THEN RETURN false; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(q) k WHERE k NOT IN ('ingredientId','quantity','optional','note')) THEN RETURN false; END IF;
    IF jsonb_typeof(q -> 'ingredientId') IS DISTINCT FROM 'string' OR (q ->> 'ingredientId') !~ '^[a-z0-9_-]{1,64}$' THEN RETURN false; END IF;
    IF NOT irori_private.dinner_valid_quantity(q -> 'quantity') THEN RETURN false; END IF;
    IF q ? 'optional' AND jsonb_typeof(q -> 'optional') <> 'boolean' THEN RETURN false; END IF;
    IF q ? 'note' AND (jsonb_typeof(q -> 'note') <> 'string' OR char_length(q ->> 'note') > 60) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

-- 買い物項目の出所（アプリの GrocerySource[] + 作った料理への充当に使う 2 項目）。
--   entryId: その必要量を生んだ献立の枠（dinner_plan_entries.id）。特定できなければ null / 省略。
--   buy    : その枠が買い物へ載せた正味量（必要量 − 在庫でまかなう量。項目の単位）。数値化しない分は null / 省略。
--            1 項目の buy の合計は required_quantity に等しい（アプリが計算する。sync_grocery_auto_items の「充当」を参照）。
CREATE FUNCTION irori_private.dinner_valid_sources(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE q jsonb;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) <> 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(v) > 40 OR char_length(v::text) > 16000 THEN RETURN false; END IF;
  FOR q IN SELECT e.value FROM jsonb_array_elements(v) e LOOP
    IF jsonb_typeof(q) <> 'object' THEN RETURN false; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(q) k WHERE k NOT IN ('date','recipeId','title','quantity','entryId','buy')) THEN RETURN false; END IF;
    IF jsonb_typeof(q -> 'entryId') = 'string' THEN
      IF (q ->> 'entryId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
    ELSIF q ? 'entryId' AND jsonb_typeof(q -> 'entryId') <> 'null' THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(q -> 'buy') = 'number' THEN
      IF (q ->> 'buy')::numeric < 0 OR (q ->> 'buy')::numeric > 9999999 THEN RETURN false; END IF;
    ELSIF q ? 'buy' AND jsonb_typeof(q -> 'buy') <> 'null' THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(q -> 'date') IS DISTINCT FROM 'string' OR (q ->> 'date') !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN false; END IF;
    IF jsonb_typeof(q -> 'title') IS DISTINCT FROM 'string' OR char_length(btrim(q ->> 'title')) NOT BETWEEN 1 AND 60 THEN RETURN false; END IF;
    IF jsonb_typeof(q -> 'recipeId') = 'string' THEN
      IF (q ->> 'recipeId') !~ '^[a-z0-9_-]{1,64}$' THEN RETURN false; END IF;
    ELSIF jsonb_typeof(q -> 'recipeId') IS DISTINCT FROM 'null' THEN
      RETURN false;
    END IF;
    IF NOT irori_private.dinner_valid_quantity(q -> 'quantity') THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

-- 在庫 1 件の payload → 行型。household_id / id / created_by / 時刻は呼び出し側が埋める。
CREATE FUNCTION irori_private.dinner_pantry_parse(p jsonb) RETURNS public.pantry_items
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE n public.pantry_items; today date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
BEGIN
  PERFORM irori_private.dinner_j_keys(p, ARRAY['ingredient_id','name','quantity','unit','status','use_soon','storage','expires_on','confirmed_on']);
  n.ingredient_id := irori_private.dinner_j_text(p, 'ingredient_id', '^[a-z0-9_-]{1,64}$', true);
  n.name := irori_private.dinner_j_label(p, 'name', 40, false);
  n.quantity := irori_private.dinner_j_qty(p, 'quantity', 9999999.99, 2);
  n.unit := irori_private.dinner_j_label(p, 'unit', 12, true);
  n.status := irori_private.dinner_j_text(p, 'status', '^(have|low|out)$', false);
  n.use_soon := irori_private.dinner_j_bool(p, 'use_soon');
  n.storage := irori_private.dinner_j_text(p, 'storage', '^(fridge|freezer|pantry)$', true);
  n.expires_on := irori_private.dinner_j_date(p, 'expires_on', true);
  n.confirmed_on := irori_private.dinner_j_date(p, 'confirmed_on', false);
  IF n.quantity IS NOT NULL AND n.unit IS NULL THEN
    RAISE EXCEPTION 'quantity needs a unit' USING ERRCODE = '22023';
  END IF;
  IF n.expires_on IS NOT NULL AND n.expires_on NOT BETWEEN DATE '2000-01-01' AND DATE '2100-12-31' THEN
    RAISE EXCEPTION 'invalid expires_on' USING ERRCODE = '22023';
  END IF;
  -- 最終確認日は今日（JST）以前。
  IF n.confirmed_on NOT BETWEEN DATE '2000-01-01' AND today THEN
    RAISE EXCEPTION 'invalid confirmed_on' USING ERRCODE = '22023';
  END IF;
  RETURN n;
END;
$$;

-- 在庫 1 件の作成・更新。p_bulk（まとめ入力）は「作成か、同内容の再送」だけを受ける。
CREATE FUNCTION irori_private.dinner_pantry_put(h uuid, p_id uuid, p_version timestamptz, p jsonb, p_bulk boolean) RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE n public.pantry_items; r public.pantry_items;
BEGIN
  IF p_id IS NULL THEN RAISE EXCEPTION 'invalid id' USING ERRCODE = '22023'; END IF;
  n := irori_private.dinner_pantry_parse(p);
  SELECT * INTO r FROM public.pantry_items t WHERE t.id = p_id FOR UPDATE;
  IF FOUND THEN
    IF r.household_id <> h THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
    IF (r.ingredient_id, r.name, r.quantity, r.unit, r.status, r.use_soon, r.storage, r.expires_on, r.confirmed_on)
       IS NOT DISTINCT FROM (n.ingredient_id, n.name, n.quantity, n.unit, n.status, n.use_soon, n.storage, n.expires_on, n.confirmed_on) THEN
      RETURN jsonb_build_object('status', 'replayed', 'item', to_jsonb(r));
    END IF;
    IF p_bulk THEN RAISE EXCEPTION 'request id conflict' USING ERRCODE = '23505'; END IF;
    IF p_version IS NULL OR r.updated_at <> p_version THEN
      RETURN jsonb_build_object('status', 'conflict', 'item', to_jsonb(r));
    END IF;
    UPDATE public.pantry_items t SET
      ingredient_id = n.ingredient_id, name = n.name, quantity = n.quantity, unit = n.unit, status = n.status,
      use_soon = n.use_soon, storage = n.storage, expires_on = n.expires_on, confirmed_on = n.confirmed_on,
      updated_at = clock_timestamp()
    WHERE t.id = p_id RETURNING * INTO r;
  ELSE
    -- 版つきで届いたのに行が無い = 別の端末が削除した。
    IF p_version IS NOT NULL THEN RETURN jsonb_build_object('status', 'conflict', 'item', irori_private.dinner_gone(p_id)); END IF;
    INSERT INTO public.pantry_items(id, household_id, ingredient_id, name, quantity, unit, status, use_soon, storage, expires_on, confirmed_on, created_by)
    VALUES (p_id, h, n.ingredient_id, n.name, n.quantity, n.unit, n.status, n.use_soon, n.storage, n.expires_on, n.confirmed_on, auth.uid())
    RETURNING * INTO r;
  END IF;
  RETURN jsonb_build_object('status', 'saved', 'item', to_jsonb(r));
END;
$$;

-- 献立 1 枠の payload → 行型。
CREATE FUNCTION irori_private.dinner_entry_parse(p jsonb) RETURNS public.dinner_plan_entries
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE n public.dinner_plan_entries; today date := (now() AT TIME ZONE 'Asia/Tokyo')::date; ci jsonb;
BEGIN
  PERFORM irori_private.dinner_j_keys(p, ARRAY['plan_date','role','position','recipe_id','recipe_version','custom_title','custom_ingredients','servings','pinned','status','origin']);
  n.plan_date := irori_private.dinner_j_date(p, 'plan_date', false);
  n.role := irori_private.dinner_j_text(p, 'role', '^(main|side|staple|soup)$', false);
  n.position := irori_private.dinner_j_int(p, 'position', 0, 9, false);
  n.recipe_id := irori_private.dinner_j_text(p, 'recipe_id', '^[a-z0-9_-]{1,64}$', true);
  n.recipe_version := irori_private.dinner_j_int(p, 'recipe_version', 1, 32767, true);
  n.custom_title := irori_private.dinner_j_label(p, 'custom_title', 60, true);
  n.servings := irori_private.dinner_j_int(p, 'servings', 1, 12, false);
  n.pinned := irori_private.dinner_j_bool(p, 'pinned');
  n.status := irori_private.dinner_j_text(p, 'status', '^(proposed|confirmed|cooked|skipped)$', false);
  n.origin := irori_private.dinner_j_text(p, 'origin', '^(auto|manual|ai_assisted)$', false);
  ci := p -> 'custom_ingredients';
  IF ci IS NULL OR jsonb_typeof(ci) = 'null' THEN
    n.custom_ingredients := NULL;
  ELSE
    IF NOT irori_private.dinner_valid_ingredients(ci) THEN
      RAISE EXCEPTION 'invalid custom_ingredients' USING ERRCODE = '22023';
    END IF;
    n.custom_ingredients := ci;
  END IF;
  IF n.plan_date NOT BETWEEN today - 400 AND today + 400 THEN
    RAISE EXCEPTION 'invalid plan_date' USING ERRCODE = '22023';
  END IF;
  -- カタログのレシピ（版つき）か手動料理のどちらか一方。
  IF NOT ((n.recipe_id IS NOT NULL AND n.recipe_version IS NOT NULL AND n.custom_title IS NULL AND n.custom_ingredients IS NULL)
          OR (n.recipe_id IS NULL AND n.recipe_version IS NULL AND n.custom_title IS NOT NULL)) THEN
    RAISE EXCEPTION 'recipe and custom dish are exclusive' USING ERRCODE = '22023';
  END IF;
  -- 未来日を「作った」にしない。
  IF n.status = 'cooked' AND n.plan_date > today THEN
    RAISE EXCEPTION 'future dish cannot be cooked' USING ERRCODE = '22023';
  END IF;
  RETURN n;
END;
$$;

-- 献立の版の行を（無ければ作って）ロックして返す。
CREATE FUNCTION irori_private.dinner_state(h uuid) RETURNS public.dinner_plan_state
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE st public.dinner_plan_state;
BEGIN
  INSERT INTO public.dinner_plan_state(household_id) VALUES (h) ON CONFLICT (household_id) DO NOTHING;
  SELECT * INTO st FROM public.dinner_plan_state s WHERE s.household_id = h FOR UPDATE;
  RETURN st;
END;
$$;

CREATE FUNCTION irori_private.dinner_bump(h uuid) RETURNS bigint
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v bigint;
BEGIN
  UPDATE public.dinner_plan_state s SET revision = s.revision + 1, updated_at = clock_timestamp()
  WHERE s.household_id = h RETURNING s.revision INTO v;
  RETURN v;
END;
$$;

CREATE FUNCTION irori_private.dinner_entries_json(h uuid, d1 date, d2 date) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.plan_date, e.role, e.position), '[]'::jsonb)
  FROM public.dinner_plan_entries e
  WHERE e.household_id = h AND e.plan_date BETWEEN d1 AND d2;
$$;

-- 買い物の自動項目 1 件の payload → 行型。section（利用者の上書き）・購入・補充・メモは受け取らない。
CREATE FUNCTION irori_private.dinner_grocery_parse(p jsonb) RETURNS public.grocery_items
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE n public.grocery_items;
BEGIN
  PERFORM irori_private.dinner_j_keys(p, ARRAY['item_key','ingredient_id','name','required_quantity','unit','required_note','needs_stock_check','sources']);
  n.item_key := irori_private.dinner_j_text(p, 'item_key', '^[a-z0-9_-]{1,64}\|[a-z0-9_:-]{1,24}$', false);
  n.ingredient_id := irori_private.dinner_j_text(p, 'ingredient_id', '^[a-z0-9_-]{1,64}$', false);
  n.name := irori_private.dinner_j_label(p, 'name', 40, false);
  n.required_quantity := irori_private.dinner_j_qty(p, 'required_quantity', 9999999, 3);
  n.unit := irori_private.dinner_j_label(p, 'unit', 12, true);
  n.required_note := irori_private.dinner_j_label(p, 'required_note', 200, true);
  n.needs_stock_check := irori_private.dinner_j_bool(p, 'needs_stock_check');
  n.sources := p -> 'sources';
  IF NOT irori_private.dinner_valid_sources(n.sources) THEN
    RAISE EXCEPTION 'invalid sources' USING ERRCODE = '22023';
  END IF;
  IF NOT starts_with(n.item_key, n.ingredient_id || '|') OR starts_with(n.item_key, 'manual|') THEN
    RAISE EXCEPTION 'invalid item_key' USING ERRCODE = '22023';
  END IF;
  RETURN n;
END;
$$;

-- 実消費の台帳（grocery_items.consumptions）の形を確かめ、充当中（on）の量の合計を返す。形が違えば NULL
-- （CHECK grocery_items_consumptions が拒む。NULL を「合計 0」と読み替えない）。
--   要素は {k, q, m, on[, d][, pc]} だけ。k は枠 ID（UUID）か 'settled'（重複なし。'settled' は on=true）、
--   q は小数 3 桁までの 0 以上の数、m・on・pc は真偽、d は YYYY-MM-DD か null。
--   件数は 200 まで（dinner_grocery_settle が 150 件を超えた分を畳む）。
CREATE FUNCTION irori_private.dinner_ledger_total(v jsonb) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE e jsonb; total numeric := 0; seen text[] := '{}'; q numeric;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) <> 'array' OR jsonb_array_length(v) > 200 THEN RETURN NULL; END IF;
  FOR e IN SELECT x.value FROM jsonb_array_elements(v) x LOOP
    IF jsonb_typeof(e) <> 'object' THEN RETURN NULL; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(e) k WHERE k NOT IN ('k','q','m','d','on','pc')) THEN RETURN NULL; END IF;
    IF jsonb_typeof(e -> 'k') IS DISTINCT FROM 'string' OR jsonb_typeof(e -> 'q') IS DISTINCT FROM 'number'
       OR jsonb_typeof(e -> 'm') IS DISTINCT FROM 'boolean' OR jsonb_typeof(e -> 'on') IS DISTINCT FROM 'boolean' THEN
      RETURN NULL;
    END IF;
    IF e ? 'pc' AND jsonb_typeof(e -> 'pc') <> 'boolean' THEN RETURN NULL; END IF;
    IF (e ->> 'k') = 'settled' THEN
      IF NOT (e ->> 'on')::boolean THEN RETURN NULL; END IF;
    ELSIF (e ->> 'k') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN NULL;
    END IF;
    IF (e ->> 'k') = ANY(seen) THEN RETURN NULL; END IF;
    IF e ? 'd' AND jsonb_typeof(e -> 'd') <> 'null'
       AND (jsonb_typeof(e -> 'd') <> 'string' OR (e ->> 'd') !~ '^\d{4}-\d{2}-\d{2}$') THEN
      RETURN NULL;
    END IF;
    q := (e ->> 'q')::numeric;
    IF q < 0 OR q > 9999999 OR q <> round(q, 3) THEN RETURN NULL; END IF;
    seen := seen || (e ->> 'k');
    IF (e ->> 'on')::boolean THEN total := total + q; END IF;
  END LOOP;
  RETURN total;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END;
$$;

ALTER TABLE public.grocery_items ADD CONSTRAINT grocery_items_consumptions
  CHECK (irori_private.dinner_ledger_total(consumptions) IS NOT DISTINCT FROM consumed_quantity);

-- 1 行の充当の台帳（consumptions / consumed_quantity / purchase_consumed）を、献立の枠の今の状態へ合わせる。
-- 台帳を書くのはこの関数だけ。呼び手は世帯ロック（dinner_begin）の内側の RPC:
--   * sync_grocery_auto_items … p_next = この項目の新しい必要量の出所。
--   * save_dinner_entry（状態・日付が変わった枠を出所か台帳に持つ行）・set_grocery_purchase・restock_pantry_from_grocery
--     … p_next = NULL（同期を待たずに合わせる。今の出所のうち、まだ消費済みでない出所が必要量に載っているとみなす）。
--     同期が失敗しても「作った」の直後から使った分を在庫へ足せず、日が過ぎた枠も補充・購入の前に数える。
-- 順序（1 行の中）:
--   (1) 既にある記録を見直す。
--       * 枠が消えた・35 日より前 → 充当中なら残したまま 'settled' へ畳む。眠りは捨てる。
--       * この項目の必要量に再び載った → この記録だけを外す（消費されれば、出所から改めて記録する）。
--       * もう消費済みでない（作らなかった・取り消し・未来へ移動）→ 充当中なら眠らせる（on=false。q はそのまま）。
--       * 消費済みで眠り → (2) の後に min(q, 充てられる量) で起こす（過ぎた日の枠を取り消しても充当を失わない）。
--   (2) 充てられる量 = max(0, purchased_quantity − restocked_quantity − 充当中の合計)。
--   (3) 今の出所のうち、必要量に載っておらず消費済み（作った・確定のまま日が過ぎた。枠の無い出所は日付が今日より前）の
--       ものを、記録の無い枠に限り 1 回だけ記録する。量 = min(buy, 充てられる量)（作った枠は 0 でも記録し、作った後の
--       購入を充てない。確定のまま日が過ぎた枠で 0 のときは記録を待つ）。
--       同じ行で複数を記録するときは充てられる量を順に減らす。枠の無い出所は取り消せないので 'settled' へ。
--       消費されないまま必要量から外れた「作らなかった」枠は、需要（buy）を眠りとして覚える（後の取り消しで起こす）。
--   印（purchase_consumed）: 量の購入は「充当が増えたら立て、記録が外れたら下ろす」。印だけの購入（量 0）は、
--     印が生きている間に済んだ枠を m=true で記録し、出所が全て済んだら立てる。まとまりの枠を眠らせたら下ろし（pc に覚える）、
--     その枠を起こしたら立て直す。
--   同じ状態での再実行では書かない（戻り値 false。版も進めない）。
CREATE FUNCTION irori_private.dinner_grocery_settle(h uuid, p_id uuid, p_next jsonb) RETURNS boolean
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  cur public.grocery_items; ent public.dinner_plan_entries; rec record; v_next jsonb;
  v_ledger jsonb := '[]'::jsonb; v_wake jsonb := '[]'::jsonb; v_settled numeric := 0; v_avail numeric; v_q numeric; v_i bigint;
  v_key text; v_buy numeric; v_listed boolean; v_spent boolean; v_on boolean; v_m boolean; v_found boolean;
  v_reverted boolean := false; v_reverted_mark boolean := false; v_added_qty boolean := false;
  v_woke_mark boolean := false; v_woke_pc boolean := false;
  v_tick_alive boolean; v_all_spent boolean; v_consumed numeric; v_pc boolean;
  today date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
BEGIN
  SELECT * INTO cur FROM public.grocery_items t WHERE t.id = p_id AND t.household_id = h AND t.origin = 'auto' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_next IS NULL THEN
    SELECT coalesce(jsonb_agg(s.value ORDER BY s.ordinality), '[]'::jsonb) INTO v_next
    FROM jsonb_array_elements(cur.sources) WITH ORDINALITY s
    WHERE NOT CASE WHEN jsonb_typeof(s.value -> 'entryId') = 'string'
                   THEN EXISTS (
                     SELECT 1 FROM public.dinner_plan_entries e
                     WHERE e.id = (s.value ->> 'entryId')::uuid AND e.household_id = h
                       AND (e.status = 'cooked' OR (e.status = 'confirmed' AND e.plan_date < today)))
                   ELSE (s.value ->> 'date')::date < today END;
  ELSE
    v_next := p_next;
  END IF;

  -- (1) 既にある記録を見直す
  FOR rec IN SELECT x.value AS e FROM jsonb_array_elements(cur.consumptions) WITH ORDINALITY x ORDER BY x.ordinality LOOP
    v_on := (rec.e ->> 'on')::boolean;
    v_m := (rec.e ->> 'm')::boolean;
    IF rec.e ->> 'k' = 'settled' THEN
      v_settled := v_settled + (rec.e ->> 'q')::numeric;
      CONTINUE;
    END IF;
    SELECT * INTO ent FROM public.dinner_plan_entries pe WHERE pe.id = (rec.e ->> 'k')::uuid AND pe.household_id = h;
    IF NOT FOUND OR ent.plan_date < today - 35 THEN
      IF v_on THEN v_settled := v_settled + (rec.e ->> 'q')::numeric; END IF;
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_next) x WHERE x.value ->> 'entryId' = rec.e ->> 'k') THEN
      IF v_on THEN
        v_reverted := true;
        IF v_m THEN v_reverted_mark := true; END IF;
      END IF;
      CONTINUE;
    END IF;
    IF ent.status = 'cooked' OR (ent.status = 'confirmed' AND ent.plan_date < today) THEN
      IF v_on THEN
        v_ledger := v_ledger || jsonb_build_array(rec.e);
      ELSE
        v_wake := v_wake || jsonb_build_array(rec.e);
      END IF;
    ELSIF v_on THEN
      v_ledger := v_ledger || jsonb_build_array(jsonb_build_object(
        'k', rec.e ->> 'k', 'q', (rec.e ->> 'q')::numeric, 'm', v_m, 'd', rec.e -> 'd', 'on', false,
        'pc', v_m AND cur.purchase_consumed));
      v_reverted := true;
      IF v_m THEN v_reverted_mark := true; END IF;
    ELSE
      v_ledger := v_ledger || jsonb_build_array(rec.e);
    END IF;
  END LOOP;

  -- (2) 今の必要に充てられる購入。消費済みに戻った眠りの記録を、日付の順に起こす
  v_avail := greatest(cur.purchased_quantity - cur.restocked_quantity - v_settled
    - coalesce((SELECT sum((x.value ->> 'q')::numeric) FROM jsonb_array_elements(v_ledger) x WHERE (x.value ->> 'on')::boolean), 0), 0);
  FOR rec IN SELECT x.value AS e FROM jsonb_array_elements(v_wake) x ORDER BY x.value ->> 'd', x.value ->> 'k' LOOP
    v_q := round(least((rec.e ->> 'q')::numeric, v_avail), 3);
    v_m := (rec.e ->> 'm')::boolean;
    v_ledger := v_ledger || jsonb_build_array(jsonb_build_object(
      'k', rec.e ->> 'k', 'q', v_q, 'm', v_m, 'd', rec.e -> 'd', 'on', true));
    v_avail := v_avail - v_q;
    IF v_q > 0 THEN v_added_qty := true; END IF;
    IF v_m THEN v_woke_mark := true; END IF;
    IF coalesce((rec.e ->> 'pc')::boolean, false) THEN v_woke_pc := true; END IF;
  END LOOP;

  -- (3) 済んだ出所を、記録の無い枠に限り 1 回だけ記録する
  v_tick_alive := cur.purchased AND cur.purchased_quantity = 0 AND NOT cur.purchase_consumed;
  v_all_spent := jsonb_array_length(cur.sources) > 0;
  FOR rec IN
    SELECT x.value AS s FROM jsonb_array_elements(cur.sources) WITH ORDINALITY x
    ORDER BY x.value ->> 'date', coalesce(x.value ->> 'entryId', ''), x.ordinality
  LOOP
    v_key := CASE WHEN jsonb_typeof(rec.s -> 'entryId') = 'string' THEN rec.s ->> 'entryId' END;
    v_buy := round(CASE WHEN jsonb_typeof(rec.s -> 'buy') = 'number' THEN (rec.s ->> 'buy')::numeric ELSE 0 END, 3);
    v_listed := EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_next) x
      WHERE CASE WHEN v_key IS NOT NULL
                 THEN x.value ->> 'entryId' = v_key
                 ELSE jsonb_typeof(x.value -> 'entryId') IS DISTINCT FROM 'string'
                      AND (x.value ->> 'date', x.value ->> 'recipeId', x.value ->> 'title')
                          IS NOT DISTINCT FROM (rec.s ->> 'date', rec.s ->> 'recipeId', rec.s ->> 'title') END);
    IF v_listed THEN
      v_all_spent := false;
      CONTINUE;
    END IF;
    v_found := false;
    IF v_key IS NOT NULL THEN
      SELECT * INTO ent FROM public.dinner_plan_entries pe WHERE pe.id = v_key::uuid AND pe.household_id = h;
      v_found := FOUND;
      v_spent := v_found AND (ent.status = 'cooked' OR (ent.status = 'confirmed' AND ent.plan_date < today));
    ELSE
      v_spent := (rec.s ->> 'date')::date < today;
    END IF;
    IF v_key IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_ledger) x WHERE x.value ->> 'k' = v_key) THEN
      IF NOT v_spent THEN v_all_spent := false; END IF;
      CONTINUE;
    END IF;
    IF NOT v_spent THEN
      v_all_spent := false;
      -- 「作らなかった」で必要量から外れた枠: 需要を眠りとして覚える（取り消して過ぎた日の確定へ戻れば起こす）
      IF v_found AND ent.status = 'skipped' AND ent.plan_date >= today - 35 THEN
        v_ledger := v_ledger || jsonb_build_array(jsonb_build_object(
          'k', v_key, 'q', v_buy, 'm', v_tick_alive, 'd', ent.plan_date, 'on', false, 'pc', false));
      END IF;
      CONTINUE;
    END IF;
    v_q := round(least(v_buy, v_avail), 3);
    IF v_key IS NULL THEN
      v_settled := v_settled + v_q;
    ELSIF v_q > 0 OR v_tick_alive OR ent.status = 'cooked' THEN
      -- 作った枠は 0 でも記録する（作った後の購入を、その料理に充てない）。確定のまま日が過ぎた枠で
      -- 充てられる量が 0 のときは記録を待つ（日が過ぎてから記録された購入は、その料理の分として充てる）
      v_ledger := v_ledger || jsonb_build_array(jsonb_build_object(
        'k', v_key, 'q', v_q, 'm', v_tick_alive, 'd', ent.plan_date, 'on', true));
    END IF;
    v_avail := v_avail - v_q;
    IF v_q > 0 THEN v_added_qty := true; END IF;
  END LOOP;

  -- 件数の上限: 古い記録から畳む（充当中は 'settled' へ、眠りは捨てる）
  WHILE jsonb_array_length(v_ledger) > 150 LOOP
    SELECT x.ordinality, CASE WHEN (x.value ->> 'on')::boolean THEN (x.value ->> 'q')::numeric ELSE 0 END INTO v_i, v_q
    FROM jsonb_array_elements(v_ledger) WITH ORDINALITY x
    ORDER BY x.value ->> 'd' NULLS FIRST, x.value ->> 'k' LIMIT 1;
    v_settled := v_settled + v_q;
    v_ledger := v_ledger - (v_i::integer - 1);
  END LOOP;
  IF v_settled > 0 THEN
    v_ledger := jsonb_build_array(jsonb_build_object('k', 'settled', 'q', v_settled, 'm', false, 'on', true)) || v_ledger;
  END IF;
  v_consumed := coalesce((SELECT sum((x.value ->> 'q')::numeric) FROM jsonb_array_elements(v_ledger) x WHERE (x.value ->> 'on')::boolean), 0);
  v_pc := CASE
    WHEN NOT cur.purchased THEN false
    WHEN cur.purchased_quantity > 0 THEN
      CASE WHEN v_reverted THEN false WHEN v_added_qty THEN true ELSE cur.purchase_consumed END
    WHEN v_reverted_mark THEN false
    WHEN v_woke_pc THEN true
    WHEN v_tick_alive AND v_all_spent THEN true
    WHEN v_woke_mark AND v_tick_alive AND jsonb_array_length(v_next) = 0
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_ledger) x
                         WHERE (x.value ->> 'm')::boolean AND NOT (x.value ->> 'on')::boolean) THEN true
    ELSE cur.purchase_consumed
  END;
  IF (v_ledger, v_consumed, v_pc) IS NOT DISTINCT FROM (cur.consumptions, cur.consumed_quantity, cur.purchase_consumed) THEN
    RETURN false;
  END IF;
  UPDATE public.grocery_items t SET
    consumptions = v_ledger, consumed_quantity = v_consumed, purchase_consumed = v_pc, updated_at = clock_timestamp()
  WHERE t.id = cur.id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION irori_private.dinner_household() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_begin() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_gone(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_label(text, integer, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_j_keys(jsonb, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_j_text(jsonb, text, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_j_label(jsonb, text, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_j_int(jsonb, text, integer, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_qty(numeric, numeric, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_j_qty(jsonb, text, numeric, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_j_bool(jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_j_date(jsonb, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_j_uuid(jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_valid_quantity(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_valid_ingredients(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_valid_sources(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_pantry_parse(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_pantry_put(uuid, uuid, timestamptz, jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_entry_parse(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_state(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_bump(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_entries_json(uuid, date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_grocery_parse(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_ledger_total(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION irori_private.dinner_grocery_settle(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
-- CHECK（grocery_items_consumptions）から呼ぶ関数は、書く役割に EXECUTE が要る。RPC は所有者として書くので不要だが、
-- service_role の保守の書込（表への GRANT ALL は §2）が CHECK で 42501 にならぬよう、service_role にだけ与える。
-- 形を確かめて合計を返すだけの純関数（読み書きしない）。authenticated / anon には与えない。
GRANT EXECUTE ON FUNCTION irori_private.dinner_ledger_total(jsonb) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. 設定
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION public.save_dinner_settings(
  p_version timestamptz, p_servings integer, p_include_soup boolean, p_max_cook_minutes integer,
  p_staples text[], p_child_stages jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE h uuid; s public.dinner_settings; v_staples text[];
BEGIN
  h := irori_private.dinner_begin();
  IF p_servings IS NULL OR p_servings NOT BETWEEN 1 AND 12 OR p_include_soup IS NULL
     OR (p_max_cook_minutes IS NOT NULL AND p_max_cook_minutes NOT BETWEEN 5 AND 180)
     OR p_staples IS NULL OR coalesce(array_ndims(p_staples), 1) <> 1 OR cardinality(p_staples) > 200
     OR p_child_stages IS NULL OR jsonb_typeof(p_child_stages) <> 'object' THEN
    RAISE EXCEPTION 'invalid settings' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_staples) x WHERE x IS NULL OR x !~ '^[a-z0-9_-]{1,64}$') THEN
    RAISE EXCEPTION 'invalid staples' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(array_agg(q.x ORDER BY q.x COLLATE "C"), '{}'::text[]) INTO v_staples
  FROM (SELECT DISTINCT x FROM unnest(p_staples) x) q;
  IF (SELECT count(*) FROM jsonb_object_keys(p_child_stages)) > 20
     OR EXISTS (
       SELECT 1 FROM jsonb_each(p_child_stages) kv
       WHERE kv.key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR jsonb_typeof(kv.value) <> 'string' OR (kv.value #>> '{}') !~ '^[a-z0-9_]{1,40}$'
     ) THEN
    RAISE EXCEPTION 'invalid child stages' USING ERRCODE = '22023';
  END IF;
  -- 世帯またぎの子（と存在しない子）を拒む。
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_child_stages) k
    WHERE NOT EXISTS (SELECT 1 FROM public.children c WHERE c.household_id = h AND c.id = k::uuid)
  ) THEN
    RAISE EXCEPTION 'child unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO s FROM public.dinner_settings t WHERE t.household_id = h FOR UPDATE;
  IF FOUND THEN
    IF (s.servings::integer, s.include_soup, s.max_cook_minutes::integer, s.staples, s.child_stages)
       IS NOT DISTINCT FROM (p_servings, p_include_soup, p_max_cook_minutes, v_staples, p_child_stages) THEN
      RETURN jsonb_build_object('status', 'replayed', 'settings', to_jsonb(s));
    END IF;
    IF p_version IS NULL OR s.updated_at <> p_version THEN
      RETURN jsonb_build_object('status', 'conflict', 'settings', to_jsonb(s));
    END IF;
    UPDATE public.dinner_settings t SET
      servings = p_servings, include_soup = p_include_soup, max_cook_minutes = p_max_cook_minutes,
      staples = v_staples, child_stages = p_child_stages, updated_by = auth.uid(), updated_at = clock_timestamp()
    WHERE t.household_id = h RETURNING * INTO s;
  ELSE
    IF p_version IS NOT NULL THEN RETURN jsonb_build_object('status', 'conflict', 'settings', irori_private.dinner_gone(h)); END IF;
    INSERT INTO public.dinner_settings(household_id, servings, include_soup, max_cook_minutes, staples, child_stages, updated_by)
    VALUES (h, p_servings, p_include_soup, p_max_cook_minutes, v_staples, p_child_stages, auth.uid())
    RETURNING * INTO s;
  END IF;
  RETURN jsonb_build_object('status', 'saved', 'settings', to_jsonb(s));
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. 在庫
-- ─────────────────────────────────────────────────────────────────────────────

-- p_item: {ingredient_id, name, quantity, unit, status, use_soon, storage, expires_on, confirmed_on}
CREATE FUNCTION public.save_pantry_item(p_id uuid, p_version timestamptz, p_item jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE h uuid;
BEGIN
  h := irori_private.dinner_begin();
  RETURN irori_private.dinner_pantry_put(h, p_id, p_version, p_item, false);
END;
$$;

CREATE FUNCTION public.delete_pantry_item(p_id uuid, p_version timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE h uuid; r public.pantry_items;
BEGIN
  h := irori_private.dinner_begin();
  IF p_id IS NULL THEN RAISE EXCEPTION 'invalid id' USING ERRCODE = '22023'; END IF;
  SELECT * INTO r FROM public.pantry_items t WHERE t.id = p_id FOR UPDATE;
  -- 既に無い = 自分の削除の再送として扱う。
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'replayed', 'id', p_id); END IF;
  IF r.household_id <> h THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  IF p_version IS NULL OR r.updated_at <> p_version THEN
    RETURN jsonb_build_object('status', 'conflict', 'item', to_jsonb(r));
  END IF;
  DELETE FROM public.pantry_items t WHERE t.id = p_id;
  RETURN jsonb_build_object('status', 'saved', 'id', p_id);
END;
$$;

-- まとめ入力。p_items: [{id, ...save_pantry_item の p_item}]（最大 50 件・1 トランザクション）。
-- 同じ id・同じ内容は replayed として数え、同じ id・違う内容は 23505 で全体を取り消す。
CREATE FUNCTION public.add_pantry_items(p_items jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE h uuid; it jsonb; v_id uuid; res jsonb; v_ids uuid[] := '{}'; v_saved integer := 0; v_replayed integer := 0; v_rows jsonb := '[]'::jsonb;
BEGIN
  h := irori_private.dinner_begin();
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'invalid items' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_items) NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'invalid item count' USING ERRCODE = '22023';
  END IF;
  FOR it IN SELECT e.value FROM jsonb_array_elements(p_items) e LOOP
    IF jsonb_typeof(it) <> 'object' THEN RAISE EXCEPTION 'invalid item' USING ERRCODE = '22023'; END IF;
    v_id := irori_private.dinner_j_uuid(it, 'id');
    IF v_id = ANY(v_ids) THEN RAISE EXCEPTION 'duplicate id' USING ERRCODE = '22023'; END IF;
    v_ids := v_ids || v_id;
    res := irori_private.dinner_pantry_put(h, v_id, NULL, it - 'id', true);
    IF res ->> 'status' = 'saved' THEN v_saved := v_saved + 1; ELSE v_replayed := v_replayed + 1; END IF;
    v_rows := v_rows || jsonb_build_array(res -> 'item');
  END LOOP;
  RETURN jsonb_build_object(
    'status', CASE WHEN v_saved > 0 THEN 'saved' ELSE 'replayed' END,
    'saved', v_saved, 'replayed', v_replayed, 'items', v_rows);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. 必須除外（アレルギー・苦手）— 正規メンバーなら誰でも登録・削除できる（安全側）
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION public.save_food_exclusion(
  p_id uuid, p_subject_kind text, p_subject_profile_id uuid, p_subject_child_id uuid,
  p_reason text, p_target_kind text, p_target_id text, p_custom_label text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE h uuid; r public.food_exclusions; v_label text;
BEGIN
  h := irori_private.dinner_begin();
  IF p_id IS NULL OR p_subject_kind IS NULL OR p_subject_kind NOT IN ('household','member','child')
     OR p_reason IS NULL OR p_reason NOT IN ('allergy','dislike')
     OR p_target_kind IS NULL OR p_target_kind NOT IN ('allergen','ingredient','custom') THEN
    RAISE EXCEPTION 'invalid exclusion' USING ERRCODE = '22023';
  END IF;
  IF NOT ((p_subject_kind = 'household' AND p_subject_profile_id IS NULL AND p_subject_child_id IS NULL)
          OR (p_subject_kind = 'member' AND p_subject_profile_id IS NOT NULL AND p_subject_child_id IS NULL)
          OR (p_subject_kind = 'child' AND p_subject_profile_id IS NULL AND p_subject_child_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'invalid subject' USING ERRCODE = '22023';
  END IF;
  IF p_target_kind = 'custom' THEN
    IF p_target_id IS NOT NULL THEN RAISE EXCEPTION 'invalid target' USING ERRCODE = '22023'; END IF;
    v_label := irori_private.dinner_label(p_custom_label, 30, false, 'custom_label');
  ELSE
    IF p_custom_label IS NOT NULL OR p_target_id IS NULL OR p_target_id !~ '^[a-z0-9_-]{1,64}$' THEN
      RAISE EXCEPTION 'invalid target' USING ERRCODE = '22023';
    END IF;
  END IF;
  -- 世帯またぎ（と存在しない）対象者を拒む。
  IF p_subject_kind = 'member' AND NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = p_subject_profile_id AND p.household_id = h
  ) THEN
    RAISE EXCEPTION 'subject unavailable' USING ERRCODE = '42501';
  END IF;
  IF p_subject_kind = 'child' AND NOT EXISTS (
    SELECT 1 FROM public.children c WHERE c.id = p_subject_child_id AND c.household_id = h
  ) THEN
    RAISE EXCEPTION 'subject unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO r FROM public.food_exclusions t WHERE t.id = p_id FOR UPDATE;
  IF FOUND THEN
    IF r.household_id <> h THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
    IF (r.subject_kind, r.subject_profile_id, r.subject_child_id, r.reason, r.target_kind, r.target_id, r.custom_label)
       IS NOT DISTINCT FROM (p_subject_kind, p_subject_profile_id, p_subject_child_id, p_reason, p_target_kind, p_target_id, v_label) THEN
      RETURN jsonb_build_object('status', 'replayed', 'exclusion', to_jsonb(r));
    END IF;
    -- 除外は「登録して消す」だけ。同じ id で内容を変えることはできない。
    RAISE EXCEPTION 'request id conflict' USING ERRCODE = '23505';
  END IF;
  -- 別の id で同じ除外が既にある（別の端末が登録済み）。
  SELECT * INTO r FROM public.food_exclusions t
  WHERE t.household_id = h AND t.dedupe_key = (
    p_subject_kind || ':' || coalesce(p_subject_profile_id::text, p_subject_child_id::text, '')
    || '|' || p_reason || '|' || p_target_kind || ':' || coalesce(p_target_id, lower(v_label), ''));
  IF FOUND THEN RETURN jsonb_build_object('status', 'conflict', 'exclusion', to_jsonb(r)); END IF;
  INSERT INTO public.food_exclusions(id, household_id, subject_kind, subject_profile_id, subject_child_id, reason, target_kind, target_id, custom_label, created_by)
  VALUES (p_id, h, p_subject_kind, p_subject_profile_id, p_subject_child_id, p_reason, p_target_kind, p_target_id, v_label, auth.uid())
  RETURNING * INTO r;
  RETURN jsonb_build_object('status', 'saved', 'exclusion', to_jsonb(r));
END;
$$;

CREATE FUNCTION public.delete_food_exclusion(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE h uuid; r public.food_exclusions;
BEGIN
  h := irori_private.dinner_begin();
  IF p_id IS NULL THEN RAISE EXCEPTION 'invalid id' USING ERRCODE = '22023'; END IF;
  SELECT * INTO r FROM public.food_exclusions t WHERE t.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'replayed', 'id', p_id); END IF;
  IF r.household_id <> h THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  DELETE FROM public.food_exclusions t WHERE t.id = p_id;
  RETURN jsonb_build_object('status', 'saved', 'id', p_id);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. 好み（採点にだけ使う）と食後評価 — personal と評価は本人だけが書ける
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION public.save_food_preference(
  p_id uuid, p_version timestamptz, p_scope text, p_target_kind text, p_target_id text, p_sentiment text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE h uuid; me uuid := auth.uid(); r public.food_preferences; v_owner uuid;
BEGIN
  h := irori_private.dinner_begin();
  IF p_id IS NULL OR p_scope IS NULL OR p_scope NOT IN ('household','personal')
     OR p_target_kind IS NULL OR p_target_kind NOT IN ('recipe','ingredient','tag')
     OR p_target_id IS NULL OR p_target_id !~ '^[a-z0-9_-]{1,64}$'
     OR p_sentiment IS NULL OR p_sentiment NOT IN ('like','dislike') THEN
    RAISE EXCEPTION 'invalid preference' USING ERRCODE = '22023';
  END IF;
  -- personal の持ち主は常に呼び手（引数で受けない）。
  v_owner := CASE WHEN p_scope = 'personal' THEN me END;
  SELECT * INTO r FROM public.food_preferences t WHERE t.id = p_id FOR UPDATE;
  IF FOUND THEN
    IF r.household_id <> h THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
    -- 同じ世帯でも、他人の個人設定は変更できない。
    IF r.scope = 'personal' AND r.profile_id IS DISTINCT FROM me THEN
      RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
    END IF;
    IF (r.scope, r.target_kind, r.target_id) IS DISTINCT FROM (p_scope, p_target_kind, p_target_id) THEN
      RAISE EXCEPTION 'preference target is immutable' USING ERRCODE = '22023';
    END IF;
    IF r.sentiment = p_sentiment THEN RETURN jsonb_build_object('status', 'replayed', 'preference', to_jsonb(r)); END IF;
    IF p_version IS NULL OR r.updated_at <> p_version THEN
      RETURN jsonb_build_object('status', 'conflict', 'preference', to_jsonb(r));
    END IF;
    UPDATE public.food_preferences t SET sentiment = p_sentiment, updated_at = clock_timestamp()
    WHERE t.id = p_id RETURNING * INTO r;
  ELSE
    IF p_version IS NOT NULL THEN RETURN jsonb_build_object('status', 'conflict', 'preference', irori_private.dinner_gone(p_id)); END IF;
    SELECT * INTO r FROM public.food_preferences t
    WHERE t.household_id = h AND t.scope = p_scope AND t.profile_id IS NOT DISTINCT FROM v_owner
      AND t.target_kind = p_target_kind AND t.target_id = p_target_id;
    IF FOUND THEN RETURN jsonb_build_object('status', 'conflict', 'preference', to_jsonb(r)); END IF;
    INSERT INTO public.food_preferences(id, household_id, scope, profile_id, target_kind, target_id, sentiment)
    VALUES (p_id, h, p_scope, v_owner, p_target_kind, p_target_id, p_sentiment)
    RETURNING * INTO r;
  END IF;
  RETURN jsonb_build_object('status', 'saved', 'preference', to_jsonb(r));
END;
$$;

CREATE FUNCTION public.delete_food_preference(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE h uuid; r public.food_preferences;
BEGIN
  h := irori_private.dinner_begin();
  IF p_id IS NULL THEN RAISE EXCEPTION 'invalid id' USING ERRCODE = '22023'; END IF;
  SELECT * INTO r FROM public.food_preferences t WHERE t.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'replayed', 'id', p_id); END IF;
  IF r.household_id <> h OR (r.scope = 'personal' AND r.profile_id IS DISTINCT FROM auth.uid()) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.food_preferences t WHERE t.id = p_id;
  RETURN jsonb_build_object('status', 'saved', 'id', p_id);
END;
$$;

CREATE FUNCTION public.save_dish_feedback(
  p_id uuid, p_version timestamptz, p_recipe_id text, p_dish_title text, p_eaten_on date,
  p_taste integer, p_effort integer, p_again boolean, p_exclude_from_learning boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE h uuid; me uuid := auth.uid(); r public.dish_feedback; v_title text; today date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
BEGIN
  h := irori_private.dinner_begin();
  v_title := irori_private.dinner_label(p_dish_title, 60, false, 'dish_title');
  IF p_id IS NULL OR (p_recipe_id IS NOT NULL AND p_recipe_id !~ '^[a-z0-9_-]{1,64}$')
     OR p_eaten_on IS NULL OR NOT isfinite(p_eaten_on)
     OR (p_taste IS NOT NULL AND p_taste NOT BETWEEN 1 AND 3)
     OR (p_effort IS NOT NULL AND p_effort NOT BETWEEN 1 AND 3)
     OR p_exclude_from_learning IS NULL THEN
    RAISE EXCEPTION 'invalid feedback' USING ERRCODE = '22023';
  END IF;
  -- 食べた日は今日（JST）以前。
  IF p_eaten_on NOT BETWEEN DATE '2000-01-01' AND today THEN
    RAISE EXCEPTION 'invalid eaten_on' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO r FROM public.dish_feedback t WHERE t.id = p_id FOR UPDATE;
  IF FOUND THEN
    -- 評価は本人のもの。同じ世帯の別人も変更できない。
    IF r.household_id <> h OR r.profile_id <> me THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
    IF (r.recipe_id, r.dish_title, r.eaten_on) IS DISTINCT FROM (p_recipe_id, v_title, p_eaten_on) THEN
      RAISE EXCEPTION 'feedback target is immutable' USING ERRCODE = '22023';
    END IF;
    IF (r.taste::integer, r.effort::integer, r.again, r.exclude_from_learning)
       IS NOT DISTINCT FROM (p_taste, p_effort, p_again, p_exclude_from_learning) THEN
      RETURN jsonb_build_object('status', 'replayed', 'feedback', to_jsonb(r));
    END IF;
    IF p_version IS NULL OR r.updated_at <> p_version THEN
      RETURN jsonb_build_object('status', 'conflict', 'feedback', to_jsonb(r));
    END IF;
    UPDATE public.dish_feedback t SET
      taste = p_taste, effort = p_effort, again = p_again, exclude_from_learning = p_exclude_from_learning,
      updated_at = clock_timestamp()
    WHERE t.id = p_id RETURNING * INTO r;
  ELSE
    IF p_version IS NOT NULL THEN RETURN jsonb_build_object('status', 'conflict', 'feedback', irori_private.dinner_gone(p_id)); END IF;
    -- 同じ本人・料理・日付の評価が別の id で既にある。
    SELECT * INTO r FROM public.dish_feedback t
    WHERE t.household_id = h AND t.profile_id = me AND t.eaten_on = p_eaten_on
      AND t.dish_key = coalesce('r:' || p_recipe_id, 't:' || lower(v_title));
    IF FOUND THEN RETURN jsonb_build_object('status', 'conflict', 'feedback', to_jsonb(r)); END IF;
    INSERT INTO public.dish_feedback(id, household_id, profile_id, recipe_id, dish_title, eaten_on, taste, effort, again, exclude_from_learning)
    VALUES (p_id, h, me, p_recipe_id, v_title, p_eaten_on, p_taste, p_effort, p_again, p_exclude_from_learning)
    RETURNING * INTO r;
  END IF;
  RETURN jsonb_build_object('status', 'saved', 'feedback', to_jsonb(r));
END;
$$;

CREATE FUNCTION public.delete_dish_feedback(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE h uuid; r public.dish_feedback;
BEGIN
  h := irori_private.dinner_begin();
  IF p_id IS NULL THEN RAISE EXCEPTION 'invalid id' USING ERRCODE = '22023'; END IF;
  SELECT * INTO r FROM public.dish_feedback t WHERE t.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'replayed', 'id', p_id); END IF;
  IF r.household_id <> h OR r.profile_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.dish_feedback t WHERE t.id = p_id;
  RETURN jsonb_build_object('status', 'saved', 'id', p_id);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. 献立
-- ─────────────────────────────────────────────────────────────────────────────

-- 範囲（最大 7 日）内の「固定でも調理済みでもない」枠を p_entries で置き換える。
--   * 固定（pinned）・調理済み（cooked）の行は消さず、上書きもしない。p_entries が同じ枠（または同じ id）を
--     指していたら無視し、skipped に入れて返す。
--   * 同じ p_operation_id の再送は replayed（版が進んでいても）。内容が違えば 23505。
--   * p_expected_revision が現在の版と違えば conflict（最新の版と範囲内の行を返す）。
--   p_entries: [{id, plan_date, role, position, recipe_id, recipe_version, custom_title, custom_ingredients,
--                servings, pinned, status('proposed'|'confirmed'), origin}]
CREATE FUNCTION public.apply_dinner_plan(
  p_operation_id uuid, p_expected_revision bigint, p_range_start date, p_range_end date, p_entries jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  h uuid; st public.dinner_plan_state; it jsonb; n public.dinner_plan_entries; x public.dinner_plan_entries;
  v_id uuid; v_hash text; v_ids uuid[] := '{}'; v_slots text[] := '{}'; v_slot text;
  v_skipped jsonb := '[]'::jsonb; today date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
BEGIN
  h := irori_private.dinner_begin();
  IF p_operation_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 0
     OR p_range_start IS NULL OR p_range_end IS NULL OR p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' THEN
    RAISE EXCEPTION 'invalid plan' USING ERRCODE = '22023';
  END IF;
  IF NOT isfinite(p_range_start) OR NOT isfinite(p_range_end) THEN
    RAISE EXCEPTION 'invalid range' USING ERRCODE = '22023';
  END IF;
  IF p_range_end < p_range_start OR p_range_end - p_range_start > 6
     OR p_range_start < today - 400 OR p_range_end > today + 400 OR jsonb_array_length(p_entries) > 80 THEN
    RAISE EXCEPTION 'invalid range' USING ERRCODE = '22023';
  END IF;
  -- 入力を全件検証してから書く。
  FOR it IN SELECT e.value FROM jsonb_array_elements(p_entries) e LOOP
    IF jsonb_typeof(it) <> 'object' THEN RAISE EXCEPTION 'invalid entry' USING ERRCODE = '22023'; END IF;
    v_id := irori_private.dinner_j_uuid(it, 'id');
    n := irori_private.dinner_entry_parse(it - 'id');
    IF n.plan_date NOT BETWEEN p_range_start AND p_range_end OR n.status NOT IN ('proposed','confirmed') THEN
      RAISE EXCEPTION 'entry outside the plan' USING ERRCODE = '22023';
    END IF;
    v_slot := n.plan_date::text || '|' || n.role || '|' || n.position::text;
    IF v_id = ANY(v_ids) OR v_slot = ANY(v_slots) THEN
      RAISE EXCEPTION 'duplicate entry' USING ERRCODE = '22023';
    END IF;
    v_ids := v_ids || v_id; v_slots := v_slots || v_slot;
  END LOOP;

  v_hash := md5(jsonb_build_object('s', p_range_start, 'e', p_range_end, 'x', p_entries)::text);
  st := irori_private.dinner_state(h);
  IF st.last_operation_id = p_operation_id THEN
    IF st.last_request_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'operation id conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('status', 'replayed', 'revision', st.revision,
      'entries', irori_private.dinner_entries_json(h, p_range_start, p_range_end), 'skipped', '[]'::jsonb);
  END IF;
  IF st.revision <> p_expected_revision THEN
    RETURN jsonb_build_object('status', 'conflict', 'revision', st.revision,
      'entries', irori_private.dinner_entries_json(h, p_range_start, p_range_end), 'skipped', '[]'::jsonb);
  END IF;

  DELETE FROM public.dinner_plan_entries e
  WHERE e.household_id = h AND e.plan_date BETWEEN p_range_start AND p_range_end
    AND NOT e.pinned AND e.status <> 'cooked';
  FOR it IN SELECT e.value FROM jsonb_array_elements(p_entries) e LOOP
    v_id := irori_private.dinner_j_uuid(it, 'id');
    n := irori_private.dinner_entry_parse(it - 'id');
    -- 範囲内に残っているのは固定・調理済みの行だけ。
    SELECT * INTO x FROM public.dinner_plan_entries e
    WHERE e.household_id = h AND e.plan_date BETWEEN p_range_start AND p_range_end
      AND (e.id = v_id OR (e.plan_date = n.plan_date AND e.role = n.role AND e.position = n.position))
    LIMIT 1;
    IF FOUND THEN
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'id', v_id, 'kept_id', x.id, 'plan_date', n.plan_date, 'role', n.role, 'position', n.position,
        'reason', CASE WHEN x.status = 'cooked' THEN 'cooked' ELSE 'pinned' END));
      CONTINUE;
    END IF;
    SELECT * INTO x FROM public.dinner_plan_entries e WHERE e.id = v_id;
    IF FOUND THEN
      IF x.household_id <> h THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
      -- 範囲の外にある行の id を流用して、その行を動かすことはしない。
      RAISE EXCEPTION 'entry id in use' USING ERRCODE = '23505';
    END IF;
    INSERT INTO public.dinner_plan_entries(id, household_id, plan_date, role, position, recipe_id, recipe_version, custom_title, custom_ingredients, servings, pinned, status, origin, created_by)
    VALUES (v_id, h, n.plan_date, n.role, n.position, n.recipe_id, n.recipe_version, n.custom_title, n.custom_ingredients, n.servings, n.pinned, n.status, n.origin, auth.uid());
  END LOOP;

  UPDATE public.dinner_plan_state s SET
    revision = s.revision + 1, last_operation_id = p_operation_id, last_request_hash = v_hash, updated_at = clock_timestamp()
  WHERE s.household_id = h RETURNING * INTO st;
  RETURN jsonb_build_object('status', 'saved', 'revision', st.revision,
    'entries', irori_private.dinner_entries_json(h, p_range_start, p_range_end), 'skipped', v_skipped);
END;
$$;

-- 1 枠の作成・編集（固定/解除、料理の差替え、日付移動、確定、作った/作らなかった、人数、手動料理と材料）。
-- 移動先の枠が埋まっていれば 23505。成功で献立の版が +1。
-- p_entry: apply_dinner_plan の要素から id を除いた形（status は 4 値）。
-- 状態の遷移は画面が出すものだけを受ける（ほかは 22023）:
--   * 新しい枠は提案か確定だけ（作った・作らなかったで直に作ると、取り消しの戻り先も買い物の充当も持たない）。
--   * 作った ↔ 作らなかった を直に行き来しない（取り消してから付け直す。直の行き来は充当を一度も付けずに済ませうる）。
-- prior_status（取り消しで戻す先）はここが遷移から決める: 提案・確定 → 作った・作らなかった で直前の状態を保ち、
-- 提案・確定へ戻ると消す。payload からは受けない。
-- 状態か日付が変わったら、その枠を出所か充当の台帳に持つ買い物の行を、同期を待たずに枠の状態へ合わせる
-- （irori_private.dinner_grocery_settle。同期が失敗しても「作った」の直後から使った分を在庫へ足せない）。
CREATE FUNCTION public.save_dinner_entry(p_id uuid, p_version timestamptz, p_entry jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE h uuid; st public.dinner_plan_state; n public.dinner_plan_entries; r public.dinner_plan_entries; v_rev bigint; v_prior text;
  v_settle boolean := false; v_gid uuid;
BEGIN
  h := irori_private.dinner_begin();
  IF p_id IS NULL THEN RAISE EXCEPTION 'invalid id' USING ERRCODE = '22023'; END IF;
  n := irori_private.dinner_entry_parse(p_entry);
  st := irori_private.dinner_state(h);
  SELECT * INTO r FROM public.dinner_plan_entries e WHERE e.id = p_id FOR UPDATE;
  IF FOUND THEN
    IF r.household_id <> h THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
    IF (r.plan_date, r.role, r.position::integer, r.recipe_id, r.recipe_version::integer, r.custom_title, r.custom_ingredients, r.servings::integer, r.pinned, r.status, r.origin)
       IS NOT DISTINCT FROM (n.plan_date, n.role, n.position::integer, n.recipe_id, n.recipe_version::integer, n.custom_title, n.custom_ingredients, n.servings::integer, n.pinned, n.status, n.origin) THEN
      RETURN jsonb_build_object('status', 'replayed', 'entry', to_jsonb(r), 'revision', st.revision);
    END IF;
    IF p_version IS NULL OR r.updated_at <> p_version THEN
      RETURN jsonb_build_object('status', 'conflict', 'entry', to_jsonb(r), 'revision', st.revision);
    END IF;
  ELSE
    IF p_version IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'conflict', 'entry', irori_private.dinner_gone(p_id), 'revision', st.revision);
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.dinner_plan_entries e
    WHERE e.household_id = h AND e.plan_date = n.plan_date AND e.role = n.role AND e.position = n.position AND e.id <> p_id
  ) THEN
    RAISE EXCEPTION 'slot occupied' USING ERRCODE = '23505';
  END IF;
  IF r.id IS NULL AND n.status NOT IN ('proposed','confirmed') THEN
    RAISE EXCEPTION 'a new entry must be proposed or confirmed' USING ERRCODE = '22023';
  END IF;
  IF r.id IS NOT NULL AND r.status IN ('cooked','skipped') AND n.status IN ('cooked','skipped') AND r.status <> n.status THEN
    RAISE EXCEPTION 'cooked and skipped cannot be switched directly' USING ERRCODE = '22023';
  END IF;
  v_prior := CASE
    WHEN n.status IN ('proposed','confirmed') THEN NULL
    WHEN r.id IS NOT NULL AND r.status IN ('proposed','confirmed') THEN r.status
    WHEN r.id IS NOT NULL THEN r.prior_status
  END;
  IF r.id IS NOT NULL THEN
    v_settle := (r.status, r.plan_date) IS DISTINCT FROM (n.status, n.plan_date);
    UPDATE public.dinner_plan_entries e SET
      plan_date = n.plan_date, role = n.role, position = n.position, recipe_id = n.recipe_id, recipe_version = n.recipe_version,
      custom_title = n.custom_title, custom_ingredients = n.custom_ingredients, servings = n.servings, pinned = n.pinned,
      status = n.status, prior_status = v_prior, origin = n.origin, updated_at = clock_timestamp()
    WHERE e.id = p_id RETURNING * INTO r;
  ELSE
    INSERT INTO public.dinner_plan_entries(id, household_id, plan_date, role, position, recipe_id, recipe_version, custom_title, custom_ingredients, servings, pinned, status, prior_status, origin, created_by)
    VALUES (p_id, h, n.plan_date, n.role, n.position, n.recipe_id, n.recipe_version, n.custom_title, n.custom_ingredients, n.servings, n.pinned, n.status, v_prior, n.origin, auth.uid())
    RETURNING * INTO r;
  END IF;
  IF v_settle THEN
    FOR v_gid IN
      SELECT g.id FROM public.grocery_items g
      WHERE g.household_id = h AND g.origin = 'auto'
        AND (g.sources @> jsonb_build_array(jsonb_build_object('entryId', p_id::text))
             OR g.consumptions @> jsonb_build_array(jsonb_build_object('k', p_id::text)))
      ORDER BY g.item_key
    LOOP
      PERFORM irori_private.dinner_grocery_settle(h, v_gid, NULL);
    END LOOP;
  END IF;
  v_rev := irori_private.dinner_bump(h);
  RETURN jsonb_build_object('status', 'saved', 'entry', to_jsonb(r), 'revision', v_rev);
END;
$$;

CREATE FUNCTION public.delete_dinner_entry(p_id uuid, p_version timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE h uuid; st public.dinner_plan_state; r public.dinner_plan_entries; v_rev bigint;
BEGIN
  h := irori_private.dinner_begin();
  IF p_id IS NULL THEN RAISE EXCEPTION 'invalid id' USING ERRCODE = '22023'; END IF;
  st := irori_private.dinner_state(h);
  SELECT * INTO r FROM public.dinner_plan_entries e WHERE e.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'replayed', 'id', p_id, 'revision', st.revision); END IF;
  IF r.household_id <> h THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  IF p_version IS NULL OR r.updated_at <> p_version THEN
    RETURN jsonb_build_object('status', 'conflict', 'entry', to_jsonb(r), 'revision', st.revision);
  END IF;
  DELETE FROM public.dinner_plan_entries e WHERE e.id = p_id;
  v_rev := irori_private.dinner_bump(h);
  RETURN jsonb_build_object('status', 'saved', 'id', p_id, 'revision', v_rev);
END;
$$;

-- 提案（proposed）の枠を、1 トランザクションで確定にする（成功で献立の版は 1 回だけ進む）。
--   * 1 品ずつ save_dinner_entry で書くと、途中で止まった後の再送が「自分の途中経過」で版違いになり、
--     確定済みの分だけが残る。まとめて書けば「全部確定した」か「何も変わっていない」かのどちらかになる。
--   * 献立の版が違う・枠が無い・枠の版が違う・提案でない枠が 1 つでも在れば、何も書かずに conflict。
--   * 応答を失った再送は、呼び出し側が「範囲に提案が残っていない」ことで見分ける（ここは replay を持たない）。
--   p_entries: [{id, version}]（呼び出し側が読んだ、確定する枠とその版）
CREATE FUNCTION public.confirm_dinner_entries(p_expected_revision bigint, p_entries jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  h uuid; st public.dinner_plan_state; it jsonb; r public.dinner_plan_entries;
  v_id uuid; v_version timestamptz; v_ids uuid[] := '{}'; v_rev bigint;
BEGIN
  h := irori_private.dinner_begin();
  IF p_expected_revision IS NULL OR p_expected_revision < 0 OR p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array'
     OR jsonb_array_length(p_entries) NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid confirmation' USING ERRCODE = '22023';
  END IF;
  st := irori_private.dinner_state(h);
  -- 入力を全件検証し、行をロックしてから書く（1 つでも合わなければ何も書かない）。
  FOR it IN SELECT e.value FROM jsonb_array_elements(p_entries) e LOOP
    IF jsonb_typeof(it) <> 'object' THEN RAISE EXCEPTION 'invalid entry' USING ERRCODE = '22023'; END IF;
    PERFORM irori_private.dinner_j_keys(it, ARRAY['id','version']);
    v_id := irori_private.dinner_j_uuid(it, 'id');
    IF jsonb_typeof(it -> 'version') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'invalid version' USING ERRCODE = '22023'; END IF;
    BEGIN
      v_version := (it ->> 'version')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid version' USING ERRCODE = '22023';
    END;
    IF v_id = ANY(v_ids) THEN RAISE EXCEPTION 'duplicate entry' USING ERRCODE = '22023'; END IF;
    v_ids := v_ids || v_id;
    SELECT * INTO r FROM public.dinner_plan_entries e WHERE e.id = v_id FOR UPDATE;
    IF FOUND AND r.household_id <> h THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
    IF st.revision <> p_expected_revision THEN
      RETURN jsonb_build_object('status', 'conflict', 'revision', st.revision, 'detail', 'stale_plan');
    END IF;
    IF r.id IS NULL THEN
      RETURN jsonb_build_object('status', 'conflict', 'revision', st.revision, 'detail', 'gone');
    END IF;
    IF r.updated_at <> v_version OR r.status <> 'proposed' THEN
      RETURN jsonb_build_object('status', 'conflict', 'revision', st.revision, 'detail', 'row_changed');
    END IF;
  END LOOP;
  UPDATE public.dinner_plan_entries e SET status = 'confirmed', updated_at = clock_timestamp()
  WHERE e.household_id = h AND e.id = ANY(v_ids);
  v_rev := irori_private.dinner_bump(h);
  RETURN jsonb_build_object('status', 'saved', 'revision', v_rev, 'confirmed', cardinality(v_ids));
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. 買い物
-- ─────────────────────────────────────────────────────────────────────────────

-- 自動項目を item_key で upsert する（冪等）。
--   * 更新するのは required_* / sources / needs_stock_check / name / ingredient_id / plan_revision / still_needed=true。
--     purchased_* / restocked_quantity / restock_ids / note / section は保持する（購入の事実はここでは書かない）。
--   * 見える内容が変わらない行は updated_at を進めない（買い物中の端末が持つ版を無用に古くしない）。
--   * p_items に無い既存の自動項目は、購入・メモ・補充・充当の記録があれば still_needed=false で残し（出所は空にする）、
--     無ければ削除。充当の台帳を持つ行を消すと、取り消しの後に購入の事実の無い行が作り直されるため消さない。
--   * manual 行には触れない。
--   * 新しい自動項目の id はサーバーが採番する（同一性は item_key）。
--   p_items: [{item_key, ingredient_id, name, required_quantity, unit, required_note, needs_stock_check, sources}]
--
-- 作った料理への充当（実消費の台帳 consumptions。購入の事実 purchased_quantity / purchased は書き換えない）
--   購入は「これから作る料理の必要量」に対するもの。作った後・日が過ぎた後・翌週の必要量まで相殺し続けると、
--   買うべき食材が買い物リストから消える。そこで upsert の前に、出所か台帳を持つ行ごとに
--   irori_private.dinner_grocery_settle（p_next = その項目の新しい出所）で台帳を枠の状態へ合わせる（手順はそちら）。
--   * 献立の変更（削除・差し替え）で外れた出所は記録しない（食材は家に残っている）。「作らなかった」は需要だけを眠りで覚える。
--   * 判定は DB の枠の状態から行う。出所に載せられるのは世帯の確定の枠だけ（作った・作らなかった・提案の枠を載せる
--     p_items は 22023。載せた枠の充当の記録が外れ、補充の上限が上がるため）。枠は呼び手の世帯のものだけを見る。
--   * 1 項目の出所の buy の合計は必要量を超えられない（22023）。超えた分を使った扱いにすると、充てられる購入が消える。
--   * 同じ状態での再実行では台帳も版も変えない（取り消しの再送・同期の再送で二重に戻さない）。
--   * 既知の限界: 取り消しは記録した量だけを戻す。間に別の料理の「作った」があり、その料理が充てられる購入の不足で
--     少なく記録されていても、後から付け替えはしない（在庫の台帳への作り直しはしない）。buy を少なく申告する
--     p_items（作った料理の分を軽くする）は、必要量の合計からは見分けられない。
CREATE FUNCTION public.sync_grocery_auto_items(p_operation_id uuid, p_plan_revision bigint, p_items jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  h uuid; st public.dinner_plan_state; it jsonb; n public.grocery_items; v_hash text; v_keys text[] := '{}';
  v_retained integer; v_removed integer; cur public.grocery_items; v_next jsonb; v_now timestamptz;
  v_used integer := 0;
BEGIN
  h := irori_private.dinner_begin();
  IF p_operation_id IS NULL OR p_plan_revision IS NULL OR p_plan_revision < 0
     OR p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'invalid sync' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_items) > 200 THEN RAISE EXCEPTION 'too many items' USING ERRCODE = '22023'; END IF;
  FOR it IN SELECT e.value FROM jsonb_array_elements(p_items) e LOOP
    n := irori_private.dinner_grocery_parse(it);
    IF n.item_key = ANY(v_keys) THEN RAISE EXCEPTION 'duplicate item_key' USING ERRCODE = '22023'; END IF;
    v_keys := v_keys || n.item_key;
    IF (SELECT coalesce(sum(round((s.value ->> 'buy')::numeric, 3)), 0) FROM jsonb_array_elements(n.sources) s
        WHERE jsonb_typeof(s.value -> 'buy') = 'number') > coalesce(n.required_quantity, 0) THEN
      RAISE EXCEPTION 'sources buy more than the item needs' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  v_hash := md5(jsonb_build_object('r', p_plan_revision, 'x', p_items)::text);
  st := irori_private.dinner_state(h);
  IF st.grocery_operation_id = p_operation_id THEN
    IF st.grocery_request_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'operation id conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('status', 'replayed', 'revision', st.revision);
  END IF;
  -- 献立が計算の後で変わっていたら、古い必要量を書かない。
  IF st.revision <> p_plan_revision THEN
    RETURN jsonb_build_object('status', 'conflict', 'revision', st.revision);
  END IF;

  -- 出所の枠は献立の今の状態と照らす（クライアントの申告だけで充当の記録を外させない）。必要量に載せられるのは
  -- 確定の枠だけ（作った・作らなかった・提案の枠を載せると、その枠の充当の記録が外れ、補充の上限が上がる）。
  -- 世帯に無い枠（削除済み・別世帯）は、充当の記録を持たないので照らさない。
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) i, jsonb_array_elements(i.value -> 'sources') s
    JOIN public.dinner_plan_entries e
      ON jsonb_typeof(s.value -> 'entryId') = 'string' AND e.id = (s.value ->> 'entryId')::uuid AND e.household_id = h
    WHERE e.status <> 'confirmed'
  ) THEN
    RAISE EXCEPTION 'a source names an entry that is not confirmed' USING ERRCODE = '22023';
  END IF;

  -- 作った料理への充当（冒頭の注記）。出所か台帳を持つ自動項目が対象。購入の事実（purchased_*）には触れない。
  FOR cur IN
    SELECT * FROM public.grocery_items t
    WHERE t.household_id = h AND t.origin = 'auto'
      AND (jsonb_array_length(t.sources) > 0 OR jsonb_array_length(t.consumptions) > 0)
    ORDER BY t.item_key
    FOR UPDATE
  LOOP
    SELECT coalesce((SELECT e.value -> 'sources' FROM jsonb_array_elements(p_items) e WHERE e.value ->> 'item_key' = cur.item_key), '[]'::jsonb)
    INTO v_next;
    IF irori_private.dinner_grocery_settle(h, cur.id, v_next) THEN v_used := v_used + 1; END IF;
  END LOOP;

  FOR it IN SELECT e.value FROM jsonb_array_elements(p_items) e LOOP
    n := irori_private.dinner_grocery_parse(it);
    v_now := clock_timestamp();
    INSERT INTO public.grocery_items AS g (id, household_id, origin, item_key, ingredient_id, name, required_quantity, unit, required_note, needs_stock_check, sources, plan_revision, still_needed, created_by)
    VALUES (gen_random_uuid(), h, 'auto', n.item_key, n.ingredient_id, n.name, n.required_quantity, n.unit, n.required_note, n.needs_stock_check, n.sources, p_plan_revision, true, auth.uid())
    ON CONFLICT ON CONSTRAINT grocery_items_key DO UPDATE SET
      ingredient_id = EXCLUDED.ingredient_id, name = EXCLUDED.name, required_quantity = EXCLUDED.required_quantity,
      unit = EXCLUDED.unit, required_note = EXCLUDED.required_note, needs_stock_check = EXCLUDED.needs_stock_check,
      sources = EXCLUDED.sources, plan_revision = EXCLUDED.plan_revision, still_needed = true,
      -- 単位が変われば購入量の意味が変わる（アプリは単位族ごとに同じ単位を送るので普段は起きぬ。直の呼出しへの守り）。
      -- 購入の事実を書いた時刻も同じ時刻で進め、変わる前に開いた画面からの購入を conflict にする
      purchase_updated_at = CASE WHEN g.unit IS DISTINCT FROM EXCLUDED.unit THEN v_now ELSE g.purchase_updated_at END,
      updated_at = CASE
        WHEN (g.ingredient_id, g.name, g.required_quantity, g.unit, g.required_note, g.needs_stock_check, g.sources, g.still_needed)
             IS DISTINCT FROM (EXCLUDED.ingredient_id, EXCLUDED.name, EXCLUDED.required_quantity, EXCLUDED.unit, EXCLUDED.required_note, EXCLUDED.needs_stock_check, EXCLUDED.sources, true)
        THEN v_now ELSE g.updated_at END
    WHERE g.origin = 'auto';
  END LOOP;

  -- 不要化した行の出所は空にする（済んだ出所は上の台帳へ記録済み。古い出所を残すと、後の同期で同じ枠をもう一度見る）。
  -- 充当の台帳を持つ行は消さない（取り消しで台帳の記録を外すと、購入の事実がまた必要量に充たる）。
  UPDATE public.grocery_items g SET still_needed = false, sources = '[]'::jsonb, updated_at = clock_timestamp()
  WHERE g.household_id = h AND g.origin = 'auto' AND g.still_needed AND NOT (g.item_key = ANY(v_keys))
    AND (g.purchased_quantity > 0 OR g.purchased OR g.note IS NOT NULL OR g.restocked_quantity > 0 OR cardinality(g.restock_ids) > 0
         OR jsonb_array_length(g.consumptions) > 0);
  GET DIAGNOSTICS v_retained = ROW_COUNT;
  DELETE FROM public.grocery_items g
  WHERE g.household_id = h AND g.origin = 'auto' AND NOT (g.item_key = ANY(v_keys))
    AND NOT (g.purchased_quantity > 0 OR g.purchased OR g.note IS NOT NULL OR g.restocked_quantity > 0 OR cardinality(g.restock_ids) > 0
             OR jsonb_array_length(g.consumptions) > 0);
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  UPDATE public.dinner_plan_state s SET
    grocery_operation_id = p_operation_id, grocery_request_hash = v_hash, grocery_revision = p_plan_revision, updated_at = clock_timestamp()
  WHERE s.household_id = h RETURNING * INTO st;
  RETURN jsonb_build_object('status', 'saved', 'revision', st.revision,
    'synced', cardinality(v_keys), 'retained', v_retained, 'removed', v_removed, 'used', v_used);
END;
$$;

CREATE FUNCTION public.save_grocery_manual_item(
  p_id uuid, p_version timestamptz, p_name text, p_quantity numeric, p_unit text, p_section text, p_note text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE h uuid; r public.grocery_items; v_name text; v_qty numeric; v_unit text; v_note text; v_now timestamptz;
BEGIN
  h := irori_private.dinner_begin();
  IF p_id IS NULL OR (p_section IS NOT NULL AND p_section !~ '^[a-z_]{1,20}$') THEN
    RAISE EXCEPTION 'invalid item' USING ERRCODE = '22023';
  END IF;
  v_name := irori_private.dinner_label(p_name, 40, false, 'name');
  v_qty := irori_private.dinner_qty(p_quantity, 9999999, 3, 'quantity');
  v_unit := irori_private.dinner_label(p_unit, 12, true, 'unit');
  v_note := irori_private.dinner_label(p_note, 200, true, 'note');
  SELECT * INTO r FROM public.grocery_items g WHERE g.id = p_id FOR UPDATE;
  IF FOUND THEN
    IF r.household_id <> h THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
    IF r.origin <> 'manual' THEN RAISE EXCEPTION 'not a manual item' USING ERRCODE = '22023'; END IF;
    IF (r.name, r.required_quantity, r.unit, r.section, r.note) IS NOT DISTINCT FROM (v_name, v_qty, v_unit, p_section, v_note) THEN
      RETURN jsonb_build_object('status', 'replayed', 'item', to_jsonb(r));
    END IF;
    IF p_version IS NULL OR r.updated_at <> p_version THEN
      RETURN jsonb_build_object('status', 'conflict', 'item', to_jsonb(r));
    END IF;
    -- 品名・単位が変わると、購入の事実（量・印）の意味が変わる。購入の事実を書いた時刻も進め、変わる前に開いた
    -- 画面からの購入（set_grocery_purchase の緩めた版の照合）を conflict にする（「2 本」を「2 ml」として記録しない）
    v_now := clock_timestamp();
    UPDATE public.grocery_items g SET
      name = v_name, required_quantity = v_qty, unit = v_unit, section = p_section, note = v_note,
      purchase_updated_at = CASE WHEN (r.name, r.unit) IS DISTINCT FROM (v_name, v_unit) THEN v_now ELSE g.purchase_updated_at END,
      updated_at = v_now
    WHERE g.id = p_id RETURNING * INTO r;
  ELSE
    IF p_version IS NOT NULL THEN RETURN jsonb_build_object('status', 'conflict', 'item', irori_private.dinner_gone(p_id)); END IF;
    INSERT INTO public.grocery_items(id, household_id, origin, item_key, name, required_quantity, unit, section, note, created_by)
    VALUES (p_id, h, 'manual', 'manual|' || p_id::text, v_name, v_qty, v_unit, p_section, v_note, auth.uid())
    RETURNING * INTO r;
  END IF;
  RETURN jsonb_build_object('status', 'saved', 'item', to_jsonb(r));
END;
$$;

-- 消せるのは手動項目と、献立から不要になって残っている自動項目（still_needed=false）だけ。
CREATE FUNCTION public.delete_grocery_item(p_id uuid, p_version timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE h uuid; r public.grocery_items;
BEGIN
  h := irori_private.dinner_begin();
  IF p_id IS NULL THEN RAISE EXCEPTION 'invalid id' USING ERRCODE = '22023'; END IF;
  SELECT * INTO r FROM public.grocery_items g WHERE g.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'replayed', 'id', p_id); END IF;
  IF r.household_id <> h THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  IF r.origin = 'auto' AND r.still_needed THEN
    RAISE EXCEPTION 'needed auto item cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF p_version IS NULL OR r.updated_at <> p_version THEN
    RETURN jsonb_build_object('status', 'conflict', 'item', to_jsonb(r));
  END IF;
  DELETE FROM public.grocery_items g WHERE g.id = p_id;
  RETURN jsonb_build_object('status', 'saved', 'id', p_id);
END;
$$;

-- 購入の記録（購入の事実を書く唯一の RPC）。p_purchased_quantity は購入した**事実の合計量**（0 で取り消し。
-- 画面に出している「今の必要に充てられる量」や残りを合計として送らない — 別の端末の買い足しを上書きする）。
-- p_purchased は数値化できない項目用の印。
--   * 書く前に、充当の台帳を枠の今の状態へ合わせる（dinner_grocery_settle。同期を待たない）。
--   * 同じ内容の判定は「量の事実」と「画面の印（purchased AND NOT purchase_consumed）」で行う。作った料理で使い終えた
--     印を家族がもう一度付けたとき、事実の印が true のままでも replayed に吸わず、新しい購入として書く。
--   * 版は「購入の事実を最後に書いた時刻（purchase_updated_at）以後で、今の版を超えない」なら通す。画面が今の購入の
--     事実を見ていたなら、その後に変わったのが必要量・出所・充当・補充・メモだけでも、送られた合計で家族の購入を
--     消さない（作る前に開いた画面から、作った後に買い足しを記録できる）。購入の事実が後から変わっていれば conflict。
--   * 合計を「在庫へ足した量 + 作った料理への充当」より下へ下げる書込は拒む（22023。上げる・同じ量は通す）。
--     Action（`setGroceryPurchase`）と同じ式。
--   * 書いたら purchase_consumed は false（新しい購入の事実）。充当の台帳の記録には触れない。
CREATE FUNCTION public.set_grocery_purchase(p_id uuid, p_version timestamptz, p_purchased_quantity numeric, p_purchased boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE h uuid; r public.grocery_items; v_qty numeric; v_any boolean; v_now timestamptz;
BEGIN
  h := irori_private.dinner_begin();
  IF p_id IS NULL OR p_purchased IS NULL OR p_purchased_quantity IS NULL OR p_purchased_quantity = 'NaN'::numeric
     OR p_purchased_quantity < 0 OR p_purchased_quantity > 9999999 THEN
    RAISE EXCEPTION 'invalid purchase' USING ERRCODE = '22023';
  END IF;
  v_qty := round(p_purchased_quantity, 3);
  v_any := v_qty > 0 OR p_purchased;
  SELECT * INTO r FROM public.grocery_items g WHERE g.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'conflict', 'item', irori_private.dinner_gone(p_id)); END IF;
  IF r.household_id <> h THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  IF irori_private.dinner_grocery_settle(h, p_id, NULL) THEN
    SELECT * INTO r FROM public.grocery_items g WHERE g.id = p_id;
  END IF;
  IF (r.purchased_quantity, r.purchased AND NOT r.purchase_consumed) IS NOT DISTINCT FROM (v_qty, p_purchased) THEN
    RETURN jsonb_build_object('status', 'replayed', 'item', to_jsonb(r));
  END IF;
  IF p_version IS NULL OR p_version > r.updated_at
     OR (r.purchase_updated_at IS NOT NULL AND p_version < r.purchase_updated_at) THEN
    RETURN jsonb_build_object('status', 'conflict', 'item', to_jsonb(r));
  END IF;
  IF v_qty < r.purchased_quantity AND v_qty < r.restocked_quantity + r.consumed_quantity THEN
    RAISE EXCEPTION 'purchase below restocked and used' USING ERRCODE = '22023';
  END IF;
  v_now := clock_timestamp();
  UPDATE public.grocery_items g SET
    purchased_quantity = v_qty, purchased = p_purchased, purchase_consumed = false,
    purchased_at = CASE WHEN v_any THEN v_now END,
    purchased_by = CASE WHEN v_any THEN auth.uid() END,
    purchase_updated_at = v_now, updated_at = v_now
  WHERE g.id = p_id RETURNING * INTO r;
  RETURN jsonb_build_object('status', 'saved', 'item', to_jsonb(r));
END;
$$;

-- メモと売場の上書き（自動・手動どちらの項目にも使える。再計算で消えない）。
CREATE FUNCTION public.update_grocery_item_meta(p_id uuid, p_version timestamptz, p_note text, p_section text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE h uuid; r public.grocery_items; v_note text;
BEGIN
  h := irori_private.dinner_begin();
  IF p_id IS NULL OR (p_section IS NOT NULL AND p_section !~ '^[a-z_]{1,20}$') THEN
    RAISE EXCEPTION 'invalid item' USING ERRCODE = '22023';
  END IF;
  v_note := irori_private.dinner_label(p_note, 200, true, 'note');
  SELECT * INTO r FROM public.grocery_items g WHERE g.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'conflict', 'item', irori_private.dinner_gone(p_id)); END IF;
  IF r.household_id <> h THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  IF (r.note, r.section) IS NOT DISTINCT FROM (v_note, p_section) THEN
    RETURN jsonb_build_object('status', 'replayed', 'item', to_jsonb(r));
  END IF;
  IF p_version IS NULL OR r.updated_at <> p_version THEN
    RETURN jsonb_build_object('status', 'conflict', 'item', to_jsonb(r));
  END IF;
  UPDATE public.grocery_items g SET note = v_note, section = p_section, updated_at = clock_timestamp()
  WHERE g.id = p_id RETURNING * INTO r;
  RETURN jsonb_build_object('status', 'saved', 'item', to_jsonb(r));
END;
$$;

-- 買ったものを在庫へ。確認した量だけを、新しい在庫行（id = p_pantry_item_id）として 1 度だけ反映する。
--   * 同じ p_pantry_item_id の再送は replayed（版が進んでいても二重に足さない）。
--   * 購入の記録（purchased_*）には触れない。p_quantity NULL は「数量不明の在庫」として追加する。
--   * 上限を見る前に、充当の台帳を枠の今の状態へ合わせる（dinner_grocery_settle。同期の失敗・日の経過で
--     consumed_quantity が古いまま上限を緩めない）。
--   * 補充できる量の上限は**ここで守る**（Server Action の検査だけに頼らない。RPC を直に呼ばれても同じ）:
--     - 量で追う購入（purchased_quantity > 0）は、充てられる量 = purchased_quantity − least(purchased_quantity, restocked_quantity)
--       − consumed_quantity（0 未満にしない）まで。0 なら数量不明でも足せない。超えたら 22023。上限ちょうどは通る。
--     - 量の無い購入（印だけ。purchased AND NOT purchase_consumed）は量の上限を持たない（量で追えない項目）。
--     - 買っていない項目（量 0 かつ印なし・印を作った料理で使い終えた）は足せない（22023）。
--     Action（`restockPantryFromGrocery`）の検査と同じ式。食い違えば、ここが正本。
CREATE FUNCTION public.restock_pantry_from_grocery(p_grocery_id uuid, p_grocery_version timestamptz, p_pantry_item_id uuid, p_quantity numeric) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE h uuid; g public.grocery_items; p public.pantry_items; v_qty numeric; v_avail numeric; today date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
BEGIN
  h := irori_private.dinner_begin();
  IF p_grocery_id IS NULL OR p_pantry_item_id IS NULL THEN
    RAISE EXCEPTION 'invalid restock' USING ERRCODE = '22023';
  END IF;
  v_qty := irori_private.dinner_qty(p_quantity, 9999999.99, 2, 'quantity');
  SELECT * INTO g FROM public.grocery_items t WHERE t.id = p_grocery_id FOR UPDATE;
  IF FOUND AND g.household_id <> h THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  SELECT * INTO p FROM public.pantry_items t WHERE t.id = p_pantry_item_id FOR UPDATE;
  IF FOUND AND p.household_id <> h THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  IF g.id IS NULL THEN
    -- 買い物の行が既に消されている。何も作らない（= 二重に足す経路が無い）。
    RETURN jsonb_build_object('status', 'conflict', 'item', irori_private.dinner_gone(p_grocery_id), 'pantry_item', CASE WHEN p.id IS NOT NULL THEN to_jsonb(p) END);
  END IF;
  -- 上限の前に、充当の台帳を枠の今の状態へ合わせる（同期が走っていない「作った」・日が過ぎた枠も数える）。
  -- 合わせて行が変わったら、それを見ていない画面の版は下の検査で conflict になる。
  IF irori_private.dinner_grocery_settle(h, p_grocery_id, NULL) THEN
    SELECT * INTO g FROM public.grocery_items t WHERE t.id = p_grocery_id;
  END IF;
  IF p_pantry_item_id = ANY(g.restock_ids) THEN
    RETURN jsonb_build_object('status', 'replayed', 'item', to_jsonb(g), 'pantry_item', CASE WHEN p.id IS NOT NULL THEN to_jsonb(p) END);
  END IF;
  IF p_grocery_version IS NULL OR g.updated_at <> p_grocery_version THEN
    RETURN jsonb_build_object('status', 'conflict', 'item', to_jsonb(g), 'pantry_item', NULL);
  END IF;
  IF p.id IS NOT NULL THEN RAISE EXCEPTION 'pantry id in use' USING ERRCODE = '23505'; END IF;
  IF v_qty IS NOT NULL AND g.unit IS NULL THEN
    RAISE EXCEPTION 'quantity needs a unit' USING ERRCODE = '22023';
  END IF;
  IF g.purchased_quantity > 0 THEN
    v_avail := greatest(g.purchased_quantity - least(g.purchased_quantity, g.restocked_quantity) - g.consumed_quantity, 0);
    IF v_avail <= 0 THEN
      RAISE EXCEPTION 'nothing to restock' USING ERRCODE = '22023';
    END IF;
    IF v_qty IS NOT NULL AND v_qty > v_avail THEN
      RAISE EXCEPTION 'restock exceeds purchase' USING ERRCODE = '22023';
    END IF;
  ELSIF NOT (g.purchased AND NOT g.purchase_consumed) THEN
    RAISE EXCEPTION 'not purchased' USING ERRCODE = '22023';
  END IF;
  IF cardinality(g.restock_ids) >= 50 THEN
    RAISE EXCEPTION 'too many restocks' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.pantry_items(id, household_id, ingredient_id, name, quantity, unit, status, use_soon, confirmed_on, created_by)
  VALUES (p_pantry_item_id, h, g.ingredient_id, g.name, v_qty, CASE WHEN v_qty IS NOT NULL THEN g.unit END, 'have', false, today, auth.uid())
  RETURNING * INTO p;
  UPDATE public.grocery_items t SET
    restocked_quantity = t.restocked_quantity + coalesce(v_qty, 0), restock_ids = t.restock_ids || p_pantry_item_id,
    updated_at = clock_timestamp()
  WHERE t.id = p_grocery_id RETURNING * INTO g;
  RETURN jsonb_build_object('status', 'saved', 'item', to_jsonb(g), 'pantry_item', to_jsonb(p));
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. AI 補助の回数計上（世帯 1 日 10 回・UTC 日）と無料枠の枯渇による全体停止
-- ─────────────────────────────────────────────────────────────────────────────

-- 1 回ぶんを原子的に確保する。provider が停止中なら計上しない。
CREATE FUNCTION public.claim_dinner_ai_call(p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE h uuid; v_until timestamptz; v_used integer; v_day date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  h := irori_private.dinner_household();
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'invalid limit' USING ERRCODE = '22023';
  END IF;
  SELECT s.exhausted_until INTO v_until FROM public.dinner_ai_provider_state s WHERE s.id;
  IF v_until IS NOT NULL AND v_until > now() THEN
    RETURN jsonb_build_object('status', 'provider_exhausted', 'resets_at', v_until);
  END IF;
  INSERT INTO public.dinner_ai_usage AS u (household_id, usage_day, calls) VALUES (h, v_day, 1)
  ON CONFLICT (household_id, usage_day) DO UPDATE SET calls = u.calls + 1 WHERE u.calls < p_limit
  RETURNING u.calls INTO v_used;
  IF v_used IS NULL THEN
    SELECT u.calls INTO v_used FROM public.dinner_ai_usage u WHERE u.household_id = h AND u.usage_day = v_day;
    RETURN jsonb_build_object('status', 'household_limit', 'used', coalesce(v_used, 0), 'limit', p_limit);
  END IF;
  RETURN jsonb_build_object('status', 'ok', 'used', v_used, 'limit', p_limit);
END;
$$;

-- 表示用（計上しない）。
CREATE FUNCTION public.dinner_ai_status() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE h uuid; v_until timestamptz; v_used integer;
BEGIN
  h := irori_private.dinner_household();
  SELECT s.exhausted_until INTO v_until FROM public.dinner_ai_provider_state s WHERE s.id;
  SELECT u.calls INTO v_used FROM public.dinner_ai_usage u
  WHERE u.household_id = h AND u.usage_day = (now() AT TIME ZONE 'UTC')::date;
  RETURN jsonb_build_object(
    'used', coalesce(v_used, 0),
    'provider_exhausted', coalesce(v_until > now(), false),
    'resets_at', CASE WHEN v_until > now() THEN v_until END);
END;
$$;

-- 日次無料枠の枯渇を記録する。サーバー（service_role）だけが呼べる。
CREATE FUNCTION public.mark_dinner_ai_exhausted(p_until timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_until IS NULL OR NOT isfinite(p_until) OR p_until <= now() OR p_until > now() + interval '26 hours' THEN
    RAISE EXCEPTION 'invalid until' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.dinner_ai_provider_state AS s (id, exhausted_until) VALUES (true, p_until)
  ON CONFLICT (id) DO UPDATE SET exhausted_until = EXCLUDED.exhausted_until, updated_at = clock_timestamp();
  RETURN jsonb_build_object('status', 'saved', 'exhausted_until', p_until);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. EXECUTE 権限（シグネチャ完全一致で REVOKE → GRANT。anon には何も与えない）
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.save_dinner_settings(timestamptz, integer, boolean, integer, text[], jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_pantry_item(uuid, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_pantry_item(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.add_pantry_items(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_food_exclusion(uuid, text, uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_food_exclusion(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_food_preference(uuid, timestamptz, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_food_preference(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_dish_feedback(uuid, timestamptz, text, text, date, integer, integer, boolean, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_dish_feedback(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_dinner_plan(uuid, bigint, date, date, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_dinner_entry(uuid, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_dinner_entry(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_dinner_entries(bigint, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_grocery_auto_items(uuid, bigint, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_grocery_manual_item(uuid, timestamptz, text, numeric, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_grocery_item(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_grocery_purchase(uuid, timestamptz, numeric, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_grocery_item_meta(uuid, timestamptz, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.restock_pantry_from_grocery(uuid, timestamptz, uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_dinner_ai_call(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dinner_ai_status() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_dinner_ai_exhausted(timestamptz) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.save_dinner_settings(timestamptz, integer, boolean, integer, text[], jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_pantry_item(uuid, timestamptz, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_pantry_item(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_pantry_items(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_food_exclusion(uuid, text, uuid, uuid, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_food_exclusion(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_food_preference(uuid, timestamptz, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_food_preference(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_dish_feedback(uuid, timestamptz, text, text, date, integer, integer, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_dish_feedback(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_dinner_plan(uuid, bigint, date, date, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_dinner_entry(uuid, timestamptz, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_dinner_entry(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_dinner_entries(bigint, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_grocery_auto_items(uuid, bigint, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_grocery_manual_item(uuid, timestamptz, text, numeric, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_grocery_item(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_grocery_purchase(uuid, timestamptz, numeric, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_grocery_item_meta(uuid, timestamptz, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restock_pantry_from_grocery(uuid, timestamptz, uuid, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_dinner_ai_call(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dinner_ai_status() TO authenticated;
-- 枯渇の記録はサーバー専用（cron / Server Action の service role）。
GRANT EXECUTE ON FUNCTION public.mark_dinner_ai_exhausted(timestamptz) TO service_role;
