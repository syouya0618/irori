-- 承認関数 `approve_user` / `get_pending_approvals` の権限ゲートを pgTAP で固定する（I-13 → P1-02）。
-- 実行: supabase test db supabase/tests/approval_functions.sql
--
-- ## ⚠️ 旧版の (11)「別世帯 owner も承認できる」を**意図して反転した**（2026-10 / P1-02）
-- 旧版は「全 owner が全 pending を見て承認できる（グローバル allowlist）」を
-- 意図された設計として固定しておった（20260603000001:108-125）。その記録自身が
-- 「マルチテナント分離（独立した複数家族の併存）が要件化した場合は承認モデル自体を
-- 再設計せよ」と先送り条件を書いておったが、その条件はもう成立しておる:
--   * 世帯同士は**互いに信頼しない**（公開サインアップのインスタンスに複数の家族が併存する）
--   * にもかかわらず、新規サインアップした第三者の **email・表示名・登録時刻が全世帯の
--     owner に見え**、どの owner も見知らぬ他人を承認できた（世帯を跨ぐ PII の漏洩）
--   * しかも P1-01 により誰でも owner になれたゆえ、匿名サインアップ 1 つで email を収穫できた
-- ゆえに承認は**インスタンス運用者（app_operators）の権能**へ移した
-- （20261002100002_restrict_approvals_to_operators.sql）。世帯 owner の権能ではない。
--
-- ## 「自世帯フィルタ」を入れぬ理由は今も生きておる
-- 承認待ち(is_approved=false)ユーザーは必ず household_id IS NULL じゃ（handle_new_user は
-- 世帯を設定せず、create_household は承認済みにしか通らず、accept_invitation は承認と
-- 所属を同時に立てる）。ゆえに「自世帯の pending」なる概念は存在せず、世帯フィルタは
-- 承認導線を全損させる（H3 撤回の理由）。運用者モデルはこの前提を変えずに分離を回復する。
--
-- ## superuser では検出できぬ
-- 両関数と is_app_operator() は auth.uid() で分岐する。superuser 文脈では auth.uid() が
-- NULL となり**どれも拒否側の枝に落ちる**ため、「拒否された」assert が偽緑になる。
-- ゆえに authenticated + request.jwt.claims を注入して実際に通す。
--
-- ## 偽緑を潰す設計
-- (S) 承認待ち 2 人と運用者 1 人が seed されたことを先に固定する（居らねば拒否は常に緑）。
--     数えるのは本テストが seed した ID に限る（手元 DB の残留ユーザーに依らぬ）。
-- (C) 拒否（member / 自世帯 owner / 別世帯 owner）と受理（運用者）を同じファイルで撃つ。
-- (P) 承認状態は superuser で観測する（profiles_select が未所属の他人の行を隠すため）。
BEGIN;
SELECT plan(30);

-- ── seed(superuser = RLS バイパス) ─────────────────────────────
-- H1 = owner U1 / member U2, H2 = owner U5 / member U6（U6 が運用者）
-- U3, U4 = 承認待ち（household_id IS NULL / is_approved=false）
-- 運用者 U6 をあえて **owner ではない member** にする: 権能が role ではなく
-- app_operators の在籍から来ることを示すため。
INSERT INTO households (id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'H1'),
  ('99999999-9999-9999-9999-999999999999', 'H2');
