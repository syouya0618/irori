-- 家事（ごみ・掃除・ごはん）の 3 本の migration が作った関数と表の、権限の横断検査（X-07 / X-08）。
--   採用方式: 新規表は「SELECT 用の RLS ＋ 直接 DML の GRANT もポリシーも無し ＋ 認可済みの SECURITY DEFINER RPC だけが書く」。
--   ポリシーの本数ではなく、実効権限で確かめる:
--   * 全関数: PUBLIC / anon に EXECUTE が無い（proacl が NULL = 既定の PUBLIC 実行、も不合格）。固定の search_path=''。
--     所有者は API ロールではなく、既存の表（households）と同じ migration の所有者。
--   * irori_private の内部ヘルパは API ロールの誰も実行できない。
--   * 書込 RPC は authenticated だけが実行でき（mark_dinner_ai_exhausted は service_role だけ）、
--     未ログイン・世帯を持たぬ利用者・子ども閲覧招待の受諾者・世帯内の viewer・未承認のメンバーは、
--     引数に依らず 42501（認可が入力の検証より先）。
--   * 新規表: RLS が有効、anon / authenticated / PUBLIC に INSERT / UPDATE / DELETE / TRUNCATE の権限が無い、
--     anon に SELECT も無い、ポリシーは SELECT だけ（FOR ALL・書込ポリシーなし）。
-- 関数・表を足したら、下の一覧（pg_temp.chores_public_rpcs / pg_temp.chores_tables）と件数の検査を一緒に直すこと。
BEGIN;
SELECT plan(175);

CREATE FUNCTION pg_temp.chores_public_rpcs() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    -- 20261111100001_event_purposes
    'save_event_purpose','delete_orphan_event_purpose','cleanup_deleted_event_purposes',
    -- 20261111100002_cleaning_routines
    'save_cleaning_routine','set_cleaning_routine_state','record_cleaning_log','update_cleaning_log','void_cleaning_log',
    'cleaning_log_marks',
    -- 20261111100003_dinner_tables
    'save_dinner_settings','save_pantry_item','delete_pantry_item','add_pantry_items',
    'save_food_exclusion','delete_food_exclusion','save_food_preference','delete_food_preference',
    'save_dish_feedback','delete_dish_feedback',
    'apply_dinner_plan','save_dinner_entry','delete_dinner_entry','confirm_dinner_entries',
    'sync_grocery_auto_items','save_grocery_manual_item','delete_grocery_item','set_grocery_purchase',
    'update_grocery_item_meta','restock_pantry_from_grocery',
    'claim_dinner_ai_call','dinner_ai_status','mark_dinner_ai_exhausted'
  ]::text[]
$$;
-- 読み取りだけの RPC（書込の拒否の対象から外す。cleaning_log_marks は SECURITY INVOKER で RLS が効く）
CREATE FUNCTION pg_temp.chores_read_rpcs() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['cleaning_log_marks','dinner_ai_status']::text[]
$$;
CREATE FUNCTION pg_temp.chores_tables() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    'event_purposes','cleaning_routines','cleaning_logs',
    'dinner_settings','pantry_items','food_exclusions','food_preferences','dish_feedback',
    'dinner_plan_state','dinner_plan_entries','grocery_items','dinner_ai_usage','dinner_ai_provider_state'
  ]::text[]
$$;

-- 3 本の migration が作った関数（public の RPC ＋ irori_private の内部ヘルパ・トリガ関数）
CREATE TEMP TABLE chores_fn AS
SELECT p.oid, n.nspname, p.proname, p.prosecdef, p.proconfig, p.proacl, p.proowner
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE (n.nspname = 'public' AND p.proname = ANY(pg_temp.chores_public_rpcs()))
   OR (n.nspname = 'irori_private' AND (
        p.proname LIKE 'cleaning\_%' OR p.proname LIKE 'dinner\_%'
        OR p.proname IN ('event_series_key','event_purpose_is_orphan','calendar_events_apply_purpose_default',
                         'event_reminders_record_opt_out','event_reminders_clear_opt_out')));

-- ── 1. 関数の一覧が揃っている（一覧と実体のずれを見逃さない） ──
SELECT is((SELECT count(DISTINCT proname) FROM chores_fn WHERE nspname = 'public'),
  cardinality(pg_temp.chores_public_rpcs())::bigint, 'every listed chores RPC exists in public');
SELECT is((SELECT count(*) FROM chores_fn WHERE nspname = 'public'),
  cardinality(pg_temp.chores_public_rpcs())::bigint, 'no chores RPC has a second overload');
SELECT cmp_ok((SELECT count(*) FROM chores_fn WHERE nspname = 'irori_private'), '>=', 10::bigint,
  'internal chores helpers are found by their prefixes');

-- ── 2. EXECUTE: PUBLIC と anon には誰にも無い。proacl が NULL（既定 = PUBLIC 実行）も不合格 ──
SELECT is((SELECT array_agg(nspname || '.' || proname ORDER BY nspname, proname) FROM chores_fn WHERE proacl IS NULL),
  NULL::text[], 'no chores function keeps the default PUBLIC EXECUTE (proacl is never NULL)');
