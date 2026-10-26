-- ============================================================
-- 要望・改善提案（feedback）— 受付から「本番で反映を確かめた」まで
-- ============================================================
--
-- 家族（利用者）が要望を送り、インスタンス運用者（app_operators）が受け取り、
-- 対応状況を返し、本番への反映を確かめてから「反映済み」と確定する器じゃ。
--
-- ## 表は 3 つ
--   * feedback_items         … 要望 1 件 = 1 行。現在の状態と版（version）を持つ
--   * feedback_events        … 状態変更・返信の履歴（追記のみ）。初回の「受付」行も入る
--   * feedback_notifications … Push の配信キュー（受信者 × 端末）。アプリ内が正本で、こちらは知らせ
--
-- ## 誰が何を見るか（RLS は SELECT 1 本ずつ。FOR ALL は使わぬ）
--   * 投稿者は**自分の要望だけ**を見る。同じ世帯の家族にも開かぬ
--     （要望は投稿者と運用者の間のやり取りじゃ）
--   * 運用者（is_app_operator()）は全件を見る。世帯 owner であることは根拠にせぬ
--     （20261002100002 と同じ筋。owner は誰でもなれる）
--   * anon には表も関数も開かぬ
--   * INSERT / UPDATE / DELETE のポリシーは**意図的に置かぬ**。書込は下の
--     SECURITY DEFINER の RPC だけが行う（push_subscriptions・notification_deliveries と同じ型）。
--     ゆえに一般利用者は自分の要望の状態を 1 つも動かせぬ（「反映済み」にもできぬ）
--
-- ## 「反映済み」は DB が門を閉じる
-- 「PR をマージした」と「本番へ反映された」は別物じゃ。released は
--   * 専用の RPC（operator_release_feedback）しか立てられず
--   * 確かめたコミット SHA と「本番で確かめた」時刻を**必ず**伴う（CHECK が双方向で縛る）
-- マージの記録は merge_ref（任意）に分けて持ち、released を含意させぬ。
--
-- ## 二重送信と通信断
-- 投稿は端末が作る client_request_id で冪等にする（UNIQUE (submitter_id, client_request_id)）。
-- 応答だけが失われて再送されても、同じ鍵なら同じ 1 行を返す。運用者の操作も
-- (feedback_id, client_request_id) で冪等にし、さらに version で古い画面からの上書きを止める。
--
-- ## Push は「知らせ」であって正本ではない
-- キューへの積み込みは要望の書込と**同じトランザクション**で行うが、積み込みの失敗は
-- サブトランザクションで捕まえて WARNING に落とし、要望そのものは必ず残す。
-- 送るのは既存の cron（/api/cron/notify・service role）だけで、Server Action は
-- service role を使わぬ。sent_at は claim の印であって配達の証ではない（結果の分からぬ失敗でも
-- 立ったまま残る）。push サービスが 2xx で受理した時だけ accepted_at を立てる。
-- それでも端末に表示されたかは誰にも分からぬゆえ、画面は「届いた」と断定せぬ。
--
-- ## エラーコード（アプリ側の写し: src/lib/domain/feedback.ts）
--   28000 未認証 / 42501 権限なし / 22023 入力が不正（メッセージに本文を載せぬ）
--   P0002 要望が無い・見えぬ / IRF01 同じ鍵で別の内容 / IRF02 投稿の上限 / IRF03 版の衝突
--
-- ## Realtime publication へは載せぬ（明文宣言）
-- 更新はタブ復帰の再取得と Push で拾う。walrus の負荷と RLS の列漏れを増やさぬ。
-- ============================================================


-- ------------------------------------------------------------
-- 0. 文字列の形（CHECK と RPC が同じ述語を見る）
-- ------------------------------------------------------------
-- 長さは**コードポイント**で数える（char_length）。画面側（Array.from）と揃える。
-- 前後の空白・改行は呼び手が落としてから渡す（落としておらねば拒む）。
-- 制御文字（C0 / C1。本文の改行とタブだけ例外）と、表示の向きを入れ替える
-- 双方向制御文字（U+202A–U+202E / U+2066–U+2069）は拒む。後者は受信箱の一覧で
-- 別の要望・別の名前に見せかける細工に使えるからじゃ。
--
-- ⚠️ **拒む文字をこのファイルに生のまま書くな。** 双方向制御文字や全角空白を文字列の
-- 中へ直に置くと、エディタにもレビューにも見えぬ（Trojan Source の型）。ゆえに文字の集合は
-- `chr(<コードポイント>)` で組む下の 2 関数に閉じ、述語と提出者名の掃除が同じ集合を使う。

-- 落としてから渡すべき前後の空白: 空白・タブ・改行・復帰・全角空白（U+3000 = 12288）。
CREATE OR REPLACE FUNCTION public.feedback_trim_chars()
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT ' ' || chr(9) || chr(10) || chr(13) || chr(12288)
$$;

-- 拒む文字の正規表現の文字クラス。複数行の欄はタブ（9）と改行（10）だけを許す。
--   C0: 1–31 / DEL + C1: 127–159 / 双方向制御: 8234–8238（U+202A–E）・8294–8297（U+2066–9）
CREATE OR REPLACE FUNCTION public.feedback_forbidden_class(p_multiline BOOLEAN)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT '['
      || CASE
           WHEN p_multiline THEN chr(1) || '-' || chr(8) || chr(11) || '-' || chr(31)
           ELSE chr(1) || '-' || chr(31)
         END
      || chr(127) || '-' || chr(159)
      || chr(8234) || '-' || chr(8238)
      || chr(8294) || '-' || chr(8297)
      || ']'
$$;

