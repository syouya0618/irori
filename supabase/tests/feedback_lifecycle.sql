-- 要望・改善提案の**状態遷移・冪等・「反映済み」の門・Push の積み込み**を pgTAP で固定する。
-- 実行: supabase test db supabase/tests/feedback_lifecycle.sql
-- 権限の行列（誰が見えるか）は feedback_rls.sql が持つ。ここは運用の筋書きを順に撃つ:
--
--   1. 投稿 → 受付の履歴 1 行・運用者の端末ぶんの配信行（投稿者自身には積まぬ）
--   2. 再送（同じ鍵・同じ内容）は同じ 1 行 / 同じ鍵で別の内容は IRF01
--   3. 運用者の状態変更 → 版が進む・投稿者の未読が立つ・投稿者の端末ぶんの配信行
--   4. 同じ操作の再送は記録済みとして返す / 古い版からの操作は IRF03
--   5. 「マージ済み」は記録できても released にはならぬ
--   6. released は証拠（本番確認の宣言 + コミット SHA）が無ければ立たぬ。superuser でも CHECK が拒む
--   7. 差し戻しは理由が要り、現在の証拠は消えるが履歴には残る
--   8. 積み込みが失敗しても要望・履歴は残る（Push は知らせであって正本ではない）
--   9. 投稿の上限（24 時間で 20 件）と、再送は上限に数えぬこと
--  10. 提出者名の写しから制御文字・双方向制御文字を落とすこと
--  （4 と 6 には「同じ鍵で内容を変えた再送は IRF01」も含む — 通信断の後の書き直しを黙って捨てぬ）
--
-- ## このファイルが見ぬもの
-- 2 接続が同時に同じ鍵で投稿する競争は 1 本のトランザクションでは再現できぬ。
-- `INSERT ... ON CONFLICT DO NOTHING` は 2 本目を 1 本目の commit まで待たせ、
-- 続く SELECT で既存行を返す（PostgreSQL の挿入時の一意性検査の挙動）。ここでは順に撃つ。
BEGIN;
SELECT plan(70);

-- ── seed（superuser）──────────────────────────────────────────
INSERT INTO households (id, name) VALUES
  ('e1111111-1111-1111-1111-111111111111', 'FL H1'),
  ('e9999999-9999-9999-9999-999999999999', 'FL H2');
INSERT INTO auth.users (id, email) VALUES
  ('e2222222-2222-2222-2222-222222222222', 'fl-wife@example.com'),
  ('e3333333-3333-3333-3333-333333333333', 'fl-operator@example.com'),
  ('e5555555-5555-5555-5555-555555555555', 'fl-other@example.com');
UPDATE profiles SET household_id = 'e1111111-1111-1111-1111-111111111111',
                    display_name = '妻', role = 'owner', is_approved = true
  WHERE id = 'e2222222-2222-2222-2222-222222222222';
UPDATE profiles SET household_id = 'e1111111-1111-1111-1111-111111111111',
                    display_name = '運用者', role = 'member', is_approved = true
  WHERE id = 'e3333333-3333-3333-3333-333333333333';
UPDATE profiles SET household_id = 'e9999999-9999-9999-9999-999999999999',
                    display_name = '他世帯', role = 'owner', is_approved = true
  WHERE id = 'e5555555-5555-5555-5555-555555555555';
INSERT INTO app_operators (user_id) VALUES ('e3333333-3333-3333-3333-333333333333');
-- 端末: 運用者 1 台・妻 2 台・他世帯 0 台
INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES
  ('e0000000-0000-4000-8000-0000000000a1', 'e3333333-3333-3333-3333-333333333333',
   'https://fcm.googleapis.com/fl-operator', 'k', 'a'),
  ('e0000000-0000-4000-8000-0000000000b1', 'e2222222-2222-2222-2222-222222222222',
   'https://fcm.googleapis.com/fl-wife-1', 'k', 'a'),
  ('e0000000-0000-4000-8000-0000000000b2', 'e2222222-2222-2222-2222-222222222222',
   'https://web.push.apple.com/fl-wife-2', 'k', 'a');

