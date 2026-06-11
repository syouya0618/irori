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

  // getUser() でサーバー側トークン検証（getSession()は改ざん可能で非推奨）
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl

  const isPublicRoute =
    pathname === "/login" || pathname.startsWith("/auth/callback")
  const isInviteRoute = pathname.startsWith("/invite/")
  const isPendingRoute = pathname === "/pending-approval"

  // ── 未認証 ──
  if (!user) {
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
    .eq("id", user.id)
    .single()

  if (profileError) {
    logSupabaseError("proxy", "profile lookup failed", profileError, {
      userId: user.id,
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
