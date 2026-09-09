-- baby_logs の poop_amount / breast_start_side（20260909100001）の CHECK を pgTAP で固定する。
-- 実行: supabase test db supabase/tests/baby_diaper_amount_start_side.sql
--
-- CHECK 制約は全ロールに適用されるため superuser で検証する（baby_breast_counts.sql と同流儀）。
-- 期待 SQLSTATE は 23514 = check_violation。拒否側だけでなく**通る側**も対で置き、
-- 「CHECK が厳しすぎて正常な記録が落ちる」回帰も同時に殺す。
BEGIN;
SELECT plan(14);

-- ── seed(superuser) ───────────────────────────────────────────
INSERT INTO households (id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'H1');
INSERT INTO auth.users (id, email) VALUES
  ('22222222-2222-2222-2222-222222222222', 'u1@example.com');
-- （profiles は auth.users トリガで生成される。baby_logs.logged_by の FK 先として使う）

-- ══ poop_amount ═══════════════════════════════════════════════

-- (1) 通る側: うんち + 少量
SELECT lives_ok(
  $$ INSERT INTO baby_logs (household_id, log_type, logged_by, diaper_type, poop_amount)
     VALUES ('11111111-1111-1111-1111-111111111111', 'diaper', '22222222-2222-2222-2222-222222222222', 'poop', 'small') $$,
  'poop_amount: poop 行に small は付けられる'
);
-- (2) 通る側: 両方 + 大量（both もうんちを含む）
SELECT lives_ok(
  $$ INSERT INTO baby_logs (household_id, log_type, logged_by, diaper_type, poop_amount)
     VALUES ('11111111-1111-1111-1111-111111111111', 'diaper', '22222222-2222-2222-2222-222222222222', 'both', 'large') $$,
  'poop_amount: both 行に large は付けられる'
);
-- (3) 通る側: 量なし（既存行・量を選ばぬ記録）は NULL で合法
SELECT lives_ok(
  $$ INSERT INTO baby_logs (household_id, log_type, logged_by, diaper_type)
     VALUES ('11111111-1111-1111-1111-111111111111', 'diaper', '22222222-2222-2222-2222-222222222222', 'poop') $$,
  'poop_amount: NULL（量の記録なし）は合法'
);
-- (4) 拒否: おしっこ行に量は付けられない
SELECT throws_ok(
  $$ INSERT INTO baby_logs (household_id, log_type, logged_by, diaper_type, poop_amount)
     VALUES ('11111111-1111-1111-1111-111111111111', 'diaper', '22222222-2222-2222-2222-222222222222', 'pee', 'small') $$,
  '23514', NULL, 'poop_amount: pee 行に量は付けられない'
);
-- (5) 拒否: NULL 穴の封鎖 — diaper_type IS NULL の行（memo）に量が付くのを拒否
SELECT throws_ok(
  $$ INSERT INTO baby_logs (household_id, log_type, logged_by, memo, poop_amount)
     VALUES ('11111111-1111-1111-1111-111111111111', 'memo', '22222222-2222-2222-2222-222222222222', 'x', 'large') $$,
  '23514', NULL, 'poop_amount: diaper_type NULL の行に量は付けられない（NULL 穴の封鎖）'
);
-- (6) 拒否: 値の集合外
SELECT throws_ok(
  $$ INSERT INTO baby_logs (household_id, log_type, logged_by, diaper_type, poop_amount)
     VALUES ('11111111-1111-1111-1111-111111111111', 'diaper', '22222222-2222-2222-2222-222222222222', 'poop', 'medium') $$,
  '23514', NULL, 'poop_amount: small / large 以外は拒否'
);

-- (7) 部分 UPDATE: 量を残したまま pee へ変えるのは拒否（無音の矛盾行を作らせない）
INSERT INTO baby_logs (id, household_id, log_type, logged_by, diaper_type, poop_amount)
  VALUES ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
          'diaper', '22222222-2222-2222-2222-222222222222', 'poop', 'large');
SELECT throws_ok(
  $$ UPDATE baby_logs SET diaper_type = 'pee'
     WHERE id = '44444444-4444-4444-4444-444444444444' $$,
  '23514', NULL, 'UPDATE: 量を残した pee への種別変更は拒否'
);
-- (8) 量の同時 NULL 化を伴う種別変更は許可（web updateLog の規約）
SELECT lives_ok(
  $$ UPDATE baby_logs SET diaper_type = 'pee', poop_amount = NULL
     WHERE id = '44444444-4444-4444-4444-444444444444' $$,
  'UPDATE: 量の同時 NULL 化を伴う pee への変更は許可'
);

-- ══ breast_start_side ═════════════════════════════════════════

-- (9) 通る側: breast 行 + left
SELECT lives_ok(
  $$ INSERT INTO baby_logs (household_id, log_type, logged_by, feeding_type, breast_left_count, breast_right_count, breast_start_side)
     VALUES ('11111111-1111-1111-1111-111111111111', 'feeding', '22222222-2222-2222-2222-222222222222', 'breast', 1, 0, 'left') $$,
  'breast_start_side: breast 行に left は付けられる'
);
-- (10) 通る側: breast 行 + right
SELECT lives_ok(
  $$ INSERT INTO baby_logs (household_id, log_type, logged_by, feeding_type, breast_left_count, breast_right_count, breast_start_side)
     VALUES ('11111111-1111-1111-1111-111111111111', 'feeding', '22222222-2222-2222-2222-222222222222', 'breast', 0, 1, 'right') $$,
  'breast_start_side: breast 行に right は付けられる'
);
-- (11) 通る側: 開始側不明（NULL）の breast 行は合法（列追加以前の行・旧形式タイマー）
SELECT lives_ok(
  $$ INSERT INTO baby_logs (household_id, log_type, logged_by, feeding_type, breast_left_count, breast_right_count)
     VALUES ('11111111-1111-1111-1111-111111111111', 'feeding', '22222222-2222-2222-2222-222222222222', 'breast', 1, 1) $$,
  'breast_start_side: NULL（不明）は合法'
);
-- (12) 拒否: bottle 行に開始側は付けられない
SELECT throws_ok(
  $$ INSERT INTO baby_logs (household_id, log_type, logged_by, feeding_type, breast_start_side)
     VALUES ('11111111-1111-1111-1111-111111111111', 'feeding', '22222222-2222-2222-2222-222222222222', 'bottle', 'left') $$,
  '23514', NULL, 'breast_start_side: bottle 行に開始側は付けられない'
);
-- (13) 拒否: NULL 穴の封鎖 — feeding_type IS NULL の行（diaper）に開始側が付くのを拒否
SELECT throws_ok(
  $$ INSERT INTO baby_logs (household_id, log_type, logged_by, diaper_type, breast_start_side)
     VALUES ('11111111-1111-1111-1111-111111111111', 'diaper', '22222222-2222-2222-2222-222222222222', 'pee', 'left') $$,
  '23514', NULL, 'breast_start_side: feeding_type NULL の行に開始側は付けられない（NULL 穴の封鎖）'
);
-- (14) 拒否: 値の集合外
SELECT throws_ok(
  $$ INSERT INTO baby_logs (household_id, log_type, logged_by, feeding_type, breast_left_count, breast_right_count, breast_start_side)
     VALUES ('11111111-1111-1111-1111-111111111111', 'feeding', '22222222-2222-2222-2222-222222222222', 'breast', 1, 0, 'both') $$,
  '23514', NULL, 'breast_start_side: left / right 以外は拒否'
);

SELECT * FROM finish();
ROLLBACK;
