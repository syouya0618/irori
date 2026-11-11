-- ============================================================
-- event_purposes（ごみの分類と前日通知の既定）— 20261111100001_event_purposes.sql
--
-- 固定するもの:
--   A. 権限の形（SELECT のみ・ポリシー 1 本・FOR ALL 無し・RPC の EXECUTE・FK 無し）
--   B. 分類の保存 → 再読込、同じ操作の再送（replayed・行が増えぬ）
--   C. シリーズ既定と単回例外（別名称 / 通常へ戻す）。series_id == 初回行 id の衝突
--   D. 前日 20:00 JST の remind_at、既存の通知時刻を上書きせぬ、過去の回に足さぬ
--   E. 個別 OFF の記録と解除（トリガ）、後から INSERT された将来回
--   F. Google の 410 完全再同期（DELETE → 新 UUID で INSERT）で分類と通知設定が残り、
--      明示 OFF の回に通知が復活せぬ
--   G. series OFF、解除、予定の削除で cascade せぬ、掃除と手動整理の門
--   H. 別世帯・child-share 受諾者・viewer・anon は読めず書けぬ。直接 DML は拒否
--
-- 偽緑を避ける作法: 2 世帯 seed / SET ROLE の前に seed 件数を assert / 拒否には通る側の対照 /
-- harness で GRANT を足さぬ（migration が入れた権限そのものを検証する）。
-- ============================================================
BEGIN;
SELECT plan(189);

-- ── seed（superuser）────────────────────────────────────────
INSERT INTO households(id, name) VALUES
  ('e7000000-0000-4000-8000-000000000001', 'synthetic garbage household A'),
  ('e7000000-0000-4000-8000-000000000002', 'synthetic garbage household B');
INSERT INTO auth.users(id, email) VALUES
  ('e7000000-0000-4000-8000-000000000003', 'garbage-a1@example.invalid'),
  ('e7000000-0000-4000-8000-000000000004', 'garbage-a2@example.invalid'),
  ('e7000000-0000-4000-8000-000000000005', 'garbage-b1@example.invalid');
UPDATE profiles SET household_id = 'e7000000-0000-4000-8000-000000000001', is_approved = true, role = 'owner'
 WHERE id = 'e7000000-0000-4000-8000-000000000003';
UPDATE profiles SET household_id = 'e7000000-0000-4000-8000-000000000001', is_approved = true, role = 'member'
 WHERE id = 'e7000000-0000-4000-8000-000000000004';
UPDATE profiles SET household_id = 'e7000000-0000-4000-8000-000000000002', is_approved = true, role = 'owner'
 WHERE id = 'e7000000-0000-4000-8000-000000000005';

-- 世帯 A の native シリーズ（series_id = 初回の行 id = …10。鍵空間の衝突を作る）
INSERT INTO calendar_events(id, household_id, title, is_all_day, start_date, end_date, source, series_id) VALUES
  ('e7000000-0000-4000-8000-000000000010', 'e7000000-0000-4000-8000-000000000001', 'synthetic weekly 1', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date + 7,  (now() AT TIME ZONE 'Asia/Tokyo')::date + 7,  'native', 'e7000000-0000-4000-8000-000000000010'),
  ('e7000000-0000-4000-8000-000000000011', 'e7000000-0000-4000-8000-000000000001', 'synthetic weekly 2', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date + 14, (now() AT TIME ZONE 'Asia/Tokyo')::date + 14, 'native', 'e7000000-0000-4000-8000-000000000010'),
  ('e7000000-0000-4000-8000-000000000012', 'e7000000-0000-4000-8000-000000000001', 'synthetic weekly 3', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date + 21, (now() AT TIME ZONE 'Asia/Tokyo')::date + 21, 'native', 'e7000000-0000-4000-8000-000000000010'),
  ('e7000000-0000-4000-8000-000000000013', 'e7000000-0000-4000-8000-000000000001', 'synthetic weekly past', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date - 7,  (now() AT TIME ZONE 'Asia/Tokyo')::date - 7,  'native', 'e7000000-0000-4000-8000-000000000010');
-- 世帯 A の native 単発
INSERT INTO calendar_events(id, household_id, title, is_all_day, start_date, end_date, source) VALUES
  ('e7000000-0000-4000-8000-000000000020', 'e7000000-0000-4000-8000-000000000001', 'synthetic single', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date + 3, (now() AT TIME ZONE 'Asia/Tokyo')::date + 3, 'native');
-- 世帯 A の google シリーズ 2 回 + google 単発
INSERT INTO calendar_events(household_id, title, is_all_day, start_date, end_date, source,
                            google_calendar_id, google_event_id, recurring_event_id) VALUES
  ('e7000000-0000-4000-8000-000000000001', 'synthetic google 1', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date + 5,  (now() AT TIME ZONE 'Asia/Tokyo')::date + 5,  'google',
   'synthetic-cal@example.invalid', 'grec_1', 'grec'),
  ('e7000000-0000-4000-8000-000000000001', 'synthetic google 2', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date + 12, (now() AT TIME ZONE 'Asia/Tokyo')::date + 12, 'google',
   'synthetic-cal@example.invalid', 'grec_2', 'grec'),
  ('e7000000-0000-4000-8000-000000000001', 'synthetic google single', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date + 6,  (now() AT TIME ZONE 'Asia/Tokyo')::date + 6,  'google',
   'synthetic-cal@example.invalid', 'gsingle', NULL);
-- 世帯 A の健診の予定（医療記録に紐づく。分類の対象外）
INSERT INTO medical_records(id, household_id, child_id, kind, title, status, scheduled_date, source_key)
SELECT 'e7000000-0000-4000-8000-000000000025', 'e7000000-0000-4000-8000-000000000001', c.id,
       'checkup', 'synthetic checkup', 'planned', (now() AT TIME ZONE 'Asia/Tokyo')::date + 10, 'cfa-checkup-2026-07-23'
  FROM children c WHERE c.household_id = 'e7000000-0000-4000-8000-000000000001' AND c.is_legacy;
INSERT INTO calendar_events(id, household_id, child_id, medical_record_id, title, is_all_day, start_date, end_date, source)
SELECT 'e7000000-0000-4000-8000-000000000025', 'e7000000-0000-4000-8000-000000000001', c.id,
       'e7000000-0000-4000-8000-000000000025', 'synthetic checkup', true,
       (now() AT TIME ZONE 'Asia/Tokyo')::date + 10, (now() AT TIME ZONE 'Asia/Tokyo')::date + 10, 'native'
  FROM children c WHERE c.household_id = 'e7000000-0000-4000-8000-000000000001' AND c.is_legacy;
-- 世帯 B の native シリーズ 1 回
INSERT INTO calendar_events(id, household_id, title, is_all_day, start_date, end_date, source, series_id) VALUES
  ('e7000000-0000-4000-8000-000000000030', 'e7000000-0000-4000-8000-000000000002', 'synthetic other household', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date + 5, (now() AT TIME ZONE 'Asia/Tokyo')::date + 5, 'native', 'e7000000-0000-4000-8000-000000000031');
-- 既に通知時刻（10 分前）を持つ回（上書きされぬことの対照）
INSERT INTO event_reminders(household_id, event_uid, remind_kind, remind_minutes_before) VALUES
  ('e7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000011', 'minutes', 10);

CREATE TEMP TABLE fx(k text PRIMARY KEY, value jsonb);
GRANT ALL ON fx TO authenticated;
CREATE TEMP TABLE old_google(google_event_id text PRIMARY KEY, id uuid);

-- 「今の状態を読んだばかりの画面」からの保存。save_event_purpose は画面が見ておった版
-- （series 行・event 行の updated_at。無ければ NULL）を受ける。この helper は呼び出しの直前の
-- 版を呼び出し元の権限（RLS）で読んで渡す = 画面を開いて直ぐ保存する経路と同じ。
-- **古い版を渡す経路（版の照合）と、認可の拒否は helper を通さず RPC を直に呼ぶ**
-- （helper の SELECT が先に落ちて、RPC の拒否を見ずに緑になるのを避ける）。
CREATE FUNCTION pg_temp.sep(p_event uuid, p_scope text, p_action text, p_kind text, p_reminder text)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.save_event_purpose(
    p_event, p_scope, p_action, p_kind, p_reminder,
    (SELECT p.updated_at FROM public.calendar_events c
       JOIN public.event_purposes p
         ON p.household_id = c.household_id AND p.scope = 'series'
        AND p.target_key = CASE WHEN c.source = 'google'
                                THEN c.google_calendar_id || '|' || c.recurring_event_id
                                ELSE c.series_id::text END
      WHERE c.id = p_event),
    (SELECT p.updated_at FROM public.calendar_events c
       JOIN public.event_purposes p
         ON p.household_id = c.household_id AND p.scope = 'event' AND p.target_key = c.event_uid
      WHERE c.id = p_event));
$$;
GRANT EXECUTE ON FUNCTION pg_temp.sep(uuid, text, text, text, text) TO authenticated;

-- 世帯 C: 通知の停止の範囲（シリーズ全体 / この回だけ）と、版の照合の検査に使う。
-- 世帯 A の件数・状態に触れぬよう、別の世帯に置く。
INSERT INTO households(id, name) VALUES
  ('e7000000-0000-4000-8000-0000000000c0', 'synthetic garbage household C');
INSERT INTO auth.users(id, email) VALUES
  ('e7000000-0000-4000-8000-0000000000c1', 'garbage-c1@example.invalid'),
  ('e7000000-0000-4000-8000-0000000000c2', 'garbage-c2@example.invalid');
