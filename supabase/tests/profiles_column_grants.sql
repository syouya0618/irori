-- profiles の**列レベル GRANT** を機械で固定する。
-- 実行: supabase test db supabase/tests/profiles_column_grants.sql
--
-- ## なぜこの assert が要るか
-- `profiles.is_approved` / `role` / `household_id` は、書き換えられると
-- **承認ゲートの突破と全世帯の乗っ取り**に直結する。これを止めておるのは
-- RLS ポリシーではなく **列レベル GRANT 1 枚**じゃ:
--   20260603000001_security_hardening_rls.sql
--     REVOKE INSERT, UPDATE ON public.profiles FROM authenticated;
--     GRANT UPDATE (display_name, avatar_url, default_page) ON public.profiles TO authenticated;
-- 既存の profiles_update ポリシー（USING id = auth.uid()）は**行**を絞るのみで、
-- 「自分の行の is_approved を true にする」は行レベルでは合法じゃ。列 GRANT が
-- 外れた瞬間に防御はゼロになる — しかも RLS ポリシーは残るため、ポリシー一覧を
-- 見ても異常に見えぬ。ゆえに列 GRANT そのものを assert する。
--
-- ## information_schema を使わぬ理由
-- `information_schema.column_privileges` は「現在有効なロールが grantor か
-- grantee である行」しか返さぬ（SQL 標準の可視性規則）。テストを走らせるロール
-- 次第で**黙って 0 行になり、assert が偽緑になる**。ゆえに catalog（`pg_attribute.attacl`
-- / `pg_class.relacl`）を `aclexplode` で直接読む。
--
-- ## この assert は原因究明も兼ねる（計画書 I-04）
-- 開発機のローカル DB では同じ GRANT が失われており、実機 probe で is_approved の
-- 自己書き換えが成功した（BEGIN…ROLLBACK 済み）。一方で本番 dump では保護されておる。
-- CI は毎回 fresh reset の上でこれを走らせるため、
--   - CI で緑 → migration は正しく、壊れておるのは stale なローカルのみ
--   - CI で赤 → 原因が再現可能な形で CI に捕まる
-- のどちらかに決着する。
--
-- ## 限界（正直に書く）
-- これは**検知**であって**防止**ではない。GRANT を緩める migration を書けば
-- このテストが赤くなるだけで、緩めること自体は止められぬ。赤を無視するなという
-- 規律とセットで初めて意味を持つ。
BEGIN;
SELECT plan(4);

-- ── 1. authenticated は profiles を「列を指定せず」UPDATE できてはならぬ ──
-- テーブルレベル UPDATE が在ると全列が書けてしまい、列 GRANT は無意味になる。
SELECT is_empty(
  $$
  SELECT 1
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) acl
  WHERE n.nspname = 'public'
    AND c.relname = 'profiles'
    AND acl.grantee = 'authenticated'::regrole
    AND acl.privilege_type = 'UPDATE'
  $$,
  'authenticated に profiles のテーブルレベル UPDATE が無い'
);

-- ── 2. authenticated は profiles へ直接 INSERT できてはならぬ ──
-- 新規行は handle_new_user トリガ（SECURITY DEFINER）が作る契約じゃ。
SELECT is_empty(
  $$
  SELECT 1
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) acl
  WHERE n.nspname = 'public'
    AND c.relname = 'profiles'
    AND acl.grantee = 'authenticated'::regrole
    AND acl.privilege_type = 'INSERT'
  $$,
  'authenticated に profiles のテーブルレベル INSERT が無い'
);

-- ── 3. 列 UPDATE の集合が「ちょうど」自己申告 3 列であること ──
-- set_eq ゆえ、**足りなくても余っても**赤くなる。is_approved / role /
-- household_id がここへ紛れ込んだ瞬間に落ちる。
SELECT set_eq(
  $$
  SELECT a.attname::text
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(a.attacl) acl
  WHERE n.nspname = 'public'
    AND c.relname = 'profiles'
    AND a.attnum > 0
    AND NOT a.attisdropped
    AND acl.grantee = 'authenticated'::regrole
    AND acl.privilege_type = 'UPDATE'
  $$,
  ARRAY['display_name', 'avatar_url', 'default_page'],
  'authenticated が UPDATE できる profiles の列は display_name / avatar_url / default_page のみ'
);

-- ── 4. 権限に直結する 3 列が名指しで書けぬこと ──
-- 3 の set_eq に包含されるが、**この 3 列こそが守るべきもの**である事実を
-- テスト名として残す（将来 set_eq を緩めようとした者への警告になる）。
SELECT is_empty(
  $$
  SELECT a.attname::text
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(a.attacl) acl
  WHERE n.nspname = 'public'
    AND c.relname = 'profiles'
    AND a.attname IN ('is_approved', 'role', 'household_id')
    AND acl.grantee = 'authenticated'::regrole
    AND acl.privilege_type = 'UPDATE'
  $$,
  'authenticated は is_approved / role / household_id を UPDATE できぬ（承認ゲートと世帯分離の要）'
);

SELECT * FROM finish();
ROLLBACK;
