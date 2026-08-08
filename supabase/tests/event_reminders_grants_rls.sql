-- event_reminders / notification_preferences の **権限カタログ・世帯分離・導出規則** を
-- 機械で固定する（B-2）。
--
-- ## この表で守っておるもの
-- 1. **世帯単位**であること。夫が付けた通知は妻にも届く = 妻からも見える。
--    ユーザー単位へ縮退すると「片方にしか届かぬ」に静かに変わる。
-- 2. **remind_at はトリガの領分**であること。列 GRANT（一段目）が外れても
--    BEFORE トリガ（二段目）がクライアントの値を捨てる。
-- 3. **410 フル再同期を跨いで通知が生き残る**こと。これが本設計の核そのものじゃ
--    （`sync.ts` の `resetForFullResync` は google 行を DELETE してから入れ直す）。
--    しかも「行が残る」だけでは足りぬ — **入れ直した後の remind_at が正しい**ことまで見る。
--
-- ## information_schema を使わぬ理由（既存テストと同じ）
-- `information_schema.column_privileges` は「現在有効なロールが grantor か grantee
-- である行」しか返さぬ。走らせるロール次第で黙って 0 行になり偽緑になるため、
-- catalog（`pg_class.relacl` / `pg_attribute.attacl`）を `aclexplode` で直読みする。
--
-- ## 偽緑を潰す設計（三段・既存テストの型を踏襲）
-- (P) positive control: `aclexplode(NULL)` は 0 行ゆえ、ACL が空でも negative
--     assert は緑になる。まず relacl が NULL でないことを固定する。
-- (S) seed の固定: 「他世帯のが見えぬ」は行が 0 件なら常に緑ゆえ、先に
--     **2 世帯ぶんの行が入ったこと**を assert する。
-- (C) 対照: 「見えぬ／書けぬ」だけでなく「見える／書ける」を同じ文脈で assert する。
--
-- ## CHECK の層について（実測して分かったこと・正直に書く）
-- BEFORE トリガは CHECK 制約より**先**に走るため、`remind_kind='minutes'` かつ
-- 分が NULL の組は CHECK ではなく**トリガの例外**で落ちる。また未知の kind は
-- kind の CHECK と pairing の CHECK を**同時に**破るため、どちらが報告されるかは
-- 評価順に依存する。ゆえに:
--   * 実行時は「弾かれること」を（構成に依らぬ形で）assert し、
--   * 制約そのものは `pg_get_constraintdef` で**定義を**固定する
-- の二本立てにする。片方だけだと「制約が消えても別の層が落とすから緑」になる。
BEGIN;
SELECT plan(71);

-- ══════════════════════════════════════════════════════════════
-- A. 権限カタログ・スキーマ（静的・ロール切替なし）
-- ══════════════════════════════════════════════════════════════

-- ── A-0. positive control ─────────────────────────────────────
SELECT isnt(
  (SELECT relacl FROM pg_class WHERE oid = 'event_reminders'::regclass),
  NULL,
  'A-0a: event_reminders の relacl は NULL でない（以降の negative assert の前提）'
);
SELECT isnt(
  (SELECT relacl FROM pg_class WHERE oid = 'notification_preferences'::regclass),
  NULL,
  'A-0b: notification_preferences の relacl は NULL でない'
);

-- ── A-1. calendar_events.event_uid は STORED 生成列 ───────────
-- attgenerated: 's' = stored。'' なら普通の列に化けており、410 を跨ぐ不変性が消える。
SELECT is(
  (SELECT a.attgenerated FROM pg_attribute a
    WHERE a.attrelid = 'calendar_events'::regclass AND a.attname = 'event_uid'),
  's'::"char",
  'A-1: calendar_events.event_uid は STORED 生成列（手で書けぬ = ずれぬ）'
);
SELECT is(
  (SELECT a.attnotnull FROM pg_attribute a
    WHERE a.attrelid = 'calendar_events'::regclass AND a.attname = 'event_uid'),
  true,
  'A-2: event_uid は NOT NULL（google 行の両 id は CHECK が、native は PK が保証する）'
);

-- ── A-3. (household_id, event_uid) の一意性 ───────────────────
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'calendar_events'::regclass
      AND c.relname = 'uq_calendar_events_uid'
      AND i.indisunique
  ),
  'A-3: uq_calendar_events_uid が UNIQUE で在る（導出関数が「ちょうど 1 行」を引ける前提）'
);

-- ── A-4. event_reminders は calendar_events へ FK を張らぬ ────
-- **本設計の核**。FK を張った瞬間 410 のたびに通知が全滅（CASCADE）するか
-- 迷子になる（SET NULL）。「張っておらぬ」ことは画面にも型にも出ぬゆえ機械で固定する。
SELECT is_empty(
  $$
  SELECT conname::text FROM pg_constraint
  WHERE conrelid = 'event_reminders'::regclass
    AND contype = 'f'
    AND confrelid = 'calendar_events'::regclass
  $$,
  'A-4: event_reminders → calendar_events の FK は**無い**（410 の DELETE→INSERT を跨ぐため）'
);

