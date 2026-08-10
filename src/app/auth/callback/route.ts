import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getAppOrigin } from "@/lib/utils/app-origin"
import type { AuthErrorReason } from "@/lib/auth/auth-error-messages"

/**
 * マジックリンクの着地点。
 *
 * ## ここは以前、失敗の証拠を全て捨てておった
 *
 * `if (code)` 以外は素通しで `/login?error=auth` へ飛ばすだけじゃった。GoTrue は
 * 失敗を `error` / `error_code` / `error_description` に載せて返してくるのに、
 * それを読まず・記録せず・利用者にも伝えなんだ。結果、配偶者がログインできなく
 * なった時（2026-08-10）に**誰も原因を言えぬ**状態になった。
 *
 * ゆえに: (1) 生の値は必ずサーバログへ（Vercel の runtime log で読める）、
 * (2) 利用者へは**理由コードだけ**を渡す（`/login?error=<reason>`）。
 * 自由文（`error_description`）を画面まで運んではならぬ —— URL に書かれた任意の
 * 文章を表示する装置になるゆえ、文言は `auth-error-messages.ts` の表から引く。
 */

/** 相対パスのみ許可（open redirect 防止）。従来の判定をそのまま関数へ切り出したもの。 */
function safeReturnTo(returnTo: string | null): string | null {
  if (!returnTo) return null
  return returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : null
}

function loginUrl(
  origin: string,
  reason: AuthErrorReason,
  returnTo: string | null
): string {
  const params = new URLSearchParams({ error: reason })
  const safe = safeReturnTo(returnTo)
  if (safe) params.set("returnTo", safe)
  return `${origin}/login?${params.toString()}`
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  // request.url の origin は loopback アクセス時に localhost へ正規化されるため
  // 使わない (issue #16)。NEXT_PUBLIC_APP_URL → host ヘッダの順で解決する。
  const origin = getAppOrigin(request)
  const code = searchParams.get("code")
  const returnTo = searchParams.get("returnTo")

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)

    if (!error) {
      const safe = safeReturnTo(returnTo)
      return NextResponse.redirect(safe ? `${origin}${safe}` : `${origin}/`)
    }

    console.error("[auth/callback] exchangeCodeForSession が失敗しました", {
      code: error.code,
      status: error.status,
      message: error.message,
      name: error.name,
    })

    /**
     * PKCE の検証子欠落を名指しする。
     *
     * 検証子は `signInWithOtp` を実行した**ブラウザの保存領域**にしかない。
     * ホーム画面の web app で送信し、メールアプリからリンクを開くと別領域で
     * 開かれ、必ずここへ落ちる —— そして本人には絶対に推測できぬ。
     *
     * ⚠️ 判定は message の文字列一致ゆえ脆い（GoTrue の文言が変われば外れる）。
     * 外れても `exchange_failed` の総称文へ落ちるだけで、**生の値は上のログに
     * 残る**。文字列一致に賭けているのは「より親切な文言」だけで、可観測性は
     * 一致に依存しておらぬ。
     */
    const isVerifierMissing = /code[\s_-]?verifier/i.test(error.message ?? "")
    return NextResponse.redirect(
      loginUrl(
        origin,
        isVerifierMissing ? "verifier_missing" : "exchange_failed",
        returnTo
      )
    )
  }

  // code が無い ＝ GoTrue 側で失敗しておる（期限切れ・使用済み・拒否）。
  // ⚠️ code がある時にここを見てはならぬ。`/login?error=...` から再送すると
  // 古い error がリンクに紛れうるため、**code の有無を先に見る**のが順序の要。
  const gotrueError = searchParams.get("error")
  const gotrueErrorCode = searchParams.get("error_code")

  console.error("[auth/callback] code なしで着地しました", {
    error: gotrueError,
    errorCode: gotrueErrorCode,
    // 自由文ゆえ画面へは出さぬが、原因特定にはこれが要る
    errorDescription: searchParams.get("error_description"),
  })

  const expired =
    gotrueErrorCode === "otp_expired" || gotrueErrorCode === "email_link_invalid"
  return NextResponse.redirect(
    loginUrl(origin, expired ? "link_expired" : "link_invalid", returnTo)
  )
}