INSERT INTO auth.users (id, email) VALUES
  ('22222222-2222-2222-2222-222222222222', 'owner1@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'member1@example.com'),
  ('44444444-4444-4444-4444-444444444444', 'pending1@example.com'),
  ('55555555-5555-5555-5555-555555555555', 'pending2@example.com'),
  ('66666666-6666-6666-6666-666666666666', 'owner2@example.com'),
  ('77777777-7777-7777-7777-777777777777', 'operator@example.com');
UPDATE profiles SET household_id = '11111111-1111-1111-1111-111111111111',
                    display_name = 'U1 owner', role = 'owner', is_approved = true
  WHERE id = '22222222-2222-2222-2222-222222222222';
UPDATE profiles SET household_id = '11111111-1111-1111-1111-111111111111',
                    display_name = 'U2 member', role = 'member', is_approved = true
  WHERE id = '33333333-3333-3333-3333-333333333333';
UPDATE profiles SET household_id = '99999999-9999-9999-9999-999999999999',
                    display_name = 'U5 owner(H2)', role = 'owner', is_approved = true
  WHERE id = '66666666-6666-6666-6666-666666666666';
UPDATE profiles SET household_id = '99999999-9999-9999-9999-999999999999',
                    display_name = 'U6 operator(H2 member)', role = 'member', is_approved = true
  WHERE id = '77777777-7777-7777-7777-777777777777';
-- 運用者の登録は service role / SQL Editor の手作業（migration は誰も seed せぬ = fail-closed）。
INSERT INTO app_operators (user_id) VALUES ('77777777-7777-7777-7777-777777777777');
-- U3/U4 は handle_new_user が作った素の行のまま（household_id NULL・is_approved false）

-- ── (1)(2) seed が効いておることの固定 ──────────────────────────
-- ⚠️ **本テストが seed した ID に限定して数える**（世界全体を数えぬ）。
-- 世界を数えると、手元で e2e を一度回しただけの残留ユーザーで無関係に赤くなる
-- （実測: 残留 13 人 + seed 2 人 = 15）。変更と無関係な赤は「赤に慣れる」を招く。
SELECT is(
  (SELECT count(*) FROM profiles
    WHERE id IN ('44444444-4444-4444-4444-444444444444',
                 '55555555-5555-5555-5555-555555555555')
      AND is_approved = false AND household_id IS NULL),
  2::bigint, 'seed: 本テストの承認待ち 2 人が居る（household_id は NULL）');
SELECT is(
  (SELECT count(*) FROM app_operators
    WHERE user_id IN ('22222222-2222-2222-2222-222222222222',
                      '33333333-3333-3333-3333-333333333333',
                      '66666666-6666-6666-6666-666666666666',
                      '77777777-7777-7777-7777-777777777777')),
  1::bigint, 'seed: 本テストの運用者は U6 の 1 人だけ（owner は誰も運用者ではない）');

-- ══ member(H1) 文脈 ════════════════════════════════════════════
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '33333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text, true);

-- (3) member には承認待ち一覧が見えぬ
SELECT is((SELECT count(*) FROM get_pending_approvals()), 0::bigint,
  'get_pending_approvals: member には 0 件');
-- (4) member は承認できぬ
SELECT throws_ok(
  $$ SELECT approve_user('44444444-4444-4444-4444-444444444444') $$,
  '42501', 'Only app operators can approve users',
  'approve_user: member は 42501 で拒否される');

-- ══ owner(H1) 文脈 — 自世帯の owner でも運用者でなければ見えぬ ═══
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '22222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);

-- (5) 旧版では 2 件見えておった（他人の email が全 owner に漏れておった）
SELECT is((SELECT count(*) FROM get_pending_approvals()), 0::bigint,
  'get_pending_approvals: 運用者でない owner には 0 件（他人の email を見せぬ）');
-- (6) 承認もできぬ
SELECT throws_ok(
  $$ SELECT approve_user('44444444-4444-4444-4444-444444444444') $$,
  '42501', 'Only app operators can approve users',
  'approve_user: 運用者でない owner は 42501 で拒否される');
-- (7) 運用者判定は false
SELECT is(is_app_operator(), false,
  'is_app_operator: 運用者でない owner には false');

-- ══ owner(H2) 文脈 — 旧 (11) の反転 ════════════════════════════
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '66666666-6666-6666-6666-666666666666', 'role', 'authenticated')::text, true);

-- (8) 別世帯の owner にも一覧は見えぬ
SELECT is((SELECT count(*) FROM get_pending_approvals()), 0::bigint,
  'get_pending_approvals: 別世帯の owner にも 0 件');
-- (9) 旧版の (11)「別世帯 owner も承認できる」を**意図して反転**した
SELECT throws_ok(
  $$ SELECT approve_user('55555555-5555-5555-5555-555555555555') $$,
  '42501', 'Only app operators can approve users',
  'approve_user: 別世帯の owner は承認できぬ（旧 (11) を反転・世帯は相互に非信頼）');

