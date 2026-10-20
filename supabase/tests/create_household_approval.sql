-- `create_household` の**呼び出し資格**を pgTAP で固定する（P1-01）。
-- 実行: supabase test db supabase/tests/create_household_approval.sql
--
-- ## なぜこの assert が要るか
-- `create_household` は SECURITY DEFINER で、成功すると呼び手を
-- `role='owner'`・`is_approved=true` にする。ところが 20260603000001 の版は
-- 「未所属か」しか見ておらず、**未承認ユーザーが RPC を直に 1 回叩くだけで
-- 承認済み owner へ自己昇格できた**。承認の判定は proxy（Next の経路）にしか
-- 無く、PostgREST を直に叩く者には効かぬ。家族専用インスタンスの唯一の入場
-- 制御が DB 層で素通しであった。20261002100001 が関数の頭で `is_approved` を
-- `FOR UPDATE` で検査して塞いだ。本ファイルはその門番じゃ。
--
-- ## 偽緑を潰す設計
-- (S) seed の固定: 「未承認は作れぬ」は未承認ユーザーが居らねば常に緑ゆえ、
--     先に三者（未承認・承認済み未所属・所属済み）の状態を assert する。
-- (C) 対照: 拒否だけでなく「承認済み・未所属なら作れる」を同じファイルで撃つ。
--     両方無いと、関数が丸ごと壊れておる状態と区別がつかぬ。
-- (P) 副作用の観測は superuser で行う。authenticated のままだと households_select
--     が他人の世帯を隠し、「作られておらぬ」と「見えぬだけ」の区別がつかぬ。
--     数えるのは本テストが付けた名前の世帯に限る（外部の残留データに依らぬ）。
--
-- ## superuser では検出できぬ
-- 関数は auth.uid() で分岐する。superuser 文脈では auth.uid() が NULL となり
-- 'Not authenticated' の枝に落ちるゆえ、authenticated + request.jwt.claims を
-- 注入して実際に通す（approval_functions.sql と同流儀）。
BEGIN;
SELECT plan(15);

-- ── seed(superuser = RLS バイパス) ─────────────────────────────
-- HX = 既存の世帯（UM が所属）
-- UP = 未承認（handle_new_user が作った素の行のまま）
-- UA = 承認済み・未所属（承認された後、/setup に来たところ）
-- UM = 所属済み（HX の owner）
INSERT INTO households (id, name) VALUES
  ('a1111111-1111-1111-1111-111111111111', 'P1-01 既存世帯');
INSERT INTO auth.users (id, email) VALUES
  ('a2222222-2222-2222-2222-222222222222', 'p101-pending@example.com'),
  ('a3333333-3333-3333-3333-333333333333', 'p101-approved@example.com'),
  ('a4444444-4444-4444-4444-444444444444', 'p101-member@example.com');
UPDATE profiles SET is_approved = true, display_name = 'UA'
  WHERE id = 'a3333333-3333-3333-3333-333333333333';
UPDATE profiles SET household_id = 'a1111111-1111-1111-1111-111111111111',
                    display_name = 'UM', role = 'owner', is_approved = true
  WHERE id = 'a4444444-4444-4444-4444-444444444444';

-- ── (1)(2)(3) seed が効いておることの固定 ───────────────────────
SELECT is(
  (SELECT count(*) FROM profiles
    WHERE id = 'a2222222-2222-2222-2222-222222222222'
      AND is_approved = false AND household_id IS NULL AND role = 'member'),
  1::bigint, 'seed: UP は未承認・未所属（handle_new_user の既定のまま）');
SELECT is(
  (SELECT count(*) FROM profiles
    WHERE id = 'a3333333-3333-3333-3333-333333333333'
      AND is_approved = true AND household_id IS NULL),
  1::bigint, 'seed: UA は承認済み・未所属');
SELECT is(
  (SELECT count(*) FROM profiles
    WHERE id = 'a4444444-4444-4444-4444-444444444444'
      AND household_id = 'a1111111-1111-1111-1111-111111111111'),
  1::bigint, 'seed: UM は既存世帯に所属');

-- ══ 未承認(UP) 文脈 ════════════════════════════════════════════
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'a2222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);

-- (4) 未承認は世帯を作れぬ（P1-01 の本体）
SELECT throws_ok(
  $$ SELECT create_household('P1-01 未承認の試み') $$,
  '42501', 'not approved',
  'create_household: 未承認ユーザーは 42501 で拒否される（RPC 直叩きの自己昇格を塞ぐ）');