-- 観測は superuser で行う（配信キューは API ロールから読めぬ）。参照用の id 表。
CREATE TEMP TABLE fl_ref (name text PRIMARY KEY, id uuid) ON COMMIT DROP;
GRANT SELECT ON fl_ref TO authenticated;

-- ══ 1. 投稿 ═════════════════════════════════════════════════════
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'e2222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);
-- (1)
SELECT is(
  (SELECT created FROM submit_feedback('b0000000-0000-4000-8000-000000000001',
                                       '夜は画面を暗くしてほしい', E'授乳中にまぶしい\n寝室で使うので')),
  true, '投稿: 新しい要望として受理される');
RESET ROLE;
INSERT INTO fl_ref SELECT 'f1', id FROM feedback_items
  WHERE client_request_id = 'b0000000-0000-4000-8000-000000000001';
-- (2)-(5) 初期状態
SELECT is((SELECT status FROM feedback_items WHERE id = (SELECT id FROM fl_ref WHERE name = 'f1')),
  'received', '投稿: 状態は「受付」');
SELECT is((SELECT version FROM feedback_items WHERE id = (SELECT id FROM fl_ref WHERE name = 'f1')),
  1, '投稿: 版は 1');
SELECT is((SELECT submitter_name FROM feedback_items WHERE id = (SELECT id FROM fl_ref WHERE name = 'f1')),
  '妻', '投稿: 提出者名は profiles から写される');
SELECT is((SELECT body FROM feedback_items WHERE id = (SELECT id FROM fl_ref WHERE name = 'f1')),
  E'授乳中にまぶしい\n寝室で使うので', '投稿: 本文の改行は保たれる');
-- (6) 受付の履歴が 1 行
SELECT is(
  (SELECT array_agg(kind || ':' || to_status || ':' || actor_role)
     FROM feedback_events WHERE feedback_id = (SELECT id FROM fl_ref WHERE name = 'f1')),
  ARRAY['submitted:received:submitter'], '投稿: 受付の履歴が 1 行だけ入る');
-- (7) 運用者の端末 1 台ぶんの配信行（宛先は運用者・audience=operator）
SELECT is(
  (SELECT array_agg(recipient_id::text || ':' || audience || ':' || subscription_key)
     FROM feedback_notifications n JOIN feedback_events e ON e.id = n.event_id
    WHERE e.feedback_id = (SELECT id FROM fl_ref WHERE name = 'f1')),
  ARRAY['e3333333-3333-3333-3333-333333333333:operator:e0000000-0000-4000-8000-0000000000a1'],
  '投稿: 運用者の端末ぶんだけ配信行が積まれる（投稿者自身には積まぬ）');
-- (8) 投稿者は「未読の更新あり」ではない
SELECT is((SELECT submitter_has_unseen FROM feedback_items WHERE id = (SELECT id FROM fl_ref WHERE name = 'f1')),
  false, '投稿: 投稿者の未読は立たぬ');
-- (9) 運用者にとっては未読
SELECT is((SELECT operator_seen_at FROM feedback_items WHERE id = (SELECT id FROM fl_ref WHERE name = 'f1')),
  NULL::timestamptz, '投稿: 運用者には未読（operator_seen_at が NULL）');
-- 1 本のトランザクションの now() は一定ゆえ、投稿と運用者の操作が「同じ瞬間」になり
-- 未読（activity > seen）が立たぬ。本番では別トランザクションゆえ必ず後になる。
-- 投稿の時刻を 1 分前へ戻して、時間の経過を写す。
UPDATE feedback_items
   SET created_at = now() - interval '1 minute',
       updated_at = now() - interval '1 minute',
       submitter_seen_at = now() - interval '1 minute'
 WHERE id = (SELECT id FROM fl_ref WHERE name = 'f1');