-- ── A-5. authenticated のテーブルレベル権限 ───────────────────
-- INSERT / UPDATE は列 GRANT ゆえ attacl 側に出る。ここに出ておったら
-- 「全列に効く INSERT/UPDATE」が付いた証拠で、下の列 assert が無意味になる。
SELECT set_eq(
  $$
  SELECT acl.privilege_type::text
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(c.relacl) acl
  WHERE c.oid = 'event_reminders'::regclass
    AND acl.grantee = 'authenticated'::regrole
  $$,
  ARRAY['SELECT', 'DELETE'],
  'A-5: authenticated のテーブルレベル権限は SELECT / DELETE のみ（INSERT/UPDATE は列 GRANT）'
);

-- ── A-6. anon は一切の権限を持たぬ（両表・テーブル権限と列権限とも）──
SELECT is_empty(
  $$
  SELECT c.relname::text || ':' || acl.privilege_type
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) acl
  WHERE n.nspname = 'public'
    AND c.relname IN ('event_reminders', 'notification_preferences')
    AND acl.grantee = 'anon'::regrole
  UNION ALL
  SELECT c.relname::text || '.' || a.attname
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(a.attacl) acl
  WHERE n.nspname = 'public'
    AND c.relname IN ('event_reminders', 'notification_preferences')
    AND acl.grantee = 'anon'::regrole
  $$,
  'A-6: anon は event_reminders / notification_preferences に一切の権限を持たぬ'
);

-- ── A-7. ポリシーは SELECT/INSERT/UPDATE/DELETE の 4 種 ───────
-- polcmd: r=SELECT / a=INSERT / w=UPDATE / d=DELETE / *=ALL。
-- set_eq ゆえ「FOR ALL 禁止」も同時に固定される（'*' が出たら赤）。
SELECT set_eq(
  $$ SELECT polcmd::text FROM pg_policy WHERE polrelid = 'event_reminders'::regclass $$,
  ARRAY['r', 'a', 'w', 'd'],
  'A-7: event_reminders のポリシーは 4 種に分離されておる（FOR ALL 無し）'
);

-- ── A-8. **notification_preferences に UPDATE ポリシーが在る** ─
-- 設定カードから繰り返し編集する表ゆえ、UPDATE を塞ぐと初回 INSERT 後は
-- 二度と変えられぬ。しかも「保存した気になって変わらぬ」という最も気付きにくい
-- 壊れ方をする（0 行 UPDATE は error:null で返る）。
SELECT set_eq(
  $$ SELECT polcmd::text FROM pg_policy WHERE polrelid = 'notification_preferences'::regclass $$,
  ARRAY['r', 'a', 'w'],
  'A-8: notification_preferences は SELECT/INSERT/**UPDATE** の 3 種（DELETE は意図的に無し）'
);

-- ── A-9. authenticated が INSERT できる列は「ちょうど」4 列 ───
-- remind_at / created_by / created_at / updated_at が 1 つでも紛れ込めば赤くなる。
SELECT set_eq(
  $$
  SELECT a.attname::text
  FROM pg_attribute a
  CROSS JOIN LATERAL aclexplode(a.attacl) acl
  WHERE a.attrelid = 'event_reminders'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped
    AND acl.grantee = 'authenticated'::regrole
    AND acl.privilege_type = 'INSERT'
  $$,
  ARRAY['event_uid', 'household_id', 'remind_kind', 'remind_minutes_before'],
  'A-9: INSERT 可能な列は 4 つのみ（remind_at はトリガの領分・created_by は詐称防止）'
);

-- ── A-10. UPDATE 可能列は INSERT と**同一集合** ──────────────
-- PostgREST の upsert は `INSERT ... ON CONFLICT DO UPDATE SET <送った列>` を出すため、
-- UPDATE 側が狭いと**衝突時だけ** 42501 で落ちる（初回は通るゆえ気付きにくい）。
SELECT set_eq(
  $$
  SELECT a.attname::text
  FROM pg_attribute a
  CROSS JOIN LATERAL aclexplode(a.attacl) acl
  WHERE a.attrelid = 'event_reminders'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped
    AND acl.grantee = 'authenticated'::regrole
    AND acl.privilege_type = 'UPDATE'
  $$,
  ARRAY['event_uid', 'household_id', 'remind_kind', 'remind_minutes_before'],
  'A-10: UPDATE 可能列は INSERT と同一（狭いと upsert の衝突時だけ 42501 で落ちる）'
);