REVOKE ALL ON FUNCTION public.feedback_trim_chars() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feedback_forbidden_class(BOOLEAN) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.feedback_text_ok(
  p_text      TEXT,
  p_max       INTEGER,
  p_multiline BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p_text IS NOT NULL
     AND char_length(p_text) BETWEEN 1 AND p_max
     AND p_text = btrim(p_text, public.feedback_trim_chars())
     AND p_text !~ public.feedback_forbidden_class(p_multiline)
$$;

REVOKE ALL ON FUNCTION public.feedback_text_ok(TEXT, INTEGER, BOOLEAN) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.feedback_text_ok(TEXT, INTEGER, BOOLEAN) IS
  '要望の文字列の形（長さはコードポイント・前後空白なし・制御文字と双方向制御文字なし）。CHECK と RPC が共用する唯一の述語。';


-- ------------------------------------------------------------
-- 1. feedback_items — 要望 1 件
-- ------------------------------------------------------------
CREATE TABLE public.feedback_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submitter_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- 提出者の表示名の**写し**（RPC が profiles から取る。クライアントの入力ではない）。
  -- 運用者が別世帯に居ると profiles の RLS で JOIN できぬゆえ、行に持つ。email は持たぬ。
  submitter_name    TEXT NOT NULL,
  client_request_id UUID NOT NULL,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'received',
  -- 運用者の操作ごとに 1 進む。古い画面からの上書きを止める（IRF03）。
  version           INTEGER NOT NULL DEFAULT 1,

  -- 「反映済み」の証拠（status = 'released' の間だけ値を持つ。履歴は feedback_events に残る）
  released_commit_sha      TEXT,
  released_note            TEXT,
  released_observed_deploy TEXT,
  released_verified_at     TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 投稿者に見せる更新（状態変更・返信）の最終時刻。投稿者の「未読」の起点
  last_operator_activity_at TIMESTAMPTZ,
  submitter_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- いずれかの運用者が詳細を開いた最終時刻。NULL = 未読（受信箱の未読の起点）
  operator_seen_at  TIMESTAMPTZ,
  -- 投稿者の未読。PostgREST では 2 列の比較で絞れぬゆえ生成列にする（設定画面の件数に使う）
  submitter_has_unseen BOOLEAN GENERATED ALWAYS AS (
    last_operator_activity_at IS NOT NULL
    AND last_operator_activity_at > submitter_seen_at
  ) STORED,

  CONSTRAINT uq_feedback_items_request UNIQUE (submitter_id, client_request_id),
  CONSTRAINT chk_feedback_items_status
    CHECK (status IN ('received', 'considering', 'in_progress', 'released', 'declined')),
  CONSTRAINT chk_feedback_items_title
    CHECK (public.feedback_text_ok(title, 100, false)),
  CONSTRAINT chk_feedback_items_body
    CHECK (body = '' OR public.feedback_text_ok(body, 2000, true)),
  -- 提出者名は受信箱に並ぶゆえ、題と同じ形（制御文字・双方向制御文字なし）に縛る。
  -- 写す時に submit_feedback が掃除する（display_name は利用者が自由に付けられる）。
  CONSTRAINT chk_feedback_items_submitter_name
    CHECK (public.feedback_text_ok(submitter_name, 100, false)),
  CONSTRAINT chk_feedback_items_version CHECK (version >= 1),
  -- ⚠️ **双方向**。released なのに証拠が無い行も、released でないのに証拠を（一部でも）
  -- 持つ行も作らせぬ。前者はこの CHECK、後者は下の release_extras が縛る。
  CONSTRAINT chk_feedback_items_released
    CHECK (status <> 'released'
           OR (released_commit_sha IS NOT NULL AND released_verified_at IS NOT NULL)),
  CONSTRAINT chk_feedback_items_release_sha
    CHECK (released_commit_sha IS NULL OR released_commit_sha ~ '^[0-9a-f]{7,40}$'),
  CONSTRAINT chk_feedback_items_release_extras
    CHECK (status = 'released'
           OR (released_commit_sha IS NULL AND released_verified_at IS NULL
               AND released_note IS NULL AND released_observed_deploy IS NULL)),
  CONSTRAINT chk_feedback_items_release_note
    CHECK (released_note IS NULL OR public.feedback_text_ok(released_note, 200, false)),
  CONSTRAINT chk_feedback_items_observed_deploy
    CHECK (released_observed_deploy IS NULL
           OR released_observed_deploy ~ '^(production|preview|development):[0-9a-f]{7,40}$')
);

-- 投稿者の一覧（自分の要望を新しい順）と、投稿の上限の数え上げ。
CREATE INDEX idx_feedback_items_submitter
  ON public.feedback_items(submitter_id, created_at DESC);
-- 運用者の受信箱（状態ごと・更新の新しい順）。
CREATE INDEX idx_feedback_items_status
  ON public.feedback_items(status, updated_at DESC);

ALTER TABLE public.feedback_items ENABLE ROW LEVEL SECURITY;

-- ⚠️ `(SELECT ...)` で包むのは行ごとに関数を評価させぬため（initPlan に畳まれる）。
CREATE POLICY "feedback_items_select" ON public.feedback_items
  FOR SELECT TO authenticated
  USING (
    submitter_id = (SELECT auth.uid())
    OR (SELECT public.is_app_operator())
  );

REVOKE ALL ON public.feedback_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.feedback_items TO authenticated;
GRANT ALL ON public.feedback_items TO service_role;

COMMENT ON TABLE public.feedback_items IS
  '要望・改善提案。投稿者本人と運用者だけが SELECT できる。書込は submit_feedback / operator_update_feedback / operator_release_feedback / mark_feedback_seen の RPC のみ。';
COMMENT ON COLUMN public.feedback_items.released_verified_at IS
  '運用者が本番環境で反映を確かめたと確定した時刻（RPC の now()）。status=released と双方向に結ぶ。マージの時刻ではない。';