-- ══ 2. 再送 ═════════════════════════════════════════════════════
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'e2222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);
-- (10)(11) 同じ鍵・同じ内容 → 同じ行・created=false
SELECT is(
  (SELECT created FROM submit_feedback('b0000000-0000-4000-8000-000000000001',
                                       '夜は画面を暗くしてほしい', E'授乳中にまぶしい\n寝室で使うので')),
  false, '再送: 同じ鍵・同じ内容は「既に受付済み」');
SELECT is(
  (SELECT feedback_id FROM submit_feedback('b0000000-0000-4000-8000-000000000001',
                                           '夜は画面を暗くしてほしい', E'授乳中にまぶしい\n寝室で使うので')),
  (SELECT id FROM fl_ref WHERE name = 'f1'), '再送: 同じ要望の id を返す');
-- (12) 同じ鍵で別の内容は IRF01（直した文面を黙って捨てぬ）
SELECT throws_ok(
  $$ SELECT * FROM submit_feedback('b0000000-0000-4000-8000-000000000001', '別の要望', '') $$,
  'IRF01', 'client_request_id reused with different content', '再送: 同じ鍵で別の内容は IRF01');
-- (13)-(16) 形の悪い入力は本文を含まぬ 22023 で拒む
SELECT throws_ok(
  $$ SELECT * FROM submit_feedback('b0000000-0000-4000-8000-000000000002', '', '') $$,
  '22023', 'invalid title', '検証: 空の題は拒む');
SELECT throws_ok(
  $$ SELECT * FROM submit_feedback('b0000000-0000-4000-8000-000000000002', repeat('あ', 101), '') $$,
  '22023', 'invalid title', '検証: 101 文字の題は拒む（コードポイントで数える）');
-- ⚠️ 拒む文字は chr(<コードポイント>) で組む（生のまま書くとエディタにもレビューにも見えぬ）。
-- 8238 = U+202E（RLO）/ 7 = BEL
SELECT throws_ok(
  $$ SELECT * FROM submit_feedback('b0000000-0000-4000-8000-000000000002', '題' || chr(8238) || 'の細工', '') $$,
  '22023', 'invalid title', '検証: 双方向制御文字は拒む');
SELECT throws_ok(
  $$ SELECT * FROM submit_feedback('b0000000-0000-4000-8000-000000000002', '題', '本文' || chr(7)) $$,
  '22023', 'invalid body', '検証: 本文の制御文字（改行・タブ以外）は拒む');
-- (17) 境界の対照: 100 文字の題・2000 文字の本文は通る
SELECT is(
  (SELECT created FROM submit_feedback('b0000000-0000-4000-8000-000000000003',
                                       repeat('あ', 100), repeat('い', 2000))),
  true, '検証: 100 文字の題と 2000 文字の本文は通る（境界の対照）');
-- (18) 鍵の無い投稿は拒む
SELECT throws_ok(
  $$ SELECT * FROM submit_feedback(NULL, '鍵なし', '') $$,
  '22023', 'client_request_id is required', '検証: client_request_id が無ければ拒む');
RESET ROLE;
-- (19) ここまでで W の要望は 2 件（再送も拒否も行を増やさぬ）
SELECT is(
  (SELECT count(*) FROM feedback_items WHERE submitter_id = 'e2222222-2222-2222-2222-222222222222'),
  2::bigint, '再送・拒否は行を増やさぬ（W の要望は 2 件）');

-- ══ 3. 運用者の状態変更 ═════════════════════════════════════════════
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'e3333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text, true);
-- (20)
SELECT is(
  (SELECT version FROM operator_update_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
     'c0000000-0000-4000-8000-000000000001', 1, 'considering', '夜間の配色を検討します', NULL)),
  2, '状態変更: 受付 → 検討中で版が 2 になる');
RESET ROLE;
-- (21) 履歴
SELECT is(
  (SELECT from_status || '→' || to_status || ':' || comment FROM feedback_events
    WHERE feedback_id = (SELECT id FROM fl_ref WHERE name = 'f1') AND kind = 'status_changed'),
  'received→considering:夜間の配色を検討します', '状態変更: 履歴に前後の状態と返信が残る');
