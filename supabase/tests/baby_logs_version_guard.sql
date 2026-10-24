-- 育児ログの編集の楽観的排他（P2-07）が拠って立つ DB の振る舞いを固定する。
-- 実行: supabase test db supabase/tests/baby_logs_version_guard.sql
--
-- ## なぜ要るか
-- updateLog（src/app/(main)/baby/actions.ts）は、編集を開いた時点の updated_at を版にして
--   UPDATE baby_logs … WHERE id = ? AND household_id = ? AND updated_at = 期待版
-- の 1 本で書き、0 行を「家族（または自分の別端末）が先に保存した」衝突として扱う。
-- vitest の fake はこの振る舞いを**自前で模すだけ**ゆえ、本物の Postgres + RLS で
-- (1) 古い版の UPDATE が 0 行になり、先の保存が残ること
-- (2) trg_baby_logs_updated_at が UPDATE で版を進めること（進まねば次の衝突を検知できぬ）
-- (3) PostgREST が JSON で返した版の文字列が、そのまま一致すること（マイクロ秒）
-- (4) 別世帯・未承認の利用者は、正しい版を知っていても 1 行も書けぬこと
-- (5) 削除済みの行は、どの版でも 0 行・読み直しも 0 行になること
-- を確かめる。どれかが崩れれば、家族の記録の無言上書き（P2-07）が戻るか、毎回の保存が
-- 誤って衝突になる。
--
-- ## 削除の版ガード（PR #235 敵対レビュー P1）
-- deleteLog も同じ版で
--   DELETE FROM baby_logs WHERE id = ? AND household_id = ? AND updated_at = 期待版
-- の 1 本で消し、0 行を「先に更新されていた」衝突として扱う（編集シートの削除・記録直後の
-- 「取り消す」）。ここでは
-- (6) A が先に更新した記録を、B が古い版で削除しても 0 行で、A の更新が残ること
-- (7) 取り消し（作成時の版）の前に家族が更新していたら、取り消しは 0 行で家族の更新が残ること
-- (8) 別世帯・未承認の利用者は、正しい版を知っていても 1 行も消せぬこと
-- (9) 対照: 読み直した最新の版での削除は 1 行で通ること（版ガードが常に 0 行の偽緑でない）
-- を固定する。
--
-- ## 版の値は明示する
-- 同じトランザクションの now() は一定じゃ。ゆえに seed の版を過去の固定値で入れ、
-- UPDATE が trigger で now()（= それと異なる値）へ進むことを見る。A の保存の後の版は
-- このトランザクションの now() に等しいゆえ、他世帯・未承認の検査は「正しい版」として
-- now() を使う（版を知らぬから 0 行、という偽緑を避ける）。
--
-- ## このファイルが見ぬもの
-- 二つのトランザクションが同時に同じ行を書く競争は、1 本のトランザクションの pgTAP では
-- 再現できぬ。READ COMMITTED の UPDATE は行ロックを取った後で WHERE を最新の行に対して
-- 評価し直す（PostgreSQL 公式 docs「Transaction Isolation」）ゆえ、同時の保存でも版の
-- 合う側の 1 本だけが書ける。本ファイルは製品の場面そのもの（A の保存の後に B が古い
-- 画面から保存する）を、別々の要求として順に撃つ。
BEGIN;
SELECT plan(27);

-- ── seed（superuser = RLS バイパス）─────────────────────────────
-- H1 = A(owner) / B(member)、H2 = 他世帯の利用者、UP = 未承認（household_id NULL）
INSERT INTO households (id, name) VALUES
  ('d1111111-1111-1111-1111-111111111111', 'VG H1'),
  ('d9999999-9999-9999-9999-999999999999', 'VG H2');
INSERT INTO auth.users (id, email) VALUES
  ('d2222222-2222-2222-2222-222222222222', 'vg-a@example.com'),
  ('d3333333-3333-3333-3333-333333333333', 'vg-b@example.com'),
  ('d4444444-4444-4444-4444-444444444444', 'vg-other@example.com'),
  ('d5555555-5555-5555-5555-555555555555', 'vg-pending@example.com');
UPDATE profiles SET household_id = 'd1111111-1111-1111-1111-111111111111',
                    display_name = 'VG A', role = 'owner', is_approved = true
  WHERE id = 'd2222222-2222-2222-2222-222222222222';
UPDATE profiles SET household_id = 'd1111111-1111-1111-1111-111111111111',
                    display_name = 'VG B', role = 'member', is_approved = true
  WHERE id = 'd3333333-3333-3333-3333-333333333333';
UPDATE profiles SET household_id = 'd9999999-9999-9999-9999-999999999999',
                    display_name = 'VG other', role = 'owner', is_approved = true
  WHERE id = 'd4444444-4444-4444-4444-444444444444';