UPDATE profiles SET household_id = 'e7000000-0000-4000-8000-0000000000c0', is_approved = true, role = 'owner'
 WHERE id = 'e7000000-0000-4000-8000-0000000000c1';
UPDATE profiles SET household_id = 'e7000000-0000-4000-8000-0000000000c0', is_approved = true, role = 'member'
 WHERE id = 'e7000000-0000-4000-8000-0000000000c2';
INSERT INTO calendar_events(id, household_id, title, is_all_day, start_date, end_date, source, series_id) VALUES
  -- シリーズ C1（既定 ON で使う）: 今日以降 3 回 + 過ぎた 1 回
  ('e7000000-0000-4000-8000-00000000c110', 'e7000000-0000-4000-8000-0000000000c0', 'synthetic c1 1', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date + 7,  (now() AT TIME ZONE 'Asia/Tokyo')::date + 7,  'native', 'e7000000-0000-4000-8000-00000000c110'),
  ('e7000000-0000-4000-8000-00000000c111', 'e7000000-0000-4000-8000-0000000000c0', 'synthetic c1 2', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date + 14, (now() AT TIME ZONE 'Asia/Tokyo')::date + 14, 'native', 'e7000000-0000-4000-8000-00000000c110'),
  ('e7000000-0000-4000-8000-00000000c112', 'e7000000-0000-4000-8000-0000000000c0', 'synthetic c1 3', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date + 21, (now() AT TIME ZONE 'Asia/Tokyo')::date + 21, 'native', 'e7000000-0000-4000-8000-00000000c110'),
  ('e7000000-0000-4000-8000-00000000c113', 'e7000000-0000-4000-8000-0000000000c0', 'synthetic c1 past', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date - 7,  (now() AT TIME ZONE 'Asia/Tokyo')::date - 7,  'native', 'e7000000-0000-4000-8000-00000000c110'),
  -- シリーズ C2（既定 none で使う）: 今日以降 2 回 + 過ぎた 1 回
  ('e7000000-0000-4000-8000-00000000c120', 'e7000000-0000-4000-8000-0000000000c0', 'synthetic c2 1', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date + 5,  (now() AT TIME ZONE 'Asia/Tokyo')::date + 5,  'native', 'e7000000-0000-4000-8000-00000000c120'),
  ('e7000000-0000-4000-8000-00000000c121', 'e7000000-0000-4000-8000-0000000000c0', 'synthetic c2 2', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date + 12, (now() AT TIME ZONE 'Asia/Tokyo')::date + 12, 'native', 'e7000000-0000-4000-8000-00000000c120'),
  ('e7000000-0000-4000-8000-00000000c122', 'e7000000-0000-4000-8000-0000000000c0', 'synthetic c2 past', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date - 3,  (now() AT TIME ZONE 'Asia/Tokyo')::date - 3,  'native', 'e7000000-0000-4000-8000-00000000c120'),
  -- シリーズ C3（版の照合で使う）: 今日以降 3 回
  ('e7000000-0000-4000-8000-00000000c130', 'e7000000-0000-4000-8000-0000000000c0', 'synthetic c3 1', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date + 4,  (now() AT TIME ZONE 'Asia/Tokyo')::date + 4,  'native', 'e7000000-0000-4000-8000-00000000c130'),
  ('e7000000-0000-4000-8000-00000000c131', 'e7000000-0000-4000-8000-0000000000c0', 'synthetic c3 2', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date + 11, (now() AT TIME ZONE 'Asia/Tokyo')::date + 11, 'native', 'e7000000-0000-4000-8000-00000000c130'),
  ('e7000000-0000-4000-8000-00000000c132', 'e7000000-0000-4000-8000-0000000000c0', 'synthetic c3 3', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date + 18, (now() AT TIME ZONE 'Asia/Tokyo')::date + 18, 'native', 'e7000000-0000-4000-8000-00000000c130');

SELECT is((SELECT count(*) FROM calendar_events WHERE household_id = 'e7000000-0000-4000-8000-000000000001'),
          9::bigint, 'seed: 世帯 A の予定は 9 件（native 5 + google 3 + 健診 1）');
SELECT is((SELECT count(*) FROM event_purposes), 0::bigint, 'seed: 分類はまだ無い');
SELECT is((SELECT count(*) FROM event_reminders WHERE household_id = 'e7000000-0000-4000-8000-000000000001'),
          1::bigint, 'seed: 既存の通知設定は 1 件（10 分前）。シリーズ既定の無い INSERT では足されぬ');

-- ── A. 権限の形 ─────────────────────────────────────────────
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.event_purposes'::regclass),
          'A-1: RLS が有効');
SELECT set_eq(
  $$SELECT acl.privilege_type::text FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) acl
     WHERE c.oid = 'public.event_purposes'::regclass AND acl.grantee = 'authenticated'::regrole$$,
  ARRAY['SELECT'],
  'A-2: authenticated の表権限は SELECT だけ（直接の書込権を持たぬ）');
SELECT is_empty(
  $$SELECT acl.privilege_type::text FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) acl
     WHERE c.oid = 'public.event_purposes'::regclass AND acl.grantee IN (0::oid, 'anon'::regrole::oid)$$,
  'A-3: anon / PUBLIC は表に何の権限も持たぬ');
SELECT set_eq(
  $$SELECT policyname::text || ':' || cmd::text FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'event_purposes'$$,
  ARRAY['event_purposes_select:SELECT'],
  'A-4: ポリシーは SELECT の 1 本だけ（FOR ALL 無し・書込ポリシー無し）');
SELECT is(
  (SELECT roles::text FROM pg_policies WHERE schemaname = 'public' AND tablename = 'event_purposes'),
  '{authenticated}', 'A-5: ポリシーは TO authenticated');
SELECT is_empty(
  $$SELECT conname::text FROM pg_constraint
     WHERE conrelid = 'public.event_purposes'::regclass AND contype = 'f'
       AND confrelid = 'public.calendar_events'::regclass$$,
  'A-6: calendar_events への FK を張っておらぬ（410 の DELETE→INSERT で分類を失わぬ）');
SELECT is(
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid = 'public.event_purposes'::regclass AND conname = 'chk_event_purposes_target_key'),
  'CHECK ((char_length(btrim(target_key)) >= 1))',
  'A-7: target_key の CHECK は下限のみ（Google の長い event id を拒まぬ）');
SELECT is(
  (SELECT count(*) FROM pg_proc p
    WHERE p.proname IN ('save_event_purpose', 'delete_orphan_event_purpose', 'cleanup_deleted_event_purposes',
                        'calendar_events_apply_purpose_default', 'event_reminders_record_opt_out',
                        'event_reminders_clear_opt_out', 'event_purpose_is_orphan')
      AND p.prosecdef AND p.proconfig @> ARRAY['search_path=""']),
  7::bigint, 'A-8: RPC 3 本・トリガ関数 3 本・内部ヘルパは SECURITY DEFINER + search_path 固定');
SELECT ok(has_function_privilege('authenticated', 'public.save_event_purpose(uuid,text,text,text,text,timestamptz,timestamptz)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.delete_orphan_event_purpose(uuid)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.cleanup_deleted_event_purposes(uuid[],uuid)', 'EXECUTE'),
          'A-9: authenticated は RPC 3 本を実行できる（通る側の対照）');
SELECT ok(NOT has_function_privilege('anon', 'public.save_event_purpose(uuid,text,text,text,text,timestamptz,timestamptz)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.delete_orphan_event_purpose(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.cleanup_deleted_event_purposes(uuid[],uuid)', 'EXECUTE'),
          'A-10: anon は RPC を 1 本も実行できぬ');
SELECT is_empty(
  $$SELECT p.proname::text FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) acl
     WHERE p.proname IN ('save_event_purpose', 'delete_orphan_event_purpose', 'cleanup_deleted_event_purposes',
                         'calendar_events_apply_purpose_default', 'event_reminders_record_opt_out',
                         'event_reminders_clear_opt_out', 'event_purpose_is_orphan', 'event_series_key')
       AND acl.grantee IN (0::oid, 'anon'::regrole::oid)$$,
  'A-11: どの関数も PUBLIC / anon に EXECUTE を与えておらぬ');
SELECT is_empty(
  $$SELECT p.proname::text FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) acl
     WHERE p.proname IN ('calendar_events_apply_purpose_default', 'event_reminders_record_opt_out',
                         'event_reminders_clear_opt_out', 'event_purpose_is_orphan', 'event_series_key')
       AND acl.grantee = 'authenticated'::regrole$$,
  'A-12: トリガ関数と内部ヘルパは authenticated からも直接呼べぬ');
SELECT is_empty(
  $$SELECT tablename::text FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND tablename = 'event_purposes'$$,
  'A-13: Realtime publication へ載せておらぬ');
SELECT set_eq(
  $$SELECT tgname::text FROM pg_trigger
     WHERE tgrelid = 'public.event_reminders'::regclass AND NOT tgisinternal
       AND tgname LIKE 'trg_event_reminders_purpose%'$$,
  ARRAY['trg_event_reminders_purpose_opt_out', 'trg_event_reminders_purpose_opt_in'],
  'A-14: event_reminders に個別 OFF の記録・解除のトリガが在る');

-- ── B. 単発の予定をごみに分類 → 再読込・再送 ────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"e7000000-0000-4000-8000-000000000003","role":"authenticated"}', true);