COMMENT ON COLUMN public.feedback_items.released_observed_deploy IS
  'アプリの Server Action（releaseFeedback）が、確定を処理したサーバの環境変数から観測したデプロイ（"<VERCEL_ENV>:<VERCEL_GIT_COMMIT_SHA>"）。取れねば NULL。RPC の引数ゆえ、運用者が PostgREST を直接叩けば任意の値を入れうる —— 「アプリ経由で記録した観測」であって改ざん不能な証明ではない。';


-- ------------------------------------------------------------
-- 2. feedback_events — 履歴（追記のみ）
-- ------------------------------------------------------------
CREATE TABLE public.feedback_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id       UUID NOT NULL REFERENCES public.feedback_items(id) ON DELETE CASCADE,
  -- submitted = 受付（投稿者）/ status_changed = 状態変更（運用者）/ commented = 返信だけ（運用者）
  kind              TEXT NOT NULL,
  actor_role        TEXT NOT NULL,
  -- 誰が操作したか（監査用）。⚠️ authenticated の列 GRANT から外す — 投稿者に
  -- 運用者の利用者 id を見せると「誰が運用者か」を列挙させることになる（20261002100002 の方針）。
  actor_id          UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  from_status       TEXT,
  to_status         TEXT,
  comment           TEXT,
  -- 「取り込み済み（PR 番号・コミット等）」の任意の記録。**本番反映ではない**。
  merge_ref         TEXT,
  release_commit_sha      TEXT,
  release_note            TEXT,
  release_observed_deploy TEXT,
  release_verified_at     TIMESTAMPTZ,
  client_request_id UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_feedback_events_request UNIQUE (feedback_id, client_request_id),
  CONSTRAINT chk_feedback_events_kind
    CHECK (kind IN ('submitted', 'status_changed', 'commented')),
  CONSTRAINT chk_feedback_events_actor_role
    CHECK (actor_role IN ('submitter', 'operator')),
  CONSTRAINT chk_feedback_events_status_values
    CHECK ((from_status IS NULL
            OR from_status IN ('received', 'considering', 'in_progress', 'released', 'declined'))
       AND (to_status IS NULL
            OR to_status IN ('received', 'considering', 'in_progress', 'released', 'declined'))),
  -- 種別ごとの形。submitted は投稿者の「受付」だけ、ほかは運用者の操作だけ。
  CONSTRAINT chk_feedback_events_shape
    CHECK (
      (kind = 'submitted' AND actor_role = 'submitter' AND from_status IS NULL
         AND to_status = 'received' AND comment IS NULL AND merge_ref IS NULL)
      OR (kind = 'status_changed' AND actor_role = 'operator' AND from_status IS NOT NULL
         AND to_status IS NOT NULL AND from_status <> to_status)
      OR (kind = 'commented' AND actor_role = 'operator' AND from_status IS NULL
         AND to_status IS NULL AND (comment IS NOT NULL OR merge_ref IS NOT NULL))
    ),
  -- ⚠️ **双方向**。released への変更は証拠を必ず持ち（この CHECK）、それ以外は証拠を
  -- 一部でも持たぬ（下の release_extras）。
  CONSTRAINT chk_feedback_events_release
    CHECK (NOT (kind = 'status_changed' AND to_status = 'released')
           OR (release_commit_sha IS NOT NULL AND release_verified_at IS NOT NULL)),
  CONSTRAINT chk_feedback_events_release_extras
    CHECK ((kind = 'status_changed' AND to_status = 'released')
           OR (release_commit_sha IS NULL AND release_verified_at IS NULL
               AND release_note IS NULL AND release_observed_deploy IS NULL)),
  CONSTRAINT chk_feedback_events_release_sha
    CHECK (release_commit_sha IS NULL OR release_commit_sha ~ '^[0-9a-f]{7,40}$'),
  CONSTRAINT chk_feedback_events_release_note
    CHECK (release_note IS NULL OR public.feedback_text_ok(release_note, 200, false)),
  CONSTRAINT chk_feedback_events_observed_deploy
    CHECK (release_observed_deploy IS NULL
           OR release_observed_deploy ~ '^(production|preview|development):[0-9a-f]{7,40}$'),
  -- 見送りには理由を必ず添える（投稿者に「なぜ」を返す）。
  CONSTRAINT chk_feedback_events_declined_reason
    CHECK (NOT (kind = 'status_changed' AND to_status = 'declined') OR comment IS NOT NULL),
  CONSTRAINT chk_feedback_events_comment
    CHECK (comment IS NULL OR public.feedback_text_ok(comment, 2000, true)),
  -- マージの記録は「対応中」への変更か返信にだけ付く。released / declined に付けると
  -- 「マージ = 反映」の読み違いを誘う。
  CONSTRAINT chk_feedback_events_merge_ref
    CHECK (merge_ref IS NULL
           OR (public.feedback_text_ok(merge_ref, 100, false)
               AND (kind = 'commented'
                    OR (kind = 'status_changed' AND to_status = 'in_progress'))))
);

CREATE INDEX idx_feedback_events_feedback
  ON public.feedback_events(feedback_id, created_at);
CREATE INDEX idx_feedback_events_actor
  ON public.feedback_events(actor_id);

ALTER TABLE public.feedback_events ENABLE ROW LEVEL SECURITY;

-- 錨は feedback_items と**同じ読み手**（投稿者本人 or 運用者）。EXISTS の先にも RLS が
-- 効くが、投稿者は自分の要望行を読めるゆえ縮退せぬ（読み手の集合が同一だから成り立つ）。
CREATE POLICY "feedback_events_select" ON public.feedback_events
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_app_operator())
    OR EXISTS (
      SELECT 1 FROM public.feedback_items f
       WHERE f.id = feedback_events.feedback_id
         AND f.submitter_id = (SELECT auth.uid())
    )
  );

