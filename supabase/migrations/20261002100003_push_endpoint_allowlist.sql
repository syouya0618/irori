-- ============================================================
-- push endpoint の allowlist を RPC の内側にも置く（P1-03）
-- ============================================================
--
-- ## 何が壊れておったか
-- `upsert_push_subscription`（20260808100001）は endpoint の**長さ**しか見ておらず、
-- host・scheme・port の検査は Server Action（`isAllowedPushEndpoint`）にしか無かった。
-- 書込を RPC 1 本に封じても、入力検証をアプリ層の入口にしか置かねば、承認済みの JWT で
-- RPC を直に叩くだけで `https://attacker:8443/` や内部アドレスを購読として登録できる。
-- cron（service role）はそこへ 5 分ごとに POST する ＝ 盲目 SSRF の踏み台になり
-- （failure_count が到達性の oracle になる）、応答を返さぬ宛先を並べれば直列に回る
-- 他世帯の通知まで止められた。
--
-- ## 直し方
-- 認証・承認の検査の後、**DELETE / INSERT より前**に endpoint を正規表現で検査し、
-- 合わねば 22023（invalid_parameter_value）で落とす。例外は呼び出し全体を巻き戻すゆえ
-- 順序がデータの正しさを左右するわけではないが、拒む入力で他人の行（共用端末の
-- 付け替え）に触れる文をそもそも走らせぬよう、先に置く。
--   ^https://(([a-z0-9-]+\.)+push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com)/
--   * https 必須・ホストは小文字のみ・port 無し・userinfo 無し・パス必須
--   * Apple はサブドメイン一致（地域ごとに web.push.apple.com 等が変わる）、他は完全一致
-- TS 側（`src/lib/domain/push-endpoint.ts`）は同じ文字列の正規表現を持ち、
-- `supabase/tests/push_endpoint_allowlist.sql` の事例表を vitest と pgTAP の両方が通す。
-- 残りの本文（認証・承認・付け替え・ON CONFLICT）は 20260808100001 のまま変えぬ。
--
-- ## やらぬこと（意図的）
-- * 表に CHECK を足さぬ: 既存の不適合な行が在ると、cron の診断 UPDATE
--   （last_failure_at / failure_count）まで落ち始める。送信直前の再検査
--   （`deliver.ts`）が不適合な行を撃たずに据え置く。
-- * 既存の行を消さぬ: 件数を数える監査クエリ（endpoint の値は出さぬ）を人が流し、
--   消すか否かは人が決める。
-- ============================================================

CREATE OR REPLACE FUNCTION upsert_push_subscription(
  p_endpoint   TEXT,
  p_p256dh     TEXT,
  p_auth       TEXT,
  p_user_agent TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_approved BOOLEAN;
  v_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  -- 権限チェックは API 層とページ層の両方で(CLAUDE.md)。proxy が未承認ユーザーを
  -- /pending-approval へ落とすが、DB 側でも fail-closed に確かめる。
  SELECT is_approved INTO v_approved FROM profiles WHERE id = v_user_id;
  IF v_approved IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'not approved' USING ERRCODE = '42501';
  END IF;

  -- SSRF / open relay 対策（P1-03）。拒む入力で付け替えの DELETE を走らせぬよう先に置く。
  -- `p_endpoint !~ ...` だけでは NULL が素通しになる（三値論理）ゆえ NULL を名指しで弾く。
  -- 例外の文言に endpoint を載せぬ（送信能力そのものゆえ、ログへ落とさぬ）。
  IF p_endpoint IS NULL
     OR p_endpoint !~ '^https://(([a-z0-9-]+\.)+push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com)/'
  THEN
    RAISE EXCEPTION 'push endpoint not allowed' USING ERRCODE = '22023';
  END IF;

  -- 同じ端末が別ユーザーで登録済みなら剥がす(共用端末の持ち主交代)。
  DELETE FROM push_subscriptions
   WHERE endpoint = p_endpoint AND user_id <> v_user_id;

  INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  VALUES (v_user_id, p_endpoint, p_p256dh, p_auth, p_user_agent)
  ON CONFLICT (endpoint) DO UPDATE
     SET p256dh = EXCLUDED.p256dh,
         auth   = EXCLUDED.auth,
         user_agent = EXCLUDED.user_agent,
         -- 再購読は健康な状態への復帰ゆえ失敗カウントを畳む
         failure_count = 0,
         last_failure_at = NULL
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION upsert_push_subscription(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION upsert_push_subscription(TEXT, TEXT, TEXT, TEXT) TO authenticated;