-- ── A-11. トリガ関数と導出関数は SECURITY DEFINER + search_path ──
SELECT is(
  (SELECT prosecdef FROM pg_proc WHERE proname = 'derive_event_remind_at'),
  true,
  'A-11a: derive_event_remind_at は SECURITY DEFINER（RLS を跨いで calendar_events を引く）'
);
SELECT ok(
  (SELECT proconfig FROM pg_proc WHERE proname = 'derive_event_remind_at')
    @> ARRAY['search_path=public'],
  'A-11b: derive_event_remind_at に SET search_path=public が付いておる'
);
SELECT is(
  (SELECT prosecdef FROM pg_proc WHERE proname = 'event_reminders_before_write'),
  true,
  'A-11c: event_reminders_before_write は SECURITY DEFINER'
);
SELECT ok(
  (SELECT proconfig FROM pg_proc WHERE proname = 'event_reminders_before_write')
    @> ARRAY['search_path=public'],
  'A-11d: event_reminders_before_write に SET search_path=public が付いておる'
);
-- calendar_events 側の AFTER トリガが invoker 権限だと、authenticated は remind_at への
-- UPDATE 権限を持たぬゆえ **native 予定の更新が 42501 で落ちる**（しかも Server Action の
-- 単体テストは全て mock ゆえ緑のまま、実アプリでしか出ぬ）。
SELECT is(
  (SELECT prosecdef FROM pg_proc WHERE proname = 'calendar_events_sync_remind_at'),
  true,
  'A-11e: calendar_events_sync_remind_at は SECURITY DEFINER（無いと予定の更新が 42501 で落ちる）'
);
SELECT ok(
  (SELECT proconfig FROM pg_proc WHERE proname = 'calendar_events_sync_remind_at')
    @> ARRAY['search_path=public'],
  'A-11f: calendar_events_sync_remind_at に SET search_path=public が付いておる'
);

-- ── A-12. 導出関数はクライアントへ開かぬ ─────────────────────
SELECT is_empty(
  $$
  SELECT acl.privilege_type::text
  FROM pg_proc p
  CROSS JOIN LATERAL aclexplode(p.proacl) acl
  WHERE p.proname = 'derive_event_remind_at'
    AND acl.grantee IN ('anon'::regrole, 'authenticated'::regrole)
  $$,
  'A-12: derive_event_remind_at は anon / authenticated に EXECUTE を与えておらぬ'
);

-- ── A-13. トリガが 3 本とも生きておる ────────────────────────
SELECT set_eq(
  $$
  SELECT tgname::text FROM pg_trigger
  WHERE tgrelid = 'calendar_events'::regclass AND NOT tgisinternal
  $$,
  ARRAY['trg_calendar_events_updated_at',
        'trg_calendar_events_sync_remind_at_ins',
        'trg_calendar_events_sync_remind_at_upd'],
  'A-13a: calendar_events のトリガは既存 1 本 + 通知追随 2 本'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'event_reminders'::regclass
      AND tgname = 'trg_event_reminders_before_write'
      AND NOT tgisinternal
  ),
  'A-13b: event_reminders の BEFORE トリガが在る'
);

-- ── A-14. CHECK 制約の**定義**を固定する ─────────────────────
-- 実行時はトリガが先に落とす組があるため、制約そのものは定義で固定しておく
-- （消しても別の層が落として緑、を防ぐ）。
SELECT is(
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid = 'event_reminders'::regclass
      AND conname = 'chk_event_reminders_minutes_pairing'),
  'CHECK (((remind_kind = ''minutes''::text) = (remind_minutes_before IS NOT NULL)))',
  'A-14a: pairing CHECK は双方向（minutes なら分が要り、minutes でなければ持たぬ）'
);
SELECT ok(
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid = 'event_reminders'::regclass
      AND conname = 'chk_event_reminders_kind') LIKE '%prev_day_20%',
  'A-14b: kind CHECK が 2 値を列挙しておる'
);
SELECT ok(
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid = 'event_reminders'::regclass
      AND conname = 'chk_event_reminders_minutes_range') LIKE '%40320%',
  'A-14c: range CHECK の上限は 40320（28 日。SMALLINT では表現できぬゆえ INTEGER）'
);
-- 上限が型で表現できておること。SMALLINT(最大 32767)だと上の CHECK が到達不能になり、
-- 越えた値は CHECK 違反ではなく 22003 numeric_value_out_of_range で落ちる。
SELECT is(
  (SELECT format_type(atttypid, atttypmod) FROM pg_attribute
    WHERE attrelid = 'event_reminders'::regclass AND attname = 'remind_minutes_before'),
  'integer',
  'A-14d: remind_minutes_before は integer（smallint だと上限 40320 に届かぬ）'
);

-- ── A-15. Realtime publication へ載せておらぬ ────────────────
SELECT is_empty(
  $$
  SELECT tablename FROM pg_publication_tables
  WHERE pubname = 'supabase_realtime'
    AND tablename IN ('event_reminders', 'notification_preferences')
  $$,
  'A-15: supabase_realtime publication に 2 表とも載っておらぬ'
);