-- (22) 投稿者の未読が立つ
SELECT is((SELECT submitter_has_unseen FROM feedback_items WHERE id = (SELECT id FROM fl_ref WHERE name = 'f1')),
  true, '状態変更: 投稿者に未読の更新が立つ');
-- (23) 投稿者の端末 2 台ぶんの配信行
SELECT is(
  (SELECT count(*) FROM feedback_notifications n JOIN feedback_events e ON e.id = n.event_id
    WHERE e.feedback_id = (SELECT id FROM fl_ref WHERE name = 'f1') AND e.kind = 'status_changed'
      AND n.recipient_id = 'e2222222-2222-2222-2222-222222222222' AND n.audience = 'submitter'),
  2::bigint, '状態変更: 投稿者の端末 2 台ぶんの配信行が積まれる');

-- ══ 4. 冪等と版 ═════════════════════════════════════════════════
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'e3333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text, true);
-- (24) 同じ操作の再送（応答が失われた）は記録済みとして返す
SELECT is(
  (SELECT created FROM operator_update_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
     'c0000000-0000-4000-8000-000000000001', 1, 'considering', '夜間の配色を検討します', NULL)),
  false, '冪等: 同じ操作の再送は記録済み（created=false）');
-- (24b)(24c) 同じ鍵で内容を変えた再送は IRF01（書き直した返信・選び直した状態を黙って捨てぬ）
SELECT throws_ok(
  $$ SELECT * FROM operator_update_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
       'c0000000-0000-4000-8000-000000000001', 1, 'considering', '書き直した返信', NULL) $$,
  'IRF01', 'client_request_id reused with different content',
  '冪等: 同じ鍵で返信を書き直した再送は IRF01');
SELECT throws_ok(
  $$ SELECT * FROM operator_update_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
       'c0000000-0000-4000-8000-000000000001', 1, 'declined', '夜間の配色を検討します', NULL) $$,
  'IRF01', 'client_request_id reused with different content',
  '冪等: 同じ鍵で状態を選び直した再送は IRF01');
-- (25) 古い版からの新しい操作は IRF03
SELECT throws_ok(
  $$ SELECT * FROM operator_update_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
       'c0000000-0000-4000-8000-000000000002', 1, 'in_progress', NULL, NULL) $$,
  'IRF03', 'feedback was updated by someone else', '版: 古い画面からの操作は IRF03');
-- (26)-(31) 状態変更の規則
SELECT throws_ok(
  $$ SELECT * FROM operator_update_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
       'c0000000-0000-4000-8000-000000000003', 2, 'considering', NULL, NULL) $$,
  '22023', 'status unchanged', '規則: 同じ状態への変更は拒む');
SELECT throws_ok(
  $$ SELECT * FROM operator_update_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
       'c0000000-0000-4000-8000-000000000003', 2, 'released', NULL, NULL) $$,
  '22023', 'invalid status for this function', '規則: 通常の状態変更で released にはできぬ');
SELECT throws_ok(
  $$ SELECT * FROM operator_update_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
       'c0000000-0000-4000-8000-000000000003', 2, 'done', NULL, NULL) $$,
  '22023', 'invalid status for this function', '規則: 未知の状態は拒む');
SELECT throws_ok(
  $$ SELECT * FROM operator_update_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
       'c0000000-0000-4000-8000-000000000003', 2, 'declined', NULL, NULL) $$,
  '22023', 'a reason is required to decline', '規則: 見送りには理由が要る');
SELECT throws_ok(
  $$ SELECT * FROM operator_update_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
       'c0000000-0000-4000-8000-000000000003', 2, NULL, NULL, NULL) $$,
  '22023', 'comment is required', '規則: 返信だけの操作には本文が要る');
