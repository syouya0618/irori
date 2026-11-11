/**
 * 献立の画面（/chores/meals/plan）の query の綴りと、表示する期間の決め方（正本）。
 *
 * 境界指令を持たない中立モジュール（Server Component の page・Client Component・テストの
 * どこからでも値 import できる）。日付は JST 暦日の "YYYY-MM-DD" だけで扱う。
 *
 * 画面は「開始日から 7 日ぶん」を表示する。開始日は URL に持つ（再読み込み・他端末の反映で
 * 同じ期間を読み直せる）。作る日数（1〜7）は URL に持たない — 作成の操作の入力で、表示の期間は変えない。
 */

import { MEALS_PLAN_HREF } from "@/components/chores/meals/shared/meal-routes"
import { DINNER_ENTRY_PAST_DAYS, DINNER_PLAN_START_MAX_AHEAD_DAYS } from "@/lib/meals/server/plan-requests"
import { isValidYmd, shiftYmd } from "@/lib/utils/date-jst"

export const PLAN_START_PARAM = "start"

/** 画面に並べる日数（開始日から）。 */
export const PLAN_VIEW_DAYS = 7

/** 表示できる開始日の範囲（過ぎた日は記録のため、先の日は作成のため）。 */
export function planStartBounds(today: string): { min: string; max: string } {
  return { min: shiftYmd(today, -DINNER_ENTRY_PAST_DAYS), max: shiftYmd(today, DINNER_PLAN_START_MAX_AHEAD_DAYS) }
}

/**
 * query の開始日を解決する。無い・不正・範囲外は**今日**（壊れた URL で画面を倒さない）。
 * 配列（`?start=a&start=b`）は最初の値だけを見る。
 */
export function resolvePlanStart(raw: string | string[] | undefined, today: string): string {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== "string" || !isValidYmd(value)) return today
  const { min, max } = planStartBounds(today)
  return value < min || value > max ? today : value
}

/** 献立の画面の href。開始日が今日（既定）なら query を付けない。 */
export function planHref(start: string | null, today: string | null = null): string {
  if (start === null || !isValidYmd(start) || start === today) return MEALS_PLAN_HREF
  return `${MEALS_PLAN_HREF}?${PLAN_START_PARAM}=${start}`
}

/** 作成の開始日に選べる日（今日から、開始の上限まで）。 */
export function planStartOptions(today: string): string[] {
  return Array.from({ length: DINNER_PLAN_START_MAX_AHEAD_DAYS + 1 }, (_, index) => shiftYmd(today, index))
}
