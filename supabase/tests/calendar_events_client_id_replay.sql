-- 予定作成の冪等 id（2026-10-27 大型更新 A4 / 受入 AC28）が拠って立つ DB の振る舞いを固定する。
-- 実行: supabase test db supabase/tests/calendar_events_client_id_replay.sql
--
-- createCalendarEvent（src/app/(main)/calendar/actions.ts）は、単発ではクライアントの冪等 id を主キーに、
-- 繰返しでは series_id と**初回の行の主キー**に使い、全開催日を単一の INSERT で入れる。series_id には
-- 一意制約が無い（20260722000001）ゆえ、それだけでは応答を失った後の再送が N 行を二重に入れる。
-- ここでは
-- (1) 単発: 同じ id の 2 回目は 23505 で落ち、1 件のまま
-- (2) 繰返し: 初回の行の主キーが重なる再送は、単一 INSERT ごと（他の行の id は新しくても）落ち、
--     シリーズは最初の N 行のまま（原子的。半端にも二重にもならぬ）
-- (3) 別世帯の利用者には見えず、同じ id では作れぬ
-- を確かめる。
BEGIN;
SELECT plan(8);

INSERT INTO households (id, name) VALUES
  ('f1111111-1111-1111-1111-111111111111', 'CI H1'),
  ('f9999999-9999-9999-9999-999999999999', 'CI H2');
INSERT INTO auth.users (id, email) VALUES
  ('f2222222-2222-2222-2222-222222222222', 'ci-a@example.com'),
  ('f4444444-4444-4444-4444-444444444444', 'ci-other@example.com');
UPDATE profiles SET household_id = 'f1111111-1111-1111-1111-111111111111',
                    display_name = 'CI A', role = 'owner', is_approved = true
  WHERE id = 'f2222222-2222-2222-2222-222222222222';
UPDATE profiles SET household_id = 'f9999999-9999-9999-9999-999999999999',
                    display_name = 'CI other', role = 'owner', is_approved = true
  WHERE id = 'f4444444-4444-4444-4444-444444444444';

GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_events TO authenticated;

SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'f2222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);

-- ══ (1) 単発 ═══════════════════════════════════════════════════════
SELECT lives_ok($$
  INSERT INTO calendar_events (id, household_id, title, is_all_day, start_date, end_date, source, created_by)
  VALUES ('f6666666-6666-6666-6666-666666666666', 'f1111111-1111-1111-1111-111111111111',
    '健診', true, '2026-11-02', '2026-11-02', 'native', 'f2222222-2222-2222-2222-222222222222')
$$, '(1) 冪等 id を主キーに単発の予定を作れる');
SELECT throws_ok($$
  INSERT INTO calendar_events (id, household_id, title, is_all_day, start_date, end_date, source, created_by)
  VALUES ('f6666666-6666-6666-6666-666666666666', 'f1111111-1111-1111-1111-111111111111',
    '健診', true, '2026-11-02', '2026-11-02', 'native', 'f2222222-2222-2222-2222-222222222222')
$$, '23505', NULL, '(1) 同じ id の再送は 23505');
SELECT is((SELECT count(*) FROM calendar_events WHERE id = 'f6666666-6666-6666-6666-666666666666'),
  1::bigint, '(1) 単発は 1 件のまま');

-- ══ (2) 繰返し（3 回）。初回の行の id = series_id = 冪等 id ══════════════════
SELECT lives_ok($$
  INSERT INTO calendar_events (id, household_id, title, is_all_day, start_date, end_date, source, series_id, created_by)
  VALUES
    ('f7777777-7777-7777-7777-777777777777', 'f1111111-1111-1111-1111-111111111111', '通院', true, '2026-11-03', '2026-11-03', 'native', 'f7777777-7777-7777-7777-777777777777', 'f2222222-2222-2222-2222-222222222222'),
    (gen_random_uuid(), 'f1111111-1111-1111-1111-111111111111', '通院', true, '2026-11-10', '2026-11-10', 'native', 'f7777777-7777-7777-7777-777777777777', 'f2222222-2222-2222-2222-222222222222'),
    (gen_random_uuid(), 'f1111111-1111-1111-1111-111111111111', '通院', true, '2026-11-17', '2026-11-17', 'native', 'f7777777-7777-7777-7777-777777777777', 'f2222222-2222-2222-2222-222222222222')
$$, '(2) 繰返しの一括作成（初回の行の主キー = 冪等 id）');
-- 再送: 2 行目以降の id は新しく振られるが、初回の行の主キーが重なる
SELECT throws_ok($$
  INSERT INTO calendar_events (id, household_id, title, is_all_day, start_date, end_date, source, series_id, created_by)
  VALUES
    ('f7777777-7777-7777-7777-777777777777', 'f1111111-1111-1111-1111-111111111111', '通院', true, '2026-11-03', '2026-11-03', 'native', 'f7777777-7777-7777-7777-777777777777', 'f2222222-2222-2222-2222-222222222222'),
    (gen_random_uuid(), 'f1111111-1111-1111-1111-111111111111', '通院', true, '2026-11-10', '2026-11-10', 'native', 'f7777777-7777-7777-7777-777777777777', 'f2222222-2222-2222-2222-222222222222'),
    (gen_random_uuid(), 'f1111111-1111-1111-1111-111111111111', '通院', true, '2026-11-17', '2026-11-17', 'native', 'f7777777-7777-7777-7777-777777777777', 'f2222222-2222-2222-2222-222222222222')
$$, '23505', NULL, '(2) 再送の一括 INSERT は丸ごと 23505');
SELECT is((SELECT count(*) FROM calendar_events WHERE series_id = 'f7777777-7777-7777-7777-777777777777'),
  3::bigint, '(2) シリーズは最初の 3 行のまま（半端にも二重にもならぬ）');

-- ══ (3) 別世帯 ══════════════════════════════════════════════════════
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'f4444444-4444-4444-4444-444444444444', 'role', 'authenticated')::text, true);
SELECT is(
  (SELECT count(*) FROM calendar_events
    WHERE id IN ('f6666666-6666-6666-6666-666666666666', 'f7777777-7777-7777-7777-777777777777')),
  0::bigint, '(3) 別世帯の利用者には見えぬ');
SELECT throws_ok($$
  INSERT INTO calendar_events (id, household_id, title, is_all_day, start_date, end_date, source, created_by)
  VALUES ('f6666666-6666-6666-6666-666666666666', 'f9999999-9999-9999-9999-999999999999',
    '奪う', true, '2026-11-02', '2026-11-02', 'native', 'f4444444-4444-4444-4444-444444444444')
$$, '23505', NULL, '(3) 別世帯が同じ id で作っても 23505（行を奪えぬ）');

SELECT * FROM finish();
ROLLBACK;