SELECT throws_ok(
  $$ SELECT * FROM operator_update_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
       'c0000000-0000-4000-8000-000000000003', 2, NULL, NULL, 'PR #241') $$,
  '22023', 'merge_ref is only for in_progress', '規則: 対応中でない要望にマージの記録は付けられぬ');
-- (32) 存在せぬ要望は P0002
SELECT throws_ok(
  $$ SELECT * FROM operator_update_feedback('e0000000-0000-4000-8000-00000000dead',
       'c0000000-0000-4000-8000-000000000003', 1, 'considering', NULL, NULL) $$,
  'P0002', 'feedback not found', '規則: 存在せぬ要望は P0002');

-- ══ 5. マージ ≠ 反映 ═════════════════════════════════════════════
-- (33)
SELECT is(
  (SELECT version FROM operator_update_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
     'c0000000-0000-4000-8000-000000000004', 2, 'in_progress', '修正を取り込みました', 'PR #241')),
  3, 'マージ: 対応中へ・マージの記録付きで版 3');
RESET ROLE;
-- (34)(35) マージを記録しても released ではない
SELECT is((SELECT status FROM feedback_items WHERE id = (SELECT id FROM fl_ref WHERE name = 'f1')),
  'in_progress', 'マージ: 状態は「対応中」のまま（反映済みではない）');
SELECT is((SELECT released_verified_at FROM feedback_items WHERE id = (SELECT id FROM fl_ref WHERE name = 'f1')),
  NULL::timestamptz, 'マージ: 本番確認の時刻は立たぬ');
-- (36) 投稿者が既読にすると未読が消え、版は動かぬ
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'e2222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);
SELECT lives_ok($$ SELECT mark_feedback_seen((SELECT id FROM fl_ref WHERE name = 'f1')) $$,
  '既読: 投稿者は既読にできる');
RESET ROLE;
SELECT is(
  (SELECT submitter_has_unseen::text || ':' || version::text FROM feedback_items
    WHERE id = (SELECT id FROM fl_ref WHERE name = 'f1')),
  'false:3', '既読: 未読が消え、版は動かぬ（既読は内容の変更ではない）');

-- ══ 6. 「反映済み」の門 ═══════════════════════════════════════════
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'e3333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text, true);
-- (38) 本番確認の宣言が無ければ拒む
SELECT throws_ok(
  $$ SELECT * FROM operator_release_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
       'c0000000-0000-4000-8000-000000000005', 3, 'abcdef1', NULL, NULL, false, NULL) $$,
  '22023', 'production verification is required', '反映: 本番確認の宣言が false なら拒む');
SELECT throws_ok(
  $$ SELECT * FROM operator_release_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
       'c0000000-0000-4000-8000-000000000005', 3, 'abcdef1', NULL, NULL, NULL, NULL) $$,
  '22023', 'production verification is required', '反映: 本番確認の宣言が NULL でも拒む');
-- (40)(41) コミット SHA が無い・形が違えば拒む
SELECT throws_ok(
  $$ SELECT * FROM operator_release_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
       'c0000000-0000-4000-8000-000000000005', 3, '', NULL, NULL, true, NULL) $$,
  '22023', 'invalid commit sha', '反映: コミット SHA が無ければ拒む');
SELECT throws_ok(
  $$ SELECT * FROM operator_release_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
       'c0000000-0000-4000-8000-000000000005', 3, 'main', NULL, NULL, true, NULL) $$,
  '22023', 'invalid commit sha', '反映: ブランチ名などは SHA として受けぬ');
-- (42) 観測したデプロイの形も縛る
SELECT throws_ok(
  $$ SELECT * FROM operator_release_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
       'c0000000-0000-4000-8000-000000000005', 3, 'abcdef1', NULL, 'prod@abcdef1', true, NULL) $$,
  '22023', 'invalid observed deploy', '反映: 観測したデプロイの形が違えば拒む');
