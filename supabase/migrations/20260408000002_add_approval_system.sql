-- ============================================================
-- ユーザー承認システム
-- ============================================================
-- 目的: 新規ユーザーはオーナーの承認後にのみアプリを使用可能。
--        招待リンク経由の参加は自動承認。
-- ============================================================

-- ------------------------------------------------------------
-- 1. profiles に承認カラム追加
-- ------------------------------------------------------------
ALTER TABLE profiles
  ADD COLUMN is_approved BOOLEAN NOT NULL DEFAULT false;

-- 既存ユーザーは全て承認済みにする
UPDATE profiles SET is_approved = true;

-- ------------------------------------------------------------
-- 2. 承認待ちユーザー一覧取得（ownerのみ）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_pending_approvals()
RETURNS TABLE (
  id UUID,
  display_name TEXT,
  email TEXT,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  -- ownerのみ実行可能
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE public.profiles.id = auth.uid() AND role = 'owner'
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.id, p.display_name, u.email::TEXT, p.created_at
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
  WHERE p.is_approved = false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION get_pending_approvals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_pending_approvals() TO authenticated;

-- ------------------------------------------------------------
-- 3. ユーザー承認（ownerのみ）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION approve_user(target_user_id UUID)
RETURNS VOID AS $$
BEGIN
  -- ownerのみ実行可能
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE public.profiles.id = auth.uid() AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Only owners can approve users';
  END IF;

  UPDATE public.profiles
  SET is_approved = true
  WHERE id = target_user_id AND is_approved = false;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found or already approved';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION approve_user(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approve_user(UUID) TO authenticated;

-- ------------------------------------------------------------
-- 4. accept_invitation を更新: 招待経由は自動承認
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

  -- プロフィールに世帯・ロールを設定 + 自動承認
  UPDATE public.profiles
  SET household_id = inv.household_id,
      role = inv.role,
      is_approved = true
  WHERE id = calling_user;

  -- 招待を承認済みにマーク
  UPDATE public.invitations
  SET status = 'accepted',
      accepted_by = calling_user
  WHERE id = invitation_uuid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
