-- ============================================================
-- profiles_select RLS 修正 + 孤立データクリーンアップ
-- ============================================================
-- 問題: profiles_select ポリシーが household_id = get_my_household_id() のみ。
--        新規ユーザー（household_id=NULL）の場合:
--        NULL = NULL → NULL（TRUEではない）→ 自己プロフィール読取不可。
--        さらにPostgreSQLはUPDATE時にもSELECTポリシーを適用するため、
--        createHouseholdのprofile UPDATEも0行影響で無音失敗する。
--        これが「世帯作成後のリダイレクトループ」の根本原因。
--
-- 修正: OR id = auth.uid() を追加し、自己プロフィールは常に読取可能にする。
-- ============================================================

-- profiles_select: 自己プロフィールは常に読取可能
DROP POLICY "profiles_select" ON profiles;
CREATE POLICY "profiles_select" ON profiles
  FOR SELECT USING (
    household_id = get_my_household_id()
    OR id = auth.uid()
  );

-- 孤立した households を削除（profileと紐づいていないもの）
DELETE FROM households
WHERE id NOT IN (
  SELECT household_id FROM profiles WHERE household_id IS NOT NULL
);
