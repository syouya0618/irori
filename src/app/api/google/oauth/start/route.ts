import { NextResponse } from "next/server"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { getAppOrigin } from "@/lib/utils/app-origin"
import {
  GOOGLE_OAUTH_STATE_COOKIE,
  buildGoogleAuthorizeUrl,
  createOAuthState,
  googleOAuthRedirectUri,
  oauthStateCookieOptions,
  settingsNoticeUrl,
} from "@/lib/google/oauth-connect"

/**
 * `GET /api/google/oauth/start` — Google の同意画面へ送り出す（計画書 §7 D-4）。
 *
 * ## 認可
 * `src/proxy.ts` の matcher は静的アセット以外の**全経路**を通すため、この URL は
 * 既に承認ゲートの内側にある（計画書 §D-4 の脚注「`/api/google/oauth/start` と
 * `/callback` も承認ゲートを通る＝良い設計」）。にもかかわらず `getAuthContext()`
 * を呼ぶのは**二層目**じゃ — 規約ファイル（proxy）は置き場所を一段間違えるだけで
 * ビルドも lint も緑のまま黙って無効化されうる（`auth-context.ts` の注記を見よ）。
 *
 * ## 資格情報が無い環境で落とさぬ
 * `GOOGLE_CLIENT_ID` 未設定は**デプロイ設定の誤り**であって利用者の失敗ではない。
 * 500 を投げず `?google=not_configured` で設定画面へ戻し、カードに理由を出す。
 */
export async function GET(request: Request) {
  // request.url の origin は loopback アクセス時に localhost へ正規化されるため
  // 使わない (issue #16)。NEXT_PUBLIC_APP_URL → host ヘッダの順で解決する。
  const origin = getAppOrigin(request)

  const auth = await getAuthContext()
  if (auth.error !== null) {
    // proxy が先に 307 で弾くはずの経路。ここへ来たのは proxy が効いておらぬ
    // 徴候ゆえ、黙って通さず理由を残す。
    console.error("[google-oauth-start] 未認証のためログインへ戻します", {
      reason: auth.reason,
    })
    return NextResponse.redirect(new URL("/login", origin).toString())
  }

  // env は `?.trim()` で防御（末尾改行混入の再発防止）。
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim()
  if (!clientId) {
    // 値そのものは出さぬ（未設定なのでそもそも無いが、規約を経路ごと守る）。
    console.error(
      "[google-oauth-start] GOOGLE_CLIENT_ID が未設定のため接続を開始できません",
    )
    return NextResponse.redirect(settingsNoticeUrl(origin, "not_configured"))
  }

  const state = createOAuthState()
  const authorizeUrl = buildGoogleAuthorizeUrl({
    clientId,
    // 専用 env を増やさず origin から導出する（計画書 §D-8）。
    // callback 側も同じ関数で組むため、Google が要求する「authorize と token の
    // redirect_uri 完全一致」が構造的に保たれる。
    redirectUri: googleOAuthRedirectUri(origin),
    state,
  })

  const response = NextResponse.redirect(authorizeUrl)
  // **cookie は `NextResponse` へ直接書く**。`cookies()` + `redirect()` では
  // 伝播せぬ（CLAUDE.md の既知の罠）。
  response.cookies.set(
    GOOGLE_OAUTH_STATE_COOKIE,
    state,
    oauthStateCookieOptions(origin),
  )
  return response
}
