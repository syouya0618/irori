-- D-2（純関数コア）が吐く google 行が **実テーブルに入る**ことと、
-- `calendar_events` の CHECK 境界を実 DB で固定する。
-- 実行: supabase test db supabase/tests/calendar_events_google_row_contract.sql
--
-- ## なぜこの assert が要るか
-- D-2 のテストは CHECK 述語を TypeScript へ**手で書き写した**
-- `assertSatisfiesDbChecks` で検証しておる。転写を誤れば、実装とテストが
-- **揃って間違ったまま緑**になる（規約が名指しする「テスト緑・本番不動作」と同型）。
-- 転写ズレは実 DB に当てて初めて割れる。ゆえに本ファイルは
-- **境界値を実際に INSERT** して DB の判定を正とする。
--
-- ## 通る側（lives_ok）を必ず対で置く理由
-- 「弾かれる側」だけを assert すると、CHECK が過剰に厳しくて**正当な行まで
-- 拒否しておる**状態が緑のまま通る（同期が本番で 100% 失敗しても気づけぬ）。
-- ゆえに全ての境界で「ちょうど許される値」と「1 つ外れた値」を対で置く。
--
-- ## 全ロールに効くゆえ superuser のまま検証する
-- CHECK 制約は RLS と違い role に依らぬ。RLS / 権限側は
-- calendar_events_rls.sql と google_calendar_sync_grants_rls.sql が担う。
BEGIN;
SELECT plan(18);

-- ── seed ───────────────────────────────────────────────────────
INSERT INTO households (id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'H1');
INSERT INTO auth.users (id, email) VALUES
  ('22222222-2222-2222-2222-222222222222', 'u1@example.com');
UPDATE profiles SET household_id = '11111111-1111-1111-1111-111111111111',
                    display_name = 'U1', role = 'owner', is_approved = true
  WHERE id = '22222222-2222-2222-2222-222222222222';
INSERT INTO google_connections (id, household_id, user_id, google_account_id, google_email)
  VALUES ('44444444-4444-4444-4444-444444444444',
          '11111111-1111-1111-1111-111111111111',
          '22222222-2222-2222-2222-222222222222', 'acct-u1', 'u1@example.com');
INSERT INTO google_calendar_subscriptions
  (id, connection_id, household_id, google_calendar_id, summary, is_selected)
  VALUES ('66666666-6666-6666-6666-666666666666',
          '44444444-4444-4444-4444-444444444444',
          '11111111-1111-1111-1111-111111111111',
          'family@group.calendar.google.com', '家族', true);

-- ══ chk_calendar_title: char_length(btrim(title)) BETWEEN 1 AND 200 ══
-- 前後の空白は btrim で落ちる ⇒ 実質ちょうど 200 文字は通る。
SELECT lives_ok(
  $$ INSERT INTO calendar_events
       (household_id, title, is_all_day, start_date, end_date, source,
        google_event_id, google_calendar_id)
     VALUES ('11111111-1111-1111-1111-111111111111',
             ' ' || repeat('a', 200) || ' ', true, '2026-08-10', '2026-08-10',
             'google', 'gev-title-200', 'family@group.calendar.google.com') $$,
  'title: btrim 後ちょうど 200 文字は通る');
SELECT throws_ok(
  $$ INSERT INTO calendar_events
       (household_id, title, is_all_day, start_date, end_date, source,
        google_event_id, google_calendar_id)
     VALUES ('11111111-1111-1111-1111-111111111111',
             repeat('a', 201), true, '2026-08-10', '2026-08-10',
             'google', 'gev-title-201', 'family@group.calendar.google.com') $$,
  '23514', 'new row for relation "calendar_events" violates check constraint "chk_calendar_title"', 'title: 201 文字は拒否');
SELECT throws_ok(
  $$ INSERT INTO calendar_events
       (household_id, title, is_all_day, start_date, end_date, source,
        google_event_id, google_calendar_id)
     VALUES ('11111111-1111-1111-1111-111111111111',
             '   ', true, '2026-08-10', '2026-08-10',
             'google', 'gev-title-blank', 'family@group.calendar.google.com') $$,
  '23514', 'new row for relation "calendar_events" violates check constraint "chk_calendar_title"', 'title: 空白のみは拒否（summary 欠落は "(無題)" へ倒す契約）');

