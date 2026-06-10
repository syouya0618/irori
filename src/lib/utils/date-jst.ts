/**
 * JST（Asia/Tokyo）に基づく日付ユーティリティ。
 *
 * JavaScript の new Date("YYYY-MM-DD") はUTCで解釈されるため、
 * Vercel (UTC) とクライアント (JST) で結果が食い違う。
 * このモジュールは文字列レベルで日付を扱い、
 * タイムゾーン非依存で日数差を計算する。
 *
 * 関連する学習記録:
 * - [HIGH] Date.getDate()/getMonth()のタイムゾーン依存
 * - [RECURRING] 日付パースのUTC問題
 */

// Intl.DateTimeFormat インスタンスはモジュールスコープで1回だけ生成する。
// new ごとのコンストラクタコスト（ICU ロード含む）を避けるため。
const JST_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

/**
 * 現在のJST日付を "YYYY-MM-DD" 形式で返す。
 * サーバー(UTC)でもクライアント(JST)でも同じ値を返す。
 */
export function todayJstString(now: Date = new Date()): string {
  return JST_FORMATTER.format(now)
}

/**
 * "YYYY-MM-DD" 形式の文字列を数値分解する。タイムゾーンに依存しない。
 */
function parseYmd(ymd: string): { y: number; m: number; d: number } | null {
  const pattern = /^(\d{4})-(\d{2})-(\d{2})$/
  const match = pattern.test(ymd) ? ymd.split("-").map(Number) : null
  if (!match || match.length !== 3) return null
  return { y: match[0], m: match[1], d: match[2] }
}

/**
 * 2つの YYYY-MM-DD 文字列の日数差を返す（to - from）。
 * タイムゾーンに一切依存しない。
 *
 * @returns 日数差（正なら to が未来、負なら過去）。パース失敗時は null。
 */
export function daysBetweenYmd(fromYmd: string, toYmd: string): number | null {
  const from = parseYmd(fromYmd)
  const to = parseYmd(toYmd)
  if (!from || !to) return null

  // Date.UTC はタイムゾーン非依存の Unix ms を返す
  const fromMs = Date.UTC(from.y, from.m - 1, from.d)
  const toMs = Date.UTC(to.y, to.m - 1, to.d)

  return Math.round((toMs - fromMs) / (1000 * 60 * 60 * 24))
}

/**
 * 指定された YYYY-MM-DD 文字列が今日 (JST) から何日後かを返す。
 * 期限切れは負の値、当日は 0、未来は正の値。
 */
export function daysFromTodayJst(
  targetYmd: string,
  now: Date = new Date(),
): number | null {
  return daysBetweenYmd(todayJstString(now), targetYmd)
}

/**
 * YYYY-MM-DD 文字列を指定日数シフトする。タイムゾーン非依存。
 */
export function shiftYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  return dt.toISOString().slice(0, 10)
}

/**
 * YYYY-MM-DD 文字列が属する週の月曜日を YYYY-MM-DD で返す。
 * タイムゾーンに一切依存しない（Date.UTC + getUTCDay のみ使用）。
 * 日曜は「進行中の週の末尾」として同週の月曜に丸める —
 * flutter/lib/core/utils/jst_date.dart の weekStartMonday と同一セマンティクス。
 *
 * @returns 月曜の YYYY-MM-DD。パース失敗時は null（daysBetweenYmd と同じ規約）。
 */
export function weekStartMonday(ymd: string): string | null {
  const parsed = parseYmd(ymd)
  if (!parsed) return null
  const day = new Date(
    Date.UTC(parsed.y, parsed.m - 1, parsed.d)
  ).getUTCDay() // 0 = 日曜
  return shiftYmd(ymd, day === 0 ? -6 : 1 - day)
}

/**
 * JST の今日が属する週（月〜日）の範囲を YYYY-MM-DD で返す。
 * サーバー (UTC) でもクライアント (JST) でも同じ週を返す。
 */
export function currentWeekRangeJst(now: Date = new Date()): {
  startDate: string
  endDate: string
} {
  const monday = weekStartMonday(todayJstString(now))
  // todayJstString (en-CA) の出力は常に YYYY-MM-DD のため null は到達不能だが、
  // 万一 Intl の挙動が変わった場合に silent な前週表示ではなく
  // エラーとして顕在化させるため throw で防御する。
  if (monday === null) {
    throw new Error(
      "currentWeekRangeJst: todayJstString が YYYY-MM-DD を返しませんでした"
    )
  }
  return { startDate: monday, endDate: shiftYmd(monday, 6) }
}

// JST 時刻フォーマッター（モジュールスコープで1回だけ生成）
const JST_TIME_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
})

/**
 * ISO 8601 文字列から JST の "HH:MM" を返す。
 */
export function formatTimeJst(iso: string): string {
  return JST_TIME_FORMATTER.format(new Date(iso))
}

/**
 * ISO 8601 タイムスタンプから JST の "YYYY-MM-DD" 日付文字列を返す。
 * Realtime イベントの日付フィルタリング等に使用。
 */
export function toJstDateString(iso: string): string {
  return JST_FORMATTER.format(new Date(iso))
}
