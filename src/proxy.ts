import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { getAppOrigin } from "@/lib/utils/app-origin"
import { getVerifiedUserId } from "@/lib/supabase/verified-user"

/**
 * `Server-Timing` に載せる内訳。proxy は静的アセット以外の**全リクエスト**を通り、
 * TTFB の支配項が認証往復であることが実測で分かっている（getUser 16.55ms →
 * getClaims 0.14ms への切替が #171）。次に「もっさりする」と言われた時に
 * **推測ではなく数字で**切り分けられるよう、認証と DB の内訳を毎回返す。
 *
 * 計測範囲は **proxy 自身の auth + db のみ**じゃ。ページ本体の描画時間は含まぬ
 * （それは Server Component 側の話ゆえ、必要になった時に別途足す）。
 *
 * `Server-Timing` を選ぶ理由: 同一オリジンなら追加設定なしでブラウザが解釈し、
 * DevTools の Network → Timing に表示され、`PerformanceServerTiming` から
 * スクリプトでも読める（＝ e2e で「ブラウザに見えている」ことを機械検証できる）。
 */
function serverTimingHeader(authMs: number, dbMs: number | null): string {
  // 小数 2 桁。getClaims（ローカル検証）は実測 0.14ms 級ゆえ、1 桁だと
  // 「0.1」に潰れて getUser（16.55ms 級）との差が読めなくなる。
  // 未認証リクエストはセッション無しで I/O 前に短絡するため 0.00 になるが、
  // これは計測不能ではなく**本当に何もしていない**という意味じゃ。
  const parts = [`auth;dur=${authMs.toFixed(2)}`]
  if (dbMs !== null) parts.push(`db;dur=${dbMs.toFixed(2)}`)
  return parts.join(", ")
}

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

  // 認証判定は getVerifiedUserId に集約する（proxy とページで別方式を使うと
  // 判定が食い違い無限リダイレクトになる — 詳細と根拠は同ファイルの注記を参照）。
  const authStart = performance.now()
  const userId = await getVerifiedUserId(supabase, "proxy")
  const authMs = performance.now() - authStart
  let dbMs: number | null = null

  /**
   * すべての return をこれで包む。`supabaseResponse` は cookie 書き込み
   * (`setAll`) のたびに再代入されるため、**返す直前**に載せねば消える。
   * redirect 応答にも載せる（/login への 307 が遅い場合も測れるように）。
   */
  const withTiming = <T extends NextResponse>(res: T): T => {
    res.headers.set("Server-Timing", serverTimingHeader(authMs, dbMs))
    return res
  }

  const { pathname } = request.nextUrl

  const isPublicRoute =
    pathname === "/login" ||
    pathname.startsWith("/auth/callback") ||
    // V8【致命的】Vercel Cron は **cookie 無しの GET** を送る。承認ゲートを
    // 通すと未認証と判定されて /login へ 307 され、**ハンドラに到達せぬ**
    // （テストは緑・本番は 100% 不発）。認可はハンドラ側の fail-closed な
    // CRON_SECRET 検証が担う（`src/app/api/cron/*/route.ts`）。
    //
    // **matcher から外すのではなく isPublicRoute にしてある理由**:
    // matcher から外すと proxy 自体を通らなくなり、`Server-Timing` も載らぬ
    // （#171 で入れた TTFB の内訳計測が cron 経路だけ欠ける）。isPublicRoute
    // なら proxy は通り、迂回するのは承認ゲートだけで済む。
    //
    // 意図的に認証を外すのは `/api/cron/` ただ一つじゃ。ここに別の prefix を
    // 足す前に、そのハンドラが fail-closed な認可を持つことを必ず確かめよ。
    pathname.startsWith("/api/cron/")
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
      return withTiming(
        NextResponse.redirect(
          new URL(url.pathname + url.search, getAppOrigin(request))
        )
      )
    }
    return withTiming(supabaseResponse)
  }

  // ── 認証済み: 承認チェック ──
  // Supabase error は plain object（class Error 非継承）。{ data } のみで destructure すると
  // silent fail で /pending-approval ループに陥るため、error を構造化ログ出力する。
  const dbStart = performance.now()
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("is_approved")
    .eq("id", userId)
    .single()
  dbMs = performance.now() - dbStart

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
      return withTiming(
        NextResponse.redirect(
          new URL(url.pathname + url.search, getAppOrigin(request))
        )
      )
    }
  } else {
    // 承認済み: public / pending-approval → / (default_page 解決は page.tsx に委譲)
    if (isPublicRoute || isPendingRoute) {
      const url = request.nextUrl.clone()
      url.pathname = "/"
      return withTiming(
        NextResponse.redirect(
          new URL(url.pathname + url.search, getAppOrigin(request))
        )
      )
    }
  }

  return withTiming(supabaseResponse)
}

export const config = {
  // /offline は SW の precache が未認証で取得する静的フォールバックページ。
  // 個人データゼロのため認証チェックから除外しても無害 (除外しないと
  // /login への redirect が precache に誤保存されるリスクがある)。
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icons/|manifest\\.webmanifest|sw\\.js|offline$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
}