INSERT INTO fx SELECT 'single', pg_temp.sep('e7000000-0000-4000-8000-000000000020', 'event', 'garbage', ' 燃えるごみ ', 'prev_day_20');
SELECT is((SELECT value->>'status' FROM fx WHERE k = 'single'), 'saved', 'B-1: 単発の分類は saved');
SELECT is((SELECT value->'purpose'->>'garbage_kind' FROM fx WHERE k = 'single'), '燃えるごみ',
          'B-2: 名称は前後の空白を除いて保存される');
SELECT results_eq(
  $$SELECT scope, target_key, purpose, garbage_kind, reminder_opt_out FROM event_purposes$$,
  $$VALUES ('event'::text, 'e7000000-0000-4000-8000-000000000020'::text, 'garbage'::text, '燃えるごみ'::text, false)$$,
  'B-3: 再読込で event 行が 1 件（鍵は event_uid）');
SELECT is(
  (SELECT remind_kind FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-000000000020'),
  'prev_day_20', 'B-4: 既存の event_reminders へ前日通知が 1 件入る（新しい通知種別は作らぬ）');
SELECT is(
  (SELECT remind_at FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-000000000020'),
  ((((now() AT TIME ZONE 'Asia/Tokyo')::date + 2)::timestamp + interval '20 hours') AT TIME ZONE 'Asia/Tokyo'),
  'B-5: remind_at は予定日の前日 20:00 JST');
SELECT is((pg_temp.sep('e7000000-0000-4000-8000-000000000020', 'event', 'garbage', '燃えるごみ', 'prev_day_20')->>'status'),
          'replayed', 'B-6: 同じ内容の再送は replayed');
SELECT is((SELECT count(*) FROM event_purposes), 1::bigint, 'B-7: 再送で行が増えぬ');
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-000000000020'),
          1::bigint, 'B-8: 再送で通知設定が増えぬ（同じ予定に 2 件目は付かぬ）');
SELECT is((pg_temp.sep('e7000000-0000-4000-8000-000000000020', 'event', 'garbage', '古紙', 'keep')->>'status'),
          'saved', 'B-9: 名称の変更は saved');
SELECT is((SELECT garbage_kind FROM event_purposes WHERE target_key = 'e7000000-0000-4000-8000-000000000020'),
          '古紙', 'B-10: 変更後の名称を読める');

-- 同じ世帯のもう 1 人も読め、書ける
SELECT set_config('request.jwt.claims', '{"sub":"e7000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
SELECT is((SELECT count(*) FROM event_purposes), 1::bigint, 'B-11: 同じ世帯の member も読める');
SELECT is((pg_temp.sep('e7000000-0000-4000-8000-000000000020', 'event', 'garbage', '燃えるごみ', 'keep')->>'status'),
          'saved', 'B-12: 同じ世帯の member も書ける');
SELECT set_config('request.jwt.claims', '{"sub":"e7000000-0000-4000-8000-000000000003","role":"authenticated"}', true);

-- ── C / D. シリーズ既定と単回例外・通知 ─────────────────────
INSERT INTO fx SELECT 'series', pg_temp.sep('e7000000-0000-4000-8000-000000000011', 'series', 'garbage', 'プラスチック', 'prev_day_20');
SELECT is((SELECT value->>'status' FROM fx WHERE k = 'series'), 'saved', 'C-1: シリーズ全体の分類は saved');
SELECT results_eq(
  $$SELECT target_key, garbage_kind, remind_default FROM event_purposes WHERE scope = 'series'$$,
  $$VALUES ('e7000000-0000-4000-8000-000000000010'::text, 'プラスチック'::text, 'prev_day_20'::text)$$,
  'C-2: series 行の鍵は series_id（どの回から操作しても同じ 1 行）');
SELECT is(
  (SELECT remind_at FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-000000000010'),
  ((((now() AT TIME ZONE 'Asia/Tokyo')::date + 6)::timestamp + interval '20 hours') AT TIME ZONE 'Asia/Tokyo'),
  'D-1: 今日以降の回へ前日 20:00 JST の通知が付く（1 回目）');
SELECT is(
  (SELECT remind_kind FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-000000000012'),
  'prev_day_20', 'D-2: 今日以降の回へ通知が付く（3 回目）');
SELECT results_eq(
  $$SELECT remind_kind, remind_minutes_before FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-000000000011'$$,
  $$VALUES ('minutes'::text, 10)$$,
  'D-3: 既に在る通知時刻（10 分前）は上書きされぬ');
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-000000000013'),
          0::bigint, 'D-4: 今日より前の回には通知を足さぬ');

-- series_id == 初回の行 id。同じ文字列の鍵に series 行と event 行が共存できる
INSERT INTO fx SELECT 'exception', pg_temp.sep('e7000000-0000-4000-8000-000000000010', 'event', 'garbage', '粗大ごみ', 'keep');
SELECT is((SELECT value->>'status' FROM fx WHERE k = 'exception'), 'saved', 'C-3: この回だけ別の名称にする例外は saved');
SELECT results_eq(
  $$SELECT scope, garbage_kind FROM event_purposes
     WHERE target_key = 'e7000000-0000-4000-8000-000000000010' ORDER BY scope$$,
  $$VALUES ('event'::text, '粗大ごみ'::text), ('series'::text, 'プラスチック'::text)$$,
  'C-4: 鍵の文字列が同じでも scope が違えば別の行（シリーズ既定を例外が潰さぬ）');

-- この回だけ通常へ戻す（通知も止める）
SELECT is((pg_temp.sep('e7000000-0000-4000-8000-000000000012', 'event', 'normal', NULL, 'off')->>'status'),
          'saved', 'C-5: この回だけ通常へ戻す例外は saved');
SELECT results_eq(
  $$SELECT purpose, garbage_kind, reminder_opt_out FROM event_purposes
     WHERE scope = 'event' AND target_key = 'e7000000-0000-4000-8000-000000000012'$$,
  $$VALUES ('normal'::text, NULL::text, true)$$,
  'C-6: 例外行は normal・名称なし・通知は明示 OFF');
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-000000000012'),
          0::bigint, 'C-7: その回の通知だけが消える');
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-000000000010'),
          1::bigint, 'C-8: 他の回の通知は残る（対照）');

-- 戻す元のシリーズ既定が無い予定への「通常へ戻す」は何も書かぬ
SELECT is((pg_temp.sep('e7000000-0000-4000-8000-000000000020', 'event', 'normal', NULL, 'keep')->>'status'),
          'conflict', 'C-9: シリーズ既定の無い予定を「通常へ戻す」は conflict');
SELECT is((SELECT purpose FROM event_purposes WHERE target_key = 'e7000000-0000-4000-8000-000000000020'),
          'garbage', 'C-10: conflict は行を書き換えておらぬ');
SELECT throws_ok(
  $$SELECT pg_temp.sep('e7000000-0000-4000-8000-000000000020', 'series', 'garbage', '燃えるごみ', 'keep')$$,
  '22023', NULL, 'C-11: 単発の予定に「シリーズ全体」は選べぬ');

-- ── E. 個別 OFF の記録と解除（トリガ）、後から入った回 ───────
-- 既定 ON のシリーズの回の通知を、利用者が個別に「なし」にした
DELETE FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-000000000010';
SELECT is(
  (SELECT reminder_opt_out FROM event_purposes WHERE scope = 'event' AND target_key = 'e7000000-0000-4000-8000-000000000010'),
  true, 'E-1: 既定 ON のシリーズの回の通知を消すと、明示 OFF が記録される');
SELECT is(
  (SELECT garbage_kind FROM event_purposes WHERE scope = 'event' AND target_key = 'e7000000-0000-4000-8000-000000000010'),
  '粗大ごみ', 'E-2: 明示 OFF の記録は、その回の例外（名称）を壊さぬ');
-- 付け直すと印が降りる
INSERT INTO event_reminders(household_id, event_uid, remind_kind, remind_minutes_before)
VALUES ('e7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000010', 'minutes', 30);
SELECT is(
  (SELECT reminder_opt_out FROM event_purposes WHERE scope = 'event' AND target_key = 'e7000000-0000-4000-8000-000000000010'),
  false, 'E-3: 通知を付け直すと明示 OFF が降りる');
DELETE FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-000000000010';
SELECT is(
  (SELECT reminder_opt_out FROM event_purposes WHERE scope = 'event' AND target_key = 'e7000000-0000-4000-8000-000000000010'),
  true, 'E-4: もう一度消すと明示 OFF が立つ');
-- 既定の無い単発の予定の通知を消しても、印は作られぬ（対照）
DELETE FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-000000000020';
SELECT is(
  (SELECT reminder_opt_out FROM event_purposes WHERE scope = 'event' AND target_key = 'e7000000-0000-4000-8000-000000000020'),
  false, 'E-5: シリーズ既定の無い予定の通知を消しても明示 OFF は立たぬ（対照）');

-- 後から INSERT された回（利用者の INSERT = authenticated のまま。トリガは DEFINER）
INSERT INTO calendar_events(id, household_id, title, is_all_day, start_date, end_date, source, series_id) VALUES
  ('e7000000-0000-4000-8000-000000000014', 'e7000000-0000-4000-8000-000000000001', 'synthetic weekly later', true,
   '2099-03-10', '2099-03-10', 'native', 'e7000000-0000-4000-8000-000000000010'),
  ('e7000000-0000-4000-8000-000000000015', 'e7000000-0000-4000-8000-000000000001', 'synthetic weekly late past', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date - 1, (now() AT TIME ZONE 'Asia/Tokyo')::date - 1, 'native', 'e7000000-0000-4000-8000-000000000010'),
  ('e7000000-0000-4000-8000-000000000022', 'e7000000-0000-4000-8000-000000000001', 'synthetic other series', true,
   '2099-03-10', '2099-03-10', 'native', 'e7000000-0000-4000-8000-000000000023'),
  ('e7000000-0000-4000-8000-000000000021', 'e7000000-0000-4000-8000-000000000001', 'synthetic later single', true,
   '2099-03-10', '2099-03-10', 'native', NULL);
SELECT is(
  (SELECT remind_at FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-000000000014'),
  '2099-03-09T11:00:00Z'::timestamptz,
  'E-6: 後から INSERT された将来の回に前日 20:00 JST（= 11:00 UTC）の通知が付く');
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-000000000015'),
          0::bigint, 'E-7: 後から INSERT された過去の回には付かぬ');
SELECT is((SELECT count(*) FROM event_reminders
            WHERE event_uid IN ('e7000000-0000-4000-8000-000000000022', 'e7000000-0000-4000-8000-000000000021')),
          0::bigint, 'E-8: 分類しておらぬシリーズ・単発の INSERT には付かぬ（対照）');

-- シリーズ既定をもう一度適用しても、明示 OFF の回と通常へ戻した回には付かぬ
SELECT is((pg_temp.sep('e7000000-0000-4000-8000-000000000011', 'series', 'garbage', 'プラスチック', 'prev_day_20')->>'status'),
          'replayed', 'E-9: 同じシリーズ既定の再送は replayed');
SELECT is((SELECT count(*) FROM event_reminders
            WHERE event_uid IN ('e7000000-0000-4000-8000-000000000010', 'e7000000-0000-4000-8000-000000000012')),
          0::bigint, 'E-10: 既定の再適用は、明示 OFF の回と通常へ戻した回に通知を復活させぬ');
SELECT is((SELECT count(*) FROM event_purposes WHERE scope = 'series'), 1::bigint,
          'E-11: 再送で series 行が増えぬ');

-- ── F. Google の予定と 410 完全再同期 ───────────────────────
INSERT INTO fx SELECT 'google', pg_temp.sep(
  (SELECT id FROM calendar_events WHERE google_event_id = 'grec_1'), 'series', 'garbage', '資源', 'prev_day_20');
SELECT is((SELECT value->>'status' FROM fx WHERE k = 'google'), 'saved', 'F-1: Google 由来の予定も分類できる');
SELECT is((SELECT target_key FROM event_purposes WHERE scope = 'series' AND garbage_kind = '資源'),
          'synthetic-cal@example.invalid|grec', 'F-2: google の series 鍵は calendar_id|recurring_event_id');
SELECT is((SELECT count(*) FROM event_reminders
            WHERE event_uid IN ('synthetic-cal@example.invalid|grec_1', 'synthetic-cal@example.invalid|grec_2')),
          2::bigint, 'F-3: google シリーズの今日以降の 2 回へ通知が付く');
SELECT is((pg_temp.sep((SELECT id FROM calendar_events WHERE google_event_id = 'gsingle'),
                              'event', 'garbage', '古紙', 'keep')->>'status'),
          'saved', 'F-4: google の単発も分類できる');
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'synthetic-cal@example.invalid|gsingle'),
          0::bigint, 'F-5: 「通知設定は変えない」は通知を足さぬ');