-- ── A-16. digest_time の TZ 契約が COMMENT に在る ────────────
-- TIME は TZ を持たぬ。契約を書き残さねば TZ=UTC の Vercel と DB で 9 時間ずれる。
SELECT ok(
  (SELECT col_description('notification_preferences'::regclass, a.attnum)
     FROM pg_attribute a
    WHERE a.attrelid = 'notification_preferences'::regclass
      AND a.attname = 'digest_time') LIKE '%Asia/Tokyo%',
  'A-16: digest_time の COMMENT に JST(Asia/Tokyo) 解釈の契約が書かれておる'
);

-- ══════════════════════════════════════════════════════════════
-- B. seed（**2 世帯**。1 世帯だと分離の縮退を永久に見逃す）
-- ══════════════════════════════════════════════════════════════
INSERT INTO households (id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'H1'),
  ('33333333-3333-3333-3333-333333333333', 'H2');
INSERT INTO auth.users (id, email) VALUES
  ('22222222-2222-2222-2222-222222222222', 'u1@example.com'),
  ('88888888-8888-8888-8888-888888888888', 'u2@example.com'),
  ('44444444-4444-4444-4444-444444444444', 'u3@example.com');
UPDATE profiles SET household_id = '11111111-1111-1111-1111-111111111111',
                    display_name = 'U1', role = 'owner', is_approved = true
  WHERE id = '22222222-2222-2222-2222-222222222222';
-- U2 は**同世帯の配偶者**。通知が世帯単位であることの対照に使う。
UPDATE profiles SET household_id = '11111111-1111-1111-1111-111111111111',
                    display_name = 'U2', role = 'member', is_approved = true
  WHERE id = '88888888-8888-8888-8888-888888888888';
-- U3 は**別世帯**。分離の対照に使う。
UPDATE profiles SET household_id = '33333333-3333-3333-3333-333333333333',
                    display_name = 'U3', role = 'owner', is_approved = true
  WHERE id = '44444444-4444-4444-4444-444444444444';

-- 予定: H1 に 終日 / 時刻付き / google、H2 に 終日 1 件。
INSERT INTO calendar_events
  (id, household_id, title, is_all_day, start_date, end_date, start_at, source,
   google_calendar_id, google_event_id)
VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   '終日', true, '2026-08-15', '2026-08-15', NULL, 'native', NULL, NULL),
  -- 2026-08-15T00:00:00Z = 09:00 JST
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   '時刻付き', false, '2026-08-15', '2026-08-15', '2026-08-15T00:00:00Z', 'native', NULL, NULL),
  ('aaaaaaaa-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
   'Google', false, '2026-08-20', '2026-08-20', '2026-08-20T01:00:00Z', 'google',
   'cal@g.com', 'ev1'),
  -- 通知を持たず、以降 **一度も動かさぬ** 予定。境界値と「書ける」対照の的にする
  -- （動かす予定を的にすると、期待値が上の追随テストと連動して読めなくなる）。
  ('aaaaaaaa-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111',
   '不動の時刻付き', false, '2026-08-15', '2026-08-15', '2026-08-15T00:00:00Z',
   'native', NULL, NULL),
  ('bbbbbbbb-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333',
   '他世帯', true, '2026-08-15', '2026-08-15', NULL, 'native', NULL, NULL);

-- 通知: H1 に 3 件（うち 1 件は配偶者 U2 が設定・1 件は google 行）、H2 に 1 件。
INSERT INTO event_reminders
  (event_uid, household_id, remind_kind, remind_minutes_before, remind_at, created_by)
VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'minutes', 30, '1999-01-01T00:00:00Z', '22222222-2222-2222-2222-222222222222'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   'minutes', 10, '1999-01-01T00:00:00Z', '88888888-8888-8888-8888-888888888888'),
  ('cal@g.com|ev1', '11111111-1111-1111-1111-111111111111',
   'prev_day_20', NULL, '1999-01-01T00:00:00Z', '22222222-2222-2222-2222-222222222222'),
  ('bbbbbbbb-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333',
   'minutes', 60, '1999-01-01T00:00:00Z', '44444444-4444-4444-4444-444444444444');

SELECT is((SELECT count(*) FROM event_reminders), 4::bigint,
  'B-0: seed が 4 件（2 世帯ぶん。1 世帯 seed だと分離の縮退を見逃す）');

-- ══════════════════════════════════════════════════════════════
-- C. 導出（vitest `event-reminder.test.ts` と**同じ 3 例・同じ JST**）
-- ══════════════════════════════════════════════════════════════
-- seed で渡した remind_at は全て 1999-01-01 の出鱈目じゃ。**それが残っておらぬこと**が
-- 「トリガがクライアントの値を上書きした」証拠になる（列 GRANT が外れた世界の防御）。
SELECT is(
  (SELECT remind_at FROM event_reminders
    WHERE event_uid = 'aaaaaaaa-0000-0000-0000-000000000001'),
  '2026-08-14 23:30:00+09'::timestamptz,
  'C-1: 終日 8/15 の 30 分前 = 8/14 23:30 JST（かつ seed の 1999 年が上書きされておる）'
);
SELECT is(
  (SELECT remind_at FROM event_reminders
    WHERE event_uid = 'aaaaaaaa-0000-0000-0000-000000000002'),
  '2026-08-15 08:50:00+09'::timestamptz,
  'C-2: 09:00 JST 8/15 の 10 分前 = 08:50 JST'
);
SELECT is(
  (SELECT remind_at FROM event_reminders WHERE event_uid = 'cal@g.com|ev1'),
  '2026-08-19 20:00:00+09'::timestamptz,
  'C-3: prev_day_20 は start_date(8/20) の前日 20:00 JST'
);

