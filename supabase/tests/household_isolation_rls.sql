-- 主要テーブルの**世帯分離**を pgTAP で検証する（I-13）。
-- 実行: supabase test db supabase/tests/household_isolation_rls.sql
--
-- ## なぜこの assert が要るか
-- 世帯分離は `get_my_household_id()` を使った RLS ポリシー 4 枚
-- （SELECT/INSERT/UPDATE/DELETE）だけが担保しておる。ポリシーが 1 枚落ちても
-- アプリは常に自世帯のデータしか要求せぬため**画面上は正常に見え**、他世帯の
-- 行が漏れていることに気づけぬ。vitest は Supabase を fake するゆえ RLS は
-- 自動検証の外にあった（世帯分離を検証しておったのは calendar_events のみ）。
--
-- 対象は育児記録の 2 表（baby_logs / baby_diaries）。献立・買い物・在庫の表は
-- 2026-09 の機能廃止（20260909100002 / 100003）で消えたため外した。
-- calendar_events は calendar_events_rls.sql が別に持つ。
--
-- ## 偽緑を潰す設計（重要）
-- 「他世帯の行が見えない」は**そもそも行が 1 件も無ければ常に緑**になる。
-- ゆえに本ファイルは三段で組む:
--   (0) SET ROLE の前に superuser で「各表に 2 行（自世帯 1 + 他世帯 1）入った」
--       ことを assert し、seed が効いておることを先に固定する
--   (1) RLS 下で count(*) = 1（0 でも 2 でもない）を要求する
--   (2) 見えておる 1 件が**自世帯の行である**ことを識別子で assert する
-- (0) が落ちれば seed の失敗、(1)(2) が落ちれば分離の破れ、と切り分けられる。
--
-- ## 書込側の残存確認は superuser へ戻ってから行う
-- authenticated 文脈では SELECT ポリシーが他世帯行を隠すため、
-- 「UPDATE/DELETE が 0 行だった」ことをその場では観測できぬ
-- （EXISTS が常に false になり、削除成功と区別がつかぬ＝偽緑）。
-- ゆえに攻撃側の DML を authenticated で撃ったのち RESET ROLE し、
-- superuser で他世帯行の**残存と無改変**を assert する。
--
-- ## 拒否の原因を GRANT と取り違えぬこと
-- 「permission denied for table」と「new row violates row-level security policy」は
-- **どちらも SQLSTATE 42501** じゃ。ゆえに INSERT 拒否の assert には
-- エラーメッセージまで渡し、RLS ポリシーが止めたことを固定する。
--
-- service_role / superuser は RLS をバイパスするため、authenticated +
-- request.jwt.claims を注入して RLS を実際に通す（calendar_events_rls.sql と同流儀）。
-- Supabase プラットフォームは全 public テーブルの DML を authenticated へ実行時
-- GRANT する（migration には含まれぬ）。harness で再現する。
BEGIN;
SELECT plan(12);

-- ── seed(superuser = RLS バイパス) ─────────────────────────────
-- H1 = 検証対象ユーザー U1 の世帯 / H2 = 別世帯（分離検証用・U2 が属する）
INSERT INTO households (id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'H1'),
  ('99999999-9999-9999-9999-999999999999', 'H2');
-- profiles は handle_new_user トリガ（DEFINER）が auth.users から生成する
INSERT INTO auth.users (id, email) VALUES
  ('22222222-2222-2222-2222-222222222222', 'u1@example.com'),
  ('88888888-8888-8888-8888-888888888888', 'u2@example.com');
UPDATE profiles SET household_id = '11111111-1111-1111-1111-111111111111',
                    display_name = 'U1', role = 'owner', is_approved = true
  WHERE id = '22222222-2222-2222-2222-222222222222';
UPDATE profiles SET household_id = '99999999-9999-9999-9999-999999999999',
                    display_name = 'U2', role = 'owner', is_approved = true
  WHERE id = '88888888-8888-8888-8888-888888888888';

-- 各表に「自世帯 1 行 + 他世帯 1 行」を仕込む
-- baby_logs は chk_diaper（diaper 行は diaper_type 必須）を満たす最小行にする
INSERT INTO baby_logs (household_id, log_type, diaper_type, logged_by) VALUES
  ('11111111-1111-1111-1111-111111111111', 'diaper', 'pee',
   '22222222-2222-2222-2222-222222222222'),
  ('99999999-9999-9999-9999-999999999999', 'diaper', 'poop',
   '88888888-8888-8888-8888-888888888888');
