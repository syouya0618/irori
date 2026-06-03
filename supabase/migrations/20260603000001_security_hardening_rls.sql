-- ============================================================
-- セキュリティ強化: RLS アクセス制御の修正 (2026-06-03)
-- ============================================================
-- 独立セキュリティ監査で検出した 3 件の DB 層アクセス制御欠陥を修正する。
--
-- H1 (Critical): profiles_update に WITH CHECK が無く、認証済みユーザーが
--   anon キーで PostgREST を直叩きして household_id / role / is_approved を
--   書き換え可能だった（他世帯乗っ取り・owner 自己昇格・承認自己回避）。
--   privilege 列を列権限で直接書込不可にし、遷移は SECURITY DEFINER 関数経由
--   のみに限定する。
-- H2 (High): eating-out-photos storage の INSERT/DELETE/SELECT が所有者非分離で、
--   認証済みユーザーが他者のファイルを削除/上書き/列挙可能だった。
--   アップロードパス規約 `${auth.uid()}/...` に合わせ所有者スコープ化する。
-- H3 (High): get_pending_approvals / approve_user に自世帯フィルタが無く、
--   任意 owner が全世帯の承認待ちユーザーの email を取得・任意承認できた。
-- ============================================================

-- ------------------------------------------------------------
-- H1-a: 世帯作成を SECURITY DEFINER 関数化（owner 自動承認を含む）
-- ------------------------------------------------------------
-- 従来 createHousehold は user 文脈の UPDATE で household_id/role を設定して
-- いたが、これは privilege 列の直接書込であり H1-b の列権限制限と両立しない。
-- 世帯作成を DEFINER 関数化し、owner を作成時に自動承認する
-- （従来 is_approved 未設定で owner が承認待ちに陥っていた潜在バグも解消）。
CREATE OR REPLACE FUNCTION create_household(p_name TEXT)
RETURNS UUID AS $$
DECLARE
  caller UUID := auth.uid();
  new_household_id UUID;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
    RAISE EXCEPTION 'Household name is required';
  END IF;

  -- 既に世帯所属なら拒否（再作成・他世帯への横移動防止）
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = caller AND household_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'User already belongs to a household';
  END IF;

  INSERT INTO public.households (name)
  VALUES (trim(p_name))
  RETURNING id INTO new_household_id;

  UPDATE public.profiles
  SET household_id = new_household_id,
      role = 'owner',
      is_approved = true
  WHERE id = caller;

  RETURN new_household_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION create_household(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_household(TEXT) TO authenticated;

-- ------------------------------------------------------------
-- H1-b: profiles の privilege 列を直接書込不可にする（列権限）
-- ------------------------------------------------------------
-- household_id / role / is_approved はユーザーが直接 UPDATE/INSERT できないよう
-- にし、display_name / avatar_url / default_page のみ更新可能にする。
-- handle_new_user / create_household / accept_invitation / approve_user は
-- SECURITY DEFINER（関数所有者権限で実行）ゆえ、この REVOKE の影響を受けず
-- 引き続き privilege 列を設定できる。
-- 新規行は handle_new_user トリガ（DEFINER）が作成するため、authenticated への
-- INSERT は不要（GRANT しない = 直接 INSERT 不可）。
REVOKE INSERT, UPDATE ON public.profiles FROM authenticated;
GRANT UPDATE (display_name, avatar_url, default_page) ON public.profiles TO authenticated;

-- 既存の profiles_update RLS ポリシー（USING id = auth.uid()）は行レベル制限と
-- して維持。列レベルの保護は上記 GRANT が担う（行 × 列の二段で防御）。

-- ------------------------------------------------------------
-- H2: eating-out-photos storage を所有者(auth.uid())スコープに
-- ------------------------------------------------------------
-- アップロードパスは `${auth.uid()}/${mealId}-${ts}.ext`（src の規約）。
-- パス先頭セグメント = auth.uid() で所有者を判定し、クロステナントの
-- 削除/上書き/列挙を防ぐ。表示は保存済み getPublicUrl の URL を描画するため
-- SELECT のスコープ化による影響を受けない。
DROP POLICY IF EXISTS "eating_out_photos_select" ON storage.objects;
DROP POLICY IF EXISTS "eating_out_photos_insert" ON storage.objects;
DROP POLICY IF EXISTS "eating_out_photos_delete" ON storage.objects;

CREATE POLICY "eating_out_photos_select" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'eating-out-photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "eating_out_photos_insert" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'eating-out-photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "eating_out_photos_delete" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'eating-out-photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ------------------------------------------------------------
-- H3 (承認関数) は本 migration では変更しない（当初案を撤回）
-- ------------------------------------------------------------
-- 当初 get_pending_approvals / approve_user に「自世帯フィルタ
-- （household_id = get_my_household_id()）」を追加する案だったが、独立レビューで
-- 回帰と判明したため撤回した。
-- 理由: 承認待ち(is_approved=false)ユーザーは必ず household_id=NULL になる
-- （handle_new_user は household 未設定、create_household / accept_invitation は
-- is_approved=true を同時設定するため）。本承認系は「グローバル allowlist
-- （owner が新規サインアップ全体を承認 → 承認後に各自が /setup で世帯作成）」の
-- 設計であり、自世帯フィルタを入れると NULL = owner_uuid が常に false となって
-- 承認導線が全損し、招待なしの新規ユーザーが /pending-approval に恒久的に詰む。
-- 「全 owner が全 pending を見る」のは本設計では意図された挙動。マルチテナント
-- 分離（独立した複数家族の併存）が要件化した場合は、承認モデル自体の再設計
-- （pending ユーザーを対象 household に紐付ける導線の新設）で対応すること。