REVOKE ALL ON public.feedback_events FROM PUBLIC, anon, authenticated;
-- actor_id / client_request_id は与えぬ（上の注記）。`select("*")` は 42501 で落ちる。
GRANT SELECT (
  id, feedback_id, kind, actor_role, from_status, to_status, comment, merge_ref,
  release_commit_sha, release_note, release_observed_deploy, release_verified_at, created_at
) ON public.feedback_events TO authenticated;
GRANT ALL ON public.feedback_events TO service_role;

COMMENT ON TABLE public.feedback_events IS
  '要望の履歴（追記のみ）。UPDATE / DELETE の経路は無い。actor_id は authenticated の列 GRANT の外（運用者の列挙を防ぐ）。';


-- ------------------------------------------------------------
-- 3. feedback_notifications — Push の配信キュー（受信者 × 端末）
-- ------------------------------------------------------------
-- notification_deliveries を流用せぬのは、あちらの錨が**世帯**で、SELECT が世帯全員に
-- 開いておるからじゃ。要望の知らせは受信者ごとで、運用者は別世帯に居りうる。
-- ここは RLS 有効・ポリシー 0 本（API ロールには deny-all）。読み書きは
-- cron（service role）と下の DEFINER 関数だけ。運用者は集計 RPC で状態だけを見る。
CREATE TABLE public.feedback_notifications (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         UUID NOT NULL REFERENCES public.feedback_events(id) ON DELETE CASCADE,
  recipient_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- operator = 新しい要望の知らせ / submitter = 状態変更・返信の知らせ
  audience         TEXT NOT NULL,
  -- 失効後も履歴は残す（CASCADE 禁止。notification_deliveries の核 ② と同じ）
  subscription_id  UUID REFERENCES public.push_subscriptions(id) ON DELETE SET NULL,
  -- 冪等キー用の不変コピー（核 ③ と同じ。subscription_id を鍵に入れると SET NULL が衝突する）
  subscription_key TEXT NOT NULL,
  scheduled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- claim 兼 送信済み印（配達の証ではない）
  sent_at          TIMESTAMPTZ,
  -- push サービスが 2xx で受理した時刻。端末に表示されたことまでは意味せぬ
  accepted_at      TIMESTAMPTZ,
  skipped_at       TIMESTAMPTZ,
  skip_reason      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_feedback_notifications UNIQUE (event_id, subscription_key),
  CONSTRAINT chk_feedback_notifications_audience
    CHECK (audience IN ('operator', 'submitter')),
  CONSTRAINT chk_feedback_notifications_subscription_key
    CHECK (char_length(btrim(subscription_key)) >= 1),
  CONSTRAINT chk_feedback_notifications_terminal
    CHECK (sent_at IS NULL OR skipped_at IS NULL),
  CONSTRAINT chk_feedback_notifications_skip_pairing
    CHECK ((skipped_at IS NULL) = (skip_reason IS NULL)),
  -- 理由は allowlist。増やすときは src/lib/notifications/feedback-rules.ts の型と対で足す。
  --   expired = grace を過ぎた / gone = 購読が 404・410 で失効 / revoked = 受け取る資格を失った /
  --   superseded = 送る前に状態がさらに変わった（差し戻した後の古い「反映されました」を飛ばさぬ）
  CONSTRAINT chk_feedback_notifications_skip_reason
    CHECK (skip_reason IS NULL OR skip_reason IN ('expired', 'gone', 'revoked', 'superseded')),
  CONSTRAINT chk_feedback_notifications_accepted
    CHECK (accepted_at IS NULL OR sent_at IS NOT NULL)
);

CREATE INDEX idx_feedback_notifications_pending
  ON public.feedback_notifications(scheduled_at)
  WHERE sent_at IS NULL AND skipped_at IS NULL;
CREATE INDEX idx_feedback_notifications_event
  ON public.feedback_notifications(event_id);
CREATE INDEX idx_feedback_notifications_subscription
  ON public.feedback_notifications(subscription_id);
CREATE INDEX idx_feedback_notifications_recipient
  ON public.feedback_notifications(recipient_id);

ALTER TABLE public.feedback_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.feedback_notifications FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.feedback_notifications TO service_role;

COMMENT ON TABLE public.feedback_notifications IS
  '要望の Push 配信キュー（受信者 × 端末）。RLS 有効・ポリシー無しの deny-all。書き手は要望の RPC（積み込み）と cron（service role・送信）のみ。冪等キーは (event_id, subscription_key)。';
COMMENT ON COLUMN public.feedback_notifications.accepted_at IS
  'push サービスが 2xx で受理した時刻。端末に表示されたかは分からぬ。sent_at だけが立って accepted_at が無い行は「結果不明」（at-most-once で再送せぬ）。';


