-- Google 同期 3 テーブルの **権限カタログと世帯分離** を機械で固定する（D-1）。
-- 実行: supabase test db supabase/tests/google_calendar_sync_grants_rls.sql
--
-- ## なぜこの assert が要るか
-- `google_tokens.refresh_token` は「その Google アカウントのカレンダーを読む鍵」
-- そのものじゃ。これを守っておるのは **RLS ポリシーが 0 本であること**（deny-all）と
-- **GRANT が 1 つも無いこと** の二枚だけで、どちらも「無いこと」ゆえ画面にも
-- ポリシー一覧にも異常として現れぬ。誰かが良かれと思って
-- `CREATE POLICY ... FOR SELECT` を 1 本足した瞬間に、配偶者どころか同世帯の
-- 全員へ平文トークンが開く。ゆえに「無いこと」自体を assert する。
-- 同様に `google_calendar_subscriptions.sync_token` / `sync_lease_until` は
-- 列 GRANT 1 枚で隠れておる（profiles の H1-b と同型）。
--
-- ## information_schema を使わぬ理由（profiles_column_grants.sql と同じ）
-- `information_schema.column_privileges` は「現在有効なロールが grantor か
-- grantee である行」しか返さぬ。走らせるロール次第で**黙って 0 行になり偽緑**に
-- なるゆえ、catalog（`pg_class.relacl` / `pg_attribute.attacl`）を `aclexplode`
-- で直読みする。
--
-- ## 偽緑を潰す設計（三段）
-- (P) **positive control**: `aclexplode(NULL)` は 0 行を返す。ACL 行が単に
--     空でも negative assert は緑になってしまうため、まず `relacl IS NOT NULL`
--     を固定してから「anon/authenticated が居らぬ」を assert する。
-- (S) **seed の固定**: 「他世帯が見えぬ」は行が 0 件なら常に緑ゆえ、superuser で
--     各表に 2 行（自世帯 1 + 他世帯 1）入ったことを先に assert する。
-- (C) **対照**: 「見えぬ／書けぬ」だけでなく「自世帯は見える／is_selected は
--     書ける」を同じ文脈で assert する。両方無いと、単に全部壊れておるだけの
--     状態と区別がつかぬ。
--
-- ## harness で GRANT せぬこと（既存テストとの違い・意図的）
-- calendar_events 等の既存テストは `GRANT SELECT, INSERT, UPDATE, DELETE ... TO
-- authenticated` を harness で撃っておる（ローカルの default privileges が
-- anon/authenticated へ `Dxtm` しか与えぬため）。本ファイルは **撃たぬ**。
-- migration 側が REVOKE ALL → 必要な GRANT だけを明示しておるゆえ、ここでの
-- 権限は**本番と同じ形**であり、harness で足せば検証対象そのものを壊す。
--
-- ## 限界（正直に書く）
-- これは検知であって防止ではない。GRANT を緩める migration・ポリシーを足す
-- migration を書けばこのテストが赤くなるだけで、書くこと自体は止められぬ。
BEGIN;
SELECT plan(44);

-- ══════════════════════════════════════════════════════════════
-- A. 権限カタログ（superuser のまま catalog を直読み）
-- ══════════════════════════════════════════════════════════════

-- ── A-1. positive control: google_tokens の ACL 行は空ではない ──
-- これが赤いなら以降の is_empty は「ACL が丸ごと無い」だけの偽緑じゃ。
SELECT ok(
  (SELECT c.relacl IS NOT NULL
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'google_tokens'),
  'positive control: google_tokens の relacl は NULL でない（negative assert が空振りせぬ）'
);

-- ── A-2. google_tokens に anon / authenticated の権限が 1 つも無い ──
SELECT is_empty(
  $$
  SELECT acl.privilege_type
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) acl
  WHERE n.nspname = 'public'
    AND c.relname = 'google_tokens'
    AND acl.grantee IN ('anon'::regrole, 'authenticated'::regrole)
  $$,
  'google_tokens に anon / authenticated のテーブル権限が 1 つも無い（SELECT/INSERT/UPDATE/DELETE 全て）'
);