-- ══ 未認証（sub 無し）══════════════════════════════════════════
SELECT set_config('request.jwt.claims',
  json_build_object('role', 'authenticated')::text, true);
-- (10)(11) auth.uid() が NULL でも fail-closed
SELECT is((SELECT count(*) FROM get_pending_approvals()), 0::bigint,
  'get_pending_approvals: sub の無い呼び出しには 0 件');
SELECT throws_ok(
  $$ SELECT approve_user('55555555-5555-5555-5555-555555555555') $$,
  '42501', 'Only app operators can approve users',
  'approve_user: sub の無い呼び出しは 42501');

-- (12) 運用者表そのものは authenticated から読めぬ（誰が運用者かを列挙させぬ）
SELECT throws_ok(
  $$ SELECT user_id FROM app_operators $$,
  '42501', 'permission denied for table app_operators',
  'app_operators: authenticated は運用者表を読めぬ');
-- (13) 自分を運用者に登録することもできぬ
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '22222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);
SELECT throws_ok(
  $$ INSERT INTO app_operators (user_id) VALUES ('22222222-2222-2222-2222-222222222222') $$,
  '42501', 'permission denied for table app_operators',
  'app_operators: authenticated は自分を運用者に登録できぬ');

-- ── 拒否の副作用が無いことを superuser で観測する ─────────────────
-- profiles の観測は superuser で行う。authenticated のままだと profiles_select が
-- 未所属の他人の行を隠し、is_approved が false ではなく NULL で返って assert の意味が変わる。
RESET ROLE;
-- (14) 承認待ち 2 人とも未承認のまま
SELECT is(
  (SELECT count(*) FROM profiles
    WHERE id IN ('44444444-4444-4444-4444-444444444444',
                 '55555555-5555-5555-5555-555555555555')
      AND is_approved = false),
  2::bigint, 'approve_user: 拒否された呼び出しで承認状態は変わらぬ');
-- (15) U1 は運用者になっておらぬ
SELECT is(
  (SELECT count(*) FROM app_operators WHERE user_id = '22222222-2222-2222-2222-222222222222'),
  0::bigint, 'app_operators: 拒否された INSERT は行を残さぬ');

-- ══ 運用者(U6) 文脈 — (3)〜(11) が「関数が壊れておるだけ」ではない対照 ══
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '77777777-7777-7777-7777-777777777777', 'role', 'authenticated')::text, true);

-- (16) 運用者判定は true（owner ではない member でも、在籍で決まる）
SELECT is(is_app_operator(), true,
  'is_app_operator: 運用者には true（role ではなく app_operators の在籍で決まる）');
-- (17) 運用者には seed の承認待ち 2 人が見える
--      承認待ちは household_id IS NULL ゆえ、ここへ世帯フィルタを入れると 2 → 0 で赤くなる
--      （承認導線の全損 = H3 撤回の理由の門番）。
SELECT is(
  (SELECT count(*) FROM get_pending_approvals()
    WHERE id IN ('44444444-4444-4444-4444-444444444444',
                 '55555555-5555-5555-5555-555555555555')),
  2::bigint, 'get_pending_approvals: 運用者には seed の 2 件が見える');
-- (18) 一覧には email が載る（承認判断の材料・欠けたら導線が死ぬ）
SELECT is(
  (SELECT email FROM get_pending_approvals() WHERE id = '44444444-4444-4444-4444-444444444444'),
  'pending1@example.com', 'get_pending_approvals: 運用者には email が返る');
-- (19) 承認済みのユーザーは一覧に出ぬ（is_approved=false の絞りは保たれる）
SELECT is(
  (SELECT count(*) FROM get_pending_approvals()
    WHERE id IN ('22222222-2222-2222-2222-222222222222',
                 '33333333-3333-3333-3333-333333333333',
                 '66666666-6666-6666-6666-666666666666',
                 '77777777-7777-7777-7777-777777777777')),
  0::bigint, 'get_pending_approvals: 承認済みユーザーは載らぬ');
