-- push_subscriptions の **権限カタログと所有者分離** を機械で固定する（B-1）。
-- 実行: supabase test db supabase/tests/push_subscriptions_grants_rls.sql
--
-- ## なぜこの assert が要るか
-- `(endpoint, p256dh, auth)` の三つ組は、VAPID 秘密鍵と併せて
-- **「その端末へ任意の通知を送る能力そのもの」** じゃ。設定カードは端末一覧を出す
-- ため、素直に作れば端末 A のブラウザから端末 B の三つ組が読める — 1 台の XSS が
-- 全端末のロック画面への任意表示権に化ける。
-- これを止めておるのは **列 GRANT 1 枚**だけで、外れても RLS ポリシーは残るため
-- **ポリシー一覧を見ても異常に見えぬ**（profiles_column_grants.sql と同じ構図）。
-- ゆえに「読めぬこと」を実際に撃って固定する。
--
-- ## 書込経路が 1 本であることも固定する
-- INSERT / UPDATE は **ポリシーも GRANT も意図的に置いておらぬ**。
-- 書けるのは SECURITY DEFINER の `upsert_push_subscription()` と service_role のみ。
-- 「無いこと」が設計ゆえ、誰かが良かれと思ってポリシーを 1 本足しても画面には
-- 現れぬ。set_eq で「ちょうど 2 種」を固定して検知する。
--
-- ## information_schema を使わぬ理由（既存テストと同じ）
-- `information_schema.column_privileges` は「現在有効なロールが grantor か grantee
-- である行」しか返さぬ。走らせるロール次第で黙って 0 行になり偽緑になるため、
-- catalog（`pg_class.relacl` / `pg_attribute.attacl`）を `aclexplode` で直読みする。
--
-- ## 偽緑を潰す設計（三段・既存テストの型を踏襲）
-- (P) positive control: `aclexplode(NULL)` は 0 行ゆえ、ACL が空でも negative
--     assert は緑になる。まず relacl が NULL でないことを固定する。
-- (S) seed の固定: 「他人の購読が見えぬ」は行が 0 件なら常に緑ゆえ、先に
--     **2 人ぶんの行が入ったこと**を assert する。
-- (C) 対照: 「見えぬ／書けぬ」だけでなく「自分のは見える／消せる」を同じ文脈で
--     assert する。両方無いと、単に全部壊れておる状態と区別がつかぬ。
--
-- ## 限界（正直に書く）
-- これは検知であって防止ではない。GRANT を緩める migration を書けばこのテストが
-- 赤くなるだけで、書くこと自体は止められぬ。
BEGIN;
SELECT plan(32);

-- ══════════════════════════════════════════════════════════════
-- A. 権限カタログ（静的・ロール切替なし）
-- ══════════════════════════════════════════════════════════════

-- ── A-0. positive control ─────────────────────────────────────
-- relacl が NULL だと aclexplode が 0 行を返し、以降の negative assert が
-- 「権限が無いから緑」ではなく「ACL 行が無いから緑」になる。
SELECT isnt(
  (SELECT relacl FROM pg_class WHERE oid = 'push_subscriptions'::regclass),
  NULL,
  'A-0: push_subscriptions の relacl は NULL でない（以降の negative assert が意味を持つ前提）'
);

-- ── A-1. authenticated のテーブルレベル権限は「ちょうど」DELETE のみ ──
-- SELECT は列 GRANT ゆえ attacl 側に出る。ここに SELECT が出ておったら
-- 「全列に効く SELECT」が付いた証拠で、下の列 assert が無意味になる。
SELECT set_eq(
  $$
  SELECT acl.privilege_type::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) acl
  WHERE n.nspname = 'public'
    AND c.relname = 'push_subscriptions'
    AND acl.grantee = 'authenticated'::regrole
  $$,
  ARRAY['DELETE'],
  'A-1: authenticated のテーブルレベル権限は DELETE のみ（SELECT が出たら列 GRANT が無意味化しておる）'
);

-- ── A-2. anon は一切の権限を持たぬ ────────────────────────────
SELECT is_empty(
  $$
  SELECT acl.privilege_type::text
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(c.relacl) acl
  WHERE c.oid = 'push_subscriptions'::regclass
    AND acl.grantee = 'anon'::regrole
  $$,
  'A-2: anon は push_subscriptions にいかなるテーブル権限も持たぬ'
);

