-- 承認関数 `approve_user` / `get_pending_approvals` の権限ゲートを pgTAP で固定する（I-13）。
-- 実行: supabase test db supabase/tests/approval_functions.sql
--
-- ## なぜこの assert が要るか
-- この 2 関数は**自動テストが 0 本**であった。しかも同一機能は 2026-06-03 に
-- High 重大度で壊れた前科がある（20260603000001 の H3）。防御は関数内の
-- 「role='owner' か」判定ただ 1 つで、RLS ではなく plpgsql の IF 文が担う。
-- SECURITY DEFINER ゆえ判定が外れた瞬間に**全世帯の承認が誰にでも通る**。
--
-- ## 「他世帯拒否」を assert **しない**理由（重要・意図的な設計）
-- 当初この 2 関数へ自世帯フィルタ（household_id = get_my_household_id()）を
-- 入れる案があったが、独立レビューで**回帰と判明し撤回**された。
-- 記録: 20260603000001_security_hardening_rls.sql:108-125（実読のこと）。
--   承認待ち(is_approved=false)ユーザーは必ず household_id IS NULL になる
--   （handle_new_user は household 未設定／create_household・accept_invitation は
--   is_approved=true を同時設定するため）。ゆえに自世帯フィルタを入れると
--   `NULL = owner_household` が常に false となり、**承認導線が全損**して
--   招待なしの新規ユーザーが /pending-approval に恒久的に詰む。
-- 「全 owner が全 pending を見る」は本設計（グローバル allowlist）で**意図された挙動**じゃ。
-- ゆえに本ファイルは他世帯拒否を要求せず、逆に (10) でその設計を**固定**する。
-- 将来ここへ世帯フィルタを入れる者は (10) が赤くなることで上の記録に必ず突き当たる。
--
-- ## superuser では検出できぬ
-- 両関数は auth.uid() で分岐する。superuser 文脈では auth.uid() が NULL となり
-- **どちらも拒否側の枝に落ちる**ため、「member が拒否された」assert が
-- 偽緑になる。ゆえに authenticated + request.jwt.claims を注入して実際に通す。
BEGIN;
SELECT plan(11);

-- ── seed(superuser = RLS バイパス) ─────────────────────────────
-- H1 = owner U1 / member U2, H2 = owner U5（別世帯）
-- U3, U4 = 承認待ち（household_id IS NULL / is_approved=false）
INSERT INTO households (id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'H1'),
  ('99999999-9999-9999-9999-999999999999', 'H2');
