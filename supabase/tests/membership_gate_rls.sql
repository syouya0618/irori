-- 世帯メンバーシップの**門**（households / profiles の RLS と権限）を固定する（P2-38）。
-- 実行: supabase test db supabase/tests/membership_gate_rls.sql
--
-- ## なぜこの assert が要るか
-- 世帯分離の錨 `get_my_household_id()` は `profiles.household_id` を読む。ゆえに
-- **households と profiles そのもの**が門じゃ。ところが既存の pgTAP は錨の
-- 「下流」（baby_logs / diaries / calendar_events 等）しか撃っておらず、
-- households を authenticated で読み書きする assert は 0 本であった。
-- その隙間で P1-01（未承認の自己昇格）と P3-01（households_insert
-- `WITH CHECK (true)`・TO 句なし）が CI 緑のまま本番に入った。
--
-- ## 見るもの
--   A. カタログ: households の INSERT ポリシー撤去と INSERT/DELETE/TRUNCATE の
--      REVOKE（20261002100001）、招待 2 関数の anon EXECUTE 剥奪（P3-03）
--   B. 実挙動: 他世帯 / 未承認 / anon × SELECT / INSERT / UPDATE（世帯の移動を含む）/ DELETE
--   C. 書込側の無改変は superuser へ戻って観測する
--
-- ## 偽緑を潰す設計（household_isolation_rls.sql と同じ三段）
-- (0) SET ROLE の前に superuser で seed を固定する（行が無ければ「見えぬ」は常に緑）
-- (1) RLS 下の件数は 0 でも全件でもない「ちょうど」を要求し、識別子まで見る
-- (2) UPDATE の拒否は 0 行で黙って通るゆえ、その場ではなく superuser で値の不変を見る。
--     同じ文脈で**自世帯の UPDATE が効く**対照も置く（UPDATE が丸ごと壊れた状態と区別する）
--
-- ## 拒否の原因を取り違えぬこと
-- 「permission denied for table」と「new row violates row-level security policy」は
-- どちらも SQLSTATE 42501 じゃ。ゆえに throws_ok にはメッセージまで渡し、
-- どちらの層が止めたかを固定する。
BEGIN;
SELECT plan(30);

-- ── seed(superuser = RLS バイパス) ─────────────────────────────
-- H1 = U1(owner) / U2(member)、H2 = U3(owner)、UP = 未承認（household_id NULL）
INSERT INTO households (id, name) VALUES
  ('b1111111-1111-1111-1111-111111111111', 'MG H1'),
  ('b9999999-9999-9999-9999-999999999999', 'MG H2');
INSERT INTO auth.users (id, email) VALUES
  ('b2222222-2222-2222-2222-222222222222', 'mg-u1@example.com'),
  ('b3333333-3333-3333-3333-333333333333', 'mg-u2@example.com'),
  ('b4444444-4444-4444-4444-444444444444', 'mg-u3@example.com'),
  ('b5555555-5555-5555-5555-555555555555', 'mg-pending@example.com');
UPDATE profiles SET household_id = 'b1111111-1111-1111-1111-111111111111',
                    display_name = 'MG U1', role = 'owner', is_approved = true
  WHERE id = 'b2222222-2222-2222-2222-222222222222';
UPDATE profiles SET household_id = 'b1111111-1111-1111-1111-111111111111',
                    display_name = 'MG U2', role = 'member', is_approved = true
  WHERE id = 'b3333333-3333-3333-3333-333333333333';
UPDATE profiles SET household_id = 'b9999999-9999-9999-9999-999999999999',
                    display_name = 'MG U3', role = 'owner', is_approved = true
  WHERE id = 'b4444444-4444-4444-4444-444444444444';
UPDATE profiles SET display_name = 'MG pending'
  WHERE id = 'b5555555-5555-5555-5555-555555555555';

-- anon の可視件数を数える補助。**権限で拒まれても「読めた行は 0」として返す。**
-- anon から households / profiles の SELECT 権限を剥がす変更（P2-03）が入っても、
-- 本ファイルの主張（anon は 1 行も読めぬ）はそのまま成り立つゆえ、どちらの層で
-- 止まっても緑・どちらも素通しなら赤、になるよう動的 SQL で受ける。
-- pg_temp ゆえ ROLLBACK と共に消える。SECURITY INVOKER（既定）ゆえ anon の権限で走る。
CREATE FUNCTION pg_temp.rows_visible(tbl regclass) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
BEGIN
  EXECUTE format('SELECT count(*) FROM %s', tbl) INTO n;
  RETURN n;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN 0;