-- ── C-4. 予定が動けば remind_at も動く（核 ⑤）─────────────────
-- Google 同期は開始時刻の変更を日常的に upsert する。追随せねば「10 分前」の通知が
-- **元の時刻のまま**残る（設定は生きておるのに間違った時刻に鳴る）。
UPDATE calendar_events SET start_at = '2026-08-15T05:00:00Z' -- 14:00 JST
  WHERE id = 'aaaaaaaa-0000-0000-0000-000000000002';
SELECT is(
  (SELECT remind_at FROM event_reminders
    WHERE event_uid = 'aaaaaaaa-0000-0000-0000-000000000002'),
  '2026-08-15 13:50:00+09'::timestamptz,
  'C-4: 予定を 09:00→14:00 JST へ動かすと remind_at も 13:50 へ追随する'
);

-- ── C-5. 終日 ↔ 時刻付きの切替にも追随する ──────────────────
UPDATE calendar_events SET is_all_day = true, start_at = NULL, end_at = NULL
  WHERE id = 'aaaaaaaa-0000-0000-0000-000000000002';
SELECT is(
  (SELECT remind_at FROM event_reminders
    WHERE event_uid = 'aaaaaaaa-0000-0000-0000-000000000002'),
  '2026-08-14 23:50:00+09'::timestamptz,
  'C-5: 終日へ変えると起点が 00:00 JST になり 8/14 23:50 へ移る'
);

-- ══════════════════════════════════════════════════════════════
-- D. **410 フル再同期を跨いで通知が生き残る**（本設計の核）
-- ══════════════════════════════════════════════════════════════
-- `sync.ts` の resetForFullResync は購読の google 行を丸ごと DELETE してから
-- 入れ直す。event_id を FK にしておったら、ここで CASCADE 全滅か SET NULL 迷子になる。
DELETE FROM calendar_events WHERE id = 'aaaaaaaa-0000-0000-0000-000000000003';
SELECT is(
  (SELECT count(*) FROM event_reminders WHERE event_uid = 'cal@g.com|ev1'),
  1::bigint,
  'D-1: google 行を DELETE しても通知設定は生き残る（FK を張っておらぬゆえ）'
);

-- 入れ直し（**新しい UUID** が振られる = 行 id で結んでおったら二度と紐づかぬ）。
-- 日付も 8/20 → 8/22 へ変わったものとする。
INSERT INTO calendar_events
  (household_id, title, is_all_day, start_date, end_date, start_at, source,
   google_calendar_id, google_event_id)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'Google', false,
   '2026-08-22', '2026-08-22', '2026-08-22T01:00:00Z', 'google', 'cal@g.com', 'ev1');

SELECT isnt(
  (SELECT id FROM calendar_events WHERE event_uid = 'cal@g.com|ev1'),
  'aaaaaaaa-0000-0000-0000-000000000003'::uuid,
  'D-2: 入れ直した行は**別の UUID**（= 行 id で結ぶ設計なら必ず切れる場面）'
);
SELECT is(
  (SELECT count(*) FROM event_reminders WHERE event_uid = 'cal@g.com|ev1'),
  1::bigint,
  'D-3: 入れ直しても通知は 1 件のまま（重複もせぬ）'
);
-- **行が残るだけでは足りぬ。** 時刻まで正しいことを見る。
SELECT is(
  (SELECT remind_at FROM event_reminders WHERE event_uid = 'cal@g.com|ev1'),
  '2026-08-21 20:00:00+09'::timestamptz,
  'D-4: 入れ直し後の remind_at は**新しい日付**の前日 20 時（8/22 → 8/21 20:00 JST）'
);