-- ── A-3. google_tokens の列にも anon / authenticated の権限が無い ──
-- テーブル権限を剥がしても列 GRANT が残れば読める。両方を塞ぐ。
SELECT is_empty(
  $$
  SELECT a.attname::text
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(a.attacl) acl
  WHERE n.nspname = 'public'
    AND c.relname = 'google_tokens'
    AND a.attnum > 0 AND NOT a.attisdropped
    AND acl.grantee IN ('anon'::regrole, 'authenticated'::regrole)
  $$,
  'google_tokens に anon / authenticated の列権限が 1 つも無い'
);

-- ── A-4. google_tokens は RLS 有効 ──
SELECT ok(
  (SELECT c.relrowsecurity
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'google_tokens'),
  'google_tokens は RLS 有効'
);

-- ── A-5. google_tokens のポリシーは 0 本（deny-all の本体）──
SELECT is(
  (SELECT count(*) FROM pg_policy WHERE polrelid = 'google_tokens'::regclass),
  0::bigint,
  'google_tokens のポリシーは 0 本 = deny-all（1 本でも足せば同世帯へ平文トークンが開く）'
);

-- ── A-6. google_connections: authenticated のテーブル権限が「ちょうど」2 つ ──
-- set_eq ゆえ INSERT/UPDATE が紛れ込んでも、SELECT/DELETE が消えても赤くなる。
SELECT set_eq(
  $$
  SELECT acl.privilege_type::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) acl
  WHERE n.nspname = 'public'
    AND c.relname = 'google_connections'
    AND acl.grantee = 'authenticated'::regrole
  $$,
  ARRAY['SELECT', 'DELETE'],
  'google_connections で authenticated が持つ権限は SELECT / DELETE のみ（INSERT/UPDATE は service role 専用）'
);

-- ── A-7. google_connections のポリシーは SELECT と DELETE の 2 種だけ ──
-- polcmd: r=SELECT / a=INSERT / w=UPDATE / d=DELETE / *=ALL。
-- set_eq ゆえ「INSERT/UPDATE ポリシーを作らぬ」も「FOR ALL 禁止」も同時に固定する。
SELECT set_eq(
  $$ SELECT polcmd::text FROM pg_policy WHERE polrelid = 'google_connections'::regclass $$,
  ARRAY['r', 'd'],
  'google_connections のポリシーは SELECT / DELETE のみ（INSERT・UPDATE ポリシー無し / FOR ALL 無し）'
);

-- ── A-8. google_calendar_subscriptions: authenticated のテーブルレベル権限は 0 ──
-- テーブルレベル権限が 1 つでも在ると全列に効き、下の列 GRANT の assert が
-- 意味を失う（profiles_column_grants.sql の #1 と同じ理由）。
SELECT is_empty(
  $$
  SELECT acl.privilege_type
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) acl
  WHERE n.nspname = 'public'
    AND c.relname = 'google_calendar_subscriptions'
    AND acl.grantee = 'authenticated'::regrole
  $$,
  'google_calendar_subscriptions に authenticated のテーブルレベル権限が無い（列 GRANT を無意味化させぬ）'
);

-- ── A-9. authenticated が UPDATE できる列は「ちょうど」is_selected のみ ──
SELECT set_eq(
  $$
  SELECT a.attname::text
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(a.attacl) acl
  WHERE n.nspname = 'public'
    AND c.relname = 'google_calendar_subscriptions'
    AND a.attnum > 0 AND NOT a.attisdropped
    AND acl.grantee = 'authenticated'::regrole
    AND acl.privilege_type = 'UPDATE'
  $$,
  ARRAY['is_selected'],
  'authenticated が UPDATE できる google_calendar_subscriptions の列は is_selected のみ'
);