INSERT INTO auth.users (id, email) VALUES
  ('22222222-2222-2222-2222-222222222222', 'owner1@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'member1@example.com'),
  ('44444444-4444-4444-4444-444444444444', 'pending1@example.com'),
  ('55555555-5555-5555-5555-555555555555', 'pending2@example.com'),
  ('66666666-6666-6666-6666-666666666666', 'owner2@example.com');
UPDATE profiles SET household_id = '11111111-1111-1111-1111-111111111111',
                    display_name = 'U1 owner', role = 'owner', is_approved = true
  WHERE id = '22222222-2222-2222-2222-222222222222';
UPDATE profiles SET household_id = '11111111-1111-1111-1111-111111111111',
                    display_name = 'U2 member', role = 'member', is_approved = true
  WHERE id = '33333333-3333-3333-3333-333333333333';
UPDATE profiles SET household_id = '99999999-9999-9999-9999-999999999999',
                    display_name = 'U5 owner(H2)', role = 'owner', is_approved = true
  WHERE id = '66666666-6666-6666-6666-666666666666';
-- U3/U4 は handle_new_user が作った素の行のまま（household_id NULL・is_approved false）

-- ── (1) seed が効いておることの固定 ────────────────────────────
-- 承認待ちが 0 人だと以降の「member には見えぬ」assert が**行が無いだけの偽緑**になる。
--
-- ⚠️ **本テストが seed した 2 人に限定して数える**（世界全体を数えぬ）。
-- 以前は `count(*) FROM profiles WHERE is_approved = false AND household_id IS NULL`
-- と全体を数えて 2 を期待しており、**DB に他の承認待ちユーザーが 1 人でも
-- 居れば、変更と無関係に赤くなった**。CI は毎回新品の DB ゆえ通っておったが、
-- 手元で e2e を一度回すだけで壊れる（実測: 残留 13 人 + seed 2 人 = 15）。
--
-- 変更と無関係な赤は「赤に慣れる」を招き、本物の赤と区別できなくなる。
-- ID を名指しすれば、この assert の意味（seed の 2 人が承認待ちで居る）は
-- そのままに、外部の状態から独立になる。
SELECT is(
  (SELECT count(*) FROM profiles
    WHERE id IN ('44444444-4444-4444-4444-444444444444',
                 '55555555-5555-5555-5555-555555555555')
      AND is_approved = false AND household_id IS NULL),
  2::bigint, 'seed: 本テストの承認待ち 2 人が居る（household_id は NULL）');

-- ══ member 文脈 ════════════════════════════════════════════════
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '33333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text, true);

-- (2) member には承認待ち一覧が見えぬ（関数内 role='owner' 判定の早期 RETURN）
SELECT is((SELECT count(*) FROM get_pending_approvals()), 0::bigint,
  'get_pending_approvals: member には 0 件（owner 判定の早期 RETURN）');

-- (3) member は承認できぬ
SELECT throws_ok(
  $$ SELECT approve_user('44444444-4444-4444-4444-444444444444') $$,
  'P0001', 'Only owners can approve users',
  'approve_user: member は拒否される');

-- (4) 拒否は副作用も残さぬ（例外は出たが承認されておらぬこと）
-- profiles の観測は superuser で行う。authenticated のままだと profiles_select
-- （household_id = get_my_household_id()）が承認待ち行（household_id IS NULL）を
-- 隠し、is_approved が false ではなく **NULL** で返って assert の意味が変わる。
RESET ROLE;
SELECT is(
  (SELECT is_approved FROM profiles WHERE id = '44444444-4444-4444-4444-444444444444'),
  false, 'approve_user: member の失敗で承認状態は変わらぬ');
SET LOCAL role authenticated;

-- ══ owner(H1) 文脈 ═════════════════════════════════════════════
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '22222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);

-- (5) owner には承認待ちが見える = (2) が「行が無いだけ」ではない対照
--
-- (1) と同じ理由で **seed した 2 人に限定して数える**。外部の承認待ちユーザーが
-- 居ても壊れぬ。
--
-- ⚠️ 限定しても**世帯フィルタの回帰は捕まる**: seed の承認待ち 2 人は
-- `household_id IS NULL` ゆえ、`get_pending_approvals` に自世帯フィルタを
-- 入れると `NULL = owner_household` が常に false となり、この count は
-- 2 → 0 になって赤くなる。その案は 20260603000001:109-125 で
-- 「承認導線が全損する」として撤回済みであり、この assert がその門番じゃ。
SELECT is(
  (SELECT count(*) FROM get_pending_approvals()
    WHERE id IN ('44444444-4444-4444-4444-444444444444',
                 '55555555-5555-5555-5555-555555555555')),
  2::bigint, 'get_pending_approvals: owner には seed の 2 件が見える（(2) の対照）');

-- (6) 一覧には email が載る（承認判断の材料・欠けたら導線が死ぬ）
SELECT is(
  (SELECT email FROM get_pending_approvals() WHERE id = '44444444-4444-4444-4444-444444444444'),
  'pending1@example.com', 'get_pending_approvals: email が返る');

-- (7) owner は承認できる
SELECT lives_ok(
  $$ SELECT approve_user('44444444-4444-4444-4444-444444444444') $$,
  'approve_user: owner は承認できる');

-- (8) 承認が実際に反映されておる（例外が出ぬだけの偽緑を潰す）
-- (4) と同じ理由で superuser で観測する。
RESET ROLE;
SELECT is(
  (SELECT is_approved FROM profiles WHERE id = '44444444-4444-4444-4444-444444444444'),
  true, 'approve_user: is_approved が true になる');
SET LOCAL role authenticated;

-- (9) 二重承認は fail-loud（IF NOT FOUND 分岐・silent success を作らぬ）
SELECT throws_ok(
  $$ SELECT approve_user('44444444-4444-4444-4444-444444444444') $$,
  'P0001', 'User not found or already approved',
  'approve_user: 承認済みユーザーの再承認は拒否（silent success を作らぬ）');

-- (10) 存在せぬユーザーも fail-loud（0 行 UPDATE を成功と見せぬ）
SELECT throws_ok(
  $$ SELECT approve_user('00000000-0000-0000-0000-000000000000') $$,
  'P0001', 'User not found or already approved',
  'approve_user: 存在せぬユーザーは拒否（0 行 UPDATE を成功と見せぬ）');

-- ══ owner(H2) 文脈 — 設計の固定 ════════════════════════════════
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '66666666-6666-6666-6666-666666666666', 'role', 'authenticated')::text, true);

-- (11) 別世帯の owner も承認待ちを承認できる = **グローバル allowlist（意図された設計）**。
--      承認待ちは household_id IS NULL ゆえ「自世帯の pending」なる概念が存在せぬ。
--      ここへ世帯フィルタを入れると承認導線が全損する（20260603000001:108-125）。
--      この assert は分離の欠落ではなく、**設計の意図的な固定**じゃ。
SELECT lives_ok(
  $$ SELECT approve_user('55555555-5555-5555-5555-555555555555') $$,
  'approve_user: 別世帯 owner も承認できる（グローバル allowlist = 意図された設計・20260603000001:108-125）');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
