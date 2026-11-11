/**
 * "YYYY-MM-DD"（JST 暦日）の暦演算のうち、`@/lib/utils/date-jst` に無いものだけを置く中立モジュール。
 *
 * 境界指令を持たぬ純関数ゆえ、Server Component / Server Action / Client Component / SQL と対に
 * なる検証のどこからでも値 import できる。
 *
 * ## 契約
 * - **`Date` へ文字列を渡さぬ**。年・月・日の整数へ分解し、UTC の暦演算だけで計算する
 *   （`new Date("YYYY-MM-DD")` は UTC 解釈で、JST の端末と Vercel(UTC) の結果が食い違う）
 * - **不正な入力は `null`**（`daysBetweenYmd` / `weekStartMonday` と同じ規約）。形式だけでなく
 *   実在日まで見る（`2026-02-30` は null）。黙って繰り上げた日付を返さぬ
 * - 月・年の加算は**暦で数える**。30 日・365 日へ換算せぬ。存在しない日は月末へ寄せる
 *   （1/31 + 1 ヶ月 = 2/28）。寄せた結果を次の起点にすると 2/28 → 3/28 とずれ続けるため、
 *   固定周期は `anchorDay` / `anchorMonth` へ**元の基準日**を渡して毎回そこから寄せ直す
 */
import { isValidYmd, shiftYmd, weekStartMonday } from "@/lib/utils/date-jst"

interface YmdParts {
  y: number
  m: number
  d: number
}

/** 実在日だけを年・月・日へ分解する。不正なら null。 */
function partsOf(ymd: unknown): YmdParts | null {
  if (typeof ymd !== "string" || !isValidYmd(ymd)) return null
  return { y: Number(ymd.slice(0, 4)), m: Number(ymd.slice(5, 7)), d: Number(ymd.slice(8, 10)) }
}

function isYear(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 9999
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
}

function formatParts(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/**
 * 2 つの暦日の前後。`a` が前なら -1、同じ日なら 0、後なら 1。どちらかが不正なら null
 * （不正な日付を「同じ日」や「前」と言い換えぬ。並べ替えに使う前に入力を検証すること）。
 */
export function compareYmd(a: string, b: string): -1 | 0 | 1 | null {
  if (partsOf(a) === null || partsOf(b) === null) return null
  // 実在日の "YYYY-MM-DD" は桁が揃っておるゆえ、文字列の大小が暦の前後に一致する
  return a < b ? -1 : a > b ? 1 : 0
}

/** 曜日（0 = 日曜 … 6 = 土曜）。不正なら null。 */
export function weekdayOfYmd(ymd: string): 0 | 1 | 2 | 3 | 4 | 5 | 6 | null {
  const parts = partsOf(ymd)
  if (!parts) return null
  // Date.UTC は 0〜99 年を 1900 年代へ読み替えるゆえ、setUTCFullYear で年をそのまま置く
  const date = new Date(0)
  date.setUTCFullYear(parts.y, parts.m - 1, parts.d)
  return date.getUTCDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6
}

/** その月の日数（`month` は 1〜12）。年・月が範囲外・非整数なら null。 */
export function daysInMonthOf(year: number, month: number): number | null {
  if (!isYear(year) || !isIntegerIn(month, 1, 12)) return null
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

/**
 * 暦で `months` ヶ月ずらす（負なら過去へ）。その日が無い月は月末へ寄せる。
 *
 * `anchorDay`（1〜31）を渡すと、`ymd` の「日」ではなく**元の基準日の「日」**を保って寄せる:
 * `addMonthsClamped("2026-02-28", 1, 31)` は `2026-03-31`（基準が 31 日の固定周期が、2 月で
 * 28 日へ寄った後も 3 月に 31 日へ戻る）。渡さねば `ymd` の日を使う（実施日が新しい基準になる
 * 「実施から一定期間後」向け）。
 *
 * @returns ずらした暦日。入力が不正・結果が 0001〜9999 年の外なら null
 */
export function addMonthsClamped(ymd: string, months: number, anchorDay?: number): string | null {
  const parts = partsOf(ymd)
  if (!parts || typeof months !== "number" || !Number.isInteger(months)) return null
  if (anchorDay !== undefined && !isIntegerIn(anchorDay, 1, 31)) return null
  const index = parts.y * 12 + (parts.m - 1) + months
  const year = Math.floor(index / 12)
  const month = (index % 12 + 12) % 12 + 1
  const last = daysInMonthOf(year, month)
  if (last === null) return null
  return formatParts(year, month, Math.min(anchorDay ?? parts.d, last))
}

/**
 * 暦で `years` 年ずらす（負なら過去へ）。その日が無い年は月末へ寄せる（2/29 は平年 2/28）。
 *
 * `anchorMonth`（1〜12）・`anchorDay`（1〜31）を渡すと、**元の基準の月日**を保って寄せる:
 * `addYearsClamped("2025-02-28", 3, 2, 29)` は `2028-02-29`（閏日基準の年次が、平年に 2/28 へ
 * 寄った後も次の閏年で 2/29 へ戻る）。渡さねば `ymd` の月日を使う。
 *
 * @returns ずらした暦日。入力が不正・結果が 0001〜9999 年の外なら null
 */
export function addYearsClamped(
  ymd: string,
  years: number,
  anchorMonth?: number,
  anchorDay?: number,
): string | null {
  const parts = partsOf(ymd)
  if (!parts || typeof years !== "number" || !Number.isInteger(years)) return null
  if (anchorMonth !== undefined && !isIntegerIn(anchorMonth, 1, 12)) return null
  if (anchorDay !== undefined && !isIntegerIn(anchorDay, 1, 31)) return null
  const year = parts.y + years
  const month = anchorMonth ?? parts.m
  const last = daysInMonthOf(year, month)
  if (last === null) return null
  return formatParts(year, month, Math.min(anchorDay ?? parts.d, last))
}

/**
 * その暦日が属する週（月〜日）の日曜を返す。`weekStartMonday` と対になる（日曜は同じ週の末尾）。
 * 不正なら null。
 */
export function weekEndSunday(ymd: string): string | null {
  if (partsOf(ymd) === null) return null
  const monday = weekStartMonday(ymd)
  return monday === null ? null : shiftYmd(monday, 6)
}