-- ── A-3. ポリシーは SELECT / DELETE の 2 種だけ ───────────────
-- polcmd: r=SELECT / a=INSERT / w=UPDATE / d=DELETE / *=ALL。
-- set_eq ゆえ「INSERT・UPDATE ポリシーを作らぬ」と「FOR ALL 禁止」を同時に固定する。
SELECT set_eq(
  $$ SELECT polcmd::text FROM pg_policy WHERE polrelid = 'push_subscriptions'::regclass $$,
  ARRAY['r', 'd'],
  'A-3: ポリシーは SELECT / DELETE のみ（INSERT・UPDATE ポリシー無し / FOR ALL 無し）'
);

-- ── A-4. authenticated が SELECT できる列は「ちょうど」非秘密 7 列 ──
-- endpoint / p256dh / auth が 1 つでも紛れ込めば赤くなる。
SELECT set_eq(
  $$
  SELECT a.attname::text
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  CROSS JOIN LATERAL aclexplode(a.attacl) acl
  WHERE c.oid = 'push_subscriptions'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped
    AND acl.grantee = 'authenticated'::regrole
    AND acl.privilege_type = 'SELECT'
  $$,
  ARRAY['id', 'user_id', 'user_agent', 'created_at',
        'last_success_at', 'last_failure_at', 'failure_count'],
  'A-4: authenticated が SELECT できるのは非秘密 7 列のみ（endpoint/p256dh/auth は含まぬ）'
);

-- ── A-5. authenticated が INSERT できる列は 0 ────────────────
SELECT is_empty(
  $$
  SELECT a.attname::text
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  CROSS JOIN LATERAL aclexplode(a.attacl) acl
  WHERE c.oid = 'push_subscriptions'::regclass
    AND acl.grantee = 'authenticated'::regrole
    AND acl.privilege_type = 'INSERT'
  $$,
  'A-5: authenticated に INSERT 可能な列は無い（書込は RPC のみ）'
);

-- ── A-6. authenticated が UPDATE できる列は 0 ────────────────
SELECT is_empty(
  $$
  SELECT a.attname::text
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  CROSS JOIN LATERAL aclexplode(a.attacl) acl
  WHERE c.oid = 'push_subscriptions'::regclass
    AND acl.grantee = 'authenticated'::regrole
    AND acl.privilege_type = 'UPDATE'
  $$,
  'A-6: authenticated に UPDATE 可能な列は無い（failure_count 等は service role 専用）'
);

-- ── A-7. RPC は SECURITY DEFINER かつ search_path が固定されておる ──
-- `SET search_path = public` を落とすと、auth スキーマ経由で呼ばれた時に
-- 解決先が狂う（CLAUDE.md の既知の罠）。
SELECT is(
  (SELECT prosecdef FROM pg_proc WHERE proname = 'upsert_push_subscription'),
  true,
  'A-7a: upsert_push_subscription は SECURITY DEFINER'
);
SELECT ok(
  (SELECT proconfig FROM pg_proc WHERE proname = 'upsert_push_subscription')
    @> ARRAY['search_path=public'],
  'A-7b: upsert_push_subscription に SET search_path=public が付いておる'
);

-- ── A-8. Realtime publication に載せておらぬ ─────────────────
-- 秘密列を持つゆえ walrus の列フィルタに安全性を賭けたくない。
SELECT is_empty(
  $$
  SELECT tablename FROM pg_publication_tables
  WHERE pubname = 'supabase_realtime' AND tablename = 'push_subscriptions'
  $$,
  'A-8: supabase_realtime publication に push_subscriptions は載っておらぬ'
);

-- ══════════════════════════════════════════════════════════════
-- B. 実挙動（authenticated + JWT claims）
-- ══════════════════════════════════════════════════════════════
-- U1 = 検証対象 / U2 = 同世帯の配偶者 / U3 = 未承認
INSERT INTO households (id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'H1');
INSERT INTO auth.users (id, email) VALUES
  ('22222222-2222-2222-2222-222222222222', 'u1@example.com'),
  ('88888888-8888-8888-8888-888888888888', 'u2@example.com'),
  ('99999999-9999-9999-9999-999999999999', 'u3@example.com');