END;
$$;
-- 関数の既定 EXECUTE（PUBLIC）を剥がす既定権限が在る環境でも anon が呼べるよう明示する。
-- 呼べねば例外が関数の外で起き、上の EXCEPTION では受けられずファイルごと落ちる。
GRANT EXECUTE ON FUNCTION pg_temp.rows_visible(regclass) TO anon;

-- ── (1)(2) seed が効いておることの固定 ─────────────────────────
SELECT is(
  (SELECT count(*) FROM households
    WHERE id IN ('b1111111-1111-1111-1111-111111111111',
                 'b9999999-9999-9999-9999-999999999999')),
  2::bigint, 'seed: 世帯 2 つ（自世帯 + 他世帯）が在る');
SELECT is(
  (SELECT count(*) FROM profiles
    WHERE (id = 'b5555555-5555-5555-5555-555555555555'
           AND household_id IS NULL AND is_approved = false)
       OR (id IN ('b2222222-2222-2222-2222-222222222222',
                  'b3333333-3333-3333-3333-333333333333')
           AND household_id = 'b1111111-1111-1111-1111-111111111111')
       OR (id = 'b4444444-4444-4444-4444-444444444444'
           AND household_id = 'b9999999-9999-9999-9999-999999999999')),
  4::bigint, 'seed: profiles 4 人（H1 に 2・H2 に 1・未承認 1）');

-- ══════════════════════════════════════════════════════════════
-- A. カタログ
-- ══════════════════════════════════════════════════════════════

-- (3) positive control: relacl が NULL だと aclexplode は 0 行で、以降の
--     negative assert が「ACL 行が無いから緑」になる。
SELECT isnt(
  (SELECT relacl FROM pg_class WHERE oid = 'households'::regclass),
  NULL, 'A-0: households の relacl は NULL でない（以降の権限 assert の前提）');

-- (4) households と profiles は RLS が有効
SELECT is(
  (SELECT count(*) FROM pg_class
    WHERE oid IN ('households'::regclass, 'profiles'::regclass) AND relrowsecurity),
  2::bigint, 'A-1: households / profiles とも RLS が有効');

-- (5) households のポリシーは SELECT / UPDATE の 2 種だけ（P3-01）
--     polcmd: r=SELECT / a=INSERT / w=UPDATE / d=DELETE / *=ALL。
--     set_eq ゆえ「INSERT ポリシーを戻さぬ」と「FOR ALL 禁止」を同時に固定する。
SELECT set_eq(
  $$ SELECT polcmd::text FROM pg_policy WHERE polrelid = 'households'::regclass $$,
  ARRAY['r', 'w'],
  'A-2: households のポリシーは SELECT / UPDATE のみ（WITH CHECK (true) の INSERT ポリシーは撤去済み）');

-- (6) anon / authenticated は households に INSERT / DELETE / TRUNCATE を持たぬ（P3-01）
--     正規の世帯作成は SECURITY DEFINER の create_household だけじゃ。
--     TRUNCATE は RLS を素通しするゆえ、ポリシーでは止まらぬ。
SELECT is_empty(
  $$
  SELECT acl.grantee::regrole::text || ':' || acl.privilege_type
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(c.relacl) acl
  WHERE c.oid = 'households'::regclass
    AND acl.grantee IN ('anon'::regrole, 'authenticated'::regrole)
    AND acl.privilege_type IN ('INSERT', 'DELETE', 'TRUNCATE')
  $$,
  'A-3: anon / authenticated は households に INSERT / DELETE / TRUNCATE を持たぬ');

-- (7) 対照: authenticated は自世帯の閲覧・設定更新に要る SELECT / UPDATE は持つ
--     （A-3 が「全部剥がれて壊れた」状態でも緑になるのを防ぐ）
SELECT set_eq(
  $$
  SELECT acl.privilege_type::text
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(c.relacl) acl
  WHERE c.oid = 'households'::regclass
    AND acl.grantee = 'authenticated'::regrole
    AND acl.privilege_type IN ('SELECT', 'UPDATE')
  $$,
  ARRAY['SELECT', 'UPDATE'],
  'A-4: authenticated は households の SELECT / UPDATE を持つ（設定画面の経路・対照）');

