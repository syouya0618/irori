-- 育児日記の楽観的排他（P1-06）が拠って立つ DB の振る舞いを固定する。
-- 実行: supabase test db supabase/tests/baby_diaries_version_guard.sql
--
-- ## なぜ要るか
-- upsertBabyDiary（src/app/(main)/baby/actions.ts）は updated_at を版にして、
--   新規 = INSERT … ON CONFLICT (household_id, child_id, diary_date) DO NOTHING（行が在れば 0 行）
--   更新 = UPDATE … WHERE updated_at = 期待版（版が進んでおれば 0 行）
--   削除 = DELETE … WHERE updated_at = 期待版
-- の「0 行」を衝突として扱う。vitest の fake はこの振る舞いを**自前で模すだけ**ゆえ、
-- 本物の Postgres で (1) 衝突の 0 行が返ること (2) trg_baby_diaries_updated_at が
-- UPDATE で版を進めること (3) PostgREST / Realtime の表記の版がそのまま一致すること、
-- を確かめる。どれかが崩れれば、家族の本文の無言上書き（P1-06）が戻るか、毎回の保存が
-- 誤って衝突になる。
--
-- ## 版の値は明示する
-- 同じトランザクションの now() は一定ゆえ、DEFAULT now() の行を同じトランザクションで
-- UPDATE しても版は変わらぬ（本番は要求ごとに別トランザクションゆえ進む）。ゆえに seed の
-- 版を過去の固定値で入れ、UPDATE が trigger で now()（= それと異なる値）へ進むことを見る。
BEGIN;
SELECT plan(12);

INSERT INTO households (id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'H1');
INSERT INTO auth.users (id, email) VALUES
  ('22222222-2222-2222-2222-222222222222', 'u1@example.com');
UPDATE profiles SET household_id = '11111111-1111-1111-1111-111111111111',
                    display_name = 'U1', role = 'owner', is_approved = true
  WHERE id = '22222222-2222-2222-2222-222222222222';
INSERT INTO baby_diaries (household_id, diary_date, content, updated_by, updated_at) VALUES
  ('11111111-1111-1111-1111-111111111111', '2026-07-20', '家族が先に書いた本文',
   '22222222-2222-2222-2222-222222222222', '2026-07-22T03:00:00.123456+00:00');

-- seed の固定（ここが赤いなら以降は行が無いだけの偽緑）
SELECT is((SELECT count(*) FROM baby_diaries), 1::bigint, 'seed: baby_diaries に 1 行');

GRANT SELECT, INSERT, UPDATE, DELETE ON baby_diaries TO authenticated;

SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '22222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);

-- data-modifying な CTE は文の最上位にしか置けぬゆえ、WITH … SELECT is(…) の形で書く。

-- (1) 新規の経路: 行が在れば ON CONFLICT DO NOTHING は 0 行を返す（= 衝突）
WITH ins AS (
  INSERT INTO baby_diaries (household_id, diary_date, content, updated_by)
  VALUES ('11111111-1111-1111-1111-111111111111', '2026-07-20', '空欄から書いた一言',
          '22222222-2222-2222-2222-222222222222')
  ON CONFLICT (household_id, child_id, diary_date) DO NOTHING
  RETURNING 1)
SELECT is((SELECT count(*) FROM ins), 0::bigint,
  '新規: 既存行が在れば ON CONFLICT DO NOTHING は 0 行（衝突として検知できる）');
SELECT is((SELECT content FROM baby_diaries WHERE diary_date = '2026-07-20'),
  '家族が先に書いた本文', '新規: 既存の本文は無傷');

-- (2) 古い版の UPDATE は 0 行（PostgREST の表記の版）
WITH upd AS (
  UPDATE baby_diaries SET content = '古い版から書いた本文'
   WHERE household_id = '11111111-1111-1111-1111-111111111111'
     AND diary_date = '2026-07-20'
     AND updated_at = '2026-07-21T22:00:00.654321+00:00'
  RETURNING 1)
