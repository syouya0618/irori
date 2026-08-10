import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getAppOrigin } from "@/lib/utils/app-origin"
import { safeReturnTo } from "@/lib/auth/safe-return-to"

/**
 * **メールを使わぬログインの着地点**（緊急用の逃げ道）。
 *
 * ## なぜ要るか
 *
 * Supabase の組込みメールは **1 時間に 2 通**しか送れず、組込みのままでは上げ
 * られぬ（公式: "You can only change this with a custom SMTP setup."）。夫婦
 * 二人で押し合えば即座に尽き、**ログアウトした側が戻れなくなる**。2026-08-10 に
 * 実際に起きた。
 *
 * 管理者（サービスロールキーを持つ者）が `scripts/generate-login-link.mjs` で
 * リンクを生成し、LINE 等で直接渡せば、**メールを 1 通も使わずに入れる**。
 *
 * ## 門は弱まらぬ
 *
 * 認証は Supabase の `verifyOtp` が行う。**有効・未使用・未期限切れの
 * `token_hash` を持たぬ限りセッションは立たぬ**（fail-closed）。その後も
 * 承認ゲート（proxy と `getAuthContext` の二層）と RLS はそのまま効く。
 * リンクを作れるのはサービスロールキーを持つ者だけじゃ。
 *
 * ## ⚠️ `token_hash` は**使い切りの資格情報**じゃ
 *
 * ログにも、リダイレクト先のクエリにも、絶対に載せてはならぬ。
 *
 * ## ⚠️ これは「メールのリンクが別ブラウザで開けぬ問題」を解いておらぬ
 *
 * 解けるのは**手で生成したリンク**だけじゃ。メールで届くマジックリンクは
 * PKCE のままゆえ、送信したブラウザ以外で開けば従来どおり失敗する。そちらを
 * 直すには Supabase のメールテンプレートを `{{ .TokenHash }}` 形式へ変える
 * 必要があり、それはダッシュボードの操作（このコードの外）じゃ。
 */

/**
 * 受け入れる検証種別。**この app が実際に発行するものだけ**を並べる。
 *
 * `EmailOtpType` は `(string & {})` を含むため **TypeScript は誤った値を止めぬ**。
 * 実行時のこの allowlist だけが唯一の守りじゃ。
 *
 * `recovery` / `invite` / `signup` / `email_change` は敢えて入れておらぬ ——
 * どれも GoTrue 側の別の状態遷移を伴い、この app はそれらを発行せぬ。
 * 発行するようになった PR で、そのテストと共に足すこと。
 */
const ALLOWED_TYPES = ["magiclink"] as const
type AllowedType = (typeof ALLOWED_TYPES)[number]

function isAllowedType(value: string | null): value is AllowedType {
  return (ALLOWED_TYPES as readonly string[]).includes(value ?? "")
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const origin = getAppOrigin(request)
  const tokenHash = searchParams.get("token_hash")
  const type = searchParams.get("type")
  const returnTo = safeReturnTo(searchParams.get("returnTo"))

  const loginUrl = (reason: string) => {
    const params = new URLSearchParams({ error: reason })
    if (returnTo) params.set("returnTo", returnTo)
    return `${origin}/login?${params.toString()}`
  }

  if (!tokenHash || !isAllowedType(type)) {
    // ⚠️ token_hash は値を載せぬ。**在ったか否か**だけを記録する。
    console.error("[auth/confirm] 受け付けられぬリクエスト", {
      hasTokenHash: !!tokenHash,
      type,
      allowed: ALLOWED_TYPES,
    })
    return NextResponse.redirect(loginUrl("link_invalid"))
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type,
  })

  if (error) {
    console.error("[auth/confirm] verifyOtp が失敗しました", {
      code: error.code,
      status: error.status,
      message: error.message,
      name: error.name,
    })
    // 期限切れ・使用済みは同じ見え方をする（GoTrue は区別を返さぬ）ゆえ
    // 「無効」で統一する。捏造した区別を利用者へ見せぬ。
    return NextResponse.redirect(loginUrl("link_invalid"))
  }

  return NextResponse.redirect(returnTo ? `${origin}${returnTo}` : `${origin}/`)
}