INSERT INTO baby_diaries (household_id, diary_date, content, updated_by) VALUES
  ('11111111-1111-1111-1111-111111111111', '2026-08-01', 'H1の日記',
   '22222222-2222-2222-2222-222222222222'),
  ('99999999-9999-9999-9999-999999999999', '2026-08-01', 'H2の日記',
   '88888888-8888-8888-8888-888888888888');

-- ── (0) seed が効いておることの固定（superuser = RLS バイパス）──────
-- ここが赤いなら以降の「他世帯が見えぬ」assert は**行が無いだけの偽緑**じゃ。
SELECT is((SELECT count(*) FROM baby_logs), 2::bigint,
  'seed: baby_logs に 2 行（自世帯 1 + 他世帯 1）入っておる');
SELECT is((SELECT count(*) FROM baby_diaries), 2::bigint,
  'seed: baby_diaries に 2 行（自世帯 1 + 他世帯 1）入っておる');

GRANT SELECT, INSERT, UPDATE, DELETE ON baby_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON baby_diaries TO authenticated;

-- ── U1（H1 所属）の文脈で RLS を実際に通す ──────────────────────
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '22222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);

-- ══ SELECT の分離（可視件数 + 可視行の同一性）══════════════════
SELECT is((SELECT count(*) FROM baby_logs), 1::bigint,
  'baby_logs: 自世帯のみ可視（他世帯は不可視）');
SELECT is((SELECT diaper_type::text FROM baby_logs), 'pee',
  'baby_logs: 見えておる 1 件は自世帯の行');
SELECT is((SELECT count(*) FROM baby_diaries), 1::bigint,
  'baby_diaries: 自世帯のみ可視（他世帯は不可視）');
SELECT is((SELECT content FROM baby_diaries), 'H1の日記',
  'baby_diaries: 見えておる 1 件は自世帯の行');

-- ══ INSERT の分離（他世帯 household_id での書込は拒否）═════════
SELECT throws_ok(
  $$ INSERT INTO baby_logs (household_id, log_type, diaper_type, logged_by)
     VALUES ('99999999-9999-9999-9999-999999999999', 'diaper', 'pee',
             '22222222-2222-2222-2222-222222222222') $$,
  '42501', 'new row violates row-level security policy for table "baby_logs"',
  'baby_logs: 他世帯への INSERT は拒否');
SELECT throws_ok(
  $$ INSERT INTO baby_diaries (household_id, diary_date, content, updated_by)
     VALUES ('99999999-9999-9999-9999-999999999999', '2026-08-02', 'inject',
             '22222222-2222-2222-2222-222222222222') $$,
  '42501', 'new row violates row-level security policy for table "baby_diaries"',
  'baby_diaries: 他世帯への INSERT は拒否');

-- ══ UPDATE / DELETE の分離 ═════════════════════════════════════
-- 他世帯行を狙って撃つ。RLS が効いておれば USING 不一致で 0 行（例外は出ぬ）。
-- 残存確認は superuser へ戻ってから行う（authenticated では SELECT が隠すゆえ）。
UPDATE baby_logs SET diaper_type = 'both' WHERE household_id = '99999999-9999-9999-9999-999999999999';
DELETE FROM baby_logs WHERE household_id = '99999999-9999-9999-9999-999999999999';
UPDATE baby_diaries SET content = 'hacked' WHERE household_id = '99999999-9999-9999-9999-999999999999';
DELETE FROM baby_diaries WHERE household_id = '99999999-9999-9999-9999-999999999999';

RESET ROLE;

-- 他世帯行が「残っておる」かつ「書き換わっておらぬ」ことを superuser で確認する。
-- 元の値のまま 1 行 = DELETE も UPDATE も 0 行だった証跡。
SELECT is((SELECT count(*) FROM baby_logs WHERE household_id = '99999999-9999-9999-9999-999999999999'),
  1::bigint, 'baby_logs: 他世帯行は DELETE されず残存');
SELECT is((SELECT diaper_type::text FROM baby_logs WHERE household_id = '99999999-9999-9999-9999-999999999999'),
  'poop', 'baby_logs: 他世帯行は UPDATE されず無改変');
SELECT is((SELECT count(*) FROM baby_diaries WHERE household_id = '99999999-9999-9999-9999-999999999999'),
  1::bigint, 'baby_diaries: 他世帯行は DELETE されず残存');
SELECT is((SELECT content FROM baby_diaries WHERE household_id = '99999999-9999-9999-9999-999999999999'),
  'H2の日記', 'baby_diaries: 他世帯行は UPDATE されず無改変');

SELECT * FROM finish();
ROLLBACK;