UPDATE profiles SET household_id = '11111111-1111-1111-1111-111111111111',
                    display_name = 'U1', role = 'owner', is_approved = true
  WHERE id = '22222222-2222-2222-2222-222222222222';
UPDATE profiles SET household_id = '11111111-1111-1111-1111-111111111111',
                    display_name = 'U2', role = 'member', is_approved = true
  WHERE id = '88888888-8888-8888-8888-888888888888';
-- U3 は**同世帯だが未承認**。RPC の fail-closed を確かめる対照。
UPDATE profiles SET household_id = '11111111-1111-1111-1111-111111111111',
                    display_name = 'U3', role = 'member', is_approved = false
  WHERE id = '99999999-9999-9999-9999-999999999999';

INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES
  ('22222222-2222-2222-2222-222222222222',
   'https://fcm.googleapis.com/fcm/send/u1-device', 'p256dh-u1', 'auth-u1', 'U1 の Android'),
  ('88888888-8888-8888-8888-888888888888',
   'https://web.push.apple.com/u2-device', 'p256dh-u2', 'auth-u2', 'U2 の iPhone'),
  -- B-18 用: 最後まで U2 のまま残る行（奪取・解除の対象にせぬ）
  ('88888888-8888-8888-8888-888888888888',
   'https://web.push.apple.com/u2-other', 'p256dh-u2b', 'auth-u2b', 'U2 の iPad');

-- ── B-0. seed が効いておること（これが赤いなら以降は行が無いだけの偽緑）──
SELECT is((SELECT count(*) FROM push_subscriptions), 3::bigint,
  'B-0: seed が 3 件入っておる（配偶者ぶんを含む。1 人 seed だと分離の縮退を見逃す）');

-- ── U1 の文脈へ。harness で GRANT は撃たぬ（migration の GRANT が検証対象）──
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '22222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);

-- ══ 所有者分離（対照つき）══════════════════════════════════════
SELECT is((SELECT count(*) FROM push_subscriptions), 1::bigint,
  'B-1: 自分の購読のみ可視（**同世帯の配偶者のものも見えぬ** — 購読は端末単位ゆえ）');
SELECT is((SELECT user_agent FROM push_subscriptions), 'U1 の Android',
  'B-2: 見えておる 1 件は自分の行（対照: 単に全部見えぬのとは違う）');

-- ══ 秘密列の読み取り拒否 ═══════════════════════════════════════
SELECT throws_ok(
  $$ SELECT endpoint FROM push_subscriptions $$,
  '42501', 'permission denied for table push_subscriptions',
  'B-3: endpoint は authenticated から読めぬ（列 GRANT 外・送信能力そのもの）');
SELECT throws_ok(
  $$ SELECT p256dh FROM push_subscriptions $$,
  '42501', 'permission denied for table push_subscriptions',
  'B-4: p256dh は authenticated から読めぬ');
SELECT throws_ok(
  $$ SELECT auth FROM push_subscriptions $$,
  '42501', 'permission denied for table push_subscriptions',
  'B-5: auth は authenticated から読めぬ');
-- 列 GRANT ゆえ `select("*")` は落ちる。アプリ側は列を明示すること。
SELECT throws_ok(
  $$ SELECT * FROM push_subscriptions $$,
  '42501', 'permission denied for table push_subscriptions',
  'B-6: select("*") は落ちる（アプリは列を明示して SELECT すること）');

-- ══ 直接の書込は塞がれておる ═══════════════════════════════════
SELECT throws_ok(
  $$ INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES ('22222222-2222-2222-2222-222222222222', 'https://evil/x', 'k', 'a') $$,
  '42501', 'permission denied for table push_subscriptions',
  'B-7: authenticated は直接 INSERT できぬ（書込は RPC のみ）');
SELECT throws_ok(
  $$ UPDATE push_subscriptions SET failure_count = 0 $$,
  '42501', 'permission denied for table push_subscriptions',
  'B-8: authenticated は直接 UPDATE できぬ（failure_count は service role 専用）');

