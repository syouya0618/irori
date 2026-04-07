-- ============================================================
-- 招待フロー用 SECURITY DEFINER 関数
-- ============================================================
-- 問題: 新規ユーザー（household_id=NULL）は RLS の
-- invitations_select ポリシーで弾かれ、招待レコードを読めない。
-- 解決: SECURITY DEFINER 関数で RLS をバイパスし、
--        アプリケーション側でバリデーションを行う。
-- ============================================================

-- ------------------------------------------------------------
-- トークンで招待を取得（ページ表示用）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_invitation_by_token(invite_token TEXT)
RETURNS TABLE (
  id UUID,
  household_id UUID,
  household_name TEXT,
  role household_role,
  status invite_status,
  expires_at TIMESTAMPTZ
) AS $$
  SELECT
    i.id,
    i.household_id,
    COALESCE(h.name, '不明な世帯'),
    i.role,
    i.status,
    i.expires_at
  FROM public.invitations i
  JOIN public.households h ON h.id = i.household_id
  WHERE i.token = invite_token;
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

-- 認証済みユーザーのみ実行可能
REVOKE EXECUTE ON FUNCTION get_invitation_by_token(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_invitation_by_token(TEXT) TO authenticated;

-- ------------------------------------------------------------
-- 招待を承認（アトミック操作）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION accept_invitation(invitation_uuid UUID)
RETURNS VOID AS $$
DECLARE
  inv RECORD;
  calling_user UUID := auth.uid();
BEGIN
  IF calling_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- ユーザーがすでに世帯に所属しているかチェック
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = calling_user AND household_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'User already belongs to a household';
  END IF;

  -- 招待レコードをロック（race condition防止）
  SELECT * INTO inv
  FROM public.invitations
  WHERE id = invitation_uuid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found';
  END IF;

  IF inv.status != 'pending' THEN
    RAISE EXCEPTION 'Invitation is not pending';
  END IF;

  IF inv.expires_at < now() THEN
    RAISE EXCEPTION 'Invitation has expired';
  END IF;

  -- プロフィールに世帯・ロールを設定
  UPDATE public.profiles
  SET household_id = inv.household_id,
      role = inv.role
  WHERE id = calling_user;

  -- 招待を承認済みにマーク
  UPDATE public.invitations
  SET status = 'accepted',
      accepted_by = calling_user
  WHERE id = invitation_uuid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 認証済みユーザーのみ実行可能
REVOKE EXECUTE ON FUNCTION accept_invitation(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accept_invitation(UUID) TO authenticated;

-- ------------------------------------------------------------
-- invitations テーブルに不足していた RLS ポリシー追加
-- （防御の多層化: SECURITY DEFINER 関数とは別にRLSも整備）
-- ------------------------------------------------------------

-- 世帯メンバーが招待を更新できる（期限切れにする等）
CREATE POLICY "invitations_update" ON invitations
  FOR UPDATE USING (household_id = get_my_household_id());

-- 世帯メンバーが招待を削除できる
CREATE POLICY "invitations_delete" ON invitations
  FOR DELETE USING (household_id = get_my_household_id());