-- ══════════════════════════════════════════════════════════════
-- E. 制約（実行時に弾かれること）
-- ══════════════════════════════════════════════════════════════
-- throws_ok は errmsg を完全一致で比べるため、CHECK 違反は throws_like を使う。
SELECT throws_like(
  $$ INSERT INTO event_reminders (event_uid, household_id, remind_kind, remind_minutes_before)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
             '11111111-1111-1111-1111-111111111111', 'bogus', 10) $$,
  '%chk_event_reminders_%',
  'E-1: 未知の remind_kind は CHECK で弾かれる（kind と pairing の両方を破るため片方を名指しせぬ）'
);
SELECT throws_like(
  $$ INSERT INTO event_reminders (event_uid, household_id, remind_kind, remind_minutes_before)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
             '11111111-1111-1111-1111-111111111111', 'prev_day_20', 10) $$,
  '%chk_event_reminders_minutes_pairing%',
  'E-2: prev_day_20 が分を持つのは pairing CHECK 違反'
);
-- BEFORE トリガは CHECK より先に走るため、この向きはトリガが落とす（実測）。
SELECT throws_like(
  $$ INSERT INTO event_reminders (event_uid, household_id, remind_kind, remind_minutes_before)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
             '11111111-1111-1111-1111-111111111111', 'minutes', NULL) $$,
  '%remind_minutes_before is required%',
  'E-3: minutes なのに分が無い組はトリガが落とす（CHECK より BEFORE トリガが先に走る）'
);
SELECT throws_like(
  $$ INSERT INTO event_reminders (event_uid, household_id, remind_kind, remind_minutes_before)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
             '11111111-1111-1111-1111-111111111111', 'minutes', 40321) $$,
  '%chk_event_reminders_minutes_range%',
  'E-4: 上限 40320 を越える分は range CHECK 違反（22003 ではない = 型が integer である証拠）'
);
SELECT throws_like(
  $$ INSERT INTO event_reminders (event_uid, household_id, remind_kind, remind_minutes_before)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
             '11111111-1111-1111-1111-111111111111', 'minutes', -1) $$,
  '%chk_event_reminders_minutes_range%',
  'E-5: 負の分は range CHECK 違反'
);
-- 孤児の新規作成は導出関数が拒む。
SELECT throws_like(
  $$ INSERT INTO event_reminders (event_uid, household_id, remind_kind, remind_minutes_before)
     VALUES ('no-such-uid', '11111111-1111-1111-1111-111111111111', 'minutes', 10) $$,
  '%calendar event not found%',
  'E-6: 対応する予定が無い通知は作れぬ（孤児の**新規作成**は禁ずる）'
);
-- 世帯を跨いだ宛先も作れぬ（他世帯の event_uid を自世帯の household_id で指す）。
SELECT throws_like(
  $$ INSERT INTO event_reminders (event_uid, household_id, remind_kind, remind_minutes_before)
     VALUES ('bbbbbbbb-0000-0000-0000-000000000001',
             '11111111-1111-1111-1111-111111111111', 'minutes', 10) $$,
  '%calendar event not found%',
  'E-7: 他世帯の予定を自世帯の通知の宛先にできぬ（導出は household_id でスコープする）'
);
-- 境界は**通る側も**置く（範囲がずれても片側だけでは気付かぬ）。
SELECT lives_ok(
  $$ INSERT INTO event_reminders (event_uid, household_id, remind_kind, remind_minutes_before)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000004',
             '11111111-1111-1111-1111-111111111111', 'minutes', 0) $$,
  'E-8a: 境界の下端 0 分は通る（対照）'
);
DELETE FROM event_reminders WHERE event_uid = 'aaaaaaaa-0000-0000-0000-000000000004';
SELECT lives_ok(
  $$ INSERT INTO event_reminders (event_uid, household_id, remind_kind, remind_minutes_before)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000004',
             '11111111-1111-1111-1111-111111111111', 'minutes', 40320) $$,
  'E-8b: 境界の上端 40320 分（28 日）は通る（対照。smallint なら 22003 で落ちる）'
);
DELETE FROM event_reminders WHERE event_uid = 'aaaaaaaa-0000-0000-0000-000000000004';

-- 1 予定 1 通知（UNIQUE）。
SELECT throws_like(
  $$ INSERT INTO event_reminders (event_uid, household_id, remind_kind, remind_minutes_before)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
             '11111111-1111-1111-1111-111111111111', 'minutes', 10) $$,
  '%uq_event_reminders_event%',
  'E-9: 同じ予定に 2 件目の通知は作れぬ（1 予定 1 設定）'
);

-- ══════════════════════════════════════════════════════════════
-- F. 実挙動（authenticated + JWT claims）
-- ══════════════════════════════════════════════════════════════
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '22222222-2222-2222-2222-222222222222',
                    'role', 'authenticated')::text, true);

-- ══ 世帯分離（対照つき）══════════════════════════════════════
SELECT is((SELECT count(*) FROM event_reminders), 3::bigint,
  'F-1: 自世帯の通知 3 件のみ可視（他世帯の 1 件は見えぬ）');
SELECT is(
  (SELECT count(*) FROM event_reminders
    WHERE event_uid = 'bbbbbbbb-0000-0000-0000-000000000001'),
  0::bigint,
  'F-2: 他世帯の通知は 1 件も見えぬ（対照: 上で 3 件は見えておる）'
);
-- **世帯単位であることの対照**。ユーザー単位へ縮退すると、配偶者が設定した通知が
-- 見えなくなる（= 片方にしか届かぬ状態へ静かに変わる）。
SELECT is(
  (SELECT count(*) FROM event_reminders
    WHERE created_by = '88888888-8888-8888-8888-888888888888'),
  1::bigint,
  'F-3: **配偶者が設定した通知も見える**（世帯単位ゆえ。ユーザー単位への縮退を検知する）'
);