RESET ROLE;
-- (43) 拒否の後も状態は動いておらぬ
SELECT is((SELECT status FROM feedback_items WHERE id = (SELECT id FROM fl_ref WHERE name = 'f1')),
  'in_progress', '反映: 拒否された確定は状態を動かさぬ');
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'e3333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text, true);
-- (44) 証拠が揃えば確定できる（SHA は小文字へ揃える）
SELECT is(
  (SELECT version FROM operator_release_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
     'c0000000-0000-4000-8000-000000000006', 3, ' ABCDEF1234 ', 'v1.7.0',
     'production:abcdef1234', true, '本番で夜間の配色を確かめました')),
  4, '反映: 証拠が揃えば確定でき、版は 4');
-- (44b) 同じ鍵の再送で SHA を書き直したものは IRF01（誤った証拠を黙って残さぬ）
SELECT throws_ok(
  $$ SELECT * FROM operator_release_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
       'c0000000-0000-4000-8000-000000000006', 3, '1234567', 'v1.7.0',
       'production:abcdef1234', true, '本番で夜間の配色を確かめました') $$,
  'IRF01', 'client_request_id reused with different content',
  '反映: 同じ鍵で SHA を書き直した再送は IRF01');
-- (44c) 同じ内容の再送は記録済み（観測したデプロイは比べぬ）
SELECT is(
  (SELECT created FROM operator_release_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
     'c0000000-0000-4000-8000-000000000006', 3, 'abcdef1234', 'v1.7.0',
     NULL, true, '本番で夜間の配色を確かめました')),
  false, '反映: 同じ内容の再送は記録済み（created=false）');
-- (45) 二度目の確定は拒む
SELECT throws_ok(
  $$ SELECT * FROM operator_release_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
       'c0000000-0000-4000-8000-000000000007', 4, 'abcdef1', NULL, NULL, true, NULL) $$,
  '22023', 'already released', '反映: 反映済みの再確定は拒む');
RESET ROLE;
-- (46) 現在の証拠
SELECT is(
  (SELECT status || ':' || released_commit_sha || ':' || released_note || ':' || released_observed_deploy
     FROM feedback_items WHERE id = (SELECT id FROM fl_ref WHERE name = 'f1')),
  'released:abcdef1234:v1.7.0:production:abcdef1234', '反映: 現在の証拠が行に残る（SHA は小文字）');
-- (47) 履歴の証拠
SELECT ok(
  (SELECT release_verified_at IS NOT NULL AND release_commit_sha = 'abcdef1234'
     FROM feedback_events
    WHERE feedback_id = (SELECT id FROM fl_ref WHERE name = 'f1') AND to_status = 'released'),
  '反映: 履歴にも本番確認の時刻と SHA が残る');
-- (48)(49) superuser でも証拠なしの released は CHECK が拒む（DB の門）
SELECT throws_ok(
  $$ UPDATE feedback_items SET status = 'released'
      WHERE submitter_id = 'e2222222-2222-2222-2222-222222222222' AND status = 'received' $$,
  '23514', NULL, 'DB の門: 証拠なしに released へ変える UPDATE は superuser でも CHECK が拒む');
SELECT throws_ok(
  $$ INSERT INTO feedback_events (feedback_id, kind, actor_role, from_status, to_status, client_request_id)
     VALUES ((SELECT id FROM fl_ref WHERE name = 'f1'), 'status_changed', 'operator',
             'in_progress', 'released', gen_random_uuid()) $$,
  '23514', NULL, 'DB の門: 証拠なしの released 履歴は superuser でも CHECK が拒む');
-- (49b)(49c) 逆向き: released でない行・履歴は証拠を**一部でも**持てぬ（SHA だけ等）
SELECT throws_ok(
  $$ UPDATE feedback_items SET released_commit_sha = 'abcdef1'
      WHERE submitter_id = 'e2222222-2222-2222-2222-222222222222' AND status = 'received' $$,
  '23514', NULL, 'DB の門: released でない要望に SHA だけを持たせられぬ');
