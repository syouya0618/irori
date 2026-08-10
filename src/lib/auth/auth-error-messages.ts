/**
 * 認証の失敗を**利用者に名指しで伝える**ための文言表。
 *
 * ## なぜ要るか（実際に起きたこと）
 *
 * 2026-08-10、配偶者がログインできなくなった。画面に出たのは
 * 「送信に失敗しました。もう一度お試しください。」の一行だけで、
 * `signInWithOtp` が返した `error` は **code も message も status も捨てられて
 * おった**。ログにも残らぬ。ゆえに端末を触れぬ側からは原因が原理的に分からず、
 * 本人は「もう一度」を繰り返す —— それが送信レート制限なら、**再試行が自分で
 * 自分を締め出す**形になる。
 *
 * 同じ穴が受け取り側にも在った: `auth/callback` は交換に失敗すると
 * `/login?error=auth` へ飛ばすが、`login` はこのクエリを**一切読んでおらなんだ**。
 * リンクを踏んだ側から見れば「無言でログイン画面に戻る」だけじゃった。
 *
 * ## 表にする理由（そのまま出してはならぬ）
 *
 * GoTrue は失敗を `error` / `error_code` / `error_description` でクエリに載せて
 * 返す。`error_description` は**URL に書かれた任意の文字列**ゆえ、画面へ素通し
 * すると「Anthropic のサポートに電話せよ」等の偽の指示を差し込める。
 * ゆえに**表示は必ずこの表から引く**。生の値はサーバログにだけ残す。
 */

/** 画面に出してよい理由コード（`/login?error=` に載せる値） */
export const AUTH_ERROR_REASONS = [
  "link_expired",
  "link_invalid",
  "verifier_missing",
  "exchange_failed",
] as const

export type AuthErrorReason = (typeof AUTH_ERROR_REASONS)[number]

/**
 * リンクを踏んだ側の失敗（`/login?error=<reason>`）。
 *
 * `verifier_missing` の文言が具体的なのは、これが**最も踏みやすく、かつ本人には
 * 絶対に推測できぬ**失敗だからじゃ。PKCE の検証子は「送信を押したブラウザ」の
 * 保存領域にしかない。ホーム画面の web app で送信し、メールアプリからリンクを
 * 開くと別の保存領域で開かれ、検証子が見つからず必ず失敗する。
 */
const REASON_MESSAGES: Record<AuthErrorReason, string> = {
  link_expired:
    "リンクの有効期限が切れています。お手数ですが、もう一度送信してください。",
  link_invalid:
    "リンクが無効です。すでに使用済みか、期限切れの可能性があります。もう一度送信してください。",
  verifier_missing:
    "リンクを、送信したときと別のブラウザで開いています。送信ボタンを押したブラウザ（同じアプリ）でリンクを開いてください。",
  exchange_failed:
    "ログインの確認に失敗しました。もう一度送信してお試しください。",
}

function isAuthErrorReason(value: string): value is AuthErrorReason {
  return (AUTH_ERROR_REASONS as readonly string[]).includes(value)
}

/**
 * `/login?error=` の値を表示文言へ。未知の値は null（＝何も出さぬ）。
 *
 * ⚠️ 未知の値を「そのまま出す」フォールバックを足してはならぬ。それを足した
 * 瞬間、この関数はクエリ文字列に書かれた任意の文章を画面に出す装置になる。
 */
export function messageForAuthErrorReason(
  value: string | null | undefined
): string | null {
  if (!value) return null
  return isAuthErrorReason(value) ? REASON_MESSAGES[value] : null
}

/** Supabase の AuthError の最小形（code/status は版により欠けうる） */
export interface AuthErrorLike {
  message?: string
  code?: string
  status?: number
}

/**
 * 送信（`signInWithOtp`）の失敗を表示文言へ。
 *
 * 既知の code は名指しで、未知は総称文＋**code をそのまま添える**。
 * code を出すのは、次に「入れぬ」と言われた時に**本人に読み上げてもらう**ため
 * じゃ。ここが総称文だけだと、また同じ盲目に戻る。
 *
 * ⚠️ `message`（サーバ由来の自由文）は画面へ出さぬ。出すのは code だけで、
 * それも `[a-z0-9_]` に限る（表示経路に自由文を通さぬための封じ）。
 */
export function messageForSignInError(error: AuthErrorLike): string {
  const code = error.code
  const status = error.status

  // レート制限は「待てば直る」ゆえ、再試行を促してはならぬ。
  // 促すと本人が再試行で制限を延ばし続ける（本件で実際に起きた形）。
  if (code === "over_email_send_rate_limit" || status === 429) {
    return "メールの送信回数が上限に達しました。しばらく（1時間ほど）待ってから、もう一度お試しください。何度も押すと待ち時間が延びます。"
  }
  if (code === "signup_disabled" || code === "email_provider_disabled") {
    return "このメールアドレスではログインできません。管理者（世帯の作成者）に招待を依頼してください。"
  }
  if (code === "validation_failed" || code === "email_address_invalid") {
    return "メールアドレスの形式が正しくないようです。入力をご確認ください。"
  }

  const safeCode =
    typeof code === "string" && /^[a-z0-9_]{1,40}$/.test(code) ? code : null
  return safeCode
    ? `送信に失敗しました（${safeCode}）。この括弧内をそのまま伝えてください。`
    : "送信に失敗しました。しばらく待ってから、もう一度お試しください。"
}