-- ══ remind_at はクライアントから書けぬ（列 GRANT・一段目）══
SELECT throws_ok(
  $$ INSERT INTO event_reminders (event_uid, household_id, remind_kind, remind_minutes_before, remind_at)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000004',
             '11111111-1111-1111-1111-111111111111', 'minutes', 10, now()) $$,
  '42501', 'permission denied for table event_reminders',
  'F-4: remind_at を指定した INSERT は列 GRANT で弾かれる（PostgREST 直叩きの脅威）');
SELECT throws_ok(
  $$ UPDATE event_reminders SET remind_at = now() $$,
  '42501', 'permission denied for table event_reminders',
  'F-5: remind_at の UPDATE も列 GRANT で弾かれる');
SELECT throws_ok(
  $$ INSERT INTO event_reminders (event_uid, household_id, remind_kind, remind_minutes_before, created_by)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000004',
             '11111111-1111-1111-1111-111111111111', 'minutes', 10,
             '44444444-4444-4444-4444-444444444444') $$,
  '42501', 'permission denied for table event_reminders',
  'F-6: created_by は詐称できぬ（列 GRANT 外。トリガが auth.uid() で埋める）');

-- ══ 対照: 許された列だけなら書ける ═════════════════════════
SELECT lives_ok(
  $$ INSERT INTO event_reminders (event_uid, household_id, remind_kind, remind_minutes_before)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000004',
             '11111111-1111-1111-1111-111111111111', 'minutes', 10) $$,
  'F-7: 許された 4 列だけの INSERT は通る（対照: 単に全部書けぬのとは違う）');
-- トリガが remind_at と created_by を埋めておること。
SELECT is(
  (SELECT created_by FROM event_reminders
    WHERE event_uid = 'aaaaaaaa-0000-0000-0000-000000000004'),
  '22222222-2222-2222-2222-222222222222'::uuid,
  'F-8: created_by はトリガが auth.uid() で埋める（クライアントは送っておらぬ）'
);
SELECT is(
  (SELECT remind_at FROM event_reminders
    WHERE event_uid = 'aaaaaaaa-0000-0000-0000-000000000004'),
  '2026-08-15 08:50:00+09'::timestamptz,
  'F-9: remind_at もトリガが導出する（09:00 JST の 10 分前。クライアントは送っておらぬ）'
);

-- ══ 他世帯へは書けぬ ═══════════════════════════════════════
SELECT throws_like(
  $$ INSERT INTO event_reminders (event_uid, household_id, remind_kind, remind_minutes_before)
     VALUES ('bbbbbbbb-0000-0000-0000-000000000001',
             '33333333-3333-3333-3333-333333333333', 'minutes', 10) $$,
  '%row-level security%',
  'F-10: 他世帯の household_id では INSERT できぬ（RLS の WITH CHECK）'
);

-- ══ 削除（対照つき）═══════════════════════════════════════
DELETE FROM event_reminders WHERE event_uid = 'bbbbbbbb-0000-0000-0000-000000000001';
SELECT is(
  (SELECT count(*) FROM event_reminders), 4::bigint,
  'F-11: 他世帯の通知は DELETE しても 0 行（自世帯の 4 件は無傷）'
);
DELETE FROM event_reminders WHERE event_uid = 'aaaaaaaa-0000-0000-0000-000000000004';
SELECT is(
  (SELECT count(*) FROM event_reminders), 3::bigint,
  'F-12: 自世帯の通知は消せる（対照: DELETE は通る = 「なし」へ戻す経路）'
);

-- ══ 更新（upsert の DO UPDATE 経路）═══════════════════════
UPDATE event_reminders SET remind_kind = 'prev_day_20', remind_minutes_before = NULL
  WHERE event_uid = 'aaaaaaaa-0000-0000-0000-000000000001';
SELECT is(
  (SELECT remind_at FROM event_reminders
    WHERE event_uid = 'aaaaaaaa-0000-0000-0000-000000000001'),
  '2026-08-14 20:00:00+09'::timestamptz,
  'F-13: 種別を変えると remind_at も引き直される（8/15 の前日 20 時）'
);
SELECT is(
  (SELECT created_by FROM event_reminders
    WHERE event_uid = 'aaaaaaaa-0000-0000-0000-000000000001'),
  '22222222-2222-2222-2222-222222222222'::uuid,
  'F-14: UPDATE で created_by はすり替わらぬ（最後の編集者に化けさせぬ）'
);

-- ══ **authenticated の役で** 予定を動かして remind_at が追随するか ══
-- C-4/C-5 は postgres で走っており、そこでは SECURITY DEFINER の有無が効かぬ。
-- 本番の呼び出し元（`updateCalendarEvent`）は authenticated で、その単体テストは
-- 全て mock ゆえ**構造的にこの経路へ到達できぬ**。ここが唯一の実役検証じゃ。
-- AFTER トリガが invoker 権限に戻ると、authenticated は remind_at への UPDATE 権限を
-- 持たぬため、この UPDATE 自体が 42501 で落ちる（= 通知付き予定が編集不能になる）。
UPDATE calendar_events SET is_all_day = false, start_at = '2026-08-15T06:00:00Z'
  WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001';