-- ══ RPC 経由の書込（対照: 消せる・書ける）═════════════════════
SELECT isnt(
  upsert_push_subscription('https://fcm.googleapis.com/fcm/send/u1-new', 'k-new', 'a-new', 'U1 の新端末'),
  NULL,
  'B-9: RPC 経由なら自分の購読を登録できる（対照）');
SELECT is((SELECT count(*) FROM push_subscriptions), 2::bigint,
  'B-10: 登録後、自分に見える購読は 2 件（配偶者ぶんは依然として不可視）');

-- 同じ endpoint を再登録しても増えぬ（冪等）。
SELECT isnt(
  upsert_push_subscription('https://fcm.googleapis.com/fcm/send/u1-new', 'k-2', 'a-2', 'U1 の新端末'),
  NULL,
  'B-11: 同一 endpoint の再登録は成功する（再購読の経路）');
SELECT is((SELECT count(*) FROM push_subscriptions), 2::bigint,
  'B-12: 再登録しても件数は増えぬ（endpoint UNIQUE で冪等）');

-- 共用端末の持ち主交代: U2 の端末を U1 が登録すると付け替わる。
-- 付け替えねば、旧ユーザー宛の通知が新しい利用者の端末に届き続ける。
SELECT isnt(
  upsert_push_subscription('https://web.push.apple.com/u2-device', 'k-taken', 'a-taken', '共用端末'),
  NULL,
  'B-13: 別ユーザーが登録済みの endpoint を奪える（共用端末の持ち主交代）');
SELECT is((SELECT count(*) FROM push_subscriptions), 3::bigint,
  'B-14: 奪った後、U1 に見えるのは 3 件（U2 の行は増えず付け替わった）');

-- 自分の行は消せる（対照）。
DELETE FROM push_subscriptions WHERE user_agent = '共用端末';
SELECT is((SELECT count(*) FROM push_subscriptions), 2::bigint,
  'B-15: 自分の端末は自分で解除できる（対照: DELETE は通る）');

-- ══ endpoint 指定の解除（サインアウト経路）═══════════════════
-- endpoint は列 GRANT 外ゆえ authenticated は WHERE 句にも使えぬ。RPC が要る所以。
SELECT is(
  delete_my_push_subscription('https://fcm.googleapis.com/fcm/send/u1-new'),
  true,
  'B-16: 自分の購読を endpoint 指定で解除できる（サインアウト時の経路）');
SELECT is((SELECT count(*) FROM push_subscriptions), 1::bigint,
  'B-17: 解除後は 1 件');
-- 他人の endpoint を指定しても消せぬ（対照）。U2 の端末は seed 時のまま残っておる。
SELECT is(
  delete_my_push_subscription('https://web.push.apple.com/u2-other'),
  false,
  'B-18: **他人の生きた購読**を endpoint 指定でも消せぬ（false が返るだけ）');
-- 未登録の endpoint でも落ちぬ（サインアウトを止めてはならぬ）。
SELECT is(
  delete_my_push_subscription('https://fcm.googleapis.com/fcm/send/never-registered'),
  false,
  'B-19: 未登録の endpoint でも例外を投げぬ（サインアウト経路を止めぬ）');

-- ══ 未承認ユーザーは RPC を拒まれる（fail-closed）═════════════
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '99999999-9999-9999-9999-999999999999', 'role', 'authenticated')::text, true);
SELECT throws_like(
  $$ SELECT upsert_push_subscription('https://fcm.googleapis.com/fcm/send/u3', 'k', 'a', 'U3') $$,
  '%not approved%',
  'B-20: 未承認ユーザーは購読を登録できぬ（proxy とは独立した DB 側の fail-closed）');

-- ══ 未認証（anon）は RPC を実行できぬ ═════════════════════════
SET LOCAL role anon;
SELECT set_config('request.jwt.claims', NULL, true);
SELECT throws_like(
  $$ SELECT upsert_push_subscription('https://fcm.googleapis.com/fcm/send/anon', 'k', 'a', 'anon') $$,
  '%permission denied for function upsert_push_subscription%',
  'B-21: anon は RPC を実行できぬ（EXECUTE を GRANT しておらぬ）');

SELECT * FROM finish();
ROLLBACK;
