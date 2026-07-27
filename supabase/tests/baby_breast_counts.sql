-- baby_logs の母乳サイクル不変条件（CHECK 2本 + backfill 述語）を pgTAP で検証する。
-- 実行: supabase test db supabase/tests/baby_breast_counts.sql
--
-- 背景（PR #165 の独立批判レビュー P4）: これらの制約は「最後の砦」（Flutter の部分
-- update による breast→bottle 化け等を fail-loud で拒否する防御）だが、vitest は
-- Supabase を fake するため DB CHECK は自動検証の外にあった。CHECK 制約は全ロールに
-- 適用されるため superuser で検証する（calendar_events_rls.sql と同流儀）。
-- 期待 SQLSTATE は 23514 = check_violation。
BEGIN;
SELECT plan(15);

-- ── seed(superuser) ───────────────────────────────────────────
INSERT INTO households (id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'H1');
INSERT INTO auth.users (id, email) VALUES
  ('22222222-2222-2222-2222-222222222222', 'u1@example.com');
-- （profiles は auth.users トリガで生成される。baby_logs.logged_by の FK 先として使う）

-- ══ chk_breast_counts_only_breast（counts を持てるのは breast 行だけ） ══

-- (1) NULL 穴の封鎖: feeding_type IS NULL の行（diaper）に counts が付くのを拒否。
--     `= 'breast'` 形だと式が NULL 評価で CHECK を素通りする（Postgres は NULL を許容と
--     扱う）ため IS NOT DISTINCT FROM にした — その穴が塞がっていることの回帰固定。
SELECT throws_ok(
  $$ INSERT INTO baby_logs (household_id, log_type, logged_by, diaper_type, breast_left_count, breast_right_count)
     VALUES ('11111111-1111-1111-1111-111111111111', 'diaper', '22222222-2222-2222-2222-222222222222', 'pee', 5, 3) $$,
  '23514', NULL, 'CHECK: feeding_type NULL の行に counts は付けられない（NULL 穴の封鎖）'
);
-- (2) bottle 行に counts は付けられない（Flutter/編集経路の化け防止の基本形）
SELECT throws_ok(
  $$ INSERT INTO baby_logs (household_id, log_type, logged_by, feeding_type, breast_left_count, breast_right_count)
     VALUES ('11111111-1111-1111-1111-111111111111', 'feeding', '22222222-2222-2222-2222-222222222222', 'bottle', 1, 0) $$,
  '23514', NULL, 'CHECK: bottle 行に counts は付けられない'
);

-- ══ chk_breast_counts_required（breast 行は counts 必須・各0..20・合計>=1） ══

-- (3) counts 欠落
SELECT throws_ok(
  $$ INSERT INTO baby_logs (household_id, log_type, logged_by, feeding_type)
     VALUES ('11111111-1111-1111-1111-111111111111', 'feeding', '22222222-2222-2222-2222-222222222222', 'breast') $$,
  '23514', NULL, 'CHECK: breast 行は counts 必須'
);
-- (4) 合計 0（授乳していないサイクル行）
SELECT throws_ok(
  $$ INSERT INTO baby_logs (household_id, log_type, logged_by, feeding_type, breast_left_count, breast_right_count)
     VALUES ('11111111-1111-1111-1111-111111111111', 'feeding', '22222222-2222-2222-2222-222222222222', 'breast', 0, 0) $$,
  '23514', NULL, 'CHECK: 合計 0 は拒否'
);
-- (5) 上限超過 21
SELECT throws_ok(
  $$ INSERT INTO baby_logs (household_id, log_type, logged_by, feeding_type, breast_left_count, breast_right_count)
     VALUES ('11111111-1111-1111-1111-111111111111', 'feeding', '22222222-2222-2222-2222-222222222222', 'breast', 21, 0) $$,
  '23514', NULL, 'CHECK: 21 回は拒否（上限 20）'
);
-- (6) 負数
SELECT throws_ok(
  $$ INSERT INTO baby_logs (household_id, log_type, logged_by, feeding_type, breast_left_count, breast_right_count)
     VALUES ('11111111-1111-1111-1111-111111111111', 'feeding', '22222222-2222-2222-2222-222222222222', 'breast', -1, 2) $$,
  '23514', NULL, 'CHECK: 負数は拒否'
);
-- (7) 境界の緑側 20/20（ミューテーション実測でどの層にもテストが無かった側 — M01 対策）
SELECT lives_ok(
  $$ INSERT INTO baby_logs (household_id, log_type, logged_by, feeding_type, breast_left_count, breast_right_count)
     VALUES ('11111111-1111-1111-1111-111111111111', 'feeding', '22222222-2222-2222-2222-222222222222', 'breast', 20, 20) $$,
  'CHECK: 境界値 20/20 は通る（緑側）'
);
-- (8) 最小 0/1（片側 0 は有効値）
SELECT lives_ok(
  $$ INSERT INTO baby_logs (household_id, log_type, logged_by, feeding_type, breast_left_count, breast_right_count)
     VALUES ('11111111-1111-1111-1111-111111111111', 'feeding', '22222222-2222-2222-2222-222222222222', 'breast', 0, 1) $$,
  'CHECK: 0/1 は通る（片側 0 は有効）'
);
-- (9) breast 行に amount_ml は付けられない（chk_amount_ml が 'breast' を含まない）
SELECT throws_ok(
  $$ INSERT INTO baby_logs (household_id, log_type, logged_by, feeding_type, breast_left_count, breast_right_count, amount_ml)
     VALUES ('11111111-1111-1111-1111-111111111111', 'feeding', '22222222-2222-2222-2222-222222222222', 'breast', 1, 0, 100) $$,
  '23514', NULL, 'CHECK: breast 行に amount_ml は付けられない'
);

