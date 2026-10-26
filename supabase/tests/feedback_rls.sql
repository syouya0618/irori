-- 要望・改善提案（20261025200001_feedback.sql）の**誰が何をできるか**を pgTAP で固定する。
-- 実行: supabase test db supabase/tests/feedback_rls.sql
--
-- ## 撃つ主体
--   W  = 投稿者（H1 の owner・運用者ではない）  … owner であることは運用者の根拠にならぬ
--   O  = 運用者（H1 の member・app_operators に在籍）
--   M  = W と同じ世帯の家族（投稿者ではない）     … 同世帯にも要望は開かぬ
--   X  = 別世帯の利用者（H2 の owner）
--   P  = 未承認（household_id NULL）
--   anon / sub の無い authenticated
--
-- ## superuser では検出できぬ
-- 関数は auth.uid() / is_app_operator() で分岐し、表は RLS で絞る。superuser は RLS を
-- 素通りし auth.uid() が NULL になるゆえ、authenticated + request.jwt.claims で実際に通す。
--
-- ## 偽緑を潰す
--   * 拒否（W・M・X・P・anon）と受理（O・本人）を同じファイルで撃つ
--   * 「0 件見える」は、行が**在ること**を superuser で先に固定してから見る
--
-- ## EXECUTE の無い関数を anon / authenticated で**呼ばぬ**（(5)(20)）
-- 影響する Supabase Postgres の image（CI の 17.6.1.106 を含む）では、anon / authenticated が EXECUTE の無い関数を呼ぶと backend が
-- 落ち、DB ごと recovery に入る（supabase/postgres#2112・#2124。CI が pin する CLI 2.101.0 の既定は
-- 17.6.1.106 で、2026-10-26 の E2E run 40274212697 が (5) でこの形に落ちた）。上流 maintainer は「supautils
-- 3.2.0/3.2.1 = image 17.6.1.099〜.112」と言うが、範囲の外で落ちたという報告も在る。1 本でも
-- 撃てば `supabase test db` の後続ファイルまで道連れになる。ゆえに関数の EXECUTE 拒否は
-- throws_ok で呼ばず、その role に切り替えた session の has_function_privilege(関数, 'EXECUTE')
-- で固定する — 2 引数形は current_user に対し、executor が呼出し時に引くのと同じ
-- object_aclcheck(ACL_EXECUTE) を引く（PUBLIC・継承を含む実効権限）。値は (55)(56) の catalog
-- 検査と同じで、(5)(20) の役目は「その role の session の内側で引くこと」と位置・件数を保つこと。
-- executor の実際の拒否（permission denied for function）は、このファイルでは撃たぬ。
-- throws_ok へ戻すのは、版の番号ではなく CI の image で落ちぬと実測してからにせよ。
-- 表の拒否・RLS・関数の中の認可（RAISE の 42501）は、同じ image の main の CI で落ちずに
-- 通っておる形（approval_functions.sql 等）ゆえ、従来どおり実行して撃つ。
BEGIN;
SELECT plan(59);

-- ── seed（superuser = RLS バイパス）─────────────────────────────
INSERT INTO households (id, name) VALUES
  ('f1111111-1111-1111-1111-111111111111', 'FB H1'),
  ('f9999999-9999-9999-9999-999999999999', 'FB H2');
INSERT INTO auth.users (id, email) VALUES
  ('f2222222-2222-2222-2222-222222222222', 'fb-wife@example.com'),
  ('f3333333-3333-3333-3333-333333333333', 'fb-operator@example.com'),
  ('f4444444-4444-4444-4444-444444444444', 'fb-family@example.com'),
  ('f5555555-5555-5555-5555-555555555555', 'fb-other@example.com'),
  ('f6666666-6666-6666-6666-666666666666', 'fb-pending@example.com');
UPDATE profiles SET household_id = 'f1111111-1111-1111-1111-111111111111',
                    display_name = '妻', role = 'owner', is_approved = true
  WHERE id = 'f2222222-2222-2222-2222-222222222222';
UPDATE profiles SET household_id = 'f1111111-1111-1111-1111-111111111111',
                    display_name = '運用者', role = 'member', is_approved = true
  WHERE id = 'f3333333-3333-3333-3333-333333333333';
UPDATE profiles SET household_id = 'f1111111-1111-1111-1111-111111111111',
                    display_name = '同世帯の家族', role = 'member', is_approved = true
  WHERE id = 'f4444444-4444-4444-4444-444444444444';