SELECT throws_ok(
  $$ INSERT INTO feedback_events (feedback_id, kind, actor_role, comment, release_commit_sha, client_request_id)
     VALUES ((SELECT id FROM fl_ref WHERE name = 'f1'), 'commented', 'operator',
             '返信', 'abcdef1', gen_random_uuid()) $$,
  '23514', NULL, 'DB の門: released でない履歴に SHA だけを持たせられぬ');

-- ══ 7. 差し戻し ═════════════════════════════════════════════════
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'e3333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text, true);
-- (50) 理由なしの差し戻しは拒む
SELECT throws_ok(
  $$ SELECT * FROM operator_update_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
       'c0000000-0000-4000-8000-000000000008', 4, 'in_progress', NULL, NULL) $$,
  '22023', 'a reason is required to reopen released feedback', '差し戻し: 理由が要る');
-- (51)
SELECT is(
  (SELECT version FROM operator_update_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
     'c0000000-0000-4000-8000-000000000008', 4, 'in_progress', '不具合が見つかったため戻しました', NULL)),
  5, '差し戻し: 理由付きなら対応中へ戻せる');
RESET ROLE;
-- (52) 現在の証拠は消え、履歴の released 行は残る
SELECT is(
  (SELECT (released_commit_sha IS NULL AND released_verified_at IS NULL)::text || ':' ||
          (SELECT count(*) FROM feedback_events
            WHERE feedback_id = (SELECT id FROM fl_ref WHERE name = 'f1') AND to_status = 'released')::text
     FROM feedback_items WHERE id = (SELECT id FROM fl_ref WHERE name = 'f1')),
  'true:1', '差し戻し: 現在の証拠は消え、履歴の反映記録は残る');

-- ══ 8. 積み込みの失敗で要望を失わぬ ═══════════════════════════════════
-- 投稿者宛の配信行だけを拒む一時の制約で、積み込みを確実に失敗させる。
ALTER TABLE feedback_notifications
  ADD CONSTRAINT tmp_block_submitter CHECK (audience <> 'submitter') NOT VALID;
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'e3333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text, true);
-- (53) 返信は成功する
SELECT is(
  (SELECT version FROM operator_update_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
     'c0000000-0000-4000-8000-000000000009', 5, NULL, '直したら知らせます', NULL)),
  6, '積み込み失敗: 返信そのものは成功する');
RESET ROLE;
-- (54) 履歴は残り、配信行は 0
SELECT is(
  (SELECT count(*)::text || ':' ||
          (SELECT count(*) FROM feedback_notifications n WHERE n.event_id = e.id)::text
     FROM feedback_events e
    WHERE e.feedback_id = (SELECT id FROM fl_ref WHERE name = 'f1') AND e.kind = 'commented'
    GROUP BY e.id),
  '1:0', '積み込み失敗: 履歴は残り、配信行は 0（アプリ内が正本）');
ALTER TABLE feedback_notifications DROP CONSTRAINT tmp_block_submitter;
-- (54b) 返信だけの操作も、同じ内容の再送は記録済み（created=false）
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'e3333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text, true);
SELECT is(
  (SELECT created FROM operator_update_feedback((SELECT id FROM fl_ref WHERE name = 'f1'),
     'c0000000-0000-4000-8000-000000000009', 5, NULL, '直したら知らせます', NULL)),
  false, '冪等: 返信だけの操作の同じ内容の再送は記録済み');
RESET ROLE;

-- (54c) 配信状況の集計は superseded（状態が変わって送らなんだ）も数える。
-- 数えねば全部 0 に見え、運用者の画面が「Push の宛先なし」と嘘をつく。
UPDATE feedback_notifications SET skipped_at = now(), skip_reason = 'superseded'
 WHERE id = (SELECT n.id FROM feedback_notifications n
               JOIN feedback_events e ON e.id = n.event_id
              WHERE e.feedback_id = (SELECT id FROM fl_ref WHERE name = 'f1')
                AND e.to_status = 'considering'
              LIMIT 1);
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'e3333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text, true);
SELECT is(
  (SELECT queued::text || ':' || superseded::text
     FROM get_feedback_push_summary((SELECT id FROM fl_ref WHERE name = 'f1')) s
     JOIN feedback_events e ON e.id = s.event_id
    WHERE e.to_status = 'considering'),
  '1:1', '集計: 状態が変わって送らなんだ行を superseded として数える');