-- ══ 部分 UPDATE（本 CHECK の主目的 = Flutter 型の化けを fail-loud に拒否） ══

INSERT INTO baby_logs (id, household_id, log_type, logged_by, feeding_type, breast_left_count, breast_right_count)
  VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
          'feeding', '22222222-2222-2222-2222-222222222222', 'breast', 2, 1);

-- (10) Flutter の updateFeeding は feeding_type/amount_ml/memo のみ送る部分 update。
--      counts を残したままの種別変更は「ミルクなのに左右回数を持つ」無音破損になる
--      ため拒否されなければならない（flutter/lib/features/baby/data/baby_repository.dart:229-233）
SELECT throws_ok(
  $$ UPDATE baby_logs SET feeding_type = 'bottle'
     WHERE id = '33333333-3333-3333-3333-333333333333' $$,
  '23514', NULL, 'UPDATE: counts を残した種別変更は拒否（Flutter 型部分 update の fail-loud）'
);
-- (11) web の updateLog は種別変更と同時に counts を null 化する（許可される形）
SELECT lives_ok(
  $$ UPDATE baby_logs SET feeding_type = 'bottle', breast_left_count = NULL, breast_right_count = NULL
     WHERE id = '33333333-3333-3333-3333-333333333333' $$,
  'UPDATE: counts の同時 null 化を伴う種別変更は許可（web updateLog の規約）'
);

-- ══ backfill 述語（20260726100003）の回帰固定 ══
-- migration 本体は適用済みで再実行されないが、「述語が何を選び何を除外するか」は
-- logged_at セマンティクスの根幹ゆえ、同一 UPDATE 文を fixture に当てて意味を固定する。
-- 文面は 20260726100003_baby_feeding_backfill_start_time.sql の UPDATE と同一に保つこと。

INSERT INTO baby_logs (id, household_id, log_type, logged_by, feeding_type, duration_sec, duration_min, logged_at, created_at) VALUES
  -- A: 無編集タイマー行（logged_at = created_at・duration あり）→ 巻き戻し対象
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'feeding',
   '22222222-2222-2222-2222-222222222222', 'breast_left', 600, 10, '2026-07-20 10:00:00+09', '2026-07-20 10:00:00+09'),
  -- B: 時刻編集済み（logged_at ≠ created_at）→ ユーザーが決めた時刻を尊重・不変
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'feeding',
   '22222222-2222-2222-2222-222222222222', 'breast_right', NULL, 10, '2026-07-20 08:00:00+09', '2026-07-20 12:00:00+09'),
  -- C: bottle（duration があっても logged_at はタップ時刻）→ 型フィルタで不変
  ('aaaaaaaa-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'feeding',
   '22222222-2222-2222-2222-222222222222', 'bottle', NULL, 10, '2026-07-20 09:00:00+09', '2026-07-20 09:00:00+09'),
  -- D: duration なし（巻き戻す幅が無い）→ 不変
  ('aaaaaaaa-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'feeding',
   '22222222-2222-2222-2222-222222222222', 'breast_left', NULL, NULL, '2026-07-20 07:00:00+09', '2026-07-20 07:00:00+09');

UPDATE baby_logs
SET logged_at = logged_at - make_interval(secs => COALESCE(duration_sec, duration_min * 60))
WHERE log_type = 'feeding'
  AND feeding_type IN ('breast_left', 'breast_right')
  AND (duration_sec IS NOT NULL OR duration_min IS NOT NULL)
  AND logged_at = created_at;

-- (12) A は duration_sec=600 ぶん巻き戻る（終了 10:00 → 開始 09:50）
SELECT is(
  (SELECT logged_at FROM baby_logs WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  '2026-07-20 09:50:00+09'::timestamptz,
  'backfill: 無編集タイマー行は duration ぶん巻き戻る'
);
-- (13) B は不変（時刻編集済みは除外）
SELECT is(
  (SELECT logged_at FROM baby_logs WHERE id = 'aaaaaaaa-0000-0000-0000-000000000002'),
  '2026-07-20 08:00:00+09'::timestamptz,
  'backfill: 時刻編集済み行（logged_at ≠ created_at）は不変'
);
-- (14) C は不変（bottle は型フィルタで除外）
SELECT is(
  (SELECT logged_at FROM baby_logs WHERE id = 'aaaaaaaa-0000-0000-0000-000000000003'),
  '2026-07-20 09:00:00+09'::timestamptz,
  'backfill: bottle 行は不変（duration があっても対象外）'
);
-- (15) D は不変（duration なしは巻き戻す幅が無い）
SELECT is(
  (SELECT logged_at FROM baby_logs WHERE id = 'aaaaaaaa-0000-0000-0000-000000000004'),
  '2026-07-20 07:00:00+09'::timestamptz,
  'backfill: duration なし行は不変'
);

SELECT * FROM finish();
ROLLBACK;
