-- ============================================================
-- Web Push 購読基盤 (B-1)
--
-- 訴え②「予定を希望の時間で通知してほしい」の土台。本 migration は**購読の器**
-- だけを作る。予定への通知設定 (event_reminders) と配信キュー
-- (notification_deliveries) は B-2 / B-3 で別途足す。
--
-- 設計の要点:
--
-- 【household_id を持たせぬ】
--   購読は**ユーザー単位**(端末単位)じゃ。世帯は必ず profiles 経由で辿る。
--   非正規化すると、profiles.household_id が動いた後(accept_invitation 等で
--   動く・nullable・ON DELETE SET NULL)に**旧世帯の通知が届き続ける**。
--   CLAUDE.md の軸2(世帯データ分離)に正面から当たるため、持たせない。
--   配信側は push_subscriptions → profiles → household_id と辿り、
--   household_id が NULL(未承認/世帯離脱)の購読には**送らぬ**(fail-closed)。
--
-- 【(endpoint, p256dh, auth) は秘密。列 GRANT から外す】
--   この三つ組は VAPID 秘密鍵と併せて「**その端末へ任意の通知を送る能力そのもの**」。
--   設定カードは端末一覧を出すため、素直に作ると端末 A のブラウザから端末 B の
--   三つ組が読める = 1 台の XSS が全端末のロック画面への任意表示権に化ける。
--   UI が要るのは id / user_agent / created_at / last_success_at / failure_count
--   だけで、三つ組は一切要らぬ。
--   profiles の H1-b(20260603000001) / google_calendar_subscriptions の
--   sync_token(20260802100001) と同型の「行 RLS × 列 GRANT」二段防御。
--
-- 【書き込みは SECURITY DEFINER RPC に封じる】
--   push の endpoint は**ブラウザ単位**ゆえ、共用端末で持ち主が変わる
--   (夫がサインアウト → 妻がログイン)と同じ endpoint が衝突する。RLS 下の
--   `INSERT ... ON CONFLICT DO UPDATE` は他人の行へ触れず落ちるため、
--   ユーザーには「通知を有効にできぬ」としか見えぬ(しかも RLS が行を隠すので
--   原因調査もできぬ)。RPC なら「この端末の所有者は今ログインしている者」と
--   正しく扱える。
--   → authenticated には INSERT / UPDATE の GRANT もポリシーも与えぬ。
--
-- 【権限は既定に頼らず明示的に REVOKE → GRANT する】
--   20260802100001 が確立した型。hosted は arwd 既定・ローカルは Dxtm 既定ゆえ、
--   どちらの環境でも同じ ACL へ収束させる。
--
-- 【Realtime publication へは追加しない】
--   秘密列を持つゆえ、walrus の列フィルタに安全性を賭けたくない。購読の増減を
--   他端末へ即時反映する要求も無い。
--   → 本ファイルに ALTER PUBLICATION は **意図的に存在しない**。
-- ============================================================

-- ------------------------------------------------------------
-- 1. push_subscriptions
-- ------------------------------------------------------------
CREATE TABLE push_subscriptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- ── 以下 3 列は秘密。authenticated には SELECT を与えぬ ──
  -- push サービスの宛先 URL。ブラウザ単位で一意ゆえ冪等キーになる。
  endpoint     TEXT NOT NULL,
  -- RFC 8291 のペイロード暗号化に使う購読側の公開鍵と認証シークレット。
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  -- ── ここまで秘密 ──

  -- 設定カードで端末を見分けるための表示用。取得できずとも配信は成立するゆえ nullable。
  user_agent   TEXT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 配信ジョブ(B-3)が更新する診断用の列。authenticated には UPDATE を与えぬ。
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  failure_count   INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT uq_push_subscriptions_endpoint UNIQUE (endpoint),
  CONSTRAINT chk_push_subscriptions_endpoint
    CHECK (char_length(btrim(endpoint)) BETWEEN 1 AND 2048),
  CONSTRAINT chk_push_subscriptions_p256dh
    CHECK (char_length(btrim(p256dh)) BETWEEN 1 AND 255),
  CONSTRAINT chk_push_subscriptions_auth
    CHECK (char_length(btrim(auth)) BETWEEN 1 AND 255),
  CONSTRAINT chk_push_subscriptions_user_agent
    CHECK (user_agent IS NULL OR char_length(user_agent) <= 500),
  CONSTRAINT chk_push_subscriptions_failure_count
    CHECK (failure_count >= 0)
);

