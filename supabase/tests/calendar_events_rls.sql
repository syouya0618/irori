-- calendar_events の RLS + CHECK + 世帯分離を pgTAP で検証する。
-- 実行: supabase test db supabase/tests/calendar_events_rls.sql
--
-- service_role(superuser)は RLS をバイパスするため native/google の区別を
-- 検出できない。authenticated + request.jwt.claims を注入して RLS を実際に通す。
-- CHECK 制約(google 列の NOT NULL 等)は全ロールに適用されるため superuser で検証する。
BEGIN;
SELECT plan(9);

-- ── seed(superuser = RLS バイパス) ─────────────────────────────
-- H1 = テスト対象ユーザーの世帯 / H2 = 別世帯(分離検証用)
INSERT INTO households (id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'H1'),
  ('99999999-9999-9999-9999-999999999999', 'H2');
INSERT INTO auth.users (id, email) VALUES
  ('22222222-2222-2222-2222-222222222222', 'u1@example.com');
UPDATE profiles SET household_id = '11111111-1111-1111-1111-111111111111',
                    display_name = 'U1', is_approved = true
  WHERE id = '22222222-2222-2222-2222-222222222222';
-- H1 の既存 google 行(同期エンジンが service_role で入れる想定を superuser で代用)
INSERT INTO calendar_events (id, household_id, title, is_all_day, start_date, end_date, source, google_event_id, google_calendar_id)
  VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
          'google予定', true, '2026-07-10', '2026-07-10', 'google', 'gev1', 'gcal1');
-- H2(別世帯)の native 行 — U1 からは見えてはならない
INSERT INTO calendar_events (household_id, title, is_all_day, start_date, end_date, source)
  VALUES ('99999999-9999-9999-9999-999999999999', '他世帯の予定', true, '2026-07-10', '2026-07-10', 'native');

-- Supabase プラットフォームは全 public テーブルの DML を authenticated へ実行時 GRANT する
-- (meals 等の既存テーブルも同様で、migration には含まれない)。harness で再現する。
GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_events TO authenticated;

-- ── CHECK 制約(全ロール適用・superuser で検証) ────────────────
-- (1) V6: google 行は google_calendar_id も NOT NULL でなければならない(重複増殖の穴)
SELECT throws_ok(
  $$ INSERT INTO calendar_events (household_id, title, is_all_day, start_date, end_date, source, google_event_id)
     VALUES ('11111111-1111-1111-1111-111111111111', 'no cal id', true, '2026-07-10', '2026-07-10', 'google', 'gev2') $$,
  '23514', NULL, 'CHECK: google 行で google_calendar_id NULL は拒否'
);
-- (2) native 行は google 列を持てない(通常 UNIQUE を partial と同義にする不変条件)
SELECT throws_ok(
  $$ INSERT INTO calendar_events (household_id, title, is_all_day, start_date, end_date, source, google_event_id, google_calendar_id)
     VALUES ('11111111-1111-1111-1111-111111111111', 'native w/ google', true, '2026-07-10', '2026-07-10', 'native', 'x', 'y') $$,
  '23514', NULL, 'CHECK: native 行は google 列を持てない'
);

-- ── RLS(authenticated + JWT claims) ───────────────────────────
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '22222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);

-- (3) native CRUD は成功する
SELECT lives_ok(
  $$ INSERT INTO calendar_events (household_id, title, is_all_day, start_date, end_date, source)
     VALUES ('11111111-1111-1111-1111-111111111111', 'native ok', true, '2026-07-10', '2026-07-10', 'native') $$,
  'RLS: native INSERT は許可'
);
-- (4) google 行の INSERT は WITH CHECK(source='native')違反で拒否
SELECT throws_ok(
  $$ INSERT INTO calendar_events (household_id, title, is_all_day, start_date, end_date, source, google_event_id, google_calendar_id)
     VALUES ('11111111-1111-1111-1111-111111111111', 'blocked', true, '2026-07-10', '2026-07-10', 'google', 'gev3', 'gcal3') $$,
  '42501', NULL, 'RLS: google INSERT は拒否'
);
-- (5) native 行を source='google' へ改変しようとしても WITH CHECK 流用で拒否
SELECT throws_ok(
  $$ UPDATE calendar_events SET source = 'google', google_event_id = 'z', google_calendar_id = 'z'
     WHERE title = 'native ok' $$,
  '42501', NULL, 'RLS: native→google の source 改変は拒否'
);
-- (6) 別世帯へ移動しようとしても WITH CHECK 流用で拒否
SELECT throws_ok(
  $$ UPDATE calendar_events SET household_id = '99999999-9999-9999-9999-999999999999'
     WHERE title = 'native ok' $$,
  '42501', NULL, 'RLS: 別世帯への移動は拒否'
);
-- (7) 既存 google 行の UPDATE は USING(source='native')不一致で 0 行 → 原題のまま
UPDATE calendar_events SET title = 'hacked' WHERE id = '33333333-3333-3333-3333-333333333333';
SELECT is(
  (SELECT title FROM calendar_events WHERE id = '33333333-3333-3333-3333-333333333333'),
  'google予定', 'RLS: google 行は authenticated から UPDATE されない(0 行)'
);
-- (8) 既存 google 行の DELETE も 0 行 → 残存
DELETE FROM calendar_events WHERE id = '33333333-3333-3333-3333-333333333333';
SELECT ok(
  EXISTS (SELECT 1 FROM calendar_events WHERE id = '33333333-3333-3333-3333-333333333333'),
  'RLS: google 行は authenticated から DELETE されない(0 行)'
);
-- (9) SELECT は H1 の native + google 両方が見え、H2(別世帯)は見えない = 2 行
SELECT is(
  (SELECT count(*) FROM calendar_events),
  2::bigint, 'RLS: 自世帯の native+google のみ可視(他世帯は不可視)'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