SELECT is((SELECT count(*) FROM upd), 0::bigint, '更新: 古い版の UPDATE は 0 行');

-- (3) 一致する版の UPDATE は 1 行で、trigger が版を進める
WITH upd AS (
  UPDATE baby_diaries SET content = '版が一致した本文'
   WHERE household_id = '11111111-1111-1111-1111-111111111111'
     AND diary_date = '2026-07-20'
     AND updated_at = '2026-07-22T03:00:00.123456+00:00'
  RETURNING 1)
SELECT is((SELECT count(*) FROM upd), 1::bigint,
  '更新: 一致する版（PostgREST 表記・マイクロ秒つき）の UPDATE は 1 行');
SELECT isnt(
  (SELECT updated_at FROM baby_diaries WHERE diary_date = '2026-07-20'),
  '2026-07-22T03:00:00.123456+00:00'::timestamptz,
  '更新: trg_baby_diaries_updated_at が版を進める（進まねば次の衝突を検知できぬ）');

-- (4) 進んだ後の旧い版では、もう書けぬ（配偶者の後に古い画面から押した場合）
WITH upd AS (
  UPDATE baby_diaries SET content = '二度目の古い版'
   WHERE household_id = '11111111-1111-1111-1111-111111111111'
     AND diary_date = '2026-07-20'
     AND updated_at = '2026-07-22T03:00:00.123456+00:00'
  RETURNING 1)
SELECT is((SELECT count(*) FROM upd), 0::bigint,
  '更新: 版が進んだ後は、元の版での UPDATE は 0 行');

-- (5) 版の表記ゆれ: Realtime 風（空白区切り・時差短縮）でも同じ版として一致する
-- 版を固定値へ置くには trigger を止める（止めねば BEFORE UPDATE が now() で上書きする）。
-- DISABLE TRIGGER は表の所有者権限で足り、このトランザクションの ROLLBACK で戻る。
RESET ROLE;
ALTER TABLE baby_diaries DISABLE TRIGGER trg_baby_diaries_updated_at;
UPDATE baby_diaries SET updated_at = '2026-07-23T01:02:03.000456+00:00'
 WHERE diary_date = '2026-07-20';
ALTER TABLE baby_diaries ENABLE TRIGGER trg_baby_diaries_updated_at;
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '22222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);
SELECT is(
  (SELECT count(*) FROM baby_diaries
    WHERE diary_date = '2026-07-20' AND updated_at = '2026-07-23 01:02:03.000456+00'),
  1::bigint,
  '表記: 空白区切り・時差短縮の版も同じ timestamptz として一致する');
SELECT is(
  (SELECT count(*) FROM baby_diaries
    WHERE diary_date = '2026-07-20' AND updated_at = '2026-07-23T01:02:03.000+00:00'),
  0::bigint,
  '表記: ミリ秒へ丸めた版は一致しない（版の文字列を Date に通して丸めてはならぬ）');

-- (6) 削除: 古い版は 0 行、一致する版で 1 行
WITH del AS (
  DELETE FROM baby_diaries
   WHERE household_id = '11111111-1111-1111-1111-111111111111'
     AND diary_date = '2026-07-20'
     AND updated_at = '2026-07-22T03:00:00.123456+00:00'
  RETURNING 1)
SELECT is((SELECT count(*) FROM del), 0::bigint,
  '削除: 古い版の DELETE は 0 行（家族の新しい本文を消さぬ）');
WITH del AS (
  DELETE FROM baby_diaries
   WHERE household_id = '11111111-1111-1111-1111-111111111111'
     AND diary_date = '2026-07-20'
     AND updated_at = '2026-07-23T01:02:03.000456+00:00'
  RETURNING 1)
SELECT is((SELECT count(*) FROM del), 1::bigint, '削除: 一致する版の DELETE は 1 行');

RESET ROLE;
SELECT is((SELECT count(*) FROM baby_diaries), 0::bigint, '削除: 行は消えておる（superuser で確認）');

SELECT * FROM finish();
ROLLBACK;