UPDATE profiles SET household_id = 'f9999999-9999-9999-9999-999999999999',
                    display_name = '他世帯', role = 'owner', is_approved = true
  WHERE id = 'f5555555-5555-5555-5555-555555555555';
-- P は handle_new_user が作った素の行のまま（household_id NULL・is_approved false）
INSERT INTO app_operators (user_id) VALUES ('f3333333-3333-3333-3333-333333333333');

-- (1) seed の固定: 本テストの運用者は O の 1 人だけ（owner の W は運用者ではない）
SELECT is(
  (SELECT count(*) FROM app_operators
    WHERE user_id IN ('f2222222-2222-2222-2222-222222222222',
                      'f3333333-3333-3333-3333-333333333333',
                      'f4444444-4444-4444-4444-444444444444',
                      'f5555555-5555-5555-5555-555555555555')),
  1::bigint, 'seed: 運用者は O だけ（owner の W は運用者ではない）');

-- ══ anon ═══════════════════════════════════════════════════════
SET LOCAL role anon;
SELECT set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
-- (2)-(4) 表は読めぬ
SELECT throws_ok($$ SELECT id FROM feedback_items $$,
  '42501', 'permission denied for table feedback_items', 'anon: feedback_items を読めぬ');
SELECT throws_ok($$ SELECT id FROM feedback_events $$,
  '42501', 'permission denied for table feedback_events', 'anon: feedback_events を読めぬ');
SELECT throws_ok($$ SELECT id FROM feedback_notifications $$,
  '42501', 'permission denied for table feedback_notifications', 'anon: 配信キューを読めぬ');
-- (5) 投稿できぬ（関数の EXECUTE ごと無い）。呼ばずに、この session の実効権限で撃つ（冒頭の
--     「EXECUTE の無い関数を…呼ばぬ」— throws_ok に戻すと CI の image で backend が落ちる）。
--     PUBLIC に開いた組込み関数は実行できることを対照に置き、常に偽を返す形の偽緑を潰す
SELECT ok(
  current_user = 'anon'
    AND has_function_privilege('pg_catalog.now()', 'EXECUTE')
    AND NOT has_function_privilege('public.submit_feedback(uuid,text,text)', 'EXECUTE'),
  'anon: submit_feedback を実行できぬ（anon の session の実効権限・PUBLIC の関数は実行できる対照つき）');
-- (6) 直接 INSERT もできぬ
SELECT throws_ok(
  $$ INSERT INTO feedback_items (submitter_id, submitter_name, client_request_id, title)
     VALUES ('f2222222-2222-2222-2222-222222222222', 'x', gen_random_uuid(), 'x') $$,
  '42501', 'permission denied for table feedback_items', 'anon: feedback_items へ直接 INSERT できぬ');
RESET ROLE;

-- ══ W（投稿者）═════════════════════════════════════════════════
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'f2222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);

-- (7) 投稿できる（受理の対照）
SELECT is(
  (SELECT created FROM submit_feedback('a0000000-0000-4000-8000-0000000000a1',
                                       '授乳の記録をもっと早く付けたい', '片手で押せる大きさにしてほしい')),
  true, 'W: 投稿できる');
-- (8) 自分の要望が 1 件見える
SELECT is((SELECT count(*) FROM feedback_items), 1::bigint, 'W: 自分の要望が見える');
-- (9) 履歴（受付）も見える（列 GRANT の内側の列だけで読む）
SELECT is(
  (SELECT kind FROM feedback_events e
     JOIN feedback_items f ON f.id = e.feedback_id
    WHERE f.client_request_id = 'a0000000-0000-4000-8000-0000000000a1'),
  'submitted', 'W: 自分の要望の受付履歴が見える');
-- (10) actor_id は列 GRANT の外（運用者の利用者 id を列挙させぬ）
SELECT throws_ok($$ SELECT actor_id FROM feedback_events $$,
  '42501', 'permission denied for table feedback_events', 'W: 履歴の actor_id は読めぬ');
-- (11) `select("*")` も同じ理由で落ちる（型に載せぬ理由）
SELECT throws_ok($$ SELECT * FROM feedback_events $$,
  '42501', 'permission denied for table feedback_events', 'W: 履歴の select * は 42501');
