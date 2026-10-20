-- ============================================================
-- サインアップの承認を「インスタンス運用者」の権能に限る（P1-02）
-- ============================================================
--
-- ## 何が壊れておったか
-- `get_pending_approvals` / `approve_user`（20260408000002）は「呼び手が owner か」
-- だけを見て、**世帯条件なしに**全承認待ちの email・表示名・登録時刻を返し、誰でも
-- 承認させた。20260603000001:108-125 はこれを「単一運営者のグローバル allowlist」
-- として意図し、「マルチテナント分離（独立した複数家族の併存）が要件化したら承認
-- モデル自体を再設計せよ」と先送り条件を書いておった。その条件は成立しておる:
--   * 世帯同士は**互いに信頼しない**。にもかかわらず第三者の email が全 owner に見えた
--   * ApprovalCard は自世帯の設定画面に出るゆえ、owner は見知らぬ人を家族と誤認して承認しうる
--   * P1-01 により誰でも owner になれたゆえ、匿名サインアップ 1 つで email を収穫できた
--
-- ## 直し方（合意した設計）
-- 承認は**世帯 owner の権能ではなく、インスタンス運用者の権能**とする。
--   * `app_operators` … 運用者の名簿。RLS 有効・ポリシー 0 本 = API ロールには deny-all。
--     anon / authenticated からは権限ごと剥がし、service role（SQL Editor）だけが書く。
--   * `is_app_operator()` … 呼び手が名簿に在るか（UI が承認カードを出すか決めるのに使う）。
--   * `get_pending_approvals()` … 運用者にだけ行を返す（他は空集合。形は変えぬ）。
--   * `approve_user()` … 運用者でなければ 42501。残りの挙動（is_approved=false の行だけを
--     立てる・0 行なら fail-loud）は変えぬ。
--
-- ## 「自世帯フィルタ」は今も入れぬ
-- 承認待ちは必ず household_id IS NULL ゆえ、世帯フィルタは承認導線を全損させる
-- （H3 撤回の理由・20260603000001:108-125）。運用者モデルはこの前提を変えずに分離を回復する。
--
-- ## 名簿は空で出す（fail-closed）
-- 本 migration は誰も seed せぬ。適用直後は**誰も承認できぬ**のが正しい初期状態じゃ。
-- 運用者 1 名の登録は SQL Editor（service role）での手作業で、手順と rollback は
-- 本 PR の最終報告と runbook に置く。リポジトリは公開ゆえ、ここへ特定の UUID を書かぬ。
-- ============================================================

-- ------------------------------------------------------------
-- 1. app_operators — インスタンス運用者の名簿
-- ------------------------------------------------------------
CREATE TABLE public.app_operators (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS 有効・ポリシーを**意図的に置かぬ** = API ロールには deny-all。
-- 読むのは下の DEFINER 関数（所有者権限）と service role（BYPASSRLS）だけじゃ。
ALTER TABLE public.app_operators ENABLE ROW LEVEL SECURITY;

-- 権限は既定に頼らず明示する（hosted / local の既定は anon / authenticated に付ける）。
-- 誰が運用者かを列挙させず、自分を名簿へ書かせもせぬ。
REVOKE ALL ON public.app_operators FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.app_operators TO service_role;

COMMENT ON TABLE public.app_operators IS
  'インスタンス運用者の名簿（サインアップ承認の権能）。RLS 有効・ポリシー無しの deny-all。書込は service role の手作業のみ。';

-- ------------------------------------------------------------
-- 2. is_app_operator() — 呼び手が運用者か
-- ------------------------------------------------------------
-- SECURITY DEFINER には `SET search_path = public` が必須（CLAUDE.md の既知の罠）。
-- 名簿は authenticated から読めぬゆえ、判定は DEFINER で行い真偽だけを返す。
CREATE OR REPLACE FUNCTION public.is_app_operator()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.app_operators WHERE user_id = auth.uid()
  );
$$;

REVOKE ALL ON FUNCTION public.is_app_operator() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_app_operator() TO authenticated;

-- ------------------------------------------------------------
-- 3. get_pending_approvals() — 運用者にだけ返す
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_pending_approvals()
RETURNS TABLE (
  id UUID,
  display_name TEXT,
  email TEXT,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  -- 運用者でなければ空集合（owner であっても他人の email は見せぬ）。
  -- auth.uid() が NULL でも is_app_operator() は false ゆえ fail-closed。
  IF NOT public.is_app_operator() THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.id, p.display_name, u.email::TEXT, p.created_at
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
  WHERE p.is_approved = false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION get_pending_approvals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_pending_approvals() TO authenticated;

-- ------------------------------------------------------------
-- 4. approve_user() — 運用者でなければ 42501
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION approve_user(target_user_id UUID)
RETURNS VOID AS $$
BEGIN
  IF NOT public.is_app_operator() THEN
    RAISE EXCEPTION 'Only app operators can approve users' USING ERRCODE = '42501';
  END IF;

  -- 承認は is_approved だけを立てる（世帯には入れぬ。参加は招待か /setup の世帯作成）。
  UPDATE public.profiles
  SET is_approved = true
  WHERE id = target_user_id AND is_approved = false;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found or already approved';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION approve_user(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION approve_user(UUID) TO authenticated;