-- 配信ジョブは「この世帯のメンバー全員の購読」を引く。user_id 側から辿るため。
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- RLS: FOR ALL は使わぬ(CLAUDE.md の禁止事項)。SELECT / DELETE のみ置く。
-- INSERT / UPDATE のポリシーを**意図的に置かぬ**のがこのテーブルの設計そのもの
-- (書き込みは下の SECURITY DEFINER RPC と service_role に限る)。
CREATE POLICY "push_subscriptions_select" ON push_subscriptions
  FOR SELECT USING (user_id = auth.uid());

-- 自分の端末の登録は自分で解除できる(設定カードの「この端末の通知をやめる」)。
CREATE POLICY "push_subscriptions_delete" ON push_subscriptions
  FOR DELETE USING (user_id = auth.uid());

-- 権限は既定に頼らず明示する。
REVOKE ALL ON public.push_subscriptions FROM anon, authenticated;

-- SELECT は**非秘密列のみ**。endpoint / p256dh / auth は与えぬ。
GRANT SELECT (id, user_id, user_agent, created_at, last_success_at, last_failure_at, failure_count)
  ON public.push_subscriptions TO authenticated;

-- 自分の端末を解除するために DELETE は要る(行 RLS が自分の行に限る)。
GRANT DELETE ON public.push_subscriptions TO authenticated;

-- INSERT / UPDATE は GRANT しない。RPC(SECURITY DEFINER)と service_role のみ。

-- ------------------------------------------------------------
-- 2. upsert_push_subscription — 購読の唯一の書込経路
-- ------------------------------------------------------------
-- SECURITY DEFINER には `SET search_path = public` が必須
-- (auth スキーマ経由で呼ばれると search_path が狂う。CLAUDE.md の既知の罠)。
--
-- 同一 endpoint が既に**別のユーザー**で登録されている場合は付け替える。
-- push の endpoint はブラウザ単位ゆえ、共用端末で持ち主が変わったという意味であり、
-- 「今ログインしている者のもの」とするのが実態に合う。付け替えねば、旧ユーザー宛の
-- 通知が新しい利用者の端末に届き続ける。
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

-- ------------------------------------------------------------
-- 3. delete_my_push_subscription — endpoint 指定の解除
-- ------------------------------------------------------------
-- サインアウト時に呼ぶ。購読は**ブラウザ単位**ゆえ、放置すると旧ユーザー宛の通知が
-- 新しい利用者の端末に届く（sw.js の PURGE_HOUSEHOLD_CACHES が「1 台を複数ユーザーが
-- 使う」脅威を既に認めておるのと同じ筋）。
--
-- RPC にするのは、`DELETE ... WHERE endpoint = $1` が **endpoint への SELECT 権限**を
-- 要求するためじゃ（WHERE 句が参照する列には SELECT が要る）。endpoint は列 GRANT から
-- 外してあるゆえ、authenticated は自分の行ですら endpoint で絞れぬ。
--
-- 自分の行しか消せぬことは関数内の `user_id = auth.uid()` が担保する
-- （SECURITY DEFINER ゆえ RLS は効かぬ。スコープはコードが持つ）。
CREATE OR REPLACE FUNCTION delete_my_push_subscription(p_endpoint TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_deleted INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  DELETE FROM push_subscriptions
   WHERE endpoint = p_endpoint AND user_id = v_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- 0 行でも成功として返す（サインアウト経路ゆえ、未登録でも止めてはならぬ）。
  RETURN v_deleted > 0;
END;
$$;

REVOKE ALL ON FUNCTION delete_my_push_subscription(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION delete_my_push_subscription(TEXT) TO authenticated;

COMMENT ON TABLE push_subscriptions IS
  'Web Push の購読(端末単位)。endpoint/p256dh/auth は送信能力そのものゆえ列 GRANT から外す。書込は upsert_push_subscription() のみ。';
