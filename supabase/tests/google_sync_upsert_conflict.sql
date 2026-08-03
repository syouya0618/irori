-- 同期エンジン（D-5）の `.upsert(rows, { onConflict:
-- "household_id,google_calendar_id,google_event_id" })` が **実 DB で解決する**
-- ことを固定する。
-- 実行: supabase test db supabase/tests/google_sync_upsert_conflict.sql
--
-- ## なぜ mock では足りぬか
-- PostgREST の `on_conflict` は列名しか出せぬため、対象が **partial unique index**
-- だと Postgres が推論に失敗して **42P10 (invalid_column_reference)** を投げる。
-- これは実行時にしか出ぬ失敗で、vitest の fake クライアント（`__tests__/fake-supabase.ts`）
-- では**原理的に**検出できぬ。同期のたび重複が積もる/全滅する事故ゆえ、
-- 「この 3 列で ON CONFLICT が引ける」ことを実 DB に当てて固定する。
--
-- ## CHECK と UNIQUE の組み合わせが担う不変条件（20260709000002 の設計）
--   - google 行は google_event_id / google_calendar_id が**両方** NOT NULL
--     (chk_calendar_google_meta)
--   - native 行は**両方** NULL (chk_calendar_native_no_google)
--   - よって通常 UNIQUE (NULLS DISTINCT 既定) が partial index と同義になり、
--     native 行は無限に共存できる。
-- この 3 点が崩れると upsert は静かに重複を積む。ゆえに対で assert する。
BEGIN;
SELECT plan(6);

-- ── seed ───────────────────────────────────────────────────────
INSERT INTO households (id, name) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'H1');
INSERT INTO auth.users (id, email) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000002', 'u1@example.com');
UPDATE profiles SET household_id = 'aaaaaaaa-0000-0000-0000-000000000001',
                    display_name = 'U1', role = 'owner', is_approved = true
  WHERE id = 'aaaaaaaa-0000-0000-0000-000000000002';

-- 1 回目の同期（フル同期）が入れる行。
INSERT INTO calendar_events
  (household_id, title, is_all_day, start_date, end_date, source,
   google_event_id, google_calendar_id, synced_at)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001', '通院', true,
        '2026-08-10', '2026-08-10', 'google',
        'gev-conflict', 'family@group.calendar.google.com',
        '2026-08-02T00:00:00Z');

-- ══ 1. PostgREST が撃つのと同じ ON CONFLICT が解決すること ══
-- 対象が partial index なら **ここで 42P10 になる**。
SELECT lives_ok(
  $$ INSERT INTO calendar_events
       (household_id, title, is_all_day, start_date, end_date, source,
        google_event_id, google_calendar_id, synced_at)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000001', '通院(改題)', true,
             '2026-08-11', '2026-08-11', 'google',
             'gev-conflict', 'family@group.calendar.google.com',
             '2026-08-02T01:00:00Z')
     ON CONFLICT (household_id, google_calendar_id, google_event_id)
     DO UPDATE SET title = EXCLUDED.title,
                   start_date = EXCLUDED.start_date,
                   end_date = EXCLUDED.end_date,
                   synced_at = EXCLUDED.synced_at $$,
  'upsert の onConflict 三列が実 index へ解決する（42P10 にならぬ）');

SELECT is(
  (SELECT count(*) FROM calendar_events
     WHERE google_event_id = 'gev-conflict'),
  1::bigint,
  '同じ google_event_id は 1 行のまま（重複が積もらぬ）');

SELECT is(
  (SELECT title FROM calendar_events WHERE google_event_id = 'gev-conflict'),
  '通院(改題)',
  'DO UPDATE で既存行が更新される');

-- ══ 2. 世帯が違えば別行（UNIQUE は household スコープ）══
INSERT INTO households (id, name) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000003', 'H2');

SELECT lives_ok(
  $$ INSERT INTO calendar_events
       (household_id, title, is_all_day, start_date, end_date, source,
        google_event_id, google_calendar_id)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000003', '他世帯の同 id', true,
             '2026-08-10', '2026-08-10', 'google',
             'gev-conflict', 'family@group.calendar.google.com')
     ON CONFLICT (household_id, google_calendar_id, google_event_id)
     DO UPDATE SET title = EXCLUDED.title $$,
  '同じ google_event_id でも世帯が違えば別行として入る');

SELECT is(
  (SELECT count(*) FROM calendar_events
     WHERE google_event_id = 'gev-conflict'),
  2::bigint,
  '世帯ごとに 1 行ずつ（世帯を跨いで潰れぬ）');

-- ══ 3. native 行 (NULL, NULL) は NULLS DISTINCT で無限に共存する ══
-- ここが崩れると手入力の 2 件目が UNIQUE 違反で入らなくなる。
SELECT lives_ok(
  $$ INSERT INTO calendar_events
       (household_id, title, is_all_day, start_date, end_date, source)
     VALUES
       ('aaaaaaaa-0000-0000-0000-000000000001', '手入力1', true,
        '2026-08-10', '2026-08-10', 'native'),
       ('aaaaaaaa-0000-0000-0000-000000000001', '手入力2', true,
        '2026-08-10', '2026-08-10', 'native') $$,
  'native 行 (google 列 NULL) は同じ世帯で複数共存できる');

SELECT * FROM finish();
ROLLBACK;