UPDATE profiles SET display_name = 'VG pending'
  WHERE id = 'd5555555-5555-5555-5555-555555555555';
-- chk_diaper（diaper 行は diaper_type 必須）を満たす最小行。版は過去の固定値で入れる
-- （trigger は BEFORE UPDATE のみゆえ INSERT の値はそのまま残る）。
INSERT INTO baby_logs (id, household_id, log_type, diaper_type, logged_by, updated_at) VALUES
  ('d6666666-6666-6666-6666-666666666666', 'd1111111-1111-1111-1111-111111111111',
   'diaper', 'pee', 'd2222222-2222-2222-2222-222222222222',
   '2026-10-01T03:00:00.123456+00:00'),
  -- (6)(8)(9) 削除の版ガード: A と B が同じ記録を開いた時点の版
  ('d7777777-7777-7777-7777-777777777777', 'd1111111-1111-1111-1111-111111111111',
   'diaper', 'pee', 'd2222222-2222-2222-2222-222222222222',
   '2026-10-01T04:00:00.111111+00:00'),
  -- (7) 取り消し: A がクイック記録した直後の版（作成の応答で返る updated_at）
  ('d8888888-8888-8888-8888-888888888888', 'd1111111-1111-1111-1111-111111111111',
   'diaper', 'pee', 'd2222222-2222-2222-2222-222222222222',
   '2026-10-01T05:00:00.222222+00:00');

-- seed の固定（ここが赤いなら以降は行が無いだけの偽緑）
SELECT is((SELECT count(*) FROM baby_logs WHERE id = 'd6666666-6666-6666-6666-666666666666'),
  1::bigint, 'seed: 編集の対象の行が 1 行在る');
SELECT is((SELECT count(*) FROM baby_logs
            WHERE id IN ('d7777777-7777-7777-7777-777777777777',
                         'd8888888-8888-8888-8888-888888888888')),
  2::bigint, 'seed: 削除の版ガードの対象の 2 行が在る');

GRANT SELECT, INSERT, UPDATE, DELETE ON baby_logs TO authenticated;

-- data-modifying な CTE は文の最上位にしか置けぬゆえ、WITH … SELECT is(…) の形で書く。

-- ══ (1)(2) A が開いた時点の版で先に保存する ══════════════════════
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'd2222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);

WITH upd AS (
  UPDATE baby_logs SET diaper_type = 'poop', poop_amount = 'large', memo = 'A が先に保存'
   WHERE id = 'd6666666-6666-6666-6666-666666666666'
     AND household_id = 'd1111111-1111-1111-1111-111111111111'
     AND updated_at = '2026-10-01T03:00:00.123456+00:00'
  RETURNING 1)
SELECT is((SELECT count(*) FROM upd), 1::bigint,
  'A: 開いた時点の版（PostgREST 表記・マイクロ秒つき）での UPDATE は 1 行');
SELECT isnt(
  (SELECT updated_at FROM baby_logs WHERE id = 'd6666666-6666-6666-6666-666666666666'),
  '2026-10-01T03:00:00.123456+00:00'::timestamptz,
  'A: trg_baby_logs_updated_at が版を進める（進まねば B の古い保存を検知できぬ）');

-- ══ (1) B が同じ記録を古い版のまま保存する ═══════════════════════
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'd3333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text, true);

WITH upd AS (
  UPDATE baby_logs SET diaper_type = 'pee', poop_amount = NULL, memo = 'B が古い画面から保存'
   WHERE id = 'd6666666-6666-6666-6666-666666666666'
     AND household_id = 'd1111111-1111-1111-1111-111111111111'
     AND updated_at = '2026-10-01T03:00:00.123456+00:00'
  RETURNING 1)
SELECT is((SELECT count(*) FROM upd), 0::bigint,
  'B: 古い版での UPDATE は 0 行（衝突として検知できる）');
SELECT is(
  (SELECT memo || '/' || diaper_type::text || '/' || poop_amount::text
     FROM baby_logs WHERE id = 'd6666666-6666-6666-6666-666666666666'),
  'A が先に保存/poop/large',
  'B: A の保存は無傷で残る（読み直しで B に見せる最新の行）');

