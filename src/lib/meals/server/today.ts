/**
 * ごはんの画面と Server Action が共有する「今日」と日付範囲。
 *
 * 境界指令を持たない中立モジュール（カタログも Supabase も import しない）。
 * 日付は JST 暦日の "YYYY-MM-DD" 文字列だけで扱う（`new Date("YYYY-MM-DD")` を使わない）。
 * 不正な入力は throw せず null を返す。
 *
 * Client Component で「今日」を使うときは、描画中に `mealToday()` を直接呼ばず
 * `useNow()` の値を渡すこと（React Compiler が描画中の壁時計の読み取りを凍結する）。
 */

import { weekdayOfYmd } from "@/lib/domain/ymd-math"
import { daysBetweenYmd, isValidYmd, shiftYmd, todayJstString } from "@/lib/utils/date-jst"

/** 献立をまとめて作る日数の範囲（`planner.ts` の `MIN_PLAN_DAYS` / `MAX_PLAN_DAYS` と同じ）。 */
export const MEAL_RANGE_MIN_DAYS = 1
export const MEAL_RANGE_MAX_DAYS = 7

/** 食後評価を好みへ反映する期間（日）。 */
export const FEEDBACK_WINDOW_DAYS = 180

/** 重複回避のために遡って読む献立の日数。 */
export const PLAN_HISTORY_DAYS = 14

/** JST の今日。Server Component / Server Action 用（テストは `now` を渡す）。 */
export function mealToday(now: Date = new Date()): string {
  return todayJstString(now)
}

export interface MealDateRange {
  /** 両端を含む。 */
  from: string
  to: string
  dates: string[]
}

/** `from` から `days` 日ぶん（両端を含む）。開始日が不正・日数が 1〜7 の整数でなければ null。 */
export function mealDateRange(from: string, days: number): MealDateRange | null {
  if (!isValidYmd(from)) return null
  if (!Number.isInteger(days) || days < MEAL_RANGE_MIN_DAYS || days > MEAL_RANGE_MAX_DAYS) return null
  const dates = Array.from({ length: days }, (_, index) => shiftYmd(from, index))
  return { from, to: dates[dates.length - 1], dates }
}

/** 今日から `days` 日ぶん。 */
export function mealRangeFromToday(days: number, today: string = mealToday()): MealDateRange | null {
  return mealDateRange(today, days)
}

/** `ymd` の `days` 日前（0 以上の整数）。不正なら null。 */
export function daysBefore(ymd: string, days: number): string | null {
  if (!isValidYmd(ymd) || !Number.isInteger(days) || days < 0) return null
  return shiftYmd(ymd, -days)
}

/** 食後評価を読む範囲の開始日（今日を含めて 180 日ぶん遡った日）。 */
export function feedbackWindowStart(today: string): string | null {
  return daysBefore(today, FEEDBACK_WINDOW_DAYS)
}

/** 両端を含む範囲に入るか。どれかが不正なら false。 */
export function isWithinRange(ymd: string, from: string, to: string): boolean {
  if (!isValidYmd(ymd) || !isValidYmd(from) || !isValidYmd(to)) return false
  return ymd >= from && ymd <= to
}

/** `today` から見て何日後か（今日 = 0、明日 = 1、昨日 = -1）。不正なら null。 */
export function daysFrom(today: string, ymd: string): number | null {
  if (!isValidYmd(today) || !isValidYmd(ymd)) return null
  return daysBetweenYmd(today, ymd)
}

/** 曜日の 1 文字（日曜始まり）。 */
export const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const
export type WeekdayLabel = (typeof WEEKDAY_LABELS)[number]

/** 曜日の 1 文字。不正な日付は null。 */
export function weekdayLabel(ymd: string): WeekdayLabel | null {
  const weekday = weekdayOfYmd(ymd)
  return weekday === null ? null : WEEKDAY_LABELS[weekday]
}