SELECT is(
  (SELECT remind_at FROM event_reminders
    WHERE event_uid = 'aaaaaaaa-0000-0000-0000-000000000001'),
  '2026-08-14 20:00:00+09'::timestamptz,
  'F-15: authenticated が予定を動かしても落ちず、prev_day_20 は start_date 基準ゆえ不変'
);
-- start_at も一緒に畳む。start_date だけ動かすと start_at が取り残され、
-- minutes の起点が旧 start_at のままになる（start_date ↔ start_at の整合は
-- 書き込み側の責務で DB は縛っておらぬ = 20260709000002 の設計どおり）。
UPDATE calendar_events
   SET start_date = '2026-08-18', end_date = '2026-08-18',
       is_all_day = true, start_at = NULL, end_at = NULL
  WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001';
SELECT is(
  (SELECT remind_at FROM event_reminders
    WHERE event_uid = 'aaaaaaaa-0000-0000-0000-000000000001'),
  '2026-08-17 20:00:00+09'::timestamptz,
  'F-16: **authenticated の役で** 日付を動かすと remind_at も追随する（AFTER トリガの実役検証）'
);

-- ══ PostgREST の upsert が撃つ文（ON CONFLICT DO UPDATE）══
-- A-10 は列集合を静的に固定するのみ。実際に衝突する文を authenticated で撃たねば、
-- 「初回は通るが 2 回目だけ 42501」という経路は誰も踏まぬ。
SELECT lives_ok(
  $$ INSERT INTO event_reminders (event_uid, household_id, remind_kind, remind_minutes_before)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
             '11111111-1111-1111-1111-111111111111', 'minutes', 30)
     ON CONFLICT (household_id, event_uid) DO UPDATE
        SET event_uid = EXCLUDED.event_uid,
            household_id = EXCLUDED.household_id,
            remind_kind = EXCLUDED.remind_kind,
            remind_minutes_before = EXCLUDED.remind_minutes_before $$,
  -- **SET には送った列を全て並べる。** PostgREST の `.upsert()` はそう出すゆえ、
  -- ここで remind_kind / remind_minutes_before だけを更新する形に手加減すると、
  -- event_uid / household_id の UPDATE 権限を剥がしても緑のまま通ってしまう
  -- （実測: M16 の変異が A-10 でしか捕まらなかった）。
  'F-17: 既存行への upsert（PostgREST と同じく送った 4 列を SET）が authenticated で通る'
);
SELECT is(
  (SELECT remind_at FROM event_reminders
    WHERE event_uid = 'aaaaaaaa-0000-0000-0000-000000000001'),
  '2026-08-17 23:30:00+09'::timestamptz,
  'F-18: upsert の DO UPDATE 経路でも remind_at は引き直される（8/18 00:00 JST の 30 分前）'
);

-- ══ notification_preferences（個人設定）═══════════════════
SELECT lives_ok(
  $$ INSERT INTO notification_preferences (user_id, event_default_minutes, digest_time)
     VALUES ('22222222-2222-2222-2222-222222222222', 30, '07:30') $$,
  'F-19: 自分の通知設定を作れる');
-- **UPDATE を塞ぐと初回 INSERT 後に二度と変えられぬ。** ここが本表の要じゃ。
UPDATE notification_preferences SET event_default_minutes = 60
  WHERE user_id = '22222222-2222-2222-2222-222222222222';
SELECT is(
  (SELECT event_default_minutes FROM notification_preferences
    WHERE user_id = '22222222-2222-2222-2222-222222222222'),
  60,
  'F-20: **自分の設定を更新できる**（UPDATE ポリシーが無いと 0 行で静かに失敗する）'
);
SELECT throws_like(
  $$ INSERT INTO notification_preferences (user_id, event_default_minutes)
     VALUES ('88888888-8888-8888-8888-888888888888', 10) $$,
  '%row-level security%',
  'F-21: 配偶者の設定は作れぬ（**個人設定**ゆえ世帯では開かぬ）'
);
SELECT is(
  (SELECT count(*) FROM notification_preferences), 1::bigint,
  'F-22: 見えるのは自分の 1 件のみ'
);

-- ══ 未認証（anon）は何も触れぬ ═══════════════════════════
SET LOCAL role anon;
SELECT set_config('request.jwt.claims', NULL, true);
SELECT throws_ok(
  $$ SELECT count(*) FROM event_reminders $$,
  '42501', 'permission denied for table event_reminders',
  'F-23: anon は event_reminders を読めぬ');
SELECT throws_ok(
  $$ SELECT count(*) FROM notification_preferences $$,
  '42501', 'permission denied for table notification_preferences',
  'F-24: anon は notification_preferences を読めぬ');

SELECT * FROM finish();
ROLLBACK;
