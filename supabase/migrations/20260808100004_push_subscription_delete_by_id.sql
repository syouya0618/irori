-- ============================================================
-- 設定カードの「解除」を、ブラウザ側の unsubscribe と対にする（B-4 の穴埋め）
--
-- ## 何が壊れておったか
-- カードの解除は `DELETE ... WHERE id = $1` で **DB 行を消すだけ**じゃった。
-- ブラウザの購読はそのまま生きておるゆえ、起動時の突き合わせ
-- (`push-subscription-reconciler.tsx`) が `upsert_push_subscription` を叩いて
-- **行を作り直す**（しかも `failure_count = 0` で健康な顔をして戻る）。
-- ＝ アプリ内から端末を恒久的に外す手段が存在しておらなんだ。
-- サインアウト経路 (`push-unsubscribe.ts`) は「サーバ削除 → ブラウザ
-- `unsubscribe()`」の順を守っておるのに、カードの解除だけが守っておらなんだ。
--
-- ## なぜ RPC が要るのか（クライアントだけでは閉じられぬ）
-- ブラウザ側を unsubscribe してよいのは「今消した行が、**このブラウザの購読**
-- だった」時だけじゃ。ところが `endpoint` は列 GRANT の外（B-1）ゆえ、
-- authenticated は自分の行ですら endpoint を読めず、「どの行が自分か」を
-- 問えぬ。かといって endpoint を返す API を作れば、端末 A のブラウザへ端末 B の
-- 送信先を渡すことになり、B-1 が列 GRANT で閉じた穴を自分で開け直す。
--
-- → **endpoint を受け取り、一致したか否かの 1 ビットだけを返す**。
--   返すのは 'deleted-this-device' / 'deleted-other-device' / 'not-found' の
--   3 語のみで、endpoint そのものは決して外へ出さぬ。
--
-- ## 戻り値を BOOLEAN にせぬ理由
-- 「消えなかった（not-found）」と「消えたが別端末だった」を **必ず区別する**。
-- NULL 混じりの BOOLEAN にすると呼び出し側の `if (data)` で両者が畳まれ、
-- 「対象の端末が見つかりませんでした」の分岐が黙って消える。
--
-- ## ⚠️ SECURITY DEFINER ゆえ RLS は効かぬ
-- `AND user_id = v_user_id` **ただ 1 行**が、他人の購読を id 当て推量で消せぬ
-- 唯一の防壁じゃ（pgTAP C-2 が「別人の行は消せぬ」を撃って固定する）。
-- 消してよいのは自分の行だけ。落としたら世帯の外まで届く事故になる。
--
-- 権限は既定に頼らず REVOKE → GRANT（20260802100001 が確立した型）。
-- ============================================================

CREATE OR REPLACE FUNCTION delete_my_push_subscription_by_id(
  p_id       UUID,
  -- 呼び出し元のブラウザが今持っておる購読の endpoint。渡されねば
  -- 「この端末か」は判定できぬ → 'deleted-other-device'（＝ ブラウザ側の
  -- unsubscribe を**させぬ**方へ倒す。誤って生きた購読を畳まぬための向きじゃ）。
  p_endpoint TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id  UUID := auth.uid();
  v_endpoint TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  DELETE FROM push_subscriptions
   WHERE id = p_id
     AND user_id = v_user_id   -- ⚠️ これが唯一の所有者チェック（上の注記を見よ）
  RETURNING endpoint INTO v_endpoint;

  -- endpoint は NOT NULL ゆえ、NULL は「1 行も消えなかった」を意味する。
  IF v_endpoint IS NULL THEN
    RETURN 'not-found';
  END IF;

  IF p_endpoint IS NOT NULL AND p_endpoint = v_endpoint THEN
    RETURN 'deleted-this-device';
  END IF;
  RETURN 'deleted-other-device';
END;
$$;

REVOKE ALL ON FUNCTION delete_my_push_subscription_by_id(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION delete_my_push_subscription_by_id(UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION delete_my_push_subscription_by_id(UUID, TEXT) IS
  '自分の購読を id 指定で解除し、それが呼び出し元の端末の購読だったかだけを返す（endpoint は返さぬ）。カードの解除がブラウザ側 unsubscribe と対になるために要る。';