-- ══ (3) PostgREST が JSON で返した版の文字列は、そのまま一致する ═══
SELECT is(
  (SELECT count(*) FROM baby_logs
    WHERE id = 'd6666666-6666-6666-6666-666666666666'
      AND updated_at = (
        SELECT (to_json(updated_at) #>> '{}')::timestamptz FROM baby_logs
         WHERE id = 'd6666666-6666-6666-6666-666666666666')),
  1::bigint,
  '表記: JSON に出した版（PostgREST の応答）を送り返すと、同じ版として一致する');

-- ══ B が最新を読み直してから編集し直す ═══════════════════════════
WITH upd AS (
  UPDATE baby_logs SET memo = 'A の後に B が足したメモ'
   WHERE id = 'd6666666-6666-6666-6666-666666666666'
     AND household_id = 'd1111111-1111-1111-1111-111111111111'
     AND updated_at = (SELECT updated_at FROM baby_logs
                        WHERE id = 'd6666666-6666-6666-6666-666666666666')
  RETURNING 1)
SELECT is((SELECT count(*) FROM upd), 1::bigint,
  'B: 読み直した最新の版での UPDATE は 1 行（再編集できる）');
SELECT is(
  (SELECT diaper_type::text || '/' || poop_amount::text
     FROM baby_logs WHERE id = 'd6666666-6666-6666-6666-666666666666'),
  'poop/large',
  'B: 再編集は A の変更（うんち・大量）を巻き戻さぬ');

-- ══ (4) 他世帯の利用者は、正しい版を知っていても書けぬ ════════════
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'd4444444-4444-4444-4444-444444444444', 'role', 'authenticated')::text, true);
WITH upd AS (
  UPDATE baby_logs SET memo = '他世帯からの書き込み'
   WHERE id = 'd6666666-6666-6666-6666-666666666666'
     AND household_id = 'd1111111-1111-1111-1111-111111111111'
     AND updated_at = now()
  RETURNING 1)
SELECT is((SELECT count(*) FROM upd), 0::bigint,
  '他世帯: 正しい版（このトランザクションの now()）でも UPDATE は 0 行');
SELECT is(
  (SELECT count(*) FROM baby_logs WHERE id = 'd6666666-6666-6666-6666-666666666666'),
  0::bigint,
  '他世帯: 読み直しても 0 行（アプリは削除済みと同じ応答を返し、存在を漏らさぬ）');

-- ══ (4) 未承認の利用者（世帯なし）も書けぬ ══════════════════════
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'd5555555-5555-5555-5555-555555555555', 'role', 'authenticated')::text, true);
WITH upd AS (
  UPDATE baby_logs SET memo = '未承認からの書き込み'
   WHERE id = 'd6666666-6666-6666-6666-666666666666'
     AND household_id = 'd1111111-1111-1111-1111-111111111111'
     AND updated_at = now()
  RETURNING 1)
SELECT is((SELECT count(*) FROM upd), 0::bigint,
  '未承認: 正しい版でも UPDATE は 0 行');

RESET ROLE;
SELECT is(
  (SELECT memo FROM baby_logs WHERE id = 'd6666666-6666-6666-6666-666666666666'),
  'A の後に B が足したメモ',
  '他世帯・未承認の UPDATE は行を書き換えておらぬ（superuser で確認）');

-- ══ (5) 削除済みの行は、どの版でも 0 行・読み直しも 0 行 ═══════════
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'd2222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);
WITH del AS (
  DELETE FROM baby_logs WHERE id = 'd6666666-6666-6666-6666-666666666666'
  RETURNING 1)
SELECT is((SELECT count(*) FROM del), 1::bigint,
  '削除: A が記録を消す（ここが 0 行なら以降の「削除済み」は名前違いの赤になる）');
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'd3333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text, true);
WITH upd AS (
  UPDATE baby_logs SET memo = '削除の後に古い画面から保存'
   WHERE id = 'd6666666-6666-6666-6666-666666666666'
     AND household_id = 'd1111111-1111-1111-1111-111111111111'
     AND updated_at = now()
  RETURNING 1)
SELECT is((SELECT count(*) FROM upd), 0::bigint,
  '削除済み: UPDATE は 0 行（行を作り直さぬ）');
SELECT is(
  (SELECT count(*) FROM baby_logs WHERE id = 'd6666666-6666-6666-6666-666666666666'),
  0::bigint,
  '削除済み: 読み直しも 0 行（アプリは「削除されていました」を返す）');

-- ══ (6) A が先に更新した記録を、B が古い版のまま削除する ═══════════════
-- A と B は同じ記録を版 04:00:00.111111 で開いた。A が先に保存（trigger が版を now() へ進める）。
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'd2222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);
WITH upd AS (
  UPDATE baby_logs SET diaper_type = 'poop', poop_amount = 'small', memo = 'A が削除の前に保存'
   WHERE id = 'd7777777-7777-7777-7777-777777777777'
     AND household_id = 'd1111111-1111-1111-1111-111111111111'
     AND updated_at = '2026-10-01T04:00:00.111111+00:00'
  RETURNING 1)
SELECT is((SELECT count(*) FROM upd), 1::bigint,
  '削除の版ガード: A が開いた時点の版で先に保存する（1 行）');

SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'd3333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text, true);
WITH del AS (
  DELETE FROM baby_logs
   WHERE id = 'd7777777-7777-7777-7777-777777777777'
     AND household_id = 'd1111111-1111-1111-1111-111111111111'
     AND updated_at = '2026-10-01T04:00:00.111111+00:00'
  RETURNING 1)
SELECT is((SELECT count(*) FROM del), 0::bigint,
  '削除の版ガード: B が古い版で削除しても 0 行（A の更新ごと消さぬ）');
SELECT is(
  (SELECT memo || '/' || diaper_type::text || '/' || poop_amount::text
     FROM baby_logs WHERE id = 'd7777777-7777-7777-7777-777777777777'),
  'A が削除の前に保存/poop/small',
  '削除の版ガード: A の最新版が DB に残る（読み直しで B に見せる行）');

-- ══ (7) 取り消し（作成時の版）の前に、家族が同じ記録を更新する ═══════════
-- B（家族）が A のクイック記録を直す。版は作成時の 05:00:00.222222 から now() へ進む。
WITH upd AS (
  UPDATE baby_logs SET memo = '家族が取り消しの前に足したメモ'
   WHERE id = 'd8888888-8888-8888-8888-888888888888'
     AND household_id = 'd1111111-1111-1111-1111-111111111111'
     AND updated_at = '2026-10-01T05:00:00.222222+00:00'
  RETURNING 1)
SELECT is((SELECT count(*) FROM upd), 1::bigint,
  '取り消しの版ガード: 家族が作成時の版のまま先に更新する（1 行）');

SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'd2222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);
WITH del AS (
  DELETE FROM baby_logs
   WHERE id = 'd8888888-8888-8888-8888-888888888888'
     AND household_id = 'd1111111-1111-1111-1111-111111111111'
     AND updated_at = '2026-10-01T05:00:00.222222+00:00'
  RETURNING 1)
SELECT is((SELECT count(*) FROM del), 0::bigint,
  '取り消しの版ガード: A の「取り消す」（作成時の版）は 0 行');
SELECT is(
  (SELECT memo FROM baby_logs WHERE id = 'd8888888-8888-8888-8888-888888888888'),
  '家族が取り消しの前に足したメモ',
  '取り消しの版ガード: 家族の更新が DB に残る');

-- ══ (8) 別世帯・未承認の利用者は、正しい版を知っていても消せぬ ═════════
-- A の保存の後の版はこのトランザクションの now() に等しい（「版を知らぬから 0 行」の偽緑を避ける）
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'd4444444-4444-4444-4444-444444444444', 'role', 'authenticated')::text, true);
WITH del AS (
  DELETE FROM baby_logs
   WHERE id = 'd7777777-7777-7777-7777-777777777777'
     AND household_id = 'd1111111-1111-1111-1111-111111111111'
     AND updated_at = now()
  RETURNING 1)
SELECT is((SELECT count(*) FROM del), 0::bigint,
  '削除の版ガード: 他世帯は正しい版でも DELETE 0 行');
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'd5555555-5555-5555-5555-555555555555', 'role', 'authenticated')::text, true);
WITH del AS (
  DELETE FROM baby_logs
   WHERE id = 'd7777777-7777-7777-7777-777777777777'
     AND household_id = 'd1111111-1111-1111-1111-111111111111'
     AND updated_at = now()
  RETURNING 1)
SELECT is((SELECT count(*) FROM del), 0::bigint,
  '削除の版ガード: 未承認も正しい版で DELETE 0 行');
RESET ROLE;
SELECT is(
  (SELECT count(*) FROM baby_logs WHERE id = 'd7777777-7777-7777-7777-777777777777'),
  1::bigint,
  '削除の版ガード: 他世帯・未承認の DELETE は行を消しておらぬ（superuser で確認）');

-- ══ (9) 対照: B が最新を読み直してから削除すれば通る ═════════════════
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'd3333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text, true);
WITH del AS (
  DELETE FROM baby_logs
   WHERE id = 'd7777777-7777-7777-7777-777777777777'
     AND household_id = 'd1111111-1111-1111-1111-111111111111'
     AND updated_at = (SELECT (to_json(updated_at) #>> '{}')::timestamptz FROM baby_logs
                        WHERE id = 'd7777777-7777-7777-7777-777777777777')
  RETURNING 1)
SELECT is((SELECT count(*) FROM del), 1::bigint,
  '削除の版ガード（対照）: 読み直した最新の版（JSON 表記）での DELETE は 1 行');
SELECT is(
  (SELECT count(*) FROM baby_logs WHERE id = 'd7777777-7777-7777-7777-777777777777'),
  0::bigint,
  '削除の版ガード（対照）: 最新の版で消した行は無くなる');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
