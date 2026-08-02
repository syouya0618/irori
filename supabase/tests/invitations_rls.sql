-- invitations の RLS（role / invited_by / 世帯）を pgTAP で検証する。
-- 実行: supabase test db supabase/tests/invitations_rls.sql
--
-- ## なぜこの assert が要るか（I-14）
-- `invitations_insert` / `invitations_update` は **household_id しか拘束して
-- おらぬ**（20260406000001:283-284 / 20260407000001 末尾）。ゆえに member が
-- `role='owner'` の招待を発行でき、その招待を受けた新規アカウントは
-- `accept_invitation`（20260408000002）により **role=owner かつ is_approved=true**
-- を一度に得る。すなわち
--   (a) 権限昇格（member → 共犯アカウントを owner に）
--   (b) 承認ゲート（is_approved）のバイパス
-- の二つが RLS 一枚の欠落で同時に開く。実機 probe でも member による
-- `role='owner'` 挿入が `INSERT 0 1` で通ることを確認済み。
--
-- ## 偽緑を避けるための注意（重要）
-- 「permission denied for table」と「new row violates row-level security policy」は
-- **どちらも SQLSTATE 42501** じゃ。GRANT が無いだけでも 42501 で落ちるため、
-- errcode だけを assert すると「ポリシーで止めた」証明にならぬ。
-- ゆえに本ファイルでは throws_ok に **エラーメッセージまで渡して**、
-- 拒否の原因が RLS ポリシーであることを固定する。
--
-- Supabase プラットフォームは全 public テーブルの DML を authenticated へ実行時
-- GRANT する（migration には含まれぬ）。harness で再現する。
BEGIN;
SELECT plan(8);

-- ── seed(superuser = RLS バイパス) ─────────────────────────────
-- H1 = 検証対象の世帯（owner U1 / member U2）, H2 = 別世帯
INSERT INTO households (id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'H1'),
  ('99999999-9999-9999-9999-999999999999', 'H2');
-- profiles は handle_new_user トリガ（DEFINER）が auth.users から生成する
INSERT INTO auth.users (id, email) VALUES
  ('22222222-2222-2222-2222-222222222222', 'owner@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'member@example.com');
UPDATE profiles SET household_id = '11111111-1111-1111-1111-111111111111',
                    display_name = 'U1 owner', role = 'owner', is_approved = true
  WHERE id = '22222222-2222-2222-2222-222222222222';
UPDATE profiles SET household_id = '11111111-1111-1111-1111-111111111111',
                    display_name = 'U2 member', role = 'member', is_approved = true
  WHERE id = '33333333-3333-3333-3333-333333333333';

GRANT SELECT, INSERT, UPDATE, DELETE ON invitations TO authenticated;

-- ── member 文脈（authenticated + JWT claims）────────────────────
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '33333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text, true);

-- (1) 対照（seed とハーネスが効いておることの固定）:
--     まっとうな member 招待は通らねばならぬ。これが赤いなら以降の
--     「拒否された」assert は GRANT 不足等による偽緑じゃ。
SELECT lives_ok(
  $$ INSERT INTO invitations (household_id, invited_by, role)
     VALUES ('11111111-1111-1111-1111-111111111111',
             '33333333-3333-3333-3333-333333333333', 'member') $$,
  'RLS: member は自世帯の role=member 招待を作れる（対照・修正後も維持）'
);

-- (2) 【I-14 本体】member が role='owner' の招待を発行できてはならぬ。
SELECT throws_ok(
  $$ INSERT INTO invitations (household_id, invited_by, role)
     VALUES ('11111111-1111-1111-1111-111111111111',
             '33333333-3333-3333-3333-333333333333', 'owner') $$,
  '42501',
  'new row violates row-level security policy for table "invitations"',
  'RLS: role=owner の招待は拒否（権限昇格 + 承認ゲート回避の封鎖）'
);

-- (3) role='viewer' も同様に拒否（member 以外は一律不可）。
SELECT throws_ok(
  $$ INSERT INTO invitations (household_id, invited_by, role)
     VALUES ('11111111-1111-1111-1111-111111111111',
             '33333333-3333-3333-3333-333333333333', 'viewer') $$,
  '42501',
  'new row violates row-level security policy for table "invitations"',
  'RLS: role=viewer の招待も拒否（member 以外は一律不可）'
);

-- (4) invited_by の詐称（他人名義での招待発行）は拒否。
--     アプリ経路は actions.ts が userId を入れるが、PostgREST 直叩きでは任意に置ける。
SELECT throws_ok(
  $$ INSERT INTO invitations (household_id, invited_by, role)
     VALUES ('11111111-1111-1111-1111-111111111111',
             '22222222-2222-2222-2222-222222222222', 'member') $$,
  '42501',
  'new row violates row-level security policy for table "invitations"',
  'RLS: invited_by の詐称（他人名義）は拒否'
);

-- (5) 別世帯への招待発行は拒否（既存の household_id 拘束の回帰固定）。
SELECT throws_ok(
  $$ INSERT INTO invitations (household_id, invited_by, role)
     VALUES ('99999999-9999-9999-9999-999999999999',
             '33333333-3333-3333-3333-333333333333', 'member') $$,
  '42501',
  'new row violates row-level security policy for table "invitations"',
  'RLS: 別世帯への招待発行は拒否'
);

-- (6) UPDATE で role を owner へ昇格させる経路も塞がっておらねばならぬ。
--     INSERT だけ塞いで UPDATE を放置すると、member 招待を作ってから
--     owner へ書き換える二手で同じ昇格が成立する。
SELECT throws_ok(
  $$ UPDATE invitations SET role = 'owner'
     WHERE household_id = '11111111-1111-1111-1111-111111111111' $$,
  '42501',
  'new row violates row-level security policy for table "invitations"',
  'RLS: UPDATE による role=owner への昇格は拒否'
);

-- (7) 対照: status の遷移（期限切れにする等）は引き続き許可されねばならぬ。
--     ここが赤いと (6) の修正が招待運用そのものを壊しておる。
SELECT lives_ok(
  $$ UPDATE invitations SET status = 'expired'
     WHERE household_id = '11111111-1111-1111-1111-111111111111' $$,
  'RLS: status の遷移は許可（対照・招待運用を壊さぬこと）'
);

-- (8) 別世帯への付け替えも拒否（WITH CHECK 明示後も household 拘束が残ること）。
SELECT throws_ok(
  $$ UPDATE invitations SET household_id = '99999999-9999-9999-9999-999999999999'
     WHERE household_id = '11111111-1111-1111-1111-111111111111' $$,
  '42501',
  'new row violates row-level security policy for table "invitations"',
  'RLS: 招待の別世帯への付け替えは拒否'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