-- 2 回目の通知を個別に止める
DELETE FROM event_reminders WHERE event_uid = 'synthetic-cal@example.invalid|grec_2';
SELECT results_eq(
  $$SELECT purpose, reminder_opt_out FROM event_purposes
     WHERE scope = 'event' AND target_key = 'synthetic-cal@example.invalid|grec_2'$$,
  $$VALUES (NULL::text, true)$$,
  'F-6: 用途を持たぬ回でも、明示 OFF だけの行が記録される');

-- 410: その購読の google 行を丸ごと DELETE し、新しい UUID で INSERT し直す（service role 相当）
RESET ROLE;
INSERT INTO old_google SELECT google_event_id, id FROM calendar_events
 WHERE household_id = 'e7000000-0000-4000-8000-000000000001' AND source = 'google';
DELETE FROM calendar_events
 WHERE household_id = 'e7000000-0000-4000-8000-000000000001' AND source = 'google';
SELECT is((SELECT count(*) FROM calendar_events
            WHERE household_id = 'e7000000-0000-4000-8000-000000000001' AND source = 'google'),
          0::bigint, 'F-7: 410 の窓では google 行が 1 つも無い');
SELECT is((SELECT count(*) FROM event_purposes WHERE target_key LIKE 'synthetic-cal@example.invalid|%'),
          3::bigint, 'F-8: 予定の行が消えても分類は cascade せぬ（series 1 + 単発 1 + 明示 OFF 1）');
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'synthetic-cal@example.invalid|grec_1'),
          1::bigint, 'F-9: 通知設定も残る');
INSERT INTO calendar_events(household_id, title, is_all_day, start_date, end_date, source,
                            google_calendar_id, google_event_id, recurring_event_id) VALUES
  ('e7000000-0000-4000-8000-000000000001', 'synthetic google 1', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date + 5,  (now() AT TIME ZONE 'Asia/Tokyo')::date + 5,  'google',
   'synthetic-cal@example.invalid', 'grec_1', 'grec'),
  ('e7000000-0000-4000-8000-000000000001', 'synthetic google 2', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date + 12, (now() AT TIME ZONE 'Asia/Tokyo')::date + 12, 'google',
   'synthetic-cal@example.invalid', 'grec_2', 'grec'),
  ('e7000000-0000-4000-8000-000000000001', 'synthetic google 3', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date + 19, (now() AT TIME ZONE 'Asia/Tokyo')::date + 19, 'google',
   'synthetic-cal@example.invalid', 'grec_3', 'grec'),
  ('e7000000-0000-4000-8000-000000000001', 'synthetic google single', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date + 6,  (now() AT TIME ZONE 'Asia/Tokyo')::date + 6,  'google',
   'synthetic-cal@example.invalid', 'gsingle', NULL);
SELECT is((SELECT count(*) FROM calendar_events c JOIN old_google o USING (google_event_id)
            WHERE c.household_id = 'e7000000-0000-4000-8000-000000000001' AND c.id <> o.id),
          3::bigint, 'F-10: 入れ直した 3 行は全て新しい行 id（行 id で結んでおれば切れておった）');
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'synthetic-cal@example.invalid|grec_1'),
          1::bigint, 'F-11: 入れ直しで通知設定は 1 件のまま（二重にならぬ）');
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'synthetic-cal@example.invalid|grec_2'),
          0::bigint, 'F-12: 明示 OFF の回に通知が復活せぬ');
SELECT is((SELECT remind_kind FROM event_reminders WHERE event_uid = 'synthetic-cal@example.invalid|grec_3'),
          'prev_day_20', 'F-13: 入れ直しで初めて届いた将来の回には既定の通知が付く');
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'synthetic-cal@example.invalid|gsingle'),
          0::bigint, 'F-14: 既定を持たぬ単発には付かぬ（対照）');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"e7000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
SELECT results_eq(
  $$SELECT p.garbage_kind FROM calendar_events c
      JOIN event_purposes p ON p.scope = 'series'
       AND p.target_key = c.google_calendar_id || '|' || c.recurring_event_id
     WHERE c.google_event_id = 'grec_3'$$,
  $$VALUES ('資源'::text)$$,
  'F-15: 入れ直した後の回も、同じ鍵でシリーズの分類へ辿れる');
SELECT is((SELECT garbage_kind FROM event_purposes WHERE scope = 'event' AND target_key = 'synthetic-cal@example.invalid|gsingle'),
          '古紙', 'F-16: 単発の分類も入れ直しをまたいで残る');

-- ── G. series OFF・解除・削除・掃除 ─────────────────────────
INSERT INTO fx SELECT 'opt_out_before', to_jsonb((SELECT count(*) FROM event_purposes WHERE reminder_opt_out));
INSERT INTO fx SELECT 'series_off', pg_temp.sep('e7000000-0000-4000-8000-000000000011', 'series', 'garbage', 'プラスチック', 'off');
SELECT is((SELECT value->>'status' FROM fx WHERE k = 'series_off'), 'saved', 'G-1: series OFF は saved');
SELECT is((SELECT remind_default FROM event_purposes WHERE scope = 'series' AND target_key = 'e7000000-0000-4000-8000-000000000010'),
          'none', 'G-2: シリーズ既定が none になる（分類は残る）');
SELECT is((SELECT count(*) FROM event_reminders r JOIN calendar_events c
             ON c.household_id = r.household_id AND c.event_uid = r.event_uid
            WHERE c.series_id = 'e7000000-0000-4000-8000-000000000010'),
          0::bigint, 'G-3: 今日以降の回の通知が全て消える（10 分前の回も。利用者の明示操作）');
SELECT is((SELECT count(*) FROM event_purposes WHERE reminder_opt_out),
          (SELECT (value #>> '{}')::bigint FROM fx WHERE k = 'opt_out_before'),
          'G-4: series OFF は回ごとの明示 OFF を新しく作らぬ');
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'synthetic-cal@example.invalid|grec_1'),
          1::bigint, 'G-5: 別のシリーズの通知には触れぬ（対照）');
INSERT INTO calendar_events(id, household_id, title, is_all_day, start_date, end_date, source, series_id) VALUES
  ('e7000000-0000-4000-8000-000000000016', 'e7000000-0000-4000-8000-000000000001', 'synthetic weekly after off', true,
   '2099-03-17', '2099-03-17', 'native', 'e7000000-0000-4000-8000-000000000010');
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-000000000016'),
          0::bigint, 'G-6: series OFF の後に入った回には通知が付かぬ');

