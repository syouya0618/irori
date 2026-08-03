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

const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * "YYYY-MM-DD" として妥当かを**厳格に**判定する（形式 + 実在日）。
 *
 * ## 正規表現だけでは足りぬ
 * `/^\d{4}-\d{2}-\d{2}$/` は `2026-02-30` や `2026-13-01` を通す。この値が
 * 下流でどう化けるかは経路ごとに違い、**どれも静かじゃ**:
 *
 * - `Date.UTC(2026, 1, 30)` は **3 月 2 日へ繰り上がる**（`parseYmd` 経由の
 *   `daysBetweenYmd` / `shiftYmd` / `weekStartMonday` がこれに乗る）
 * - `shiftYmd("garbage", -1)` は `Number("garbage")=NaN` → Invalid Date →
 *   `.toISOString()` が **`RangeError` を throw** する
 * - DATE 列への INSERT は Postgres が `22008` で弾く（＝項目エラーではなく
 *   500 になる。**失敗する層が間違っておる**）
 *
 * ## 実装の断り
 * `new Date("YYYY-MM-DD")` は UTC 罠を持つため**日付演算には使わぬ**。ここでは
 * オフセットを明示（`T00:00:00.000Z`）したうえで**妥当性判定にのみ**用い、
 * UTC で往復させて実在日を確かめる。往復が一致せねば、その日は存在せぬ。
 *
 * @returns 妥当なら true（型述語ゆえ null/undefined を絞り込める）
 */
export function isValidYmd(value: string | null | undefined): value is string {
  if (typeof value !== "string" || !YMD_PATTERN.test(value)) return false
  const probe = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(probe.getTime())) return false
  return probe.toISOString().slice(0, 10) === value
}

/**
 * "YYYY-MM-DD" 形式の文字列を数値分解する。タイムゾーンに依存しない。
 *
 * ⚠️ **形式しか見ておらぬ**（`2026-02-30` を `{y:2026,m:2,d:30}` として返す）。
 * 実在日まで要るなら呼び出し前に `isValidYmd` で締めよ。ここを厳格化すると
 * `daysBetweenYmd` / `shiftYmd` / `weekStartMonday` の返り値が一斉に変わるため、
 * 本関数は据え置き、**入口（検証層）で弾く**方針を採っておる。
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
 * YYYY-MM-DD 文字列が JST の今日より未来の日付かを返す。
 * 当日・過去・パース不能な文字列はいずれも false（未来ではない）。
 * 形式検証は呼び出し側の責務（不正文字列は false を返すため単独では弾かない）。
 *
 * 誕生日など「今日以前のみ許可」の検証に使う。サーバー(UTC)でも JST 基準で
 * 判定するため、JST 00:00〜08:59（UTC ではまだ前日）に当日を未来と誤判定しない。
 */
export function isFutureJstDate(ymd: string, now: Date = new Date()): boolean {
  const days = daysFromTodayJst(ymd, now)
  return days !== null && days > 0
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
 * かつて併走していた Flutter 版 jst_date.dart の weekStartMonday と同一セマンティクス
 * （Flutter 版は 2026-07-31 に廃止済み。この関数がその契約の唯一の担い手になった）。
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

/**
 * JST の壁時計("YYYY-MM-DD" + "HH:MM")を UTC の ISO 8601 文字列へ変換する。
 * 明示オフセット +09:00 で構築するため TZ 非依存(date-only パースの UTC 罠を回避)。
 * JST は DST が無く常に +09:00 のため安全。
 * 不変条件: toJstDateString(jstWallClockToIso(d, t)) === d。
 */
export function jstWallClockToIso(dateYmd: string, timeHm: string): string {
  return new Date(`${dateYmd}T${timeHm}:00+09:00`).toISOString()
}

// <input type="time"> の value 用フォーマッター（hourCycle="h23" を明示）。
// formatTimeJst(ja-JP) は hourCycle 未指定で ICU 既定に依存し、環境により深夜 0 時を
// "24:00" と出しうる。<input type="time"> は "24:00" を不正値として空表示するため、
// seed 専用に h23 を固定し 00:00〜23:59 を保証する。
const JST_TIME_INPUT_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

/**
 * ISO 8601 から <input type="time"> 用の JST "HH:mm"(h23 固定)を返す。
 * 深夜 0 時を "24:00" にせず "00:00"〜"23:59" の範囲を保証する（seed 専用）。
 */
export function formatJstTimeInput(iso: string): string {
  return JST_TIME_INPUT_FORMATTER.format(new Date(iso))
}

/**
 * ISO 8601 時刻が現在より許容誤差(分)を超えて未来かを返す。
 * 端末時計の微小なズレを許すため toleranceMinutes(既定 5 分)まで未来を許容する。
 * epoch ms 比較のため TZ 非依存。不正 ISO(NaN)は false（未来ではない）を返す
 * — 形式検証は呼び出し側の責務。記録時刻が未来にならないことの検証に使う。
 */
export function isFutureIso(
  iso: string,
  toleranceMinutes = 5,
  now: Date = new Date(),
): boolean {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return false
  return t > now.getTime() + toleranceMinutes * 60_000
}
