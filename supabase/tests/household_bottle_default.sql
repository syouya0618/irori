-- いつものミルク量（households.bottle_default_ml・migration 20261025100001）を pgTAP で検証する。
-- 実行: supabase test db supabase/tests/household_bottle_default.sql
--
-- ## 何を固定するか
-- - 列: SMALLINT・NULL 可・既定値なし（NULL = 未設定。勝手な既定量を作らぬ）。新しい世帯は NULL
-- - CHECK chk_bottle_default_ml: 1〜999 のみ（0 / 1000 は 23514）。サーバ・クライアントの
--   検証（src/lib/domain/bottle-default.ts）と同じ範囲
-- - RLS（既存の households_select / households_update がこの列も守る）:
--   自世帯の夫婦どちらも読めて変えられる。他世帯の量は読めず、変えられぬ。anon は変えられぬ
-- - 値の楽観的排他（updateBottleDefault の `.is(null)` / `.eq(expected)`）が SQL として成り立つ:
--   見ていた値と違えば 0 行
-- - 量を決めても baby_logs の既存行（amount_ml NULL を含む）は変わらぬ
--
-- ## 偽緑を潰す設計（household_isolation_rls.sql と同じ三段）
-- (0) SET ROLE の前に superuser で seed が効いたことを assert する
-- (1) RLS 下で自世帯の 1 行だけが見え、その値を識別する
-- (2) 他世帯への UPDATE は authenticated で撃ち、RESET ROLE の後に superuser で無改変を assert する
--     （authenticated では SELECT が他世帯行を隠し、0 行だったことをその場で観測できぬ）
--
-- Supabase プラットフォームは public テーブルの DML を anon / authenticated へ実行時 GRANT する
-- （migration には含まれぬ）。INSERT / DELETE は 20261002100001 で剥がしてあるゆえ、ここでは
-- SELECT / UPDATE だけを harness で再現する。
BEGIN;
SELECT plan(24);

-- ── 列の形 ─────────────────────────────────────────────────────
SELECT col_type_is('public', 'households', 'bottle_default_ml', 'smallint',
  '列: bottle_default_ml は smallint');
SELECT col_is_null('public', 'households', 'bottle_default_ml',
  '列: NULL 可（NULL = 未設定）');
SELECT col_hasnt_default('public', 'households', 'bottle_default_ml',
  '列: 既定値を持たぬ（勝手な既定量を作らぬ）');

-- ── seed(superuser = RLS バイパス) ─────────────────────────────
-- H1 = 夫婦（U1・U1b）の世帯（未設定）/ H2 = 別世帯（200ml に設定済み・U2 が属する）
INSERT INTO households (id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'H1'),
  ('99999999-9999-9999-9999-999999999999', 'H2');
UPDATE households SET bottle_default_ml = 200
  WHERE id = '99999999-9999-9999-9999-999999999999';
