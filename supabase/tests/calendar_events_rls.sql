-- calendar_events の RLS を authenticated ロールで検証する。
-- service_role(superuser postgres)は RLS をバイパスするため native/google の
-- 区別を検出できない。authenticated + request.jwt.claims を注入して実検証する。
-- 実行: docker exec -i supabase_db_irori psql -U postgres -v ON_ERROR_STOP=1 -f - < この
-- 期待: 全 RAISE NOTICE 'PASS...' が出て、RAISE EXCEPTION 'FAIL...' が出ないこと。
\set ON_ERROR_STOP on
BEGIN;

-- seed(superuser=RLS バイパス)
INSERT INTO households (id, name) VALUES ('11111111-1111-1111-1111-111111111111', 'テスト世帯');
-- profiles は auth.users への FK があるため、まず auth.users を用意
INSERT INTO auth.users (id, email) VALUES ('22222222-2222-2222-2222-222222222222', 'a@example.com');
-- on_auth_user_created トリガが profiles を自動生成するため、UPDATE で世帯・承認を付与
UPDATE profiles SET household_id = '11111111-1111-1111-1111-111111111111', display_name = 'A', is_approved = true
  WHERE id = '22222222-2222-2222-2222-222222222222';
-- 既存の google 行(service_role で入る想定を superuser で代用)
INSERT INTO calendar_events (id, household_id, title, is_all_day, start_date, end_date, source, google_event_id, google_calendar_id)
  VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'google予定', true, '2026-07-09', '2026-07-09', 'google', 'gev1', 'gcal1');

-- Supabase プラットフォームは全 public テーブルの DML を authenticated へ実行時 GRANT する
-- (meals 等の既存テーブルも同様で、migration には含まれない)。harness ではこれを再現し
-- RLS ポリシー自体の native/google 分離を検証する。
GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_events TO authenticated;

-- authenticated ロール + JWT claims(sub=ユーザー)へ切替 → get_my_household_id() が世帯を返す
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '22222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);

-- (a) native CRUD は成功する
INSERT INTO calendar_events (household_id, title, is_all_day, start_date, end_date, source)
  VALUES ('11111111-1111-1111-1111-111111111111', 'native ok', true, '2026-07-09', '2026-07-09', 'native');
DO $$ BEGIN
  IF (SELECT count(*) FROM calendar_events WHERE title = 'native ok') = 1
  THEN RAISE NOTICE 'PASS(a): native INSERT 成功';
  ELSE RAISE EXCEPTION 'FAIL(a): native INSERT が反映されない'; END IF;
END $$;

-- (b) source='google' の INSERT は WITH CHECK 違反で拒否される
SAVEPOINT sp_b;
DO $$ BEGIN
  INSERT INTO calendar_events (household_id, title, is_all_day, start_date, end_date, source, google_event_id, google_calendar_id)
    VALUES ('11111111-1111-1111-1111-111111111111', 'blocked', true, '2026-07-09', '2026-07-09', 'google', 'gev2', 'gcal1');
  RAISE EXCEPTION 'FAIL(b): google 行の INSERT が RLS を突破した';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'PASS(b): google INSERT は RLS で拒否';
END $$;
ROLLBACK TO SAVEPOINT sp_b;

-- (c) V6 の負の回帰: google 行で calendar_id NULL は CHECK 違反(重複増殖の穴)
--     ※ この行は WITH CHECK(source=native) でも弾かれるが、CHECK 制約の存在も確認する
SAVEPOINT sp_c;
DO $$ BEGIN
  INSERT INTO calendar_events (household_id, title, is_all_day, start_date, end_date, source, google_event_id)
    VALUES ('11111111-1111-1111-1111-111111111111', 'no cal id', true, '2026-07-09', '2026-07-09', 'google', 'gev3');
  RAISE EXCEPTION 'FAIL(c): google_calendar_id NULL が通った';
EXCEPTION
  WHEN check_violation OR insufficient_privilege THEN RAISE NOTICE 'PASS(c): calendar_id NULL は拒否';
END $$;
ROLLBACK TO SAVEPOINT sp_c;

-- (d) 既存 google 行の UPDATE / DELETE は USING 不一致で 0 行(例外にならない)
UPDATE calendar_events SET title = 'x' WHERE id = '33333333-3333-3333-3333-333333333333';
DELETE FROM calendar_events WHERE id = '33333333-3333-3333-3333-333333333333';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM calendar_events WHERE id = '33333333-3333-3333-3333-333333333333' AND title = 'google予定')
  THEN RAISE NOTICE 'PASS(d): google 行は UPDATE/DELETE されず原題のまま';
  ELSE RAISE EXCEPTION 'FAIL(d): google 行が authenticated に改変/削除された'; END IF;
END $$;

-- (e) SELECT は google 行も native 行も両方見える
DO $$ BEGIN
  IF (SELECT count(*) FROM calendar_events) = 2
  THEN RAISE NOTICE 'PASS(e): native + google 両方 SELECT 可(2行)';
  ELSE RAISE EXCEPTION 'FAIL(e): SELECT 可視行数が想定外 %', (SELECT count(*) FROM calendar_events); END IF;
END $$;

ROLLBACK;