SELECT is((SELECT array_agg(DISTINCT f.nspname || '.' || f.proname)
           FROM chores_fn f, aclexplode(f.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'),
  NULL::text[], 'PUBLIC has no EXECUTE on any chores function');
SELECT is((SELECT array_agg(nspname || '.' || proname ORDER BY nspname, proname) FROM chores_fn
           WHERE has_function_privilege('anon', oid, 'EXECUTE')),
  NULL::text[], 'anon cannot execute any chores function');
SELECT is((SELECT array_agg(proname::text ORDER BY proname) FROM chores_fn
           WHERE nspname = 'irori_private'
             AND (has_function_privilege('authenticated', oid, 'EXECUTE') OR has_function_privilege('anon', oid, 'EXECUTE'))),
  NULL::text[], 'internal chores helpers are not executable by the client roles');
SELECT is((SELECT array_agg(proname::text ORDER BY proname) FROM chores_fn
           WHERE nspname = 'public' AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')),
  ARRAY['mark_dinner_ai_exhausted']::text[], 'authenticated executes every chores RPC except the provider-exhaustion marker');
SELECT ok(has_function_privilege('service_role', 'public.mark_dinner_ai_exhausted(timestamptz)', 'EXECUTE'),
  'control: the provider-exhaustion marker is reserved for service_role');

-- ── 3. definer の安全: 固定の空 search_path、所有者は API ロールではない ──
SELECT is((SELECT array_agg(nspname || '.' || proname ORDER BY nspname, proname) FROM chores_fn
           WHERE proconfig IS NULL OR NOT proconfig @> ARRAY['search_path=""']),
  NULL::text[], 'every chores function pins search_path to the empty string');
SELECT cmp_ok((SELECT count(*) FROM chores_fn WHERE nspname = 'public' AND prosecdef), '>=', 25::bigint,
  'the write RPCs are SECURITY DEFINER');
SELECT is((SELECT array_agg(proname::text ORDER BY proname) FROM chores_fn
           WHERE nspname = 'public' AND NOT prosecdef),
  ARRAY['cleaning_log_marks']::text[], 'only the read-side marks RPC runs as the caller (RLS applies)');
SELECT is((SELECT array_agg(DISTINCT pg_get_userbyid(proowner)::text) FROM chores_fn
           WHERE pg_get_userbyid(proowner) IN ('anon','authenticated','service_role','authenticator')),
  NULL::text[], 'no chores function is owned by an API role');
SELECT is((SELECT count(*) FROM chores_fn WHERE proowner <> (SELECT relowner FROM pg_class WHERE oid = 'public.households'::regclass)),
  0::bigint, 'chores functions are owned by the same migration owner as the existing schema');

-- ── 4. 新規表: RLS・直接 DML の権限・ポリシーの形 ──
SELECT is((SELECT count(*) FROM pg_class c WHERE c.oid = ANY(SELECT ('public.' || t)::regclass FROM unnest(pg_temp.chores_tables()) t)),
  cardinality(pg_temp.chores_tables())::bigint, 'every listed chores table exists');
SELECT is((SELECT array_agg(c.relname::text ORDER BY c.relname) FROM pg_class c
           WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(pg_temp.chores_tables()) AND NOT c.relrowsecurity),
  NULL::text[], 'RLS is enabled on every chores table');
SELECT is((SELECT array_agg(DISTINCT t || ':' || r || ':' || p ORDER BY t || ':' || r || ':' || p)
           FROM unnest(pg_temp.chores_tables()) t, unnest(ARRAY['anon','authenticated']) r,
                unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
           WHERE has_table_privilege(r, 'public.' || t, p)),
  NULL::text[], 'anon and authenticated hold no write privilege on any chores table');
SELECT is((SELECT array_agg(DISTINCT c.relname::text) FROM pg_class c, aclexplode(c.relacl) a
           WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(pg_temp.chores_tables()) AND a.grantee = 0),
  NULL::text[], 'PUBLIC holds no privilege on any chores table');
SELECT is((SELECT array_agg(c.relname::text ORDER BY c.relname) FROM pg_class c
           WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(pg_temp.chores_tables()) AND c.relacl IS NULL),
  NULL::text[], 'no chores table keeps default (NULL) privileges');
SELECT is((SELECT array_agg(t ORDER BY t) FROM unnest(pg_temp.chores_tables()) t WHERE has_table_privilege('anon', 'public.' || t, 'SELECT')),
  NULL::text[], 'anon cannot read any chores table');
SELECT is((SELECT array_agg(DISTINCT c.relname || ':' || pol.polname) FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
           WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(pg_temp.chores_tables()) AND pol.polcmd <> 'r'),
  NULL::text[], 'chores tables have no write or FOR ALL policy (writes go through the RPCs only)');
SELECT is((SELECT array_agg(DISTINCT c.relname || ':' || pol.polname) FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
           WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(pg_temp.chores_tables())
             AND NOT (pol.polroles = ARRAY['authenticated'::regrole::oid])),
  NULL::text[], 'every chores read policy targets authenticated only');

-- ── 5. 書込 RPC の呼び出し文（全引数 NULL）。認可は入力の検証より先ゆえ、拒否は引数に依らず 42501 ──
CREATE TEMP TABLE chores_calls AS
SELECT f.proname::text AS fn,
       format('SELECT public.%I(%s)', f.proname,
              coalesce((SELECT string_agg(format('NULL::%s', format_type(u.t, NULL)), ', ' ORDER BY u.o)
                        FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS u(t, o)), '')) AS sql
FROM chores_fn f JOIN pg_proc p ON p.oid = f.oid
WHERE f.nspname = 'public' AND NOT (f.proname = ANY(pg_temp.chores_read_rpcs()));
GRANT SELECT ON chores_calls TO anon, authenticated;
SELECT is((SELECT count(*) FROM chores_calls), 30::bigint, 'thirty write RPCs are checked for every refused identity');

INSERT INTO households(id, name) VALUES ('f7000000-0000-4000-8000-000000000001', 'synthetic chores security');
INSERT INTO auth.users(id, email) VALUES
  ('f7000000-0000-4000-8000-000000000002', 'chores-sec-owner@example.invalid'),
  ('f7000000-0000-4000-8000-000000000003', 'chores-sec-hh-viewer@example.invalid'),
  ('f7000000-0000-4000-8000-000000000004', 'chores-sec-unapproved@example.invalid'),
  ('f7000000-0000-4000-8000-000000000005', 'chores-sec-share-viewer@example.invalid'),
  ('f7000000-0000-4000-8000-000000000006', 'chores-sec-no-household@example.invalid');
UPDATE profiles SET household_id = 'f7000000-0000-4000-8000-000000000001', is_approved = true, role = 'owner'
  WHERE id = 'f7000000-0000-4000-8000-000000000002';
UPDATE profiles SET household_id = 'f7000000-0000-4000-8000-000000000001', is_approved = true, role = 'viewer'
  WHERE id = 'f7000000-0000-4000-8000-000000000003';
UPDATE profiles SET household_id = 'f7000000-0000-4000-8000-000000000001', is_approved = false, role = 'member'
  WHERE id = 'f7000000-0000-4000-8000-000000000004';
-- 子ども閲覧招待を受けた利用者の行の形（accept_child_share 後: 承認済み・viewer・世帯なし。e2e/child-sharing.spec.ts と同じ）
UPDATE profiles SET household_id = NULL, is_approved = true, role = 'viewer'
  WHERE id = 'f7000000-0000-4000-8000-000000000005';
UPDATE profiles SET household_id = NULL, is_approved = true
  WHERE id = 'f7000000-0000-4000-8000-000000000006';

-- 対照: 同じ世帯の owner は、認可を通って入力の検証（22023）まで届く（拒否が「誰でも 42501」ではない）
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"f7000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SELECT throws_ok($$SELECT public.save_cleaning_routine(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)$$, '22023', NULL,
  'control: the household owner passes authorization and reaches input validation');
SELECT throws_ok($$SELECT public.save_pantry_item(NULL,NULL,NULL)$$, '22023', NULL,
  'control: the household owner reaches dinner input validation');

-- 未ログイン（anon）: EXECUTE が無い
RESET ROLE;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SELECT throws_ok(c.sql, '42501', NULL, 'anon is refused: ' || c.fn) FROM chores_calls c ORDER BY c.fn;

-- 子ども閲覧招待の受諾者（承認済み viewer・世帯なし）
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"f7000000-0000-4000-8000-000000000005","role":"authenticated"}', true);
SELECT throws_ok(c.sql, '42501', NULL, 'child-share viewer is refused: ' || c.fn) FROM chores_calls c ORDER BY c.fn;

-- 世帯に居るが viewer
SELECT set_config('request.jwt.claims', '{"sub":"f7000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
SELECT throws_ok(c.sql, '42501', NULL, 'household viewer is refused: ' || c.fn) FROM chores_calls c ORDER BY c.fn;

-- 世帯に居るが未承認
SELECT set_config('request.jwt.claims', '{"sub":"f7000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
SELECT throws_ok(c.sql, '42501', NULL, 'unapproved member is refused: ' || c.fn) FROM chores_calls c ORDER BY c.fn;

-- 承認済みだが世帯なし（mark_dinner_ai_exhausted は EXECUTE が無いことで 42501）
SELECT set_config('request.jwt.claims', '{"sub":"f7000000-0000-4000-8000-000000000006","role":"authenticated"}', true);
SELECT throws_ok(c.sql, '42501', NULL, 'approved user without a household is refused: ' || c.fn) FROM chores_calls c ORDER BY c.fn;

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