-- 予定の削除で分類は cascade せぬ。掃除は削除した当人の経路だけが呼ぶ
DELETE FROM calendar_events WHERE id = 'e7000000-0000-4000-8000-000000000012';
SELECT is((SELECT count(*) FROM event_purposes WHERE scope = 'event' AND target_key = 'e7000000-0000-4000-8000-000000000012'),
          1::bigint, 'G-7: 予定の行を消しても分類の行は残る（cascade せぬ）');
SELECT is(cleanup_deleted_event_purposes(ARRAY['e7000000-0000-4000-8000-000000000010']::uuid[], 'e7000000-0000-4000-8000-000000000010'),
          0, 'G-8: 予定がまだ在る鍵は掃除されぬ（event 行も series 行も）');
SELECT is((SELECT count(*) FROM event_purposes WHERE target_key = 'e7000000-0000-4000-8000-000000000010'),
          2::bigint, 'G-9: 掃除されなかった 2 行が残っておる');
SELECT is(cleanup_deleted_event_purposes(ARRAY['e7000000-0000-4000-8000-000000000012']::uuid[], NULL),
          1, 'G-10: 削除した予定の分類だけが掃除される');
SELECT is((SELECT count(*) FROM event_purposes WHERE scope = 'event' AND target_key = 'e7000000-0000-4000-8000-000000000012'),
          0::bigint, 'G-11: 掃除後は行が無い');

