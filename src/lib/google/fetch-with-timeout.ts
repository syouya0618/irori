/**
 * Google API を叩く全 fetch の共通境界（計画書 §D-3「I/O シェル」）。
 *
 * **throw せず結果オブジェクトを返す**。`oauth.ts` と `calendar-client.ts` は
 * 失敗の種別（`GoogleAuthError.kind` / `GoogleCalendarError.kind`）が別物ゆえ、
 * ここで一方の型に固めると片側が必ず握り潰しになる。
 *
 * このモジュールは node/サーバ実行前提であり、**相対 URL の fetch を一切持たぬ**
 * （本番でもここと同じ `fetch` が走る）。
 */

/** 全 Google リクエスト共通のタイムアウト。計画書 §D-3「timeout 10s」。 */
export const GOOGLE_FETCH_TIMEOUT_MS = 10_000

export type GoogleFetchOutcome =
  | { ok: true; response: Response }
  /**
   * ネットワーク層の失敗。`aborted` は timeout 由来か否かを表すが、
   * **呼び出し側は両方とも `kind='network'` へ写すこと**（計画書 §D-5 の
   * 「ネットワーク断 / timeout」は 1 行にまとまっておる）。undici は DNS 失敗や
   * 接続断を `TypeError: fetch failed` で投げるため、`AbortError` だけを見ると
   * 恒久失敗（`unknown`）に誤分類される。
   */
  | { ok: false; aborted: boolean; message: string }

/**
 * `AbortController` + timeout 付きの fetch。
 *
 * `AbortSignal.timeout()` ではなく明示的な `AbortController` を使う（プロジェクト
 * 規約: `src/app/api/receipt-ocr/route.ts` と同じ流儀）。`clearTimeout` は
 * `finally` で必ず走らせ、成功時にタイマーがイベントループを掴み続けぬようにする。
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = GOOGLE_FETCH_TIMEOUT_MS
): Promise<GoogleFetchOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    return { ok: true, response }
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError"
    return {
      ok: false,
      aborted,
      message: err instanceof Error ? err.message : String(err),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * レスポンス body を JSON として読む（失敗しても throw せぬ）。
 *
 * Google はエラー時に HTML や空 body を返すことがあり、`res.json()` の SyntaxError で
 * 真因（HTTP status）が隠れるのを防ぐ。
 */
export async function readJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/**
 * ログへ載せてよい形にエラー body を縮める。
 *
 * **トークン・secret を絶対に載せぬ**ため、呼び出し側は「Google が返したエラー
 * 記述」だけを渡すこと。長さも切り詰める（丸ごと載せると refresh_token を含む
 * リクエストのエコーバックが紛れ込む余地を残す）。
 */
export function summarizeErrorBody(body: unknown): string | null {
  if (body === null || body === undefined) return null
  if (typeof body === "string") return body.slice(0, 300)
  const record = body as Record<string, unknown>
  const error = record.error
  const description = record.error_description
  // OAuth エンドポイントは { error, error_description }、
  // Calendar API は { error: { code, message } } を返す。
  if (typeof error === "string") {
    return [error, typeof description === "string" ? description : null]
      .filter((part): part is string => part !== null)
      .join(": ")
      .slice(0, 300)
  }
  if (error !== null && typeof error === "object") {
    const message = (error as Record<string, unknown>).message
    if (typeof message === "string") return message.slice(0, 300)
  }
  return null
}