-- ── A-10. authenticated が SELECT できる列は「ちょうど」非機密 9 列 ──
SELECT set_eq(
  $$
  SELECT a.attname::text
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(a.attacl) acl
  WHERE n.nspname = 'public'
    AND c.relname = 'google_calendar_subscriptions'
    AND a.attnum > 0 AND NOT a.attisdropped
    AND acl.grantee = 'authenticated'::regrole
    AND acl.privilege_type = 'SELECT'
  $$,
  ARRAY['id', 'connection_id', 'household_id', 'google_calendar_id',
        'summary', 'is_selected', 'last_synced_at', 'created_at', 'updated_at'],
  'authenticated が SELECT できる列は非機密 9 列のみ（sync_token / sync_lease_until を含まぬ）'
);

-- ── A-11. 秘密 2 列は名指しでも権限ゼロ ──
-- A-10 に包含されるが、**この 2 列こそが守るべきもの**である事実をテスト名に残す。
SELECT is_empty(
  $$
  SELECT a.attname::text || ':' || acl.privilege_type
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(a.attacl) acl
  WHERE n.nspname = 'public'
    AND c.relname = 'google_calendar_subscriptions'
    AND a.attname IN ('sync_token', 'sync_lease_until')
    AND acl.grantee IN ('anon'::regrole, 'authenticated'::regrole)
  $$,
  'sync_token / sync_lease_until には anon / authenticated の権限が一切無い（読めも書けもせぬ）'
);

-- ── A-12. subscriptions のポリシーは SELECT と UPDATE の 2 種だけ ──
SELECT set_eq(
  $$ SELECT polcmd::text FROM pg_policy WHERE polrelid = 'google_calendar_subscriptions'::regclass $$,
  ARRAY['r', 'w'],
  'google_calendar_subscriptions のポリシーは SELECT / UPDATE のみ（FOR ALL 無し）'
);

-- ── A-13. anon は 3 テーブルのどこにも権限を持たぬ ──
SELECT is_empty(
  $$
  SELECT c.relname::text || ':' || acl.privilege_type
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) acl
  WHERE n.nspname = 'public'
    AND c.relname IN ('google_connections', 'google_tokens', 'google_calendar_subscriptions')
    AND acl.grantee = 'anon'::regrole
  UNION ALL
  SELECT c.relname::text || '.' || a.attname
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(a.attacl) acl
  WHERE n.nspname = 'public'
    AND c.relname IN ('google_connections', 'google_tokens', 'google_calendar_subscriptions')
    AND acl.grantee = 'anon'::regrole
  $$,
  'anon は Google 同期 3 テーブルのテーブル権限・列権限とも一切持たぬ'
);

-- ── A-14. calendar_events.subscription_id の FK は ON DELETE SET NULL ──
-- V9: CASCADE ('c') にすると、同一の共有カレンダーを夫婦が各自購読した際に
-- 片方の解除でもう片方の予定まで消え、増分同期ゆえ永久に復活せぬ。
SELECT is(
  (SELECT confdeltype FROM pg_constraint
    WHERE conrelid = 'calendar_events'::regclass
      AND confrelid = 'google_calendar_subscriptions'::regclass
      AND contype = 'f'),
  'n'::"char",
  'V9: calendar_events.subscription_id の FK は ON DELETE SET NULL（CASCADE = ''c'' は禁止）'
);

-- ── A-15. publication に Google 系テーブルを 1 つも足しておらぬ ──
-- V7: subscriptions は sync_token / sync_lease_until という秘密を持つゆえ、
-- Realtime に載せると walrus の列フィルタへ安全性を賭けることになる。
SELECT is_empty(
  $$
  SELECT tablename::text FROM pg_publication_tables
  WHERE pubname = 'supabase_realtime' AND tablename LIKE 'google%'
  $$,
  'V7: supabase_realtime publication に google_* テーブルが 1 つも載っておらぬ'
);

