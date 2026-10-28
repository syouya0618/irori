-- 記録の再送契約（2026-10-27 大型更新 A2 / 受入 AC02・AC03）が拠って立つ DB の振る舞いを固定する。
-- 実行: supabase test db supabase/tests/baby_logs_client_id_replay.sql
--
-- ## なぜ要るか
-- record*（src/app/(main)/baby/actions.ts の insertBabyLog）はクライアントの冪等 id を主キーに INSERT し、
-- 主キー重複（23505）を「保存は成立したが応答だけが失われた再送」として、自世帯の同じ id の行を読み直して
-- 内容を比べる。授乳タイマー・手動記録は最初の押下で送信内容（開始時刻・左右秒・回数・開始側）を固定し、
-- 再送は同じ内容を送る。vitest の fake はこの振る舞いを模すだけゆえ、本物の Postgres + RLS で
-- (1) 自世帯の利用者は id を指定して INSERT できる（主キー列の権限・RLS）
-- (2) 同じ id の 2 回目の INSERT は 23505 で落ち、行は 1 件のまま・先の内容のまま
-- (3) 同じ id に別の内容を送っても 23505（上書きも二重もせぬ — サーバは衝突として確定行を返す）
-- (4) 読み直しは自世帯で絞れば 1 行・開始時刻・左右秒・合計（CHECK の等式）が送った値のまま
-- (5) 別世帯の利用者には同じ id の行が見えぬ（読み直しは「無い」= rejected。内容を漏らさぬ）
-- (6) 別世帯の利用者が同じ id で INSERT しても 23505（行を奪えぬ）、他世帯へ INSERT は RLS が拒む
-- を確かめる。
BEGIN;
SELECT plan(12);

INSERT INTO households (id, name) VALUES
  ('e1111111-1111-1111-1111-111111111111', 'RP H1'),
  ('e9999999-9999-9999-9999-999999999999', 'RP H2');
INSERT INTO auth.users (id, email) VALUES
  ('e2222222-2222-2222-2222-222222222222', 'rp-a@example.com'),
  ('e4444444-4444-4444-4444-444444444444', 'rp-other@example.com');
UPDATE profiles SET household_id = 'e1111111-1111-1111-1111-111111111111',
                    display_name = 'RP A', role = 'owner', is_approved = true
  WHERE id = 'e2222222-2222-2222-2222-222222222222';
UPDATE profiles SET household_id = 'e9999999-9999-9999-9999-999999999999',
                    display_name = 'RP other', role = 'owner', is_approved = true
  WHERE id = 'e4444444-4444-4444-4444-444444444444';

GRANT SELECT, INSERT, UPDATE, DELETE ON baby_logs TO authenticated;

SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'e2222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);

-- ══ (1) 初回の送信（タイマー停止: 開始 13:00・左 5 分・左 1 回・左から）══════════
SELECT lives_ok($$
  INSERT INTO baby_logs (id, household_id, logged_by, log_type, feeding_type,
    breast_left_count, breast_right_count, breast_left_sec, breast_right_sec,
    breast_start_side, duration_sec, duration_min, logged_at)
  VALUES ('e6666666-6666-6666-6666-666666666666', 'e1111111-1111-1111-1111-111111111111',
    'e2222222-2222-2222-2222-222222222222', 'feeding', 'breast',
    1, 0, 300, 0, 'left', 300, 5, '2026-07-19T04:00:00.000Z')
$$, '(1) 自世帯の利用者は冪等 id を主キーに指定して INSERT できる');

-- ══ (2) 応答を失った後の同じ内容の再送 ═══════════════════════════
SELECT throws_ok($$
  INSERT INTO baby_logs (id, household_id, logged_by, log_type, feeding_type,
    breast_left_count, breast_right_count, breast_left_sec, breast_right_sec,
    breast_start_side, duration_sec, duration_min, logged_at)
  VALUES ('e6666666-6666-6666-6666-666666666666', 'e1111111-1111-1111-1111-111111111111',
    'e2222222-2222-2222-2222-222222222222', 'feeding', 'breast',
    1, 0, 300, 0, 'left', 300, 5, '2026-07-19T04:00:00.000Z')
$$, '23505', NULL, '(2) 同じ id の再送は主キー重複（23505）で落ちる');
SELECT is((SELECT count(*) FROM baby_logs WHERE id = 'e6666666-6666-6666-6666-666666666666'),
  1::bigint, '(2) 行は 1 件のまま（二重記録にならぬ）');