-- 手動整理: 予定が在る分類は消せぬ / 予定が無い分類だけ消せる
INSERT INTO fx SELECT 'single_row', to_jsonb((SELECT id FROM event_purposes WHERE scope = 'event' AND target_key = 'e7000000-0000-4000-8000-000000000020'));
SELECT is((delete_orphan_event_purpose((SELECT (value #>> '{}')::uuid FROM fx WHERE k = 'single_row'))->>'status'),
          'conflict', 'G-12: 予定が在る分類の手動整理は conflict（消さぬ）');
SELECT is((SELECT count(*) FROM event_purposes WHERE target_key = 'e7000000-0000-4000-8000-000000000020'),
          1::bigint, 'G-13: conflict の後も行は残る');
DELETE FROM calendar_events WHERE id = 'e7000000-0000-4000-8000-000000000020';
SELECT is((delete_orphan_event_purpose((SELECT (value #>> '{}')::uuid FROM fx WHERE k = 'single_row'))->>'status'),
          'saved', 'G-14: 予定が見つからぬ分類は手動で整理できる');
SELECT is((delete_orphan_event_purpose((SELECT (value #>> '{}')::uuid FROM fx WHERE k = 'single_row'))->>'status'),
          'replayed', 'G-15: 整理の再送は replayed');

-- 解除
SELECT is((pg_temp.sep('e7000000-0000-4000-8000-000000000010', 'event', 'clear', NULL, 'keep')->>'status'),
          'saved', 'G-16: 単回例外の解除は saved');
SELECT results_eq(
  $$SELECT purpose, reminder_opt_out FROM event_purposes
     WHERE scope = 'event' AND target_key = 'e7000000-0000-4000-8000-000000000010'$$,
  $$VALUES (NULL::text, true)$$,
  'G-17: 例外を解除しても、その回の通知の明示 OFF は残る（「通知設定は変えない」）');
INSERT INTO fx SELECT 'series_clear', pg_temp.sep('e7000000-0000-4000-8000-000000000011', 'series', 'clear', NULL, 'keep');
SELECT is((SELECT value->>'status' FROM fx WHERE k = 'series_clear'), 'saved', 'G-18: シリーズの解除は saved');
SELECT ok((SELECT value->'purpose' = 'null'::jsonb FROM fx WHERE k = 'series_clear'), 'G-19: 解除後の purpose は null');
SELECT is((SELECT count(*) FROM event_purposes WHERE scope = 'series' AND target_key = 'e7000000-0000-4000-8000-000000000010'),
          0::bigint, 'G-20: series 行が消える');
SELECT is((pg_temp.sep('e7000000-0000-4000-8000-000000000011', 'series', 'clear', NULL, 'keep')->>'status'),
          'replayed', 'G-21: 解除の再送は replayed');
SELECT is((SELECT count(*) FROM event_purposes WHERE scope = 'series' AND garbage_kind = '資源'),
          1::bigint, 'G-22: 別のシリーズの分類は残る（対照）');

-- ── status は「今回何かを書いたか」を言う（分類の行が同じでも、通知を書けば saved）──
SELECT is((pg_temp.sep('e7000000-0000-4000-8000-000000000021', 'event', 'garbage', '古紙', 'keep')->>'status'),
          'saved', 'S-1: 通知設定を変えぬ分類は saved（通知は足さぬ）');
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-000000000021'),
          0::bigint, 'S-2: (前提) まだ通知は無い');
SELECT is((pg_temp.sep('e7000000-0000-4000-8000-000000000021', 'event', 'garbage', '古紙', 'prev_day_20')->>'status'),
          'saved', 'S-3: 分類の行が同じでも、通知を足した保存は saved（replayed と偽らぬ）');
SELECT is((pg_temp.sep('e7000000-0000-4000-8000-000000000021', 'event', 'garbage', '古紙', 'prev_day_20')->>'status'),
          'replayed', 'S-4: もう一度送ると、分類も通知も書かぬゆえ replayed');
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-000000000021'),
          1::bigint, 'S-5: 通知設定は 1 件のまま');

-- ── I. 通知の停止の範囲: シリーズ全体 / この回だけ（世帯 C・シリーズ C1）──────
-- 「シリーズ全体を止めた」は series 行の既定へ、「この回だけ止めた」は event 行の印へ記録する。
-- シリーズを前日通知へ戻せば、前者は一様に戻り、後者は止めたまま。
SELECT set_config('request.jwt.claims', '{"sub":"e7000000-0000-4000-8000-0000000000c1","role":"authenticated"}', true);
SELECT is((pg_temp.sep('e7000000-0000-4000-8000-00000000c110', 'series', 'garbage', '燃えるごみ', 'prev_day_20')->>'status'),
          'saved', 'I-1: (前提) シリーズ C1 を前日通知つきで分類');
SELECT is((SELECT count(*) FROM event_reminders WHERE household_id = 'e7000000-0000-4000-8000-0000000000c0'),
          3::bigint, 'I-2: (前提) 今日以降の 3 回に通知が付く');
-- この回だけ止める（3 回目。予定シートの通知「なし」= 1 行の DELETE）
DELETE FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-00000000c112';
SELECT results_eq(
  $$SELECT target_key, purpose, reminder_opt_out FROM event_purposes
     WHERE household_id = 'e7000000-0000-4000-8000-0000000000c0' AND scope = 'event'$$,
  $$VALUES ('e7000000-0000-4000-8000-00000000c112'::text, NULL::text, true)$$,
  'I-3: 1 回だけの停止は、その回の明示 OFF として記録される');
SELECT is((SELECT remind_default FROM event_purposes WHERE scope = 'series' AND target_key = 'e7000000-0000-4000-8000-00000000c110'),
          'prev_day_20', 'I-4: 1 回だけの停止は、シリーズの既定を変えぬ');
INSERT INTO fx SELECT 'c1_before_stop', to_jsonb((SELECT updated_at FROM event_purposes
  WHERE scope = 'series' AND target_key = 'e7000000-0000-4000-8000-00000000c110'));
-- 予定シートの「シリーズ全体・なし」= そのシリーズの全ての回の通知を 1 文で消す（setEventReminder）
DELETE FROM event_reminders
 WHERE household_id = 'e7000000-0000-4000-8000-0000000000c0'
   AND event_uid IN ('e7000000-0000-4000-8000-00000000c110', 'e7000000-0000-4000-8000-00000000c111',
                     'e7000000-0000-4000-8000-00000000c112', 'e7000000-0000-4000-8000-00000000c113');
SELECT is((SELECT count(*) FROM event_purposes
            WHERE household_id = 'e7000000-0000-4000-8000-0000000000c0' AND reminder_opt_out),
          1::bigint, 'I-5: シリーズ全体の停止は、回ごとの明示 OFF を新しく作らぬ（個別に止めた 1 回だけが残る）');
SELECT is((SELECT remind_default FROM event_purposes WHERE scope = 'series' AND target_key = 'e7000000-0000-4000-8000-00000000c110'),
          'none', 'I-6: シリーズ全体の停止は、series 行の既定へ記録される');
INSERT INTO calendar_events(id, household_id, title, is_all_day, start_date, end_date, source, series_id) VALUES
  ('e7000000-0000-4000-8000-00000000c114', 'e7000000-0000-4000-8000-0000000000c0', 'synthetic c1 later', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date + 28, (now() AT TIME ZONE 'Asia/Tokyo')::date + 28, 'native', 'e7000000-0000-4000-8000-00000000c110');
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-00000000c114'),
          0::bigint, 'I-7: シリーズ全体を止めた後に入った回には通知が付かぬ');
-- 停止の前の版で組んだ操作（古い画面・古い控え）は適用せぬ
SELECT is((save_event_purpose('e7000000-0000-4000-8000-00000000c110', 'series', 'garbage', '燃えるごみ', 'prev_day_20',
             (SELECT (value #>> '{}')::timestamptz FROM fx WHERE k = 'c1_before_stop'), NULL)->>'status'),
          'conflict', 'I-8: 停止の前の画面からのシリーズ ON は conflict（家族の停止を黙って戻さぬ）');
SELECT is((SELECT count(*) FROM event_reminders WHERE household_id = 'e7000000-0000-4000-8000-0000000000c0'),
          0::bigint, 'I-9: conflict は通知を 1 件も足しておらぬ');
-- 読み直した画面からのシリーズ ON
SELECT is((pg_temp.sep('e7000000-0000-4000-8000-00000000c110', 'series', 'garbage', '燃えるごみ', 'prev_day_20')->>'status'),
          'saved', 'I-10: 読み直した画面からのシリーズ ON は saved');
SELECT is((SELECT count(*) FROM event_reminders
            WHERE event_uid IN ('e7000000-0000-4000-8000-00000000c110', 'e7000000-0000-4000-8000-00000000c111',
                                'e7000000-0000-4000-8000-00000000c114')),
          3::bigint, 'I-11: シリーズ ON で、シリーズ全体の停止で消えた回（と後から入った回）の通知が戻る');
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-00000000c112'),
          0::bigint, 'I-12: 個別に止めた回には戻さぬ');
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-00000000c113'),
          0::bigint, 'I-13: 過ぎた回には付けぬ');
SELECT is((SELECT remind_default FROM event_purposes WHERE scope = 'series' AND target_key = 'e7000000-0000-4000-8000-00000000c110'),
          'prev_day_20', 'I-14: シリーズの既定が前日通知へ戻る');
-- ごみの画面からのシリーズ OFF → ON
SELECT is((pg_temp.sep('e7000000-0000-4000-8000-00000000c111', 'series', 'garbage', '燃えるごみ', 'off')->>'status'),
          'saved', 'I-15: RPC のシリーズ OFF は saved');
SELECT is((SELECT count(*) FROM event_reminders WHERE household_id = 'e7000000-0000-4000-8000-0000000000c0'),
          0::bigint, 'I-16: 今日以降の全ての回の通知が消える');
SELECT is((SELECT count(*) FROM event_purposes
            WHERE household_id = 'e7000000-0000-4000-8000-0000000000c0' AND reminder_opt_out),
          1::bigint, 'I-17: RPC のシリーズ OFF も、回ごとの明示 OFF を新しく作らぬ');
SELECT is((pg_temp.sep('e7000000-0000-4000-8000-00000000c111', 'series', 'garbage', '燃えるごみ', 'prev_day_20')->>'status'),
          'saved', 'I-18: OFF の後のシリーズ ON は saved');
SELECT is((SELECT count(*) FROM event_reminders
            WHERE event_uid IN ('e7000000-0000-4000-8000-00000000c110', 'e7000000-0000-4000-8000-00000000c111',
                                'e7000000-0000-4000-8000-00000000c114')),
          3::bigint, 'I-19: OFF → ON で通知が戻る');
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-00000000c112'),
          0::bigint, 'I-20: OFF → ON でも、個別に止めた回には戻さぬ');

-- ── J. 日付が動いた回（トリガ (a) の UPDATE 側。シリーズ C1 は既定 ON）────────
UPDATE calendar_events
   SET start_date = (now() AT TIME ZONE 'Asia/Tokyo')::date + 35, end_date = (now() AT TIME ZONE 'Asia/Tokyo')::date + 35
 WHERE id = 'e7000000-0000-4000-8000-00000000c113';
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-00000000c113'),
          1::bigint, 'J-1: 過ぎた日から今日以降へ動いた回に、既定の前日通知が付く');
SELECT is(
  (SELECT remind_at FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-00000000c113'),
  ((((now() AT TIME ZONE 'Asia/Tokyo')::date + 34)::timestamp + interval '20 hours') AT TIME ZONE 'Asia/Tokyo'),
  'J-2: remind_at は動いた先の日の前日 20:00 JST');
UPDATE calendar_events
   SET start_date = (now() AT TIME ZONE 'Asia/Tokyo')::date + 15, end_date = (now() AT TIME ZONE 'Asia/Tokyo')::date + 15
 WHERE id = 'e7000000-0000-4000-8000-00000000c111';
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-00000000c111'),
          1::bigint, 'J-3: 通知の付いた回を動かしても 1 件のまま（二重にならぬ）');
UPDATE calendar_events
   SET start_date = (now() AT TIME ZONE 'Asia/Tokyo')::date + 22, end_date = (now() AT TIME ZONE 'Asia/Tokyo')::date + 22
 WHERE id = 'e7000000-0000-4000-8000-00000000c112';
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-00000000c112'),
          0::bigint, 'J-4: 個別に止めた回は、動かしても通知が付かぬ');
-- 分類しておらぬシリーズ（C3）の過ぎた回を動かしても付かぬ（対照）
INSERT INTO calendar_events(id, household_id, title, is_all_day, start_date, end_date, source, series_id) VALUES
  ('e7000000-0000-4000-8000-00000000c133', 'e7000000-0000-4000-8000-0000000000c0', 'synthetic c3 past', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date - 2, (now() AT TIME ZONE 'Asia/Tokyo')::date - 2, 'native', 'e7000000-0000-4000-8000-00000000c130');
UPDATE calendar_events
   SET start_date = (now() AT TIME ZONE 'Asia/Tokyo')::date + 25, end_date = (now() AT TIME ZONE 'Asia/Tokyo')::date + 25
 WHERE id = 'e7000000-0000-4000-8000-00000000c133';
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-00000000c133'),
          0::bigint, 'J-5: 分類しておらぬシリーズの回を動かしても付かぬ（対照）');
-- 今日以降どうしの移動では足さぬ（通知も印も無い回を作って確かめる。印を立てずに消すため、
-- RPC がシリーズ全体の停止で使う合図をこの 1 文にだけ立てる）
SELECT set_config('irori.event_purpose_series_op', 'on', true);
DELETE FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-00000000c114';
SELECT set_config('irori.event_purpose_series_op', 'off', true);
SELECT is((SELECT count(*) FROM event_purposes WHERE scope = 'event' AND target_key = 'e7000000-0000-4000-8000-00000000c114'),
          0::bigint, 'J-6: (前提) 合図の間の DELETE は、回ごとの明示 OFF を記録せぬ');
UPDATE calendar_events
   SET start_date = (now() AT TIME ZONE 'Asia/Tokyo')::date + 29, end_date = (now() AT TIME ZONE 'Asia/Tokyo')::date + 29
 WHERE id = 'e7000000-0000-4000-8000-00000000c114';
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-00000000c114'),
          0::bigint, 'J-7: 今日以降どうしの移動では通知を足さぬ（日付を直しただけで通知を付けぬ）');

-- ── K / L. 通知の既定なしのシリーズ（C2）での個別の停止と、この回の通知だけを止める操作 ──
SELECT is((pg_temp.sep('e7000000-0000-4000-8000-00000000c120', 'series', 'garbage', '古紙', 'keep')->>'status'),
          'saved', 'K-1: (前提) シリーズ C2 を通知の既定なしで分類');
SELECT is((SELECT remind_default FROM event_purposes WHERE scope = 'series' AND target_key = 'e7000000-0000-4000-8000-00000000c120'),
          'none', 'K-2: (前提) 既定は none');
-- 1 回目に通知を付けて、外す（個別の明示 OFF）
INSERT INTO event_reminders(household_id, event_uid, remind_kind, remind_minutes_before)
VALUES ('e7000000-0000-4000-8000-0000000000c0', 'e7000000-0000-4000-8000-00000000c120', 'minutes', 30);
DELETE FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-00000000c120';
SELECT is((SELECT reminder_opt_out FROM event_purposes WHERE scope = 'event' AND target_key = 'e7000000-0000-4000-8000-00000000c120'),
          true, 'K-3: 既定 none のシリーズでも、個別に外した通知は明示 OFF として記録される');
-- 通知が 1 回にしか無いシリーズを RPC で OFF にしても、その回を個別 OFF にせぬ
INSERT INTO event_reminders(household_id, event_uid, remind_kind, remind_minutes_before)
VALUES ('e7000000-0000-4000-8000-0000000000c0', 'e7000000-0000-4000-8000-00000000c121', 'minutes', 10);
SELECT is((pg_temp.sep('e7000000-0000-4000-8000-00000000c120', 'series', 'garbage', '古紙', 'off')->>'status'),
          'saved', 'K-4: 通知が 1 回にだけ在るシリーズの RPC OFF は saved（その 1 件を消す）');
SELECT is((SELECT count(*) FROM event_purposes WHERE scope = 'event' AND target_key = 'e7000000-0000-4000-8000-00000000c121'),
          0::bigint, 'K-5: RPC のシリーズ OFF は、消えた通知が 1 件でも回ごとの明示 OFF を作らぬ');
-- この回の通知だけを止める（用途なし + 明示 OFF。分類はシリーズのまま）
SELECT is((pg_temp.sep('e7000000-0000-4000-8000-00000000c121', 'event', 'clear', NULL, 'off')->>'status'),
          'saved', 'L-1: シリーズ既定の回の「この回の通知だけ止める」は saved');
SELECT results_eq(
  $$SELECT purpose, garbage_kind, reminder_opt_out FROM event_purposes
     WHERE scope = 'event' AND target_key = 'e7000000-0000-4000-8000-00000000c121'$$,
  $$VALUES (NULL::text, NULL::text, true)$$,
  'L-2: 用途を持たぬ明示 OFF だけの行になる（この回だけの分類は作らぬ = シリーズから分岐せぬ）');
SELECT is((pg_temp.sep('e7000000-0000-4000-8000-00000000c121', 'event', 'clear', NULL, 'off')->>'status'),
          'replayed', 'L-3: 同じ操作の再送は replayed');
INSERT INTO calendar_events(id, household_id, title, is_all_day, start_date, end_date, source, series_id) VALUES
  ('e7000000-0000-4000-8000-00000000c123', 'e7000000-0000-4000-8000-0000000000c0', 'synthetic c2 later', true,
   (now() AT TIME ZONE 'Asia/Tokyo')::date + 19, (now() AT TIME ZONE 'Asia/Tokyo')::date + 19, 'native', 'e7000000-0000-4000-8000-00000000c120');
SELECT is((pg_temp.sep('e7000000-0000-4000-8000-00000000c120', 'series', 'garbage', '古紙', 'prev_day_20')->>'status'),
          'saved', 'K-6: シリーズを前日通知へ切り替える');
SELECT is((SELECT count(*) FROM event_reminders
            WHERE event_uid IN ('e7000000-0000-4000-8000-00000000c120', 'e7000000-0000-4000-8000-00000000c121')),
          0::bigint, 'K-7: 個別に止めた 2 回（外した回・この回だけ止めた回）には付け直さぬ');
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-00000000c123'),
          1::bigint, 'K-8: 止めておらぬ回には付く（対照）');
SELECT results_eq(
  $$SELECT scope, garbage_kind FROM event_purposes
     WHERE household_id = 'e7000000-0000-4000-8000-0000000000c0' AND purpose = 'garbage'
       AND (target_key = 'e7000000-0000-4000-8000-00000000c120' OR target_key = 'e7000000-0000-4000-8000-00000000c121')$$,
  $$VALUES ('series'::text, '古紙'::text)$$,
  'L-4: ごみの分類は series の 1 行だけ（通知を止めた回に、この回だけの分類は生えておらぬ）');

-- ── M. 版の照合: 古い画面・古い控えの再送が、家族の新しい分類と通知を消さぬ（シリーズ C3）──
SELECT is((save_event_purpose('e7000000-0000-4000-8000-00000000c130', 'series', 'garbage', '燃えるごみ', 'prev_day_20', NULL, NULL)->>'status'),
          'saved', 'M-1: 未分類を見ておった画面からの分類は saved（見ておった版は NULL）');
INSERT INTO fx SELECT 'c3_v1', to_jsonb((SELECT updated_at FROM event_purposes
  WHERE scope = 'series' AND target_key = 'e7000000-0000-4000-8000-00000000c130'));
SELECT is((save_event_purpose('e7000000-0000-4000-8000-00000000c130', 'series', 'clear', NULL, 'off',
             (SELECT (value #>> '{}')::timestamptz FROM fx WHERE k = 'c3_v1'), NULL)->>'status'),
          'saved', 'M-2: 見ておった版が今の版と同じなら適用する（解除 + 通知を止める）');
-- 家族（c2）が同じシリーズを分類し直し、前日通知を付ける
SELECT set_config('request.jwt.claims', '{"sub":"e7000000-0000-4000-8000-0000000000c2","role":"authenticated"}', true);
SELECT is((save_event_purpose('e7000000-0000-4000-8000-00000000c131', 'series', 'garbage', '資源', 'prev_day_20', NULL, NULL)->>'status'),
          'saved', 'M-3: (前提) 家族が同じシリーズを「資源」に分類し、前日通知を付ける');
-- c1 が、応答を失った「解除 + 通知を止める」を同じ内容（同じ版）で送り直す
SELECT set_config('request.jwt.claims', '{"sub":"e7000000-0000-4000-8000-0000000000c1","role":"authenticated"}', true);
INSERT INTO fx SELECT 'c3_stale', save_event_purpose('e7000000-0000-4000-8000-00000000c130', 'series', 'clear', NULL, 'off',
  (SELECT (value #>> '{}')::timestamptz FROM fx WHERE k = 'c3_v1'), NULL);
SELECT is((SELECT value->>'status' FROM fx WHERE k = 'c3_stale'), 'conflict',
          'M-4: 古い控えの再送（解除 + 通知を止める）は conflict');
SELECT is((SELECT value->'purpose'->>'garbage_kind' FROM fx WHERE k = 'c3_stale'), '資源',
          'M-5: conflict は今の行を返す');
SELECT is((SELECT count(*) FROM event_purposes
            WHERE scope = 'series' AND target_key = 'e7000000-0000-4000-8000-00000000c130' AND garbage_kind = '資源'),
          1::bigint, 'M-6: 家族の分類は消えておらぬ');
SELECT is((SELECT count(*) FROM event_reminders
            WHERE event_uid IN ('e7000000-0000-4000-8000-00000000c130', 'e7000000-0000-4000-8000-00000000c131',
                                'e7000000-0000-4000-8000-00000000c132')),
          3::bigint, 'M-7: 家族の付けた通知も 1 件も消えておらぬ');
SELECT is((save_event_purpose('e7000000-0000-4000-8000-00000000c130', 'series', 'garbage', '燃えるごみ', 'prev_day_20', NULL, NULL)->>'status'),
          'conflict', 'M-8: 逆向き — 未分類を見ておった古い画面からの上書きも conflict');
SELECT is((SELECT garbage_kind FROM event_purposes WHERE scope = 'series' AND target_key = 'e7000000-0000-4000-8000-00000000c130'),
          '資源', 'M-9: 名称は書き換わっておらぬ');
-- 応答を失った自分の再送は replayed（版は自分の最初の送信で進んでおるが、求める状態は既に成り立つ）
SELECT set_config('request.jwt.claims', '{"sub":"e7000000-0000-4000-8000-0000000000c2","role":"authenticated"}', true);
SELECT is((save_event_purpose('e7000000-0000-4000-8000-00000000c131', 'series', 'garbage', '資源', 'prev_day_20', NULL, NULL)->>'status'),
          'replayed', 'M-10: 応答を失った自分の再送は replayed（conflict と言わぬ）');
SELECT set_config('request.jwt.claims', '{"sub":"e7000000-0000-4000-8000-0000000000c1","role":"authenticated"}', true);
SELECT is((pg_temp.sep('e7000000-0000-4000-8000-00000000c130', 'series', 'garbage', '古紙', 'keep')->>'status'),
          'saved', 'M-11: 読み直した版からの変更は saved（対照）');
INSERT INTO fx SELECT 'c3_v3', to_jsonb((SELECT updated_at FROM event_purposes
  WHERE scope = 'series' AND target_key = 'e7000000-0000-4000-8000-00000000c130'));
-- event 行の版: 家族がこの回だけ別の名称にした後、それを見ておらぬ画面からの操作
SELECT set_config('request.jwt.claims', '{"sub":"e7000000-0000-4000-8000-0000000000c2","role":"authenticated"}', true);
SELECT is((save_event_purpose('e7000000-0000-4000-8000-00000000c130', 'event', 'garbage', '粗大ごみ', 'keep',
             (SELECT (value #>> '{}')::timestamptz FROM fx WHERE k = 'c3_v3'), NULL)->>'status'),
          'saved', 'M-12: (前提) 家族がこの回だけ「粗大ごみ」にする');
SELECT set_config('request.jwt.claims', '{"sub":"e7000000-0000-4000-8000-0000000000c1","role":"authenticated"}', true);
SELECT is((save_event_purpose('e7000000-0000-4000-8000-00000000c130', 'event', 'normal', NULL, 'off',
             (SELECT (value #>> '{}')::timestamptz FROM fx WHERE k = 'c3_v3'), NULL)->>'status'),
          'conflict', 'M-13: この回の例外を見ておらぬ画面からの「通常へ戻す + 通知を止める」は conflict');
SELECT results_eq(
  $$SELECT purpose, garbage_kind, reminder_opt_out FROM event_purposes
     WHERE scope = 'event' AND target_key = 'e7000000-0000-4000-8000-00000000c130'$$,
  $$VALUES ('garbage'::text, '粗大ごみ'::text, false)$$,
  'M-14: 家族の例外は書き換わっておらぬ（トリガが動かした印ごと巻き戻る）');
SELECT is((SELECT count(*) FROM event_reminders WHERE event_uid = 'e7000000-0000-4000-8000-00000000c130'),
          1::bigint, 'M-15: その回の通知も消えておらぬ');
SELECT is((save_event_purpose('e7000000-0000-4000-8000-00000000c130', 'series', 'garbage', 'びん・缶', 'keep',
             (SELECT (value #>> '{}')::timestamptz FROM fx WHERE k = 'c3_v3'), NULL)->>'status'),
          'saved', 'M-16: シリーズ全体の操作は、起点の回の event 行の版に左右されぬ（series 行の版だけを見る）');
SELECT is((save_event_purpose('e7000000-0000-4000-8000-00000000c131', 'event', 'garbage', '古紙', 'keep',
             (SELECT (value #>> '{}')::timestamptz FROM fx WHERE k = 'c3_v3'), NULL)->>'status'),
          'conflict', 'M-17: シリーズ既定が変わった後の、古い画面からの「この回だけ」の分類は conflict');
SELECT is((SELECT count(*) FROM event_purposes WHERE scope = 'event' AND target_key = 'e7000000-0000-4000-8000-00000000c131'),
          0::bigint, 'M-18: conflict は行を作っておらぬ');

-- 以降は世帯 A の利用者へ戻る
SELECT set_config('request.jwt.claims', '{"sub":"e7000000-0000-4000-8000-000000000003","role":"authenticated"}', true);

-- ── 入力の検証・対象外 ──────────────────────────────────────
SELECT throws_ok($$SELECT pg_temp.sep('e7000000-0000-4000-8000-000000000025', 'event', 'garbage', '燃えるごみ', 'keep')$$,
                 '22023', NULL, 'V-1: 健診・予防接種の予定は分類できぬ');
SELECT throws_ok($$SELECT pg_temp.sep('e7000000-0000-4000-8000-000000000011', 'household', 'garbage', '燃えるごみ', 'keep')$$,
                 '22023', NULL, 'V-2: 未知の scope は拒否');
SELECT throws_ok($$SELECT pg_temp.sep('e7000000-0000-4000-8000-000000000011', 'event', 'delete', NULL, 'keep')$$,
                 '22023', NULL, 'V-3: 未知の action は拒否');
SELECT throws_ok($$SELECT pg_temp.sep('e7000000-0000-4000-8000-000000000011', 'event', 'garbage', '燃えるごみ', 'm10')$$,
                 '22023', NULL, 'V-4: 未知の通知の扱いは拒否');
SELECT throws_ok($$SELECT pg_temp.sep('e7000000-0000-4000-8000-000000000011', 'event', 'garbage', '   ', 'keep')$$,
                 '22023', NULL, 'V-5: 空白だけの名称は拒否');
SELECT throws_ok($$SELECT pg_temp.sep('e7000000-0000-4000-8000-000000000011', 'event', 'garbage', repeat('あ', 21), 'keep')$$,
                 '22023', NULL, 'V-6: 21 文字の名称は拒否');
SELECT lives_ok($$SELECT pg_temp.sep('e7000000-0000-4000-8000-000000000011', 'event', 'garbage', repeat('あ', 20), 'keep')$$,
                'V-7: 20 文字の名称は通る（対照）');
SELECT throws_ok($$SELECT pg_temp.sep('e7000000-0000-4000-8000-000000000011', 'series', 'normal', NULL, 'keep')$$,
                 '22023', NULL, 'V-8: 「通常へ戻す」はシリーズ全体には選べぬ');
SELECT throws_ok($$SELECT pg_temp.sep('e7000000-0000-4000-8000-000000000011', 'event', 'clear', NULL, 'prev_day_20')$$,
                 '22023', NULL, 'V-9: 解除と同時に通知を足す指定は拒否');
SELECT throws_ok($$SELECT pg_temp.sep('e7000000-0000-4000-8000-000000000011', 'event', 'clear', '燃えるごみ', 'keep')$$,
                 '22023', NULL, 'V-10: ごみ以外の操作に名称は付けられぬ');
SELECT throws_ok($$SELECT pg_temp.sep('e7000000-0000-4000-8000-0000000000ff', 'event', 'garbage', '燃えるごみ', 'keep')$$,
                 '42501', NULL, 'V-11: 存在せぬ予定は 42501（別世帯の予定と同じ応答）');

-- ── H. 直接 DML の拒否 ──────────────────────────────────────
SELECT throws_ok(
  $$INSERT INTO event_purposes(household_id, scope, target_key, purpose, garbage_kind)
    VALUES ('e7000000-0000-4000-8000-000000000001', 'event', 'x', 'garbage', '燃えるごみ')$$,
  '42501', 'permission denied for table event_purposes', 'H-1: 直接 INSERT は拒否');
SELECT throws_ok($$UPDATE event_purposes SET garbage_kind = '改ざん'$$,
                 '42501', 'permission denied for table event_purposes', 'H-2: 直接 UPDATE は拒否');
SELECT throws_ok($$DELETE FROM event_purposes$$,
                 '42501', 'permission denied for table event_purposes', 'H-3: 直接 DELETE は拒否');

-- ── H. 別世帯 ───────────────────────────────────────────────
INSERT INTO fx SELECT 'a_row', to_jsonb((SELECT id FROM event_purposes WHERE scope = 'series' AND garbage_kind = '資源'));
RESET ROLE;
SELECT ok((SELECT count(*) FROM event_purposes WHERE household_id = 'e7000000-0000-4000-8000-000000000001') >= 4,
          'H-4: (対照) 世帯 A の分類が 4 行以上在る');
INSERT INTO fx SELECT 'a_count', to_jsonb((SELECT count(*) FROM event_purposes WHERE household_id = 'e7000000-0000-4000-8000-000000000001'));
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"e7000000-0000-4000-8000-000000000005","role":"authenticated"}', true);
SELECT is((SELECT count(*) FROM event_purposes), 0::bigint, 'H-5: 別世帯は 1 行も読めぬ');
SELECT throws_ok($$SELECT save_event_purpose('e7000000-0000-4000-8000-000000000011', 'event', 'garbage', '燃えるごみ', 'keep', NULL, NULL)$$,
                 '42501', NULL, 'H-6: 別世帯の予定 id では分類できぬ');
SELECT is((delete_orphan_event_purpose((SELECT (value #>> '{}')::uuid FROM fx WHERE k = 'a_row'))->>'status'),
          'replayed', 'H-7: 別世帯の分類 id の整理は「無い」と同じ応答（存在を漏らさぬ）');
SELECT is(cleanup_deleted_event_purposes(ARRAY['e7000000-0000-4000-8000-000000000012', 'e7000000-0000-4000-8000-000000000010']::uuid[],
                                         'e7000000-0000-4000-8000-000000000010'),
          0, 'H-8: 別世帯の鍵を渡しても何も掃除されぬ');
-- 世帯 B 自身は自分の予定を分類できる（通る側の対照）
SELECT is((pg_temp.sep('e7000000-0000-4000-8000-000000000030', 'series', 'garbage', '燃えるごみ', 'prev_day_20')->>'status'),
          'saved', 'H-9: 世帯 B は自分の予定を分類できる');
SELECT is((SELECT count(*) FROM event_purposes), 1::bigint, 'H-10: 世帯 B に見えるのは自分の 1 行だけ');
RESET ROLE;
SELECT is((SELECT count(*) FROM event_purposes WHERE household_id = 'e7000000-0000-4000-8000-000000000001'),
          (SELECT (value #>> '{}')::bigint FROM fx WHERE k = 'a_count'),
          'H-11: 別世帯の操作の後も、世帯 A の分類は 1 行も減っておらぬ');

-- ── H. child-share 受諾者（別世帯の利用者が、世帯 A の子どもの閲覧招待を受けた）──
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"e7000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
INSERT INTO fx SELECT 'share', create_child_share(
  (SELECT id FROM children WHERE household_id = 'e7000000-0000-4000-8000-000000000001' AND is_legacy),
  true, true, true, true, NULL);
SELECT set_config('request.jwt.claims', '{"sub":"e7000000-0000-4000-8000-000000000005","role":"authenticated"}', true);
SELECT lives_ok($$SELECT accept_child_share((SELECT value->>'token' FROM fx WHERE k = 'share'))$$,
                'H-12: (対照) 閲覧招待の受諾は成立する');
SELECT is((SELECT count(*) FROM event_purposes WHERE household_id = 'e7000000-0000-4000-8000-000000000001'),
          0::bigint, 'H-13: 子どもの閲覧招待を受けても、共有元の世帯の分類は読めぬ');
SELECT throws_ok($$SELECT save_event_purpose('e7000000-0000-4000-8000-000000000011', 'event', 'garbage', '燃えるごみ', 'keep', NULL, NULL)$$,
                 '42501', NULL, 'H-14: 子どもの閲覧招待を受けても、共有元の世帯の予定は分類できぬ');

-- ── H. viewer ───────────────────────────────────────────────
RESET ROLE;
UPDATE profiles SET role = 'viewer' WHERE id = 'e7000000-0000-4000-8000-000000000004';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"e7000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
SELECT is((SELECT count(*) FROM event_purposes), 0::bigint, 'H-15: viewer は 1 行も読めぬ');
SELECT throws_ok($$SELECT save_event_purpose('e7000000-0000-4000-8000-000000000011', 'event', 'garbage', '燃えるごみ', 'keep', NULL, NULL)$$,
                 '42501', NULL, 'H-16: viewer は分類できぬ');
SELECT throws_ok($$SELECT delete_orphan_event_purpose('e7000000-0000-4000-8000-0000000000ff')$$,
                 '42501', NULL, 'H-17: viewer は手動整理を呼べぬ');
SELECT throws_ok($$SELECT cleanup_deleted_event_purposes(ARRAY[]::uuid[], NULL)$$,
                 '42501', NULL, 'H-18: viewer は掃除を呼べぬ');

-- ── H. anon ─────────────────────────────────────────────────
RESET ROLE;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SELECT throws_ok($$SELECT count(*) FROM event_purposes$$, '42501', NULL, 'H-19: anon は表を読めぬ');
SELECT throws_ok($$SELECT save_event_purpose('e7000000-0000-4000-8000-000000000011', 'event', 'garbage', '燃えるごみ', 'keep', NULL, NULL)$$,
                 '42501', NULL, 'H-20: anon は RPC を実行できぬ');

-- ── 既定 ON のシリーズを持つ世帯の削除（CASCADE）を、トリガが止めぬ ──
RESET ROLE;
SELECT is((SELECT count(*) FROM event_reminders WHERE household_id = 'e7000000-0000-4000-8000-000000000002'),
          1::bigint, 'Z-1: (前提) 世帯 B に既定 ON のシリーズと通知が在る');
SELECT lives_ok($$DELETE FROM households WHERE id = 'e7000000-0000-4000-8000-000000000002'$$,
                'Z-2: 世帯の削除は通る（通知の CASCADE 削除でトリガが FK 違反を起こさぬ）');
SELECT is((SELECT count(*) FROM event_purposes WHERE household_id = 'e7000000-0000-4000-8000-000000000002'),
          0::bigint, 'Z-3: 世帯の分類は世帯と共に消える');

SELECT * FROM finish();
ROLLBACK;