-- ══════════════════════════════════════════════════════════════
-- B. 世帯分離と列権限の実挙動（authenticated + JWT claims）
-- ══════════════════════════════════════════════════════════════
-- H1 = 検証対象 U1 の世帯 / H2 = 別世帯（U2 が属する）
INSERT INTO households (id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'H1'),
  ('99999999-9999-9999-9999-999999999999', 'H2');
INSERT INTO auth.users (id, email) VALUES
  ('22222222-2222-2222-2222-222222222222', 'u1@example.com'),
  ('88888888-8888-8888-8888-888888888888', 'u2@example.com');
UPDATE profiles SET household_id = '11111111-1111-1111-1111-111111111111',
                    display_name = 'U1', role = 'owner', is_approved = true
  WHERE id = '22222222-2222-2222-2222-222222222222';
UPDATE profiles SET household_id = '99999999-9999-9999-9999-999999999999',
                    display_name = 'U2', role = 'owner', is_approved = true
  WHERE id = '88888888-8888-8888-8888-888888888888';

INSERT INTO google_connections (id, household_id, user_id, google_account_id, google_email) VALUES
  ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222', 'acct-u1', 'u1@example.com'),
  ('55555555-5555-5555-5555-555555555555', '99999999-9999-9999-9999-999999999999',
   '88888888-8888-8888-8888-888888888888', 'acct-u2', 'u2@example.com');
INSERT INTO google_tokens (connection_id, refresh_token) VALUES
  ('44444444-4444-4444-4444-444444444444', 'rt-h1-secret'),
  ('55555555-5555-5555-5555-555555555555', 'rt-h2-secret');
INSERT INTO google_calendar_subscriptions
  (id, connection_id, household_id, google_calendar_id, summary, is_selected, sync_token) VALUES
  ('66666666-6666-6666-6666-666666666666', '44444444-4444-4444-4444-444444444444',
   '11111111-1111-1111-1111-111111111111', 'cal-h1', 'H1のカレンダー', true, 'st-h1-secret'),
  ('77777777-7777-7777-7777-777777777777', '55555555-5555-5555-5555-555555555555',
   '99999999-9999-9999-9999-999999999999', 'cal-h2', 'H2のカレンダー', true, 'st-h2-secret');
-- H1 の google ミラー行（V9 の behavioral test 用に subscription_id を張る）
INSERT INTO calendar_events
  (id, household_id, title, is_all_day, start_date, end_date, source,
   google_event_id, google_calendar_id, subscription_id)
  VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
          'google予定', true, '2026-08-10', '2026-08-10', 'google',
          'gev1', 'cal-h1', '66666666-6666-6666-6666-666666666666');

-- ── B-0. seed が効いておること（superuser = RLS バイパス）──
-- ここが赤いなら以降の「他世帯が見えぬ」assert は行が無いだけの偽緑じゃ。
SELECT is((SELECT count(*) FROM google_connections), 2::bigint,
  'seed: google_connections に 2 行（自世帯 1 + 他世帯 1）');
SELECT is((SELECT count(*) FROM google_tokens), 2::bigint,
  'seed: google_tokens に 2 行（自世帯 1 + 他世帯 1）');
SELECT is((SELECT count(*) FROM google_calendar_subscriptions), 2::bigint,
  'seed: google_calendar_subscriptions に 2 行（自世帯 1 + 他世帯 1）');
SELECT is((SELECT count(*) FROM calendar_events
            WHERE subscription_id = '66666666-6666-6666-6666-666666666666'), 1::bigint,
  'seed: subscription_id を持つ google ミラー行が 1 件');

