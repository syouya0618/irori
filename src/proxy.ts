import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { getAppOrigin } from "@/lib/utils/app-origin"
import { getVerifiedUserId } from "@/lib/supabase/verified-user"
import { resolveDefaultPage } from "@/lib/constants/pages"

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
 *
 * ⚠️ **2026-08-09 まで、この計測は本番で一度も届いておらなんだ。**
 * Vercel の CDN が `Server-Timing` 応答ヘッダを**剥がしていた**ためじゃ。実測で
 * 弁別済み — 同一コードがローカルの `next start` では `/`・`/login`・
 * `/api/cron/notify` の全てに載り、本番では 1 つも載らなかった（`x-vercel-cache`
 * が MISS の動的経路でも載らぬゆえ、キャッシュではなく CDN の剥がしじゃ）。
 * 一次情報: https://vercel.com/changelog/server-timing-header
 *   "On August 10, 2026, Vercel's CDN will stop stripping the Server-Timing
 *    response header and begin passing it through to the client."
 * opt-in は不要で、既定で通るようになる（止めたい側が vercel.json の transform
 * で消す）。ゆえに**ヘッダの出し方は変えぬ** — 壊れていたのは経路であって
 * この実装ではない。
 *
 * ⚠️ **教訓**: `e2e/server-timing.spec.ts` は実ブラウザ + 実ビルドで緑でありながら、
 * 本番では死んでいた。e2e は**自前のサーバ**を相手にするゆえ、CDN の振る舞いを
 * 一切見ておらぬ。本番に届いているかは本番を撃つほかない
 * （`scripts/verify-prod-server-timing.mjs`）。
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
  const isRootRoute = pathname === "/"

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
    // `default_page` は**同じ 1 往復で読む**（列を足しても往復は増えぬ）。
    // これで `/` の行き先を proxy が決められる ＝ `/` の動的描画そのものが不要になる。
    .select("is_approved, default_page")
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
    /**
     * 承認済み: 入口（`/`・public・pending）を**最終目的地まで一度で**解決する。
     *
     * 以前はここで `/` へ飛ばし、`/` の Server Component が改めて認証し
     * `profiles` をもう一度引いて `/${page}` へ再 redirect しておった。つまり
     * 起動のたびに「動的描画 1 回 + getClaims 1 回 + profiles 1 往復 + HTTP 1 往復」
     * を余計に払っていた。`is_approved` を読む往復で `default_page` も既に
     * 手元にあるゆえ、その全てが要らぬ。
     *
     * `/${page}` は public でも pending でも `/` でもないゆえ、ここへ戻ってきて
     * 再び分岐に入ることはない（＝ループを作らぬ）。この不変条件は
     * `src/__tests__/proxy.test.ts` が VALID_PAGES を総なめして固定する。
     *
     * ⚠️ **ゲートの位置は動かしておらぬ。** この分岐は `isApproved === true` の
     * 枝の中だけじゃ。未認証・未承認・lookup 失敗の経路は一切触れておらぬ。
     */
    if (isPublicRoute || isPendingRoute || isRootRoute) {
      const url = request.nextUrl.clone()
      url.pathname = `/${resolveDefaultPage(profile?.default_page)}`
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
