-- ============================================================
-- 世帯作成に承認を要求する（P1-01）＋ households の直接書込を塞ぐ（P3-01）
-- ＋ 旧い DEFINER 関数から anon の EXECUTE を剥がす（P3-03）
-- ============================================================
--
-- ## P1-01: 何が壊れておったか
-- `create_household`（20260603000001 の H1-a）は「未所属か」しか見ておらず、
-- 成功すると呼び手を `role='owner'`・`is_approved=true` にした。承認の判定は
-- proxy（Next の経路）にしか無いゆえ、magic link でサインアップした者なら誰でも、
-- 公開 anon key と自分の JWT で `POST /rest/v1/rpc/create_household` を 1 回叩くだけで
-- **承認済み owner へ自己昇格できた**。家族専用インスタンスの唯一の入場制御が
-- DB 層で素通しであった。
--
-- ## 直し方
-- 関数の頭（caller の NULL 検査の直後）で `profiles` 行を `FOR UPDATE` で読み、
-- `is_approved IS DISTINCT FROM TRUE` なら 42501 で落とす
-- （`upsert_push_subscription` が既に持つ fail-closed と同じ型）。
--   * `IS DISTINCT FROM TRUE` ゆえ、行が無い（NULL）場合も拒否側へ倒れる。
--   * `FOR UPDATE` は二重送信を直列化する: 2 本目は 1 本目の commit を待ち、
--     続く「既に所属しておるか」の検査で弾かれる（孤児世帯を残さぬ）。
-- 残りの本文は 20260603000001 のまま変えぬ。
--
-- ## 変えぬもの（意図的）
-- `accept_invitation` には承認検査を**足さぬ**。招待経由の参加は自動承認が設計じゃ
-- （20260408000002 の 4）。招待リンクを持つ者は既存世帯の owner/member が招いた者ゆえ。
-- 不変条件「承認待ち(is_approved=false) ⇒ household_id IS NULL」はこれで保たれる:
-- 世帯を立てる経路は create_household（承認済みのみ）と accept_invitation（承認と
-- 所属を同時に立てる）の 2 本だけになる。
--
-- ## 運用（新しいインスタンスの最初の 1 人）
-- 承認は 20261002100002 の運用者（app_operators）の権能じゃ。新しいインスタンスでは
-- 誰も承認できぬゆえ、運用者 1 名の登録と自分の承認は SQL Editor（service role）で行う。
-- 手順は本 PR の最終報告と runbook を見よ。
-- ============================================================

CREATE OR REPLACE FUNCTION create_household(p_name TEXT)
RETURNS UUID AS $$
DECLARE
  caller UUID := auth.uid();
  new_household_id UUID;
  v_approved BOOLEAN;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- 承認済みでなければ世帯を作らせぬ（P1-01）。proxy は Next の経路にしか効かぬゆえ、
  -- DB 側でも fail-closed に確かめる。FOR UPDATE は二重送信の直列化を兼ねる。
  SELECT is_approved INTO v_approved
    FROM public.profiles
   WHERE id = caller
     FOR UPDATE;
  IF v_approved IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'not approved' USING ERRCODE = '42501';
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

-- 権限は既定に頼らず明示する。hosted / local の既定権限は public の関数に anon への
-- EXECUTE を付けるゆえ、`FROM PUBLIC` だけでは anon が残る（P3-03）。
REVOKE ALL ON FUNCTION create_household(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_household(TEXT) TO authenticated;

-- ------------------------------------------------------------
-- P3-01: households への直接 INSERT / DELETE / TRUNCATE を塞ぐ
-- ------------------------------------------------------------
-- 初期スキーマの `households_insert` は `WITH CHECK (true)`・TO 句なしで、anon /
-- authenticated が誰にも属さぬ孤児の世帯行を PostgREST から直接作れた。世帯作成は
-- H1-a で DEFINER の create_household へ移っており、アプリ（src/）に households への
-- 直接 INSERT は無い（e2e の前提データ作成は service role で、RLS も GRANT も迂回する）。
-- DELETE はポリシーが無く既に 0 行じゃが、TRUNCATE は RLS を素通しするゆえ権限ごと剥がす。
-- SELECT / UPDATE（設定画面の自世帯更新）は触らぬ。締める方向のみ。
DROP POLICY IF EXISTS "households_insert" ON public.households;
REVOKE INSERT, DELETE, TRUNCATE ON public.households FROM anon, authenticated;

-- ------------------------------------------------------------
-- P3-03: 招待の DEFINER 2 関数から anon の EXECUTE を剥がす
-- ------------------------------------------------------------
-- どちらも 20260407000001 で `REVOKE ... FROM PUBLIC` だけにしてあり、既定権限が
-- 付ける anon の明示 GRANT が残っておった。呼び手は常にログイン後（/invite は未認証を
-- /login へ送り、/setup の Action は getUser 済み）ゆえ、anon から剥がしても経路は変わらぬ。
-- 特に get_invitation_by_token は auth.uid() を見ぬゆえ、anon に開いておく理由が無い。
REVOKE ALL ON FUNCTION get_invitation_by_token(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_invitation_by_token(TEXT) TO authenticated;
REVOKE ALL ON FUNCTION accept_invitation(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accept_invitation(UUID) TO authenticated;
