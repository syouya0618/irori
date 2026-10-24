-- `upsert_push_subscription` が push endpoint を **DB 側で allowlist 検査する**ことを固定する（P1-03）。
-- 実行: supabase test db supabase/tests/push_endpoint_allowlist.sql
--
-- ## なぜこの assert が要るか
-- endpoint は cron（service role）が 5 分ごとに POST する宛先じゃ。検査が Server
-- Action（`isAllowedPushEndpoint`）にしか無かった頃は、承認済みの JWT で RPC を
-- 直に叩けば `https://attacker:8443/` でも内部アドレスでも登録でき、cron が盲目
-- SSRF の踏み台になった（failure_count が到達性の oracle になる）。応答を返さぬ
-- 宛先を並べれば、直列に回る他世帯の通知まで止められた。
-- 20261002100003_push_endpoint_allowlist.sql が RPC 内に正規表現の検査を足した。
-- TS 側（`src/lib/domain/push-endpoint.ts`）と**同じ事例表**を通すことで、
-- 両者の受理集合が食い違えば必ず片方が赤くなる。
--
-- ## 事例表は 1 つだけ（vitest と共有する）
-- 下の `push-endpoint-cases:begin` 〜 `:end` の VALUES 行を、
-- `src/lib/domain/__tests__/push-endpoint.test.ts` が**このファイルから読み取って**
-- `isAllowedPushEndpoint` に通す。行を足すときはここへ足せ（両側に効く）。
-- 書式は 1 行 1 事例 `('<endpoint>', true|false),` を守ること（vitest の読み取りが前提にする）。
--
-- ## 偽緑を潰す設計
-- (S) 事例表の件数（受理・拒否の両方）を先に固定する。0 件なら全 assert が空回りする。
-- (C) 拒否だけでなく受理も撃つ。両方無いと「RPC が丸ごと壊れた」状態と区別がつかぬ。
-- (P) 副作用は superuser で数える（authenticated からは endpoint 列が読めぬ）。
BEGIN;
SELECT plan(36);

-- ── seed(superuser) ────────────────────────────────────────────
-- U1 = 検証対象（承認済み）/ U2 = 移行前に登録された不適合な行の持ち主
INSERT INTO households (id, name) VALUES
  ('c1111111-1111-1111-1111-111111111111', 'PE H1');
INSERT INTO auth.users (id, email) VALUES
  ('c2222222-2222-2222-2222-222222222222', 'pe-u1@example.com'),
  ('c3333333-3333-3333-3333-333333333333', 'pe-u2@example.com');
UPDATE profiles SET household_id = 'c1111111-1111-1111-1111-111111111111',
                    display_name = 'PE U1', role = 'owner', is_approved = true
  WHERE id = 'c2222222-2222-2222-2222-222222222222';
UPDATE profiles SET household_id = 'c1111111-1111-1111-1111-111111111111',
                    display_name = 'PE U2', role = 'member', is_approved = true
  WHERE id = 'c3333333-3333-3333-3333-333333333333';

-- 移行前に RPC 直叩きで入った不適合な行の模擬。migration は既存行を消さず、
-- CHECK も足さぬ（cron の診断 UPDATE が落ち始めるため）。その前提を下で撃つ。
INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent) VALUES
  ('c0000000-0000-4000-8000-000000000001',
   'c3333333-3333-3333-3333-333333333333',
   'https://legacy.attacker.example:8443/x', 'k-legacy', 'a-legacy', 'legacy');

-- push-endpoint-cases:begin
CREATE TEMP TABLE push_endpoint_cases (endpoint TEXT PRIMARY KEY, allowed BOOLEAN NOT NULL);
INSERT INTO push_endpoint_cases (endpoint, allowed) VALUES
  ('https://fcm.googleapis.com/fcm/send/x', true),
  ('https://web.push.apple.com/abc', true),
  ('https://updates.push.services.mozilla.com/wpush/v2/x', true),
  ('http://fcm.googleapis.com/x', false),
  ('https://FCM.googleapis.com/x', false),
  ('https://fcm.googleapis.com:443/x', false),
  ('https://fcm.googleapis.com:81/x', false),
  ('https://user@fcm.googleapis.com/x', false),
  ('https://fcm.googleapis.com.evil.com/x', false),
  ('https://fcm.googleapis.com./x', false),
  ('https://fcm%2egoogleapis.com/x', false),
  ('https://evilpush.apple.com/x', false),
  ('https://push.apple.com/x', false),
  ('https://.push.apple.com/x', false),
  ('https://a_b.push.apple.com/x', false),
  ('https://fcm.googleapis.com', false),
  ('https://fcm.googleapis.com?x', false),
  ('https:\\fcm.googleapis.com/x', false),
  (' https://fcm.googleapis.com/x', false),
  ('https://169.254.169.254/x', false);
-- push-endpoint-cases:end
-- 事例表は authenticated 文脈の SELECT から読む（RPC を呼ぶのはその文脈ゆえ）。
GRANT SELECT ON push_endpoint_cases TO authenticated;

-- ── (1)(2)(3) seed の固定 ──────────────────────────────────────
SELECT is((SELECT count(*) FROM push_endpoint_cases WHERE allowed), 3::bigint,
  'seed: 受理の事例が 3 件（FCM / Apple / Mozilla）');
SELECT is((SELECT count(*) FROM push_endpoint_cases WHERE NOT allowed), 17::bigint,
  'seed: 拒否の事例が 17 件');
SELECT is(
  (SELECT count(*) FROM push_subscriptions
    WHERE id = 'c0000000-0000-4000-8000-000000000001'
      AND user_id = 'c3333333-3333-3333-3333-333333333333'),
  1::bigint, 'seed: U2 の不適合な旧行が 1 件在る');