-- ── B-0e. 非正規化した household_id は接続と食い違えぬ（複合 FK・全ロール適用）──
-- 購読の household_id は RLS の要ゆえ、接続と食い違えば世帯分離が静かに破れる。
SELECT throws_ok(
  $$ INSERT INTO google_calendar_subscriptions (connection_id, household_id, google_calendar_id)
     VALUES ('44444444-4444-4444-4444-444444444444',
             '99999999-9999-9999-9999-999999999999', 'cal-mismatch') $$,
  '23503', NULL,
  '複合 FK: 購読の household_id は接続の household_id と食い違えぬ');

-- ── U1（H1 所属）の文脈で RLS を実際に通す ──
-- ここで harness の GRANT は撃たぬ（migration の GRANT がそのまま検証対象）。
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '22222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);

-- ══ SELECT の分離（可視件数 + 可視行の同一性）══════════════════
SELECT is((SELECT count(*) FROM google_connections), 1::bigint,
  'google_connections: 自世帯のみ可視（他世帯は不可視）');
SELECT is((SELECT google_email FROM google_connections), 'u1@example.com',
  'google_connections: 見えておる 1 件は自世帯の行');
SELECT is((SELECT count(*) FROM google_calendar_subscriptions), 1::bigint,
  'google_calendar_subscriptions: 自世帯のみ可視（他世帯は不可視）');
SELECT is((SELECT google_calendar_id FROM google_calendar_subscriptions), 'cal-h1',
  'google_calendar_subscriptions: 見えておる 1 件は自世帯の行');

-- ══ 機密の読み取り拒否 ═════════════════════════════════════════
SELECT throws_ok(
  $$ SELECT refresh_token FROM google_tokens $$,
  '42501', 'permission denied for table google_tokens',
  'google_tokens は authenticated から読めぬ（deny-all + GRANT 無し）');
SELECT throws_ok(
  $$ SELECT sync_token FROM google_calendar_subscriptions $$,
  '42501', 'permission denied for table google_calendar_subscriptions',
  'sync_token は authenticated から読めぬ（列 GRANT 外）');
SELECT throws_ok(
  $$ SELECT sync_lease_until FROM google_calendar_subscriptions $$,
  '42501', 'permission denied for table google_calendar_subscriptions',
  'sync_lease_until は authenticated から読めぬ（列 GRANT 外）');
-- 列 GRANT ゆえ `select("*")` は落ちる。D-4 は列を明示して SELECT すること。
SELECT throws_ok(
  $$ SELECT * FROM google_calendar_subscriptions $$,
  '42501', 'permission denied for table google_calendar_subscriptions',
  'select("*") は 42501 で落ちる（列を明示する契約）');

-- ══ 書込の分離 ═════════════════════════════════════════════════
-- (対照) 自世帯の is_selected は書ける。これが無いと「全部壊れておるだけ」と
-- 区別がつかぬ。
SELECT lives_ok(
  $$ UPDATE google_calendar_subscriptions SET is_selected = false
     WHERE id = '66666666-6666-6666-6666-666666666666' $$,
  '対照: 自世帯の is_selected は UPDATE できる');
SELECT is((SELECT is_selected FROM google_calendar_subscriptions), false,
  '対照: is_selected の UPDATE が実際に反映されておる');

SELECT throws_ok(
  $$ UPDATE google_calendar_subscriptions SET sync_token = 'stolen'
     WHERE id = '66666666-6666-6666-6666-666666666666' $$,
  '42501', 'permission denied for table google_calendar_subscriptions',
  'sync_token は authenticated から UPDATE できぬ');
SELECT throws_ok(
  $$ INSERT INTO google_connections (household_id, user_id, google_account_id, google_email)
     VALUES ('11111111-1111-1111-1111-111111111111',
             '22222222-2222-2222-2222-222222222222', 'acct-x', 'x@example.com') $$,
  '42501', 'permission denied for table google_connections',
  'google_connections への INSERT は拒否（ポリシーも GRANT も無い）');