-- (20) 運用者は承認できる
SELECT lives_ok(
  $$ SELECT approve_user('44444444-4444-4444-4444-444444444444') $$,
  'approve_user: 運用者は承認できる');

-- (21)(22) 承認が実際に反映され、しかも世帯には入っておらぬ（承認 ≠ 世帯参加）
RESET ROLE;
SELECT is(
  (SELECT is_approved FROM profiles WHERE id = '44444444-4444-4444-4444-444444444444'),
  true, 'approve_user: is_approved が true になる');
SELECT is(
  (SELECT household_id FROM profiles WHERE id = '44444444-4444-4444-4444-444444444444'),
  NULL::uuid, 'approve_user: 承認しても世帯には入らぬ（参加は招待か /setup の世帯作成）');
SET LOCAL role authenticated;

-- (23) 二重承認は fail-loud（IF NOT FOUND 分岐・silent success を作らぬ）
SELECT throws_ok(
  $$ SELECT approve_user('44444444-4444-4444-4444-444444444444') $$,
  'P0001', 'User not found or already approved',
  'approve_user: 承認済みユーザーの再承認は拒否（silent success を作らぬ）');
-- (24) 存在せぬユーザーも fail-loud（0 行 UPDATE を成功と見せぬ）
SELECT throws_ok(
  $$ SELECT approve_user('00000000-0000-0000-0000-000000000000') $$,
  'P0001', 'User not found or already approved',
  'approve_user: 存在せぬユーザーは拒否（0 行 UPDATE を成功と見せぬ）');

RESET ROLE;
SELECT set_config('request.jwt.claims', NULL, true);

-- ══ カタログ（運用者表の deny-all と DEFINER の型）═════════════════
-- (25) RLS 有効・ポリシー 0 本 = API ロールには deny-all
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'app_operators'::regclass)
    AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'app_operators'::regclass),
  'app_operators: RLS 有効かつポリシー 0 本（API ロールには deny-all）');
-- (26) positive control → (27) anon / authenticated はいかなるテーブル権限も持たぬ
SELECT isnt(
  (SELECT relacl FROM pg_class WHERE oid = 'app_operators'::regclass),
  NULL, 'app_operators: relacl は NULL でない（次の negative assert の前提）');
SELECT is_empty(
  $$
  SELECT acl.grantee::regrole::text || ':' || acl.privilege_type
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(c.relacl) acl
  WHERE c.oid = 'app_operators'::regclass
    AND acl.grantee IN ('anon'::regrole, 'authenticated'::regrole)
  $$,
  'app_operators: anon / authenticated はいかなるテーブル権限も持たぬ');
-- (28) is_app_operator は SECURITY DEFINER かつ search_path 固定
SELECT ok(
  (SELECT prosecdef FROM pg_proc WHERE oid = 'is_app_operator()'::regprocedure)
    AND (SELECT proconfig FROM pg_proc WHERE oid = 'is_app_operator()'::regprocedure)
          @> ARRAY['search_path=public'],
  'is_app_operator: SECURITY DEFINER かつ SET search_path=public');
-- (29) 3 関数とも anon は実行できず、authenticated は実行できる（P3-03・対照つき）
SELECT ok(
  NOT has_function_privilege('anon', 'is_app_operator()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'get_pending_approvals()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'approve_user(uuid)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'is_app_operator()', 'EXECUTE')
    AND has_function_privilege('authenticated', 'get_pending_approvals()', 'EXECUTE')
    AND has_function_privilege('authenticated', 'approve_user(uuid)', 'EXECUTE'),
  'is_app_operator / get_pending_approvals / approve_user: anon 不可・authenticated 可');
-- (30) 承認 2 関数も SECURITY DEFINER かつ search_path 固定のまま
SELECT ok(
  (SELECT bool_and(prosecdef AND proconfig @> ARRAY['search_path=public'])
     FROM pg_proc
    WHERE oid IN ('get_pending_approvals()'::regprocedure, 'approve_user(uuid)'::regprocedure)),
  'get_pending_approvals / approve_user: SECURITY DEFINER かつ SET search_path=public');

SELECT * FROM finish();
ROLLBACK;