-- ══ chk_calendar_memo: memo IS NULL OR char_length(memo) <= 1000 ══
SELECT lives_ok(
  $$ INSERT INTO calendar_events
       (household_id, title, memo, is_all_day, start_date, end_date, source,
        google_event_id, google_calendar_id)
     VALUES ('11111111-1111-1111-1111-111111111111', 'memo 境界',
             repeat('m', 1000), true, '2026-08-10', '2026-08-10',
             'google', 'gev-memo-1000', 'family@group.calendar.google.com') $$,
  'memo: ちょうど 1000 文字は通る');
SELECT throws_ok(
  $$ INSERT INTO calendar_events
       (household_id, title, memo, is_all_day, start_date, end_date, source,
        google_event_id, google_calendar_id)
     VALUES ('11111111-1111-1111-1111-111111111111', 'memo 超過',
             repeat('m', 1001), true, '2026-08-10', '2026-08-10',
             'google', 'gev-memo-1001', 'family@group.calendar.google.com') $$,
  '23514', 'new row for relation "calendar_events" violates check constraint "chk_calendar_memo"', 'memo: 1001 文字は拒否（Google の description は切り詰める契約）');

-- ══ chk_calendar_date_order: end_date >= start_date ══
-- Google の all-day `end.date` は排他的ゆえ D-2 が -1 日する。単日は end = start。
SELECT lives_ok(
  $$ INSERT INTO calendar_events
       (household_id, title, is_all_day, start_date, end_date, source,
        google_event_id, google_calendar_id)
     VALUES ('11111111-1111-1111-1111-111111111111', '単日 all-day', true,
             '2026-08-10', '2026-08-10', 'google',
             'gev-date-eq', 'family@group.calendar.google.com') $$,
  'date_order: end_date = start_date は通る（単日 all-day）');
SELECT throws_ok(
  $$ INSERT INTO calendar_events
       (household_id, title, is_all_day, start_date, end_date, source,
        google_event_id, google_calendar_id)
     VALUES ('11111111-1111-1111-1111-111111111111', '逆転', true,
             '2026-08-10', '2026-08-09', 'google',
             'gev-date-lt', 'family@group.calendar.google.com') $$,
  '23514', 'new row for relation "calendar_events" violates check constraint "chk_calendar_date_order"', 'date_order: end_date < start_date は拒否（-1 日の引きすぎを DB が止める）');

-- ══ chk_calendar_google_meta: google 行は 2 列とも NOT NULL ══
SELECT lives_ok(
  $$ INSERT INTO calendar_events
       (household_id, title, is_all_day, start_date, end_date, source,
        google_event_id, google_calendar_id)
     VALUES ('11111111-1111-1111-1111-111111111111', 'google meta 両方', true,
             '2026-08-10', '2026-08-10', 'google',
             'gev-meta-ok', 'family@group.calendar.google.com') $$,
  'google_meta: event_id / calendar_id 両方 NOT NULL は通る');
SELECT throws_ok(
  $$ INSERT INTO calendar_events
       (household_id, title, is_all_day, start_date, end_date, source,
        google_event_id)
     VALUES ('11111111-1111-1111-1111-111111111111', 'calendar_id 欠落', true,
             '2026-08-10', '2026-08-10', 'google', 'gev-meta-ng') $$,
  '23514', 'new row for relation "calendar_events" violates check constraint "chk_calendar_google_meta"',
  'google_meta: google_calendar_id のみ NULL は拒否（V6: UNIQUE が効かず重複が積もる穴）');

-- ══ chk_calendar_native_no_google: native 行は google 列を持てぬ ══
-- これが破れると UNIQUE index(NULLS DISTINCT 既定)が partial と同義でなくなり、
-- V1/V6 の冪等キーの前提が崩れる。
SELECT lives_ok(
  $$ INSERT INTO calendar_events
       (household_id, title, is_all_day, start_date, end_date, source)
     VALUES ('11111111-1111-1111-1111-111111111111', 'native 行', true,
             '2026-08-10', '2026-08-10', 'native') $$,
  'native_no_google: native 行は google 列 NULL で通る');
SELECT throws_ok(
  $$ INSERT INTO calendar_events
       (household_id, title, is_all_day, start_date, end_date, source,
        google_event_id, google_calendar_id)
     VALUES ('11111111-1111-1111-1111-111111111111', 'native なのに google', true,
             '2026-08-10', '2026-08-10', 'native',
             'gev-native-ng', 'family@group.calendar.google.com') $$,
  '23514',
  'new row for relation "calendar_events" violates check constraint "chk_calendar_native_no_google"',
  'native_no_google: native 行に google_event_id が付いておれば拒否');