-- ── 副作用が無いことを superuser で観測する ─────────────────────
RESET ROLE;
-- (5) 世帯は作られておらぬ
SELECT is(
  (SELECT count(*) FROM households WHERE name = 'P1-01 未承認の試み'),
  0::bigint, 'create_household: 未承認の失敗で世帯行は残らぬ');
-- (6) 未承認のまま・未所属のまま・owner にもなっておらぬ
--     （「pending ⇒ household_id IS NULL」の不変条件そのもの）
SELECT is(
  (SELECT count(*) FROM profiles
    WHERE id = 'a2222222-2222-2222-2222-222222222222'
      AND is_approved = false AND household_id IS NULL AND role = 'member'),
  1::bigint, 'create_household: 未承認の失敗で profiles は一切変わらぬ（承認も owner 化もされぬ）');

-- ══ 承認済み・未所属(UA) 文脈 — 対照 ══════════════════════════
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'a3333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text, true);

-- (7) 承認済みなら作れる（(4) が「関数が壊れておるだけ」ではない対照）
SELECT lives_ok(
  $$ SELECT create_household('P1-01 承認済みの世帯') $$,
  'create_household: 承認済み・未所属のユーザーは世帯を作れる（対照）');

RESET ROLE;
-- (8) 世帯が 1 つだけできておる
SELECT is(
  (SELECT count(*) FROM households WHERE name = 'P1-01 承認済みの世帯'),
  1::bigint, 'create_household: 世帯行が 1 つ作られる');
-- (9) 呼び手がその世帯の owner になっておる（例外が出ぬだけの偽緑を潰す）
SELECT is(
  (SELECT count(*) FROM profiles p
     JOIN households h ON h.id = p.household_id
    WHERE p.id = 'a3333333-3333-3333-3333-333333333333'
      AND p.role = 'owner' AND p.is_approved = true
      AND h.name = 'P1-01 承認済みの世帯'),
  1::bigint, 'create_household: 呼び手が作った世帯の owner として所属する');

-- ══ 所属済み(UM) 文脈 — 再作成・横移動の拒否は従来どおり ═══════
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'a4444444-4444-4444-4444-444444444444', 'role', 'authenticated')::text, true);

-- (10) 既に所属しておれば拒否（承認検査を足しても従来の枝が生きておる）
SELECT throws_ok(
  $$ SELECT create_household('P1-01 二つ目の世帯') $$,
  'P0001', 'User already belongs to a household',
  'create_household: 所属済みユーザーは従来どおり拒否される');

-- ══ 未認証（sub 無し）══════════════════════════════════════════
SELECT set_config('request.jwt.claims',
  json_build_object('role', 'authenticated')::text, true);
-- (11) auth.uid() が NULL なら承認検査より前に落ちる
SELECT throws_ok(
  $$ SELECT create_household('P1-01 未認証') $$,
  'P0001', 'Not authenticated',
  'create_household: sub の無い呼び出しは Not authenticated');

RESET ROLE;
SELECT set_config('request.jwt.claims', NULL, true);
-- (12) 拒否された 2 件とも世帯を残しておらぬ
SELECT is(
  (SELECT count(*) FROM households WHERE name IN ('P1-01 二つ目の世帯', 'P1-01 未認証')),
  0::bigint, 'create_household: 拒否された呼び出しは世帯行を残さぬ');

-- ══ カタログ（DEFINER の型と実行権限）══════════════════════════
-- (13)(14) SECURITY DEFINER と search_path 固定（CLAUDE.md の既知の罠）
SELECT is(
  (SELECT prosecdef FROM pg_proc WHERE oid = 'create_household(text)'::regprocedure),
  true, 'create_household は SECURITY DEFINER');
SELECT ok(
  (SELECT proconfig FROM pg_proc WHERE oid = 'create_household(text)'::regprocedure)
    @> ARRAY['search_path=public'],
  'create_household に SET search_path=public が付いておる');
-- (15) anon は実行できぬ（P3-03: REVOKE FROM PUBLIC だけでは既定の anon GRANT が残る）
SELECT ok(
  NOT has_function_privilege('anon', 'create_household(text)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'create_household(text)', 'EXECUTE'),
  'create_household: anon は EXECUTE を持たず、authenticated は持つ（対照つき）');

SELECT * FROM finish();
ROLLBACK;