-- ------------------------------------------------------------
-- 4. enqueue_feedback_push — 受信者の端末ぶんの行を積む（内部用）
-- ------------------------------------------------------------
-- 呼ぶのは下の DEFINER 関数だけ。SECURITY INVOKER のまま置き、API ロールからは
-- EXECUTE を剥がす（呼べても INSERT の権限が無いゆえ二重に閉じる）。
-- 承認済み・世帯所属の受信者の端末だけを積む。送る直前に cron がもう一度確かめる。
CREATE OR REPLACE FUNCTION public.enqueue_feedback_push(
  p_event_id     UUID,
  p_recipient_id UUID,
  p_audience     TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO public.feedback_notifications
    (event_id, recipient_id, audience, subscription_id, subscription_key)
  SELECT p_event_id, p_recipient_id, p_audience, s.id, s.id::text
    FROM public.push_subscriptions s
    JOIN public.profiles p ON p.id = s.user_id
   WHERE s.user_id = p_recipient_id
     AND p.is_approved IS TRUE
     AND p.household_id IS NOT NULL
  ON CONFLICT (event_id, subscription_key) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_feedback_push(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- 5. submit_feedback — 投稿（冪等）
-- ------------------------------------------------------------
-- 返り値の created = false は「同じ鍵の要望が既に在った（再送）」。
-- 同じ鍵で**別の内容**なら IRF01（黙って古い方を返すと、直した文面が捨てられる）。
CREATE OR REPLACE FUNCTION public.submit_feedback(
  p_client_request_id UUID,
  p_title             TEXT,
  p_body              TEXT
)
RETURNS TABLE (feedback_id UUID, created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller   UUID := auth.uid();
  v_approved BOOLEAN;
  v_household UUID;
  v_name     TEXT;
  v_body     TEXT := coalesce(p_body, '');
  v_id       UUID;
  v_existing RECORD;
  v_recent   INTEGER;
  v_event_id UUID;
  v_operator RECORD;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  -- 承認済みかつ世帯所属だけが送れる（proxy は Next の経路にしか効かぬ。DB でも閉じる）。
  -- 行ロックは同じ利用者の投稿を直列化する。数えてから書くまでの間に別の鍵の投稿が割り込み、
  -- 上限（下の IRF02）をすり抜けるのを止める。
  -- ⚠️ **FOR UPDATE にするな（FOR NO KEY UPDATE）。** 積み込み（feedback_notifications の
  -- recipient_id → profiles の FK）は相手の profiles 行に FOR KEY SHARE を取る。FOR UPDATE は
  -- それと衝突するゆえ、運用者 2 人が同時に投稿すると互いの行を待ち合って 40P01 になり、
  -- 負けた側の知らせが積み込みのサブトランザクションごと黙って落ちる。NO KEY UPDATE は
  -- KEY SHARE と衝突せず、同じ利用者どうしの直列化は保つ。
  SELECT is_approved, household_id, display_name
    INTO v_approved, v_household, v_name
    FROM public.profiles
   WHERE id = v_caller
     FOR NO KEY UPDATE;
  IF v_approved IS DISTINCT FROM TRUE OR v_household IS NULL THEN
    RAISE EXCEPTION 'not approved' USING ERRCODE = '42501';
  END IF;

  -- 提出者名の写し。display_name は利用者が自由に付けられるゆえ、受信箱に並べる前に
  -- 制御文字・双方向制御文字を落とし、前後の空白を削って 100 文字に切る。
  -- 残らねば「名前未設定」（CHECK chk_feedback_items_submitter_name と同じ形に収める）。
  v_name := btrim(
    left(
      btrim(regexp_replace(coalesce(v_name, ''), public.feedback_forbidden_class(false), '', 'g'),
            public.feedback_trim_chars()),
      100),
    public.feedback_trim_chars());
  IF NOT public.feedback_text_ok(v_name, 100, false) THEN
    v_name := '名前未設定';
  END IF;

  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'client_request_id is required' USING ERRCODE = '22023';
  END IF;
  -- ⚠️ CHECK 違反に任せず先に拒む。CHECK の 23514 は DETAIL に**行の中身**（要望の本文）を
  -- 載せ、それがアプリのログへ流れうる。ここで本文を含まぬ文言で落とす。
  IF NOT public.feedback_text_ok(p_title, 100, false) THEN
    RAISE EXCEPTION 'invalid title' USING ERRCODE = '22023';
  END IF;
  IF v_body <> '' AND NOT public.feedback_text_ok(v_body, 2000, true) THEN
    RAISE EXCEPTION 'invalid body' USING ERRCODE = '22023';
  END IF;

  -- 再送（応答だけが失われた等）は上限より先に見る。同じ要望の再送を上限で拒まぬ。
  SELECT f.id, f.title, f.body INTO v_existing
    FROM public.feedback_items f
   WHERE f.submitter_id = v_caller AND f.client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.title = p_title AND v_existing.body = v_body THEN
      RETURN QUERY SELECT v_existing.id, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'client_request_id reused with different content' USING ERRCODE = 'IRF01';
  END IF;

  -- 1 人あたり 24 時間で 20 件まで。運用者の受信箱と Push を連打で埋めさせぬ
  -- （世帯同士は互いに信頼せぬ。承認済みの他世帯の利用者も送れる）。
  SELECT count(*) INTO v_recent
    FROM public.feedback_items f
   WHERE f.submitter_id = v_caller AND f.created_at > now() - interval '24 hours';
  IF v_recent >= 20 THEN
    RAISE EXCEPTION 'too many feedback submissions' USING ERRCODE = 'IRF02';
  END IF;

  INSERT INTO public.feedback_items
    (submitter_id, submitter_name, client_request_id, title, body)
  VALUES (
    v_caller,
    v_name,
    p_client_request_id,
    p_title,
    v_body
  )
  -- 同じ鍵の 2 本が同時に来た時、2 本目はここで 1 本目の commit を待って DO NOTHING になる。
  ON CONFLICT (submitter_id, client_request_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT f.id, f.title, f.body INTO v_existing
      FROM public.feedback_items f
     WHERE f.submitter_id = v_caller AND f.client_request_id = p_client_request_id;
    IF v_existing.title = p_title AND v_existing.body = v_body THEN
      RETURN QUERY SELECT v_existing.id, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'client_request_id reused with different content' USING ERRCODE = 'IRF01';
  END IF;

  INSERT INTO public.feedback_events
    (feedback_id, kind, actor_role, actor_id, to_status, client_request_id)
  VALUES (v_id, 'submitted', 'submitter', v_caller, 'received', p_client_request_id)
  RETURNING id INTO v_event_id;

  -- 運用者へ知らせる（自分が運用者なら自分には送らぬ）。
  -- ⚠️ 積み込みの失敗で要望を巻き戻さぬ。サブトランザクションで捕まえて WARNING に
  -- 落とす（本文を載せぬ）。運用者は受信箱で必ず見られる — そちらが正本じゃ。
  FOR v_operator IN
    SELECT o.user_id FROM public.app_operators o WHERE o.user_id <> v_caller
  LOOP
    BEGIN
      PERFORM public.enqueue_feedback_push(v_event_id, v_operator.user_id, 'operator');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'feedback push enqueue failed (event %, sqlstate %)', v_event_id, SQLSTATE;
    END;
  END LOOP;

  RETURN QUERY SELECT v_id, true;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_feedback(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_feedback(UUID, TEXT, TEXT) TO authenticated;


-- ------------------------------------------------------------
-- 6. operator_update_feedback — 状態変更 / 返信（運用者のみ・released 以外）
-- ------------------------------------------------------------
-- p_status が NULL なら返信だけ（comment か merge_ref のどちらかが要る）。
-- released へは**この関数では動かせぬ**（operator_release_feedback を使う）。
CREATE OR REPLACE FUNCTION public.operator_update_feedback(
  p_feedback_id       UUID,
  p_client_request_id UUID,
  p_expected_version  INTEGER,
  p_status            TEXT,
  p_comment           TEXT,
  p_merge_ref         TEXT
)
RETURNS TABLE (version INTEGER, created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller  UUID := auth.uid();
  v_item    RECORD;
  v_comment TEXT := nullif(p_comment, '');
  v_merge   TEXT := nullif(p_merge_ref, '');
  v_kind    TEXT;
  v_prior   RECORD;
  v_event_id UUID;
  v_version INTEGER;
BEGIN
  IF NOT public.is_app_operator() THEN
    RAISE EXCEPTION 'only app operators can update feedback' USING ERRCODE = '42501';
  END IF;
  IF p_feedback_id IS NULL OR p_client_request_id IS NULL OR p_expected_version IS NULL THEN
    RAISE EXCEPTION 'feedback_id, client_request_id and expected_version are required'
      USING ERRCODE = '22023';
  END IF;

  IF v_comment IS NOT NULL AND NOT public.feedback_text_ok(v_comment, 2000, true) THEN
    RAISE EXCEPTION 'invalid comment' USING ERRCODE = '22023';
  END IF;
  IF v_merge IS NOT NULL AND NOT public.feedback_text_ok(v_merge, 100, false) THEN
    RAISE EXCEPTION 'invalid merge_ref' USING ERRCODE = '22023';
  END IF;

  -- 行を**先に**握る。同じ鍵の再送が同時に 2 本来ても、2 本目は 1 本目の commit を待ってから
  -- 下の再送判定へ進む（握る前に判定すると、2 本目が版の衝突 IRF03 に落ちる）。
  SELECT f.* INTO v_item FROM public.feedback_items f WHERE f.id = p_feedback_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'feedback not found' USING ERRCODE = 'P0002';
  END IF;

  -- 冪等: 同じ鍵の操作が既に記録されておれば、**内容が同じ時だけ**「記録済み」として今の版を
  -- 返す。内容が違えば IRF01（通信断の後に書き直した返信・選び直した状態を黙って捨てぬ）。
  -- ⚠️ 期待する種別は先に変数へ出す。IF の条件に CASE ... THEN を書くと、plpgsql は
  -- 最初の THEN を IF の区切りと読んで構文が壊れる。
  v_kind := CASE WHEN p_status IS NULL THEN 'commented' ELSE 'status_changed' END;
  SELECT e.kind, e.to_status, e.comment, e.merge_ref INTO v_prior
    FROM public.feedback_events e
   WHERE e.feedback_id = p_feedback_id AND e.client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_prior.kind = v_kind
       AND v_prior.to_status IS NOT DISTINCT FROM p_status
       AND v_prior.comment IS NOT DISTINCT FROM v_comment
       AND v_prior.merge_ref IS NOT DISTINCT FROM v_merge THEN
      RETURN QUERY SELECT v_item.version, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'client_request_id reused with different content' USING ERRCODE = 'IRF01';
  END IF;

  IF v_item.version <> p_expected_version THEN
    RAISE EXCEPTION 'feedback was updated by someone else' USING ERRCODE = 'IRF03';
  END IF;

  IF p_status IS NULL THEN
    IF v_comment IS NULL AND v_merge IS NULL THEN
      RAISE EXCEPTION 'comment is required' USING ERRCODE = '22023';
    END IF;
    IF v_merge IS NOT NULL AND v_item.status <> 'in_progress' THEN
      RAISE EXCEPTION 'merge_ref is only for in_progress' USING ERRCODE = '22023';
    END IF;
    v_kind := 'commented';
  ELSE
    IF p_status NOT IN ('received', 'considering', 'in_progress', 'declined') THEN
      -- released はここでは立てぬ（証拠を伴う専用の関数へ）。未知の値もここで拒む。
      RAISE EXCEPTION 'invalid status for this function' USING ERRCODE = '22023';
    END IF;
    IF p_status = v_item.status THEN
      RAISE EXCEPTION 'status unchanged' USING ERRCODE = '22023';
    END IF;
    IF p_status = 'declined' AND v_comment IS NULL THEN
      RAISE EXCEPTION 'a reason is required to decline' USING ERRCODE = '22023';
    END IF;
    -- 反映済みを取り消す（差し戻し）時も理由を添える。投稿者には「反映済み」が消えて見える。
    IF v_item.status = 'released' AND v_comment IS NULL THEN
      RAISE EXCEPTION 'a reason is required to reopen released feedback' USING ERRCODE = '22023';
    END IF;
    IF v_merge IS NOT NULL AND p_status <> 'in_progress' THEN
      RAISE EXCEPTION 'merge_ref is only for in_progress' USING ERRCODE = '22023';
    END IF;
    v_kind := 'status_changed';
  END IF;

  UPDATE public.feedback_items f
     SET status = coalesce(p_status, f.status),
         version = f.version + 1,
         updated_at = now(),
         last_operator_activity_at = now(),
         -- released を離れたら現在の証拠は消す（履歴の行には残る）。
         released_commit_sha      = CASE WHEN coalesce(p_status, f.status) = 'released' THEN f.released_commit_sha END,
         released_note            = CASE WHEN coalesce(p_status, f.status) = 'released' THEN f.released_note END,
         released_observed_deploy = CASE WHEN coalesce(p_status, f.status) = 'released' THEN f.released_observed_deploy END,
         released_verified_at     = CASE WHEN coalesce(p_status, f.status) = 'released' THEN f.released_verified_at END
   WHERE f.id = p_feedback_id
  RETURNING f.version INTO v_version;

  INSERT INTO public.feedback_events
    (feedback_id, kind, actor_role, actor_id, from_status, to_status, comment, merge_ref, client_request_id)
  VALUES (
    p_feedback_id,
    v_kind,
    'operator',
    v_caller,
    CASE WHEN v_kind = 'status_changed' THEN v_item.status END,
    CASE WHEN v_kind = 'status_changed' THEN p_status END,
    v_comment,
    v_merge,
    p_client_request_id
  )
  RETURNING id INTO v_event_id;

  IF v_item.submitter_id <> v_caller THEN
    BEGIN
      PERFORM public.enqueue_feedback_push(v_event_id, v_item.submitter_id, 'submitter');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'feedback push enqueue failed (event %, sqlstate %)', v_event_id, SQLSTATE;
    END;
  END IF;

  RETURN QUERY SELECT v_version, true;
END;
$$;

REVOKE ALL ON FUNCTION public.operator_update_feedback(UUID, UUID, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.operator_update_feedback(UUID, UUID, INTEGER, TEXT, TEXT, TEXT) TO authenticated;


-- ------------------------------------------------------------
-- 7. operator_release_feedback — 「本番で反映を確かめた」の確定（運用者のみ）
-- ------------------------------------------------------------
-- p_production_verified は「本番環境で動作を確かめた」という運用者の明示の宣言じゃ。
-- true 以外は拒む（未確認のまま投稿者に「反映されました」と見せぬ）。
-- p_observed_deploy はアプリの Server Action が環境変数から読んだ稼働中のデプロイ（取れねば NULL）。
-- 引数ゆえ PostgREST を直接叩く運用者は任意の値を入れうる —— 改ざん不能な証明ではない。
CREATE OR REPLACE FUNCTION public.operator_release_feedback(
  p_feedback_id         UUID,
  p_client_request_id   UUID,
  p_expected_version    INTEGER,
  p_commit_sha          TEXT,
  p_release_note        TEXT,
  p_observed_deploy     TEXT,
  p_production_verified BOOLEAN,
  p_comment             TEXT
)
RETURNS TABLE (version INTEGER, created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller  UUID := auth.uid();
  v_item    RECORD;
  v_sha     TEXT := lower(btrim(coalesce(p_commit_sha, '')));
  v_note    TEXT := nullif(p_release_note, '');
  v_deploy  TEXT := nullif(p_observed_deploy, '');
  v_comment TEXT := nullif(p_comment, '');
  v_prior   RECORD;
  v_event_id UUID;
  v_version INTEGER;
BEGIN
  IF NOT public.is_app_operator() THEN
    RAISE EXCEPTION 'only app operators can release feedback' USING ERRCODE = '42501';
  END IF;
  IF p_feedback_id IS NULL OR p_client_request_id IS NULL OR p_expected_version IS NULL THEN
    RAISE EXCEPTION 'feedback_id, client_request_id and expected_version are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_production_verified IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'production verification is required' USING ERRCODE = '22023';
  END IF;
  IF v_sha !~ '^[0-9a-f]{7,40}$' THEN
    RAISE EXCEPTION 'invalid commit sha' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND NOT public.feedback_text_ok(v_note, 200, false) THEN
    RAISE EXCEPTION 'invalid release note' USING ERRCODE = '22023';
  END IF;
  IF v_deploy IS NOT NULL
     AND v_deploy !~ '^(production|preview|development):[0-9a-f]{7,40}$' THEN
    RAISE EXCEPTION 'invalid observed deploy' USING ERRCODE = '22023';
  END IF;
  IF v_comment IS NOT NULL AND NOT public.feedback_text_ok(v_comment, 2000, true) THEN
    RAISE EXCEPTION 'invalid comment' USING ERRCODE = '22023';
  END IF;

  -- 行を先に握ってから再送を判定する（operator_update_feedback と同じ理由）。
  SELECT f.* INTO v_item FROM public.feedback_items f WHERE f.id = p_feedback_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'feedback not found' USING ERRCODE = 'P0002';
  END IF;

  -- 冪等: 同じ鍵の確定が既に在れば、**同じ SHA・リリース情報・返信の時だけ**記録済みとして
  -- 返す。通信断の後に SHA の誤記を直して送り直したものを黙って捨て、誤った証拠を残さぬ。
  -- （観測したデプロイは再送の間に変わりうるゆえ比べぬ）
  SELECT e.kind, e.to_status, e.release_commit_sha, e.release_note, e.comment INTO v_prior
    FROM public.feedback_events e
   WHERE e.feedback_id = p_feedback_id AND e.client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_prior.kind = 'status_changed' AND v_prior.to_status = 'released'
       AND v_prior.release_commit_sha IS NOT DISTINCT FROM v_sha
       AND v_prior.release_note IS NOT DISTINCT FROM v_note
       AND v_prior.comment IS NOT DISTINCT FROM v_comment THEN
      RETURN QUERY SELECT v_item.version, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'client_request_id reused with different content' USING ERRCODE = 'IRF01';
  END IF;

  IF v_item.version <> p_expected_version THEN
    RAISE EXCEPTION 'feedback was updated by someone else' USING ERRCODE = 'IRF03';
  END IF;
  IF v_item.status = 'released' THEN
    RAISE EXCEPTION 'already released' USING ERRCODE = '22023';
  END IF;

  UPDATE public.feedback_items f
     SET status = 'released',
         version = f.version + 1,
         updated_at = now(),
         last_operator_activity_at = now(),
         released_commit_sha = v_sha,
         released_note = v_note,
         released_observed_deploy = v_deploy,
         released_verified_at = now()
   WHERE f.id = p_feedback_id
  RETURNING f.version INTO v_version;

  INSERT INTO public.feedback_events
    (feedback_id, kind, actor_role, actor_id, from_status, to_status, comment,
     release_commit_sha, release_note, release_observed_deploy, release_verified_at,
     client_request_id)
  VALUES (
    p_feedback_id, 'status_changed', 'operator', v_caller, v_item.status, 'released', v_comment,
    v_sha, v_note, v_deploy, now(),
    p_client_request_id
  )
  RETURNING id INTO v_event_id;

  IF v_item.submitter_id <> v_caller THEN
    BEGIN
      PERFORM public.enqueue_feedback_push(v_event_id, v_item.submitter_id, 'submitter');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'feedback push enqueue failed (event %, sqlstate %)', v_event_id, SQLSTATE;
    END;
  END IF;

  RETURN QUERY SELECT v_version, true;
END;
$$;

REVOKE ALL ON FUNCTION public.operator_release_feedback(UUID, UUID, INTEGER, TEXT, TEXT, TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.operator_release_feedback(UUID, UUID, INTEGER, TEXT, TEXT, TEXT, BOOLEAN, TEXT) TO authenticated;


-- ------------------------------------------------------------
-- 8. mark_feedback_seen — 既読（投稿者 / 運用者）
-- ------------------------------------------------------------
-- 見えぬ要望と存在せぬ要望は**同じ** P0002 で返す（他人の要望の有無を漏らさぬ）。
-- version と updated_at は動かさぬ（既読は内容の変更ではない）。
CREATE OR REPLACE FUNCTION public.mark_feedback_seen(p_feedback_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller    UUID := auth.uid();
  v_submitter UUID;
  v_operator  BOOLEAN;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  SELECT f.submitter_id INTO v_submitter FROM public.feedback_items f WHERE f.id = p_feedback_id;
  v_operator := public.is_app_operator();
  IF v_submitter IS NULL OR (v_submitter <> v_caller AND NOT v_operator) THEN
    RAISE EXCEPTION 'feedback not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_submitter = v_caller THEN
    UPDATE public.feedback_items f
       SET submitter_seen_at = greatest(f.submitter_seen_at, now())
     WHERE f.id = p_feedback_id;
  END IF;
  IF v_operator THEN
    UPDATE public.feedback_items f
       SET operator_seen_at = now()
     WHERE f.id = p_feedback_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_feedback_seen(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_feedback_seen(UUID) TO authenticated;


-- ------------------------------------------------------------
-- 9. get_feedback_push_summary — 知らせの配信状況（運用者のみ・数だけ）
-- ------------------------------------------------------------
-- 運用者の画面で「届いた」と断定させぬための材料じゃ。返すのは数だけで、
-- 端末の識別子・endpoint は返さぬ。
--   queued      = まだ送っておらぬ
--   accepted    = push サービスが受理（端末での表示は未確認）
--   unconfirmed = 送ったが結果が分からぬ（at-most-once で再送せぬ）
--   gone / expired / revoked / superseded = 送らずに畳んだ（skip_reason の allowlist と同じ並び）
-- ⚠️ skip_reason を増やしたらここにも列を足せ。数えぬ理由で畳んだ行は全部 0 に見え、
-- 画面が「Push の宛先なし」と嘘をつく（端末は在ったのに）。
CREATE OR REPLACE FUNCTION public.get_feedback_push_summary(p_feedback_id UUID)
RETURNS TABLE (
  event_id    UUID,
  queued      INTEGER,
  accepted    INTEGER,
  unconfirmed INTEGER,
  gone        INTEGER,
  expired     INTEGER,
  revoked     INTEGER,
  superseded  INTEGER
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_app_operator() THEN
    RAISE EXCEPTION 'only app operators can read delivery status' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT n.event_id,
         (count(*) FILTER (WHERE n.sent_at IS NULL AND n.skipped_at IS NULL))::INTEGER,
         (count(*) FILTER (WHERE n.accepted_at IS NOT NULL))::INTEGER,
         (count(*) FILTER (WHERE n.sent_at IS NOT NULL AND n.accepted_at IS NULL))::INTEGER,
         (count(*) FILTER (WHERE n.skip_reason = 'gone'))::INTEGER,
         (count(*) FILTER (WHERE n.skip_reason = 'expired'))::INTEGER,
         (count(*) FILTER (WHERE n.skip_reason = 'revoked'))::INTEGER,
         (count(*) FILTER (WHERE n.skip_reason = 'superseded'))::INTEGER
    FROM public.feedback_notifications n
    JOIN public.feedback_events e ON e.id = n.event_id
   WHERE e.feedback_id = p_feedback_id
   GROUP BY n.event_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_feedback_push_summary(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_feedback_push_summary(UUID) TO authenticated;