RESET ROLE;

-- ══ 9. 投稿の上限 ═══════════════════════════════════════════════
-- X の 24 時間以内の投稿を 20 件にしてから撃つ（superuser で直接作る）。
INSERT INTO feedback_items (submitter_id, submitter_name, client_request_id, title)
SELECT 'e5555555-5555-5555-5555-555555555555', '他世帯',
       ('d0000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '要望 ' || g
  FROM generate_series(1, 20) g;
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'e5555555-5555-5555-5555-555555555555', 'role', 'authenticated')::text, true);
-- (55) 21 件目は IRF02
SELECT throws_ok(
  $$ SELECT * FROM submit_feedback('d0000000-0000-4000-8000-000000000099', '21 件目', '') $$,
  'IRF02', 'too many feedback submissions', '上限: 24 時間で 21 件目は拒む');
-- (56) 既にある要望の再送は上限に数えぬ（応答が失われた再試行を拒まぬ）
SELECT is(
  (SELECT created FROM submit_feedback('d0000000-0000-4000-8000-000000000001', '要望 1', '')),
  false, '上限: 既存の要望の再送は上限で拒まず「受付済み」を返す');

-- (57) 運用者自身の投稿は自分へは積まぬ
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'e3333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text, true);
SELECT is(
  (SELECT created FROM submit_feedback('b0000000-0000-4000-8000-0000000000f1', '運用者の自分用メモ', '')),
  true, '運用者も投稿できる');
RESET ROLE;
SELECT is(
  (SELECT count(*) FROM feedback_notifications n JOIN feedback_events e ON e.id = n.event_id
     JOIN feedback_items f ON f.id = e.feedback_id
    WHERE f.client_request_id = 'b0000000-0000-4000-8000-0000000000f1'),
  0::bigint, '運用者自身の投稿は自分の端末へは積まぬ');

-- ══ 10. 提出者名の写しは掃除される（受信箱に細工を持ち込ませぬ）═════════════
-- display_name は利用者が自由に付けられる。全角空白（12288）・RLO（8238）・BEL（7）を混ぜる。
UPDATE profiles
   SET display_name = chr(12288) || '妻' || chr(8238) || chr(7) || 'さん '
 WHERE id = 'e2222222-2222-2222-2222-222222222222';
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'e2222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);
SELECT lives_ok(
  $$ SELECT * FROM submit_feedback('b0000000-0000-4000-8000-0000000000e1', '名前の掃除', '') $$,
  '提出者名: 細工を含む表示名でも投稿は通る');
RESET ROLE;
SELECT is(
  (SELECT submitter_name FROM feedback_items
    WHERE client_request_id = 'b0000000-0000-4000-8000-0000000000e1'),
  '妻さん', '提出者名: 制御文字・双方向制御文字と前後の空白を落として写す');
-- 掃除すると空になる名前は「名前未設定」
UPDATE profiles SET display_name = chr(8238) || chr(7)
 WHERE id = 'e2222222-2222-2222-2222-222222222222';
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'e2222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);
SELECT lives_ok(
  $$ SELECT * FROM submit_feedback('b0000000-0000-4000-8000-0000000000e2', '名前が空', '') $$,
  '提出者名: 掃除で空になる表示名でも投稿は通る');
RESET ROLE;
SELECT is(
  (SELECT submitter_name FROM feedback_items
    WHERE client_request_id = 'b0000000-0000-4000-8000-0000000000e2'),
  '名前未設定', '提出者名: 掃除で空になれば「名前未設定」');

SELECT * FROM finish();
ROLLBACK;
