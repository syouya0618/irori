const DEV_FALLBACK_ORIGIN = "http://localhost:3000"

/**
 * アプリの実効 origin を一元解決する (issue #16)。
 *
 * NextRequest の url / nextUrl は loopback host (127.0.0.0/8, [::1], localhost)
 * の hostname を一律 'localhost' に正規化する Next.js 仕様
 * (next/dist/server/web/next-url.js の REGEX_LOCALHOST_HOSTNAME) があるため、
 * request.url 由来の origin を信用せず NEXT_PUBLIC_APP_URL を最優先する。
 * env 未設定時は x-forwarded-host / host ヘッダ（正規化を受けない実アクセス値）
 * にフォールバックする。
 *
 * envAppUrl はテスト注入用の省略可能引数 (date-jst.ts の now 注入と同規約)。
 */
export function getAppOrigin(
  request?: Request,
  envAppUrl: string | undefined = process.env.NEXT_PUBLIC_APP_URL
): string {
  const trimmed = envAppUrl?.trim()
  if (trimmed) {
    try {
      const parsedOrigin = new URL(trimmed).origin
      // "localhost:3000" のようなスキーム無し値は WHATWG URL では
      // scheme="localhost:" として throw せず解釈され、opaque origin の
      // 文字列 "null" が返るため、有効な origin と区別して除外する
      if (parsedOrigin !== "null") {
        return parsedOrigin
      }
      console.error(
        "[app-origin] NEXT_PUBLIC_APP_URL から origin を解決できないためフォールバックします",
        { value: trimmed, origin: parsedOrigin }
      )
    } catch (err) {
      console.error(
        "[app-origin] NEXT_PUBLIC_APP_URL が不正な URL のためフォールバックします",
        {
          value: trimmed,
          message: err instanceof Error ? err.message : String(err),
        }
      )
    }
  }
  if (request) {
    const fwdHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
    const host = fwdHost || request.headers.get("host")?.split(",")[0]?.trim()
    if (host) {
      const proto =
        request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http"
      return `${proto}://${host}`
    }
    // 最終フォールバック（現状互換）: ヘッダすら無い異常系のみ到達する。
    // loopback アクセスでは localhost 化しうるが、従来挙動より悪化はしない。
    return new URL(request.url).origin
  }
  return DEV_FALLBACK_ORIGIN
}