-- (12)-(14) 直接の書込はどれもできぬ（自分の要望でも）
SELECT throws_ok(
  $$ INSERT INTO feedback_items (submitter_id, submitter_name, client_request_id, title)
     VALUES ('f2222222-2222-2222-2222-222222222222', '妻', gen_random_uuid(), '直接の投稿') $$,
  '42501', 'permission denied for table feedback_items', 'W: 直接 INSERT できぬ');
SELECT throws_ok(
  $$ UPDATE feedback_items SET status = 'released', released_commit_sha = 'abcdef1',
                               released_verified_at = now() $$,
  '42501', 'permission denied for table feedback_items', 'W: 自分で「反映済み」に変えられぬ');
SELECT throws_ok($$ DELETE FROM feedback_items $$,
  '42501', 'permission denied for table feedback_items', 'W: 直接 DELETE できぬ');
-- (15)(16) 履歴も書けぬ
SELECT throws_ok(
  $$ INSERT INTO feedback_events (feedback_id, kind, actor_role, to_status, client_request_id)
     SELECT id, 'submitted', 'submitter', 'received', gen_random_uuid() FROM feedback_items $$,
  '42501', 'permission denied for table feedback_events', 'W: 履歴へ直接 INSERT できぬ');
SELECT throws_ok($$ UPDATE feedback_events SET comment = '改ざん' $$,
  '42501', 'permission denied for table feedback_events', 'W: 履歴を UPDATE できぬ');
-- (17)-(19) 運用者の関数は使えぬ（owner であっても）
SELECT throws_ok(
  $$ SELECT * FROM operator_update_feedback(
       (SELECT id FROM feedback_items LIMIT 1), gen_random_uuid(), 1, 'considering', NULL, NULL) $$,
  '42501', 'only app operators can update feedback', 'W: 状態を変えられぬ');
SELECT throws_ok(
  $$ SELECT * FROM operator_release_feedback(
       (SELECT id FROM feedback_items LIMIT 1), gen_random_uuid(), 1, 'abcdef1', NULL, NULL, true, NULL) $$,
  '42501', 'only app operators can release feedback', 'W: 「反映済み」を確定できぬ');
SELECT throws_ok(
  $$ SELECT * FROM get_feedback_push_summary((SELECT id FROM feedback_items LIMIT 1)) $$,
  '42501', 'only app operators can read delivery status', 'W: 配信状況は読めぬ');
-- (20)(21) 内部用の関数・配信キューには触れぬ。(20) は (5) と同じ理由で呼ばずに撃つ。
--      同じ session で RPC は実行できる（(7) で実際に通した）ことを対照に置き、
--      has_function_privilege が常に偽を返す形の偽緑を潰す
SELECT ok(
  current_user = 'authenticated'
    AND has_function_privilege('public.submit_feedback(uuid,text,text)', 'EXECUTE')
    AND NOT has_function_privilege('public.enqueue_feedback_push(uuid,uuid,text)', 'EXECUTE'),
  'W: 積み込み関数を直接呼べぬ（authenticated の session の実効権限・RPC は実行できる対照つき）');
SELECT throws_ok($$ SELECT id FROM feedback_notifications $$,
  '42501', 'permission denied for table feedback_notifications', 'W: 配信キューを読めぬ');
-- (22) 自分の要望は既読にできる
SELECT lives_ok(
  $$ SELECT mark_feedback_seen((SELECT id FROM feedback_items LIMIT 1)) $$,
  'W: 自分の要望を既読にできる');

-- ══ X（別世帯）══════════════════════════════════════════════════
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'f5555555-5555-5555-5555-555555555555', 'role', 'authenticated')::text, true);
-- (23) X も投稿できる（受理の対照）
SELECT is(
  (SELECT created FROM submit_feedback('a0000000-0000-4000-8000-0000000000b1', '予定の色を変えたい', '')),
  true, 'X: 投稿できる');
-- (24) X に見えるのは自分の 1 件だけ
SELECT is((SELECT count(*) FROM feedback_items), 1::bigint, 'X: 自分の 1 件だけ見える');
-- (25)(26) W の要望も履歴も見えぬ
SELECT is(
  (SELECT count(*) FROM feedback_items WHERE submitter_id = 'f2222222-2222-2222-2222-222222222222'),
  0::bigint, 'X: 別世帯の W の要望は見えぬ');