-- ── (4)(5)(6) カタログ（DEFINER の型と実行権限は再定義後も保たれる）──
SELECT is(
  (SELECT prosecdef FROM pg_proc
    WHERE oid = 'upsert_push_subscription(text,text,text,text)'::regprocedure),
  true, 'upsert_push_subscription は SECURITY DEFINER のまま');
SELECT ok(
  (SELECT proconfig FROM pg_proc
    WHERE oid = 'upsert_push_subscription(text,text,text,text)'::regprocedure)
    @> ARRAY['search_path=public'],
  'upsert_push_subscription に SET search_path=public が付いたまま');
SELECT ok(
  NOT has_function_privilege('anon', 'upsert_push_subscription(text,text,text,text)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'upsert_push_subscription(text,text,text,text)', 'EXECUTE'),
  'upsert_push_subscription は anon 不可・authenticated 可のまま');

-- ══ U1（承認済み）文脈 ═════════════════════════════════════════
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'c2222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);

-- (7)〜(26) 事例表を 1 行ずつ RPC に通す。受理は lives_ok、拒否は 22023 で落ちる。
SELECT CASE WHEN allowed THEN
         lives_ok(
           format($q$ SELECT upsert_push_subscription(%L, 'k', 'a', 'case') $q$, endpoint),
           'accept: ' || endpoint)
       ELSE
         throws_ok(
           format($q$ SELECT upsert_push_subscription(%L, 'k', 'a', 'case') $q$, endpoint),
           '22023', 'push endpoint not allowed',
           'reject(22023): ' || endpoint)
       END
  FROM push_endpoint_cases
 ORDER BY allowed DESC, endpoint;

-- (27) NULL も拒否（`!~` は NULL を素通しする三値論理の穴を塞いでおる）
SELECT throws_ok(
  $$ SELECT upsert_push_subscription(NULL, 'k', 'a', 'null') $$,
  '22023', 'push endpoint not allowed',
  'reject(22023): NULL endpoint');

-- (28) 不適合な endpoint で「奪取」（共用端末の付け替え）を試みても拒まれる
SELECT throws_ok(
  $$ SELECT upsert_push_subscription('https://legacy.attacker.example:8443/x', 'k', 'a', 'steal') $$,
  '22023', 'push endpoint not allowed',
  'reject(22023): 不適合な endpoint は共用端末の付け替えにも使えぬ');

-- (29) 再購読（同じ endpoint の再登録）は従来どおり通る
SELECT lives_ok(
  $$ SELECT upsert_push_subscription('https://fcm.googleapis.com/fcm/send/x', 'k2', 'a2', 'case') $$,
  '受理済み endpoint の再登録は従来どおり通る（ON CONFLICT 経路）');

-- ══ superuser で副作用を数える ════════════════════════════════
RESET ROLE;
SELECT set_config('request.jwt.claims', NULL, true);

-- (30) 受理の事例は 3 件とも U1 の行として入った
SELECT is(
  (SELECT count(*) FROM push_subscriptions s
     JOIN push_endpoint_cases c ON c.endpoint = s.endpoint
    WHERE c.allowed AND s.user_id = 'c2222222-2222-2222-2222-222222222222'),
  3::bigint, '受理の事例 3 件が U1 の購読として登録された');
-- (31) 拒否の事例は 1 件も入っておらぬ（throws_ok の副作用も含めて）
SELECT is(
  (SELECT count(*) FROM push_subscriptions s
     JOIN push_endpoint_cases c ON c.endpoint = s.endpoint
    WHERE NOT c.allowed),
  0::bigint, '拒否の事例は 1 件も登録されておらぬ');
-- (32) 再登録で鍵が更新され、件数は増えておらぬ
SELECT is(
  (SELECT p256dh FROM push_subscriptions
    WHERE endpoint = 'https://fcm.googleapis.com/fcm/send/x'),
  'k2', '再登録で p256dh が更新された（行は 1 つのまま）');
-- (33) U2 の旧行は U2 のまま残っておる（拒否された呼び出しは付け替えを起こさぬ）
--      ※ 例外は呼び出し全体を巻き戻すゆえ、これは「検査が在る」ことの証拠であって
--        「検査が DELETE より前に在る」ことの証拠ではない（順序はデータを左右せぬ）。
SELECT is(
  (SELECT user_id FROM push_subscriptions
    WHERE id = 'c0000000-0000-4000-8000-000000000001'),
  'c3333333-3333-3333-3333-333333333333'::uuid,
  '不適合な旧行は奪取されず U2 のまま残る（拒否は付け替えを起こさぬ）');
-- (34) 旧行の診断 UPDATE（cron = service role の経路）は通る ＝ CHECK を足しておらぬ
SELECT lives_ok(
  $$ UPDATE push_subscriptions SET failure_count = failure_count + 1
      WHERE id = 'c0000000-0000-4000-8000-000000000001' $$,
  '不適合な旧行の診断 UPDATE は通る（表に CHECK を足しておらぬ）');
-- (35) 表に endpoint の形を縛る CHECK は無い（長さの CHECK だけ）
SELECT is(
  (SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'push_subscriptions'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%endpoint%'),
  1::bigint, 'push_subscriptions の endpoint の CHECK は長さの 1 本だけ（形の検査は RPC が持つ）');
-- (36) 旧行を migration が消しておらぬ前提で、件数が seed のまま
SELECT is(
  (SELECT count(*) FROM push_subscriptions
    WHERE user_id = 'c3333333-3333-3333-3333-333333333333'),
  1::bigint, 'U2 の購読は 1 件のまま（拒否された呼び出しは何も消しておらぬ）');

SELECT * FROM finish();
ROLLBACK;