-- (8)(9) 招待 2 関数は anon から実行できぬ（P3-03）。authenticated は実行できる（対照）
SELECT ok(
  NOT has_function_privilege('anon', 'get_invitation_by_token(text)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'get_invitation_by_token(text)', 'EXECUTE'),
  'A-5: get_invitation_by_token は anon 不可・authenticated 可');
SELECT ok(
  NOT has_function_privilege('anon', 'accept_invitation(uuid)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'accept_invitation(uuid)', 'EXECUTE'),
  'A-6: accept_invitation は anon 不可・authenticated 可');

-- ══════════════════════════════════════════════════════════════
-- B. 実挙動 — U1（H1 の owner）
-- ══════════════════════════════════════════════════════════════
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'b2222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);

-- (10)(11) 自世帯だけが見える（0 でも 2 でもなく 1、しかも H1）
SELECT is((SELECT count(*) FROM households), 1::bigint,
  'B-1: U1 に見える世帯はちょうど 1 つ');
-- set_eq で見る: スカラー副問い合わせだと分離が破れた瞬間に「2 行返った」で
-- ファイルごと abort し、どの assert が割れたかが出ぬ。
SELECT set_eq(
  $$ SELECT id FROM households $$,
  ARRAY['b1111111-1111-1111-1111-111111111111'::uuid],
  'B-2: 見えておる世帯は自世帯 H1（他世帯 H2 ではない）');

-- (12) profiles は自世帯の 2 人だけ（他世帯の U3 も、未承認の UP も見えぬ）
SELECT set_eq(
  $$ SELECT id FROM profiles $$,
  ARRAY['b2222222-2222-2222-2222-222222222222'::uuid,
        'b3333333-3333-3333-3333-333333333333'::uuid],
  'B-3: U1 に見える profiles は自世帯の 2 人のみ（他世帯・未承認は不可視）');

-- (13) 他世帯の UPDATE は黙って 0 行（例外は出ぬ。無改変は C-1 が superuser で見る）
SELECT lives_ok(
  $$ UPDATE households SET name = 'pwned' WHERE id = 'b9999999-9999-9999-9999-999999999999' $$,
  'B-4: 他世帯への UPDATE は例外なく 0 行で終わる（RLS が行を隠す）');
-- (14) 自世帯の UPDATE は効く（対照。C-2 が superuser で値を見る）
SELECT lives_ok(
  $$ UPDATE households SET name = 'MG H1 renamed' WHERE id = 'b1111111-1111-1111-1111-111111111111' $$,
  'B-5: 自世帯の UPDATE は通る（対照）');

-- (15) 直接 INSERT は権限で拒まれる（P3-01。ポリシーではなく GRANT が止める）
SELECT throws_ok(
  $$ INSERT INTO households (name) VALUES ('孤児の世帯') $$,
  '42501', 'permission denied for table households',
  'B-6: authenticated は households へ直接 INSERT できぬ（世帯作成は create_household のみ）');
-- (16) 直接 DELETE も権限で拒まれる（自世帯であっても）
SELECT throws_ok(
  $$ DELETE FROM households WHERE id = 'b1111111-1111-1111-1111-111111111111' $$,
  '42501', 'permission denied for table households',
  'B-7: authenticated は households を直接 DELETE できぬ');

-- (17) 世帯の移動: 自分の household_id を他世帯へ書き換えられぬ（列 GRANT）
SELECT throws_ok(
  $$ UPDATE profiles SET household_id = 'b9999999-9999-9999-9999-999999999999'
      WHERE id = 'b2222222-2222-2222-2222-222222222222' $$,
  '42501', 'permission denied for table profiles',
  'B-8: 自分の household_id を他世帯へ書き換えられぬ（世帯の横移動を列 GRANT が止める）');
-- (18) 他人の表示名の UPDATE は黙って 0 行（profiles_update は本人の行に限る）
SELECT lives_ok(
  $$ UPDATE profiles SET display_name = 'pwned'
      WHERE id = 'b4444444-4444-4444-4444-444444444444' $$,
  'B-9: 他世帯ユーザーの表示名 UPDATE は例外なく 0 行（無改変は C-3 が見る）');

-- ══ 未承認(UP) 文脈 ════════════════════════════════════════════
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'b5555555-5555-5555-5555-555555555555', 'role', 'authenticated')::text, true);

