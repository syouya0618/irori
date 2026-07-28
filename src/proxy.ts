import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { getAppOrigin } from "@/lib/utils/app-origin"

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "",
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // トークン検証は getClaims()。getSession() は改ざん可能ゆえ絶対に使わない。
  //
  // なぜ getUser() から替えたか（2026-07-28 実測）:
  //   getUser() は **JWT ごとに必ず Auth サーバへ往復**する（16.55ms）。対して
  //   getClaims() は非対称鍵（本番は ES256）なら JWKS を使い **ローカルの WebCrypto で
  //   検証**して完結する（0.14ms・118 倍差）。proxy は静的アセット以外の全リクエスト
  //   （ページ・RSC ナビ・Server Action・prefetch）を通るため、この差が体感の支配項
  //   だった（1 ページ表示あたり Supabase 往復 35 回・うち 26 回が認証専用）。
  //
  // 失うもの（承知の上）: **サーバ側の失効確認**。ログアウト・端末紛失・パスワード
  //   変更は、アクセストークンの TTL（既定 3600 秒）ぶん反映が遅れる。ただし
  //   **承認ゲートは下の profiles 読みで毎回 DB を見る**ため承認取り消しは即時に効き、
  //   世帯分離も RLS が JWT の sub で毎回評価する。高感度な操作（招待受諾・世帯作成）
  //   は各 Server Action 側で getUser() を残してあり、そこでは失効が即時に効く。
  //
  // セッション更新は失われない: 「access token が期限切れ間近なら検証前にセッションを
  //   更新する」と getClaims の契約に明記されている（@supabase/auth-js の
  //   GoTrueClient.d.ts）。ゆえに 1 時間で強制ログアウトにはならない。
  //
  // ⚠️ fail-closed を絶対に崩すな: 署名不正・期限切れ・JWKS 取得失敗・想定外の戻り値・
  //   例外、いずれも「未認証」へ倒すこと。ここを緩めると保護ページが素通しになり
  //   「OSS 公開 × 家族専用」が破れる。不変条件は src/__tests__/proxy.test.ts が固定する。
  let userId: string | null = null
  try {
    const { data, error } = await supabase.auth.getClaims()
    if (error) {
      logSupabaseError("proxy", "getClaims failed", error, {
        pathname: request.nextUrl.pathname,
      })
    }
    const sub = data?.claims?.sub
    userId = typeof sub === "string" && sub.length > 0 ? sub : null
  } catch (err) {
    // 例外も握り潰さず記録し、未認証へ倒す（catch 内でログ必須）
    console.error("[proxy] getClaims が例外を投げました", {
      message: err instanceof Error ? err.message : String(err),
      pathname: request.nextUrl.pathname,
    })
    userId = null
  }

  const { pathname } = request.nextUrl

  const isPublicRoute =
    pathname === "/login" || pathname.startsWith("/auth/callback")
  const isInviteRoute = pathname.startsWith("/invite/")
  const isPendingRoute = pathname === "/pending-approval"

  // ── 未認証 ──
  if (!userId) {
    // public / invite 以外 → /login
    if (!isPublicRoute && !isInviteRoute) {
      // nextUrl は loopback host を localhost に正規化するため (issue #16)、
      // origin は getAppOrigin で解決する (NextResponse.redirect は絶対 URL 必須)
      const url = request.nextUrl.clone()
      url.pathname = "/login"
      return NextResponse.redirect(
        new URL(url.pathname + url.search, getAppOrigin(request))
      )
    }
    return supabaseResponse
  }

  // ── 認証済み: 承認チェック ──
  // Supabase error は plain object（class Error 非継承）。{ data } のみで destructure すると
  // silent fail で /pending-approval ループに陥るため、error を構造化ログ出力する。
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("is_approved")
    .eq("id", userId)
    .single()

  if (profileError) {
    logSupabaseError("proxy", "profile lookup failed", profileError, {
      userId,
      pathname,
    })
  }

  const isApproved = profile?.is_approved ?? false

  if (!isApproved) {
    // 未承認: invite / pending-approval 以外 → /pending-approval
    if (!isPendingRoute && !isInviteRoute) {
      const url = request.nextUrl.clone()
      url.pathname = "/pending-approval"
      return NextResponse.redirect(
        new URL(url.pathname + url.search, getAppOrigin(request))
      )
    }
  } else {
    // 承認済み: public / pending-approval → / (default_page 解決は page.tsx に委譲)
    if (isPublicRoute || isPendingRoute) {
      const url = request.nextUrl.clone()
      url.pathname = "/"
      return NextResponse.redirect(
        new URL(url.pathname + url.search, getAppOrigin(request))
      )
    }
  }

  return supabaseResponse
}

export const config = {
  // /offline は SW の precache が未認証で取得する静的フォールバックページ。
  // 個人データゼロのため認証チェックから除外しても無害 (除外しないと
  // /login への redirect が precache に誤保存されるリスクがある)。
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icons/|manifest\\.webmanifest|sw\\.js|offline$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
}