SELECT throws_ok(
  $$ UPDATE google_connections SET connection_status = 'needs_reauth'
     WHERE id = '44444444-4444-4444-4444-444444444444' $$,
  '42501', 'permission denied for table google_connections',
  'google_connections への UPDATE は拒否（ポリシーも GRANT も無い）');
SELECT throws_ok(
  $$ INSERT INTO google_calendar_subscriptions
       (connection_id, household_id, google_calendar_id)
     VALUES ('44444444-4444-4444-4444-444444444444',
             '11111111-1111-1111-1111-111111111111', 'cal-x') $$,
  '42501', 'permission denied for table google_calendar_subscriptions',
  'google_calendar_subscriptions への INSERT は拒否（同期エンジン専用）');
SELECT throws_ok(
  $$ DELETE FROM google_calendar_subscriptions
     WHERE id = '66666666-6666-6666-6666-666666666666' $$,
  '42501', 'permission denied for table google_calendar_subscriptions',
  'google_calendar_subscriptions の DELETE は拒否（掃除は同期エンジン専用）');

-- 他世帯への攻撃。RLS が効いておれば USING 不一致で 0 行（例外は出ぬ）。
-- 残存確認は superuser へ戻ってから行う（authenticated では SELECT が隠すゆえ）。
UPDATE google_calendar_subscriptions SET is_selected = false
  WHERE household_id = '99999999-9999-9999-9999-999999999999';
DELETE FROM google_connections
  WHERE id = '55555555-5555-5555-5555-555555555555';

-- 本人の接続の切断は許される（DELETE ポリシー: user_id = auth.uid()）。
SELECT lives_ok(
  $$ DELETE FROM google_connections WHERE id = '44444444-4444-4444-4444-444444444444' $$,
  '対照: 本人は自分の google_connections を DELETE できる');

RESET ROLE;

-- ══ superuser へ戻って残存・波及を確認 ═════════════════════════
SELECT is((SELECT count(*) FROM google_connections
            WHERE id = '55555555-5555-5555-5555-555555555555'), 1::bigint,
  '他世帯の google_connections は DELETE されず残存');
SELECT is((SELECT count(*) FROM google_tokens
            WHERE connection_id = '55555555-5555-5555-5555-555555555555'), 1::bigint,
  '他世帯の google_tokens は巻き添えで消えておらぬ');
SELECT is((SELECT is_selected FROM google_calendar_subscriptions
            WHERE id = '77777777-7777-7777-7777-777777777777'), true,
  '他世帯の is_selected は UPDATE されず無改変');
SELECT is((SELECT sync_token FROM google_calendar_subscriptions
            WHERE id = '77777777-7777-7777-7777-777777777777'), 'st-h2-secret',
  '他世帯の sync_token は無改変');

-- 本人の切断は connection → tokens / subscriptions へ CASCADE する
-- （RI トリガはテーブル所有者権限で走るため deny-all の google_tokens にも届く）。
SELECT is((SELECT count(*) FROM google_tokens
            WHERE connection_id = '44444444-4444-4444-4444-444444444444'), 0::bigint,
  '切断で google_tokens が道連れに消える（孤児トークンを残さぬ）');
SELECT is((SELECT count(*) FROM google_calendar_subscriptions
            WHERE id = '66666666-6666-6666-6666-666666666666'), 0::bigint,
  '切断で google_calendar_subscriptions が道連れに消える');

-- ══ V9 の核心: 購読が消えても予定は消えぬ ══════════════════════
SELECT is((SELECT count(*) FROM calendar_events
            WHERE id = '33333333-3333-3333-3333-333333333333'), 1::bigint,
  'V9: 購読が消えても google ミラー行は残る（CASCADE なら 0 になり永久に復活せぬ）');
SELECT ok(
  (SELECT subscription_id IS NULL FROM calendar_events
    WHERE id = '33333333-3333-3333-3333-333333333333'),
  'V9: 残った行の subscription_id は NULL（SET NULL が効いた証跡）');

SELECT * FROM finish();
ROLLBACK;