-- ══ chk_calendar_all_day ══
SELECT lives_ok(
  $$ INSERT INTO calendar_events
       (household_id, title, is_all_day, start_date, end_date, start_at, end_at,
        source, google_event_id, google_calendar_id)
     VALUES ('11111111-1111-1111-1111-111111111111', 'all-day', true,
             '2026-08-10', '2026-08-10', NULL, NULL, 'google',
             'gev-allday-ok', 'family@group.calendar.google.com') $$,
  'all_day: 終日行は start_at / end_at とも NULL で通る');
SELECT throws_ok(
  $$ INSERT INTO calendar_events
       (household_id, title, is_all_day, start_date, end_date, start_at,
        source, google_event_id, google_calendar_id)
     VALUES ('11111111-1111-1111-1111-111111111111', 'all-day なのに時刻', true,
             '2026-08-10', '2026-08-10', '2026-08-10T01:00:00Z', 'google',
             'gev-allday-ng', 'family@group.calendar.google.com') $$,
  '23514', 'new row for relation "calendar_events" violates check constraint "chk_calendar_all_day"', 'all_day: 終日行に start_at が付いておれば拒否');

-- ══ chk_calendar_time_order: end_at IS NULL OR end_at >= start_at ══
SELECT lives_ok(
  $$ INSERT INTO calendar_events
       (household_id, title, is_all_day, start_date, end_date, start_at, end_at,
        source, google_event_id, google_calendar_id)
     VALUES ('11111111-1111-1111-1111-111111111111', '0 分の予定', false,
             '2026-08-10', '2026-08-10',
             '2026-08-10T01:00:00Z', '2026-08-10T01:00:00Z', 'google',
             'gev-time-eq', 'family@group.calendar.google.com') $$,
  'time_order: end_at = start_at（0 分）は通る');
SELECT throws_ok(
  $$ INSERT INTO calendar_events
       (household_id, title, is_all_day, start_date, end_date, start_at, end_at,
        source, google_event_id, google_calendar_id)
     VALUES ('11111111-1111-1111-1111-111111111111', '時刻逆転', false,
             '2026-08-10', '2026-08-10',
             '2026-08-10T02:00:00Z', '2026-08-10T01:00:00Z', 'google',
             'gev-time-lt', 'family@group.calendar.google.com') $$,
  '23514', 'new row for relation "calendar_events" violates check constraint "chk_calendar_time_order"', 'time_order: end_at < start_at は拒否');

-- ══ D-2 の GoogleCalendarEventRow 全 19 列を実 INSERT ══
-- 列名は src/lib/domain/google-calendar-sync.ts の interface に一致させること。
-- created_by / synced_at は D-2 の行に含まれぬ（前者は google 行では NULL、
-- 後者は「今」ゆえ I/O シェルの責務）→ どちらも nullable でなければ通らぬ。
SELECT lives_ok(
  $$ INSERT INTO calendar_events (
       household_id, title, memo, is_all_day, start_date, end_date,
       start_at, end_at, source, google_event_id, google_calendar_id,
       etag, ical_uid, subscription_id, source_user_id,
       location, html_link, recurring_event_id, google_updated
     ) VALUES (
       '11111111-1111-1111-1111-111111111111',
       'D-2 が吐く行', 'Google の description',
       false, '2026-08-10', '2026-08-10',
       '2026-08-10T01:00:00Z', '2026-08-10T02:00:00Z',
       'google', 'gev-full-row', 'family@group.calendar.google.com',
       '"etag-1"', 'uid-1@google.com',
       '66666666-6666-6666-6666-666666666666',
       '22222222-2222-2222-2222-222222222222',
       '会議室', 'https://www.google.com/calendar/event?eid=abc',
       'rec-parent-1', '2026-08-01T10:00:00Z'
     ) $$,
  'D-2 の GoogleCalendarEventRow 全 19 列がそのまま INSERT できる');

SELECT is(
  (SELECT count(*) FROM calendar_events WHERE google_event_id = 'gev-full-row'),
  1::bigint,
  'D-2 の行が実際に 1 件入っておる');

SELECT ok(
  (SELECT subscription_id = '66666666-6666-6666-6666-666666666666'
      AND source_user_id  = '22222222-2222-2222-2222-222222222222'
      AND location = '会議室'
      AND html_link = 'https://www.google.com/calendar/event?eid=abc'
      AND recurring_event_id = 'rec-parent-1'
      AND google_updated = '2026-08-01T10:00:00Z'::timestamptz
      AND synced_at IS NULL
      AND created_by IS NULL
     FROM calendar_events WHERE google_event_id = 'gev-full-row'),
  'ALTER で足した 6 列が往復し、synced_at / created_by は NULL のまま入る');

SELECT * FROM finish();
ROLLBACK;