SELECT is(
  (SELECT count(*) FROM feedback_events e
    WHERE e.feedback_id IN (SELECT id FROM feedback_items
                             WHERE submitter_id = 'f2222222-2222-2222-2222-222222222222')),
  0::bigint, 'X: 別世帯の W の履歴は見えぬ');
RESET ROLE;
-- (27) 対照: W の要望は**在る**（上の 0 件は行が無いからではない）
SELECT is(
  (SELECT count(*) FROM feedback_items WHERE submitter_id = 'f2222222-2222-2222-2222-222222222222'),
  1::bigint, 'superuser: W の要望は在る（X の 0 件は RLS による）');
-- W の要望の id を superuser で控え、他人の文脈から「在るが見えぬ」id として撃つ。
CREATE TEMP TABLE fb_ref ON COMMIT DROP AS
  SELECT 'w1'::text AS name, id FROM feedback_items
   WHERE client_request_id = 'a0000000-0000-4000-8000-0000000000a1';
GRANT SELECT ON fb_ref TO authenticated;
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'f5555555-5555-5555-5555-555555555555', 'role', 'authenticated')::text, true);
-- (28) W の要望を既読にもできぬ（存在しても「無い」と返す）
SELECT throws_ok(
  $$ SELECT mark_feedback_seen((SELECT id FROM fb_ref WHERE name = 'w1')) $$,
  'P0002', 'feedback not found', 'X: 在るが見えぬ要望の既読化は P0002（存在を漏らさぬ）');

-- ══ M（W と同じ世帯の家族・投稿者ではない）══════════════════════════
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'f4444444-4444-4444-4444-444444444444', 'role', 'authenticated')::text, true);
-- (29)(30) 同じ世帯でも、他人の要望と履歴は見えぬ
SELECT is((SELECT count(*) FROM feedback_items), 0::bigint, 'M: 同じ世帯でも W の要望は見えぬ');
SELECT is((SELECT count(*) FROM feedback_events), 0::bigint, 'M: 同じ世帯でも W の履歴は見えぬ');
SELECT throws_ok(
  $$ SELECT mark_feedback_seen((SELECT id FROM fb_ref WHERE name = 'w1')) $$,
  'P0002', 'feedback not found', 'M: 同じ世帯でも W の要望を既読にできぬ');

-- ══ P（未承認）══════════════════════════════════════════════════
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'f6666666-6666-6666-6666-666666666666', 'role', 'authenticated')::text, true);
-- (31) 投稿できぬ
SELECT throws_ok(
  $$ SELECT * FROM submit_feedback('a0000000-0000-4000-8000-0000000000c1', '承認前の要望', '') $$,
  '42501', 'not approved', 'P: 未承認は投稿できぬ');
-- (32) 何も見えぬ
SELECT is((SELECT count(*) FROM feedback_items), 0::bigint, 'P: 未承認には何も見えぬ');

-- ══ sub の無い authenticated ═══════════════════════════════════════
SELECT set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
-- (33)-(35) fail-closed
SELECT throws_ok(
  $$ SELECT * FROM submit_feedback('a0000000-0000-4000-8000-0000000000d1', 'sub 無し', '') $$,
  '28000', 'authentication required', 'sub 無し: 投稿できぬ');
SELECT is((SELECT count(*) FROM feedback_items), 0::bigint, 'sub 無し: 何も見えぬ');
SELECT throws_ok(
  $$ SELECT mark_feedback_seen('f0000000-0000-4000-8000-00000000dead') $$,
  '28000', 'authentication required', 'sub 無し: 既読化できぬ');

-- ══ O（運用者）══════════════════════════════════════════════════
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'f3333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text, true);
-- (36) 全世帯の要望が見える（W と X の 2 件）
SELECT is(
  (SELECT count(*) FROM feedback_items
    WHERE submitter_id IN ('f2222222-2222-2222-2222-222222222222',
                           'f5555555-5555-5555-5555-555555555555')),
  2::bigint, 'O: 運用者には全世帯の要望が見える');
-- (37) 提出者名は RPC が profiles から写したもの（クライアントの入力ではない）
SELECT is(
  (SELECT submitter_name FROM feedback_items
    WHERE submitter_id = 'f5555555-5555-5555-5555-555555555555'),
  '他世帯', 'O: 提出者の表示名が写されておる（別世帯でも読める）');
-- (38) 履歴も見える
SELECT is(
  (SELECT count(*) FROM feedback_events
    WHERE feedback_id IN (SELECT id FROM feedback_items)),
  2::bigint, 'O: 運用者には全件の履歴が見える');