INSERT INTO auth.users (id, email) VALUES
  ('22222222-2222-2222-2222-222222222222', 'u1@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'u1b@example.com'),
  ('88888888-8888-8888-8888-888888888888', 'u2@example.com');
UPDATE profiles SET household_id = '11111111-1111-1111-1111-111111111111',
                    display_name = 'U1', role = 'owner', is_approved = true
  WHERE id = '22222222-2222-2222-2222-222222222222';
UPDATE profiles SET household_id = '11111111-1111-1111-1111-111111111111',
                    display_name = 'U1b', role = 'member', is_approved = true
  WHERE id = '33333333-3333-3333-3333-333333333333';
UPDATE profiles SET household_id = '99999999-9999-9999-9999-999999999999',
                    display_name = 'U2', role = 'owner', is_approved = true
  WHERE id = '88888888-8888-8888-8888-888888888888';
-- H1 の既存のミルク記録（量なし 1 件・100ml 1 件）。量を決めても書き換わらぬことを最後に見る
INSERT INTO baby_logs (household_id, log_type, feeding_type, amount_ml, logged_by) VALUES
  ('11111111-1111-1111-1111-111111111111', 'feeding', 'bottle', NULL,
   '22222222-2222-2222-2222-222222222222'),
  ('11111111-1111-1111-1111-111111111111', 'feeding', 'bottle', 100,
   '22222222-2222-2222-2222-222222222222');

-- ── (0) seed と新しい世帯の既定 ────────────────────────────────
SELECT is((SELECT bottle_default_ml FROM households
           WHERE id = '11111111-1111-1111-1111-111111111111'), NULL::smallint,
  'seed: H1 は未設定（NULL）で始まる');
SELECT is((SELECT bottle_default_ml FROM households
           WHERE id = '99999999-9999-9999-9999-999999999999'), 200::smallint,
  'seed: H2 は 200ml に設定済み');

-- ── CHECK chk_bottle_default_ml（superuser でも効く）───────────
SELECT throws_ok(
  $$ UPDATE households SET bottle_default_ml = 0
     WHERE id = '11111111-1111-1111-1111-111111111111' $$,
  '23514', 'new row for relation "households" violates check constraint "chk_bottle_default_ml"', 'CHECK: 0ml は拒否');
SELECT throws_ok(
  $$ UPDATE households SET bottle_default_ml = 1000
     WHERE id = '11111111-1111-1111-1111-111111111111' $$,
  '23514', 'new row for relation "households" violates check constraint "chk_bottle_default_ml"', 'CHECK: 1000ml は拒否');
SELECT lives_ok(
  $$ UPDATE households SET bottle_default_ml = 1
     WHERE id = '11111111-1111-1111-1111-111111111111' $$,
  'CHECK: 下限 1ml は受理');
SELECT lives_ok(
  $$ UPDATE households SET bottle_default_ml = 999
     WHERE id = '11111111-1111-1111-1111-111111111111' $$,
  'CHECK: 上限 999ml は受理');
SELECT lives_ok(
  $$ UPDATE households SET bottle_default_ml = NULL
     WHERE id = '11111111-1111-1111-1111-111111111111' $$,
  'CHECK: NULL（未設定）は受理（H1 を未設定へ戻して RLS の段へ進む）');

GRANT SELECT, UPDATE ON households TO anon, authenticated;

-- ── (1) U1（H1）の文脈 ─────────────────────────────────────────
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '22222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);

SELECT is((SELECT count(*) FROM households), 1::bigint,
  'U1: 見える世帯は自世帯の 1 行だけ');
SELECT is((SELECT bottle_default_ml FROM households), NULL::smallint,
  'U1: 自世帯の量は未設定（他世帯の 200 は見えぬ）');
SELECT is((SELECT count(*) FROM households
           WHERE id = '99999999-9999-9999-9999-999999999999'), 0::bigint,
  'U1: 他世帯の行は読めぬ');

-- 初回の設定（updateBottleDefault の `.is(null)` と同じ条件）
WITH u AS (
  UPDATE households SET bottle_default_ml = 120
  WHERE id = '11111111-1111-1111-1111-111111111111' AND bottle_default_ml IS NULL
  RETURNING 1
)
SELECT is(count(*), 1::bigint, 'U1: 未設定を見て 120ml を決められる（1 行）') FROM u;

-- 古い画面（まだ未設定だと思っている）の保存は 0 行 = 衝突として読み直しへ回る
WITH u AS (
  UPDATE households SET bottle_default_ml = 140
  WHERE id = '11111111-1111-1111-1111-111111111111' AND bottle_default_ml IS NULL
  RETURNING 1
)
SELECT is(count(*), 0::bigint, 'U1: 見ていた量と違えば 0 行（黙って上書きせぬ）') FROM u;

SELECT throws_ok(
  $$ UPDATE households SET bottle_default_ml = 1000
     WHERE id = '11111111-1111-1111-1111-111111111111' $$,
  '23514', 'new row for relation "households" violates check constraint "chk_bottle_default_ml"', 'U1: RLS 下でも CHECK は効く（1000ml は拒否）');

WITH u AS (
  UPDATE households SET bottle_default_ml = 1
  WHERE id = '99999999-9999-9999-9999-999999999999'
  RETURNING 1
)
SELECT is(count(*), 0::bigint, 'U1: 他世帯の量は変えられぬ（0 行）') FROM u;

-- ── 夫婦の別端末（U1b・同じ H1）─────────────────────────────────
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '33333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text, true);

SELECT is((SELECT bottle_default_ml FROM households), 120::smallint,
  'U1b: 配偶者が決めた 120ml が見える（世帯で共有）');
WITH u AS (
  UPDATE households SET bottle_default_ml = 160
  WHERE id = '11111111-1111-1111-1111-111111111111' AND bottle_default_ml = 120
  RETURNING 1
)
SELECT is(count(*), 1::bigint, 'U1b: 120 を見て 160ml へ変えられる（1 行）') FROM u;

-- ── anon（session 切れ）──────────────────────────────────────────
RESET ROLE;
SET LOCAL role anon;
SELECT set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
WITH u AS (
  UPDATE households SET bottle_default_ml = 1
  WHERE id = '11111111-1111-1111-1111-111111111111'
  RETURNING 1
)
SELECT is(count(*), 0::bigint, 'anon: どの世帯の量も変えられぬ（0 行）') FROM u;

RESET ROLE;

-- ── (2) superuser で無改変・反映を確かめる ───────────────────────
SELECT is((SELECT bottle_default_ml FROM households
           WHERE id = '99999999-9999-9999-9999-999999999999'), 200::smallint,
  'H2: 他世帯の量は 200ml のまま（U1 の UPDATE は 0 行だった）');
SELECT is((SELECT bottle_default_ml FROM households
           WHERE id = '11111111-1111-1111-1111-111111111111'), 160::smallint,
  'H1: 最後に U1b が決めた 160ml（anon の UPDATE は 0 行だった）');
SELECT is((SELECT count(*) FROM baby_logs
           WHERE household_id = '11111111-1111-1111-1111-111111111111'
             AND feeding_type = 'bottle' AND amount_ml IS NULL), 1::bigint,
  'baby_logs: 量を決めても、既存の量なしの記録は NULL のまま');
SELECT is((SELECT count(*) FROM baby_logs
           WHERE household_id = '11111111-1111-1111-1111-111111111111'
             AND feeding_type = 'bottle' AND amount_ml = 100), 1::bigint,
  'baby_logs: 量を変えても、既存の 100ml の記録は 100ml のまま');

SELECT * FROM finish();
ROLLBACK;