-- ══ (3) 旧版の画面: 同じ id で経過の増えた秒数・押し直した時刻を送る ══════════
SELECT throws_ok($$
  INSERT INTO baby_logs (id, household_id, logged_by, log_type, feeding_type,
    breast_left_count, breast_right_count, breast_left_sec, breast_right_sec,
    breast_start_side, duration_sec, duration_min, logged_at)
  VALUES ('e6666666-6666-6666-6666-666666666666', 'e1111111-1111-1111-1111-111111111111',
    'e2222222-2222-2222-2222-222222222222', 'feeding', 'breast',
    1, 0, 390, 0, 'left', 390, 7, '2026-07-19T04:01:30.000Z')
$$, '23505', NULL, '(3) 同じ id に別の内容を送っても 23505（上書きせぬ）');

-- ══ (4) 自世帯での読み直し（insertBabyLog の重複時の読み直しと同じ絞り込み）══════
SELECT is(
  (SELECT count(*) FROM baby_logs
    WHERE id = 'e6666666-6666-6666-6666-666666666666'
      AND household_id = 'e1111111-1111-1111-1111-111111111111'),
  1::bigint, '(4) 自世帯で絞った読み直しは 1 行');
SELECT is(
  (SELECT logged_at FROM baby_logs WHERE id = 'e6666666-6666-6666-6666-666666666666'),
  '2026-07-19T04:00:00+00:00'::timestamptz,
  '(4) 開始時刻は最初の送信のまま（再送の時刻で書き換わらぬ）');
SELECT is(
  (SELECT breast_left_sec || '/' || breast_right_sec || '/' || duration_sec
     FROM baby_logs WHERE id = 'e6666666-6666-6666-6666-666666666666'),
  '300/0/300', '(4) 左右秒と合計（chk_breast_side_sec_total）は最初の送信のまま');
-- PostgREST の JSON（to_jsonb と同じ直列化）の logged_at は "+00:00" 表記。クライアントは "Z" で送る。
-- sameRecordedContent は epoch で比べる — 文字列のまま比べれば同じ内容の再送を衝突と誤る
SELECT is(
  ((SELECT to_jsonb(b) FROM baby_logs b WHERE id = 'e6666666-6666-6666-6666-666666666666')->>'logged_at'),
  '2026-07-19T04:00:00+00:00',
  '(4) 読み直しの JSON は +00:00 表記（送った Z 表記と文字列では一致せぬ → epoch で比べる根拠）');

-- ══ (5)(6) 別世帯の利用者 ════════════════════════════════════════
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'e4444444-4444-4444-4444-444444444444', 'role', 'authenticated')::text, true);
SELECT is((SELECT count(*) FROM baby_logs WHERE id = 'e6666666-6666-6666-6666-666666666666'),
  0::bigint, '(5) 別世帯の利用者には同じ id の行が見えぬ（読み直しは無い = 内容を漏らさぬ）');
SELECT throws_ok($$
  INSERT INTO baby_logs (id, household_id, logged_by, log_type, diaper_type)
  VALUES ('e6666666-6666-6666-6666-666666666666', 'e9999999-9999-9999-9999-999999999999',
    'e4444444-4444-4444-4444-444444444444', 'diaper', 'pee')
$$, '23505', NULL, '(6) 別世帯が同じ id で自世帯へ INSERT しても 23505（行を奪えぬ）');
SELECT throws_ok($$
  INSERT INTO baby_logs (id, household_id, logged_by, log_type, diaper_type)
  VALUES ('e7777777-7777-7777-7777-777777777777', 'e1111111-1111-1111-1111-111111111111',
    'e4444444-4444-4444-4444-444444444444', 'diaper', 'pee')
$$, '42501', NULL, '(6) 他世帯への INSERT は RLS が拒む');

RESET role;
SELECT is(
  (SELECT memo IS NULL AND feeding_type = 'breast' FROM baby_logs WHERE id = 'e6666666-6666-6666-6666-666666666666'),
  true, '(2)(3)(6) どの再送・別世帯の試みの後も、先の内容が無傷で残る');

SELECT * FROM finish();
ROLLBACK;