-- (39) 状態を変えられる
SELECT is(
  (SELECT version FROM operator_update_feedback(
     (SELECT id FROM feedback_items WHERE client_request_id = 'a0000000-0000-4000-8000-0000000000b1'),
     'a0000000-0000-4000-8000-0000000000e1', 1, 'considering', '検討します', NULL)),
  2, 'O: 運用者は別世帯の要望の状態も変えられる');
-- (40) 配信状況（数だけ）を読める
SELECT lives_ok(
  $$ SELECT * FROM get_feedback_push_summary(
       (SELECT id FROM feedback_items WHERE client_request_id = 'a0000000-0000-4000-8000-0000000000b1')) $$,
  'O: 配信状況を読める');
-- (41) 運用者でも表へ直接は書けぬ（書込は RPC だけ）
SELECT throws_ok(
  $$ UPDATE feedback_items SET status = 'declined' $$,
  '42501', 'permission denied for table feedback_items', 'O: 運用者でも直接 UPDATE はできぬ');
-- (42) 運用者でも配信キューは直接読めぬ（集計 RPC だけ）
SELECT throws_ok($$ SELECT id FROM feedback_notifications $$,
  '42501', 'permission denied for table feedback_notifications', 'O: 配信キューは直接読めぬ');
-- (43) 運用者は既読にできる
SELECT lives_ok(
  $$ SELECT mark_feedback_seen(
       (SELECT id FROM feedback_items WHERE client_request_id = 'a0000000-0000-4000-8000-0000000000a1')) $$,
  'O: 運用者は要望を既読にできる');

-- ══ X に戻る — 運用者の操作は本人に見える ═════════════════════════════
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'f5555555-5555-5555-5555-555555555555', 'role', 'authenticated')::text, true);
-- (44) 状態と返信が見える
SELECT is(
  (SELECT status FROM feedback_items
    WHERE client_request_id = 'a0000000-0000-4000-8000-0000000000b1'),
  'considering', 'X: 運用者が変えた状態が本人に見える');
SELECT is(
  (SELECT comment FROM feedback_events
    WHERE kind = 'status_changed'
      AND feedback_id = (SELECT id FROM feedback_items
                          WHERE client_request_id = 'a0000000-0000-4000-8000-0000000000b1')),
  '検討します', 'X: 運用者の返信が本人に見える');

RESET ROLE;
SELECT set_config('request.jwt.claims', NULL, true);

-- ══ カタログ ════════════════════════════════════════════════════
-- (46) 3 表とも RLS 有効
SELECT ok(
  (SELECT bool_and(relrowsecurity) FROM pg_class
    WHERE oid IN ('feedback_items'::regclass, 'feedback_events'::regclass,
                  'feedback_notifications'::regclass)),
  '3 表とも RLS 有効');
-- (47) ポリシーは SELECT だけ（FOR ALL・IUD のポリシーが無い）
SELECT is(
  (SELECT array_agg(DISTINCT polcmd::text) FROM pg_policy
    WHERE polrelid IN ('feedback_items'::regclass, 'feedback_events'::regclass)),
  ARRAY['r'], 'feedback_items / feedback_events のポリシーは SELECT のみ（FOR ALL なし）');
-- (48) 配信キューはポリシー 0 本（deny-all）
SELECT is(
  (SELECT count(*) FROM pg_policy WHERE polrelid = 'feedback_notifications'::regclass),
  0::bigint, 'feedback_notifications はポリシー 0 本（API ロールには deny-all）');
-- (49) positive control → (50) anon はどの表にも権限を持たぬ
SELECT isnt(
  (SELECT relacl FROM pg_class WHERE oid = 'feedback_items'::regclass),
  NULL, 'feedback_items: relacl は NULL でない（次の negative assert の前提）');
SELECT is_empty(
  $$
  SELECT c.relname || ':' || acl.privilege_type
    FROM pg_class c
   CROSS JOIN LATERAL aclexplode(c.relacl) acl
   WHERE c.oid IN ('feedback_items'::regclass, 'feedback_events'::regclass,
                   'feedback_notifications'::regclass)
     AND acl.grantee = 'anon'::regrole
  $$,
  'anon は 3 表のいずれにも権限を持たぬ');