-- (19) 未所属ゆえ世帯は 1 つも見えぬ
SELECT is((SELECT count(*) FROM households), 0::bigint,
  'B-10: 未承認（未所属）ユーザーに見える世帯は 0');
-- (20) profiles は自分の行だけ（profiles_select の `OR id = auth.uid()`）
SELECT set_eq(
  $$ SELECT id FROM profiles $$,
  ARRAY['b5555555-5555-5555-5555-555555555555'::uuid],
  'B-11: 未承認ユーザーに見える profiles は自分の行のみ');
-- (21) 自分を世帯へ押し込めぬ（承認の迂回を列 GRANT が止める）
SELECT throws_ok(
  $$ UPDATE profiles SET household_id = 'b1111111-1111-1111-1111-111111111111'
      WHERE id = 'b5555555-5555-5555-5555-555555555555' $$,
  '42501', 'permission denied for table profiles',
  'B-12: 未承認ユーザーは自分の household_id を書けぬ');
-- (22) 自分を承認できぬ
SELECT throws_ok(
  $$ UPDATE profiles SET is_approved = true
      WHERE id = 'b5555555-5555-5555-5555-555555555555' $$,
  '42501', 'permission denied for table profiles',
  'B-13: 未承認ユーザーは自分の is_approved を書けぬ');
-- (23) 直接 INSERT で孤児の世帯も作れぬ（P3-01）
SELECT throws_ok(
  $$ INSERT INTO households (name) VALUES ('未承認の孤児') $$,
  '42501', 'permission denied for table households',
  'B-14: 未承認ユーザーも households へ直接 INSERT できぬ');

-- ══ anon 文脈 ══════════════════════════════════════════════════
RESET ROLE;
SET LOCAL role anon;
SELECT set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);

-- (24)(25) anon は households / profiles を 1 行も読めぬ
SELECT is(pg_temp.rows_visible('households'), 0::bigint,
  'B-15: anon は households を 1 行も読めぬ');
SELECT is(pg_temp.rows_visible('profiles'), 0::bigint,
  'B-16: anon は profiles を 1 行も読めぬ');

-- ══════════════════════════════════════════════════════════════
-- C. 書込側の無改変を superuser で観測する
-- ══════════════════════════════════════════════════════════════
RESET ROLE;
SELECT set_config('request.jwt.claims', NULL, true);

-- (26) 他世帯 H2 の名前は変わっておらぬ（B-4 の 0 行は「通った上での嘘」ではない）
SELECT is(
  (SELECT name FROM households WHERE id = 'b9999999-9999-9999-9999-999999999999'),
  'MG H2', 'C-1: 他世帯 H2 の名前は無改変');
-- (27) 対照: 自世帯 H1 の名前は変わった（UPDATE の経路が丸ごと壊れておるのではない）
SELECT is(
  (SELECT name FROM households WHERE id = 'b1111111-1111-1111-1111-111111111111'),
  'MG H1 renamed', 'C-2: 自世帯 H1 の名前は更新された（C-1 の対照）');
-- (28) 他世帯ユーザーの表示名は無改変
SELECT is(
  (SELECT display_name FROM profiles WHERE id = 'b4444444-4444-4444-4444-444444444444'),
  'MG U3', 'C-3: 他世帯ユーザーの表示名は無改変');
-- (29) 誰の所属も動いておらぬ（未承認は未所属・未承認のまま、U1 は H1 のまま）
SELECT is(
  (SELECT count(*) FROM profiles
    WHERE (id = 'b5555555-5555-5555-5555-555555555555'
           AND household_id IS NULL AND is_approved = false)
       OR (id = 'b2222222-2222-2222-2222-222222222222'
           AND household_id = 'b1111111-1111-1111-1111-111111111111')),
  2::bigint, 'C-4: 未承認ユーザーは未所属・未承認のまま、U1 は H1 のまま');
-- (30) 拒否された INSERT は世帯を残しておらぬ
SELECT is(
  (SELECT count(*) FROM households WHERE name IN ('孤児の世帯', '未承認の孤児')),
  0::bigint, 'C-5: 拒否された直接 INSERT は世帯行を残さぬ');

SELECT * FROM finish();
ROLLBACK;