-- (51) authenticated の表単位の権限は feedback_items の SELECT だけ
SELECT is(
  (SELECT array_agg(c.relname || ':' || acl.privilege_type ORDER BY c.relname, acl.privilege_type)
     FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) acl
    WHERE c.oid IN ('feedback_items'::regclass, 'feedback_events'::regclass,
                    'feedback_notifications'::regclass)
      AND acl.grantee = 'authenticated'::regrole),
  ARRAY['feedback_items:SELECT'],
  'authenticated の表権限は feedback_items の SELECT だけ（events は列 GRANT・キューは無し）');
-- (52) 履歴の列 GRANT に actor_id / client_request_id が無い
SELECT ok(
  has_column_privilege('authenticated', 'feedback_events', 'comment', 'SELECT')
    AND NOT has_column_privilege('authenticated', 'feedback_events', 'actor_id', 'SELECT')
    AND NOT has_column_privilege('authenticated', 'feedback_events', 'client_request_id', 'SELECT'),
  'feedback_events: comment は読め、actor_id / client_request_id は読めぬ');
-- (53) RPC 5 本は SECURITY DEFINER かつ search_path 固定
SELECT ok(
  (SELECT bool_and(prosecdef AND proconfig @> ARRAY['search_path=public'])
     FROM pg_proc
    WHERE oid IN ('submit_feedback(uuid,text,text)'::regprocedure,
                  'operator_update_feedback(uuid,uuid,integer,text,text,text)'::regprocedure,
                  'operator_release_feedback(uuid,uuid,integer,text,text,text,boolean,text)'::regprocedure,
                  'mark_feedback_seen(uuid)'::regprocedure,
                  'get_feedback_push_summary(uuid)'::regprocedure)),
  'RPC 5 本: SECURITY DEFINER かつ SET search_path=public');
-- (54) 内部 4 本は DEFINER ではない（呼び手の権限で走る）
SELECT ok(
  NOT (SELECT bool_or(prosecdef) FROM pg_proc
        WHERE oid IN ('enqueue_feedback_push(uuid,uuid,text)'::regprocedure,
                      'feedback_text_ok(text,integer,boolean)'::regprocedure,
                      'feedback_trim_chars()'::regprocedure,
                      'feedback_forbidden_class(boolean)'::regprocedure)),
  '内部 4 本（積み込み・文字列の述語と文字の集合）は SECURITY INVOKER');
-- (55) anon はどの関数も実行できぬ
SELECT ok(
  NOT has_function_privilege('anon', 'submit_feedback(uuid,text,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'operator_update_feedback(uuid,uuid,integer,text,text,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'operator_release_feedback(uuid,uuid,integer,text,text,text,boolean,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'mark_feedback_seen(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'get_feedback_push_summary(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'enqueue_feedback_push(uuid,uuid,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'feedback_text_ok(text,integer,boolean)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'feedback_trim_chars()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'feedback_forbidden_class(boolean)', 'EXECUTE'),
  'anon は 9 関数のいずれも実行できぬ');
-- (56) authenticated は RPC 5 本を実行でき（対照）、内部 4 本は実行できぬ
SELECT ok(
  has_function_privilege('authenticated', 'submit_feedback(uuid,text,text)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'operator_update_feedback(uuid,uuid,integer,text,text,text)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'operator_release_feedback(uuid,uuid,integer,text,text,text,boolean,text)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'mark_feedback_seen(uuid)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'get_feedback_push_summary(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'enqueue_feedback_push(uuid,uuid,text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'feedback_text_ok(text,integer,boolean)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'feedback_trim_chars()', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'feedback_forbidden_class(boolean)', 'EXECUTE'),
  'authenticated: RPC 5 本は実行でき、内部 4 本は実行できぬ');
-- (57) Realtime publication へは載せておらぬ（明文宣言どおり）
SELECT is_empty(
  $$ SELECT tablename FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND tablename IN ('feedback_items', 'feedback_events', 'feedback_notifications') $$,
  'feedback の 3 表は supabase_realtime に載せぬ');
-- (58) service_role は配信キューを読み書きできる（cron の前提・対照）
SELECT ok(
  has_table_privilege('service_role', 'feedback_notifications', 'SELECT')
    AND has_table_privilege('service_role', 'feedback_notifications', 'UPDATE'),
  'service_role は配信キューを読み書きできる（cron の前提）');

SELECT * FROM finish();
ROLLBACK;
