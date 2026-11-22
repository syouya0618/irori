/**
 * 週の始まりは月曜。端末のローカル時刻を参照せず、サーバーのJST日付だけで扱う。
 * ?start=YYYY-MM-DD は共有できるリンクとして維持する。
 */
import { MEALS_BASE_HREF } from "@/components/chores/meals/shared/meal-routes"
import { planStartBounds } from "@/components/chores/meals/plan/plan-query"
import { isValidYmd, shiftYmd } from "@/lib/utils/date-jst"

export function mondayOf(ymd: string): string {
  if (!isValidYmd(ymd)) return ymd
  const day = new Date(`${ymd}T12:00:00Z`).getUTCDay()
  return shiftYmd(ymd, -(day === 0 ? 6 : day - 1))
}

export function resolveScheduleStart(raw: string | string[] | undefined, today: string): string {
  const start = Array.isArray(raw) ? raw[0] : raw
  const candidate = typeof start === "string" && isValidYmd(start) ? mondayOf(start) : mondayOf(today)
  const { min, max } = planStartBounds(today)
  return candidate >= min && candidate <= max ? candidate : mondayOf(today)
}

export function scheduleHref(start: string, today: string): string {
  if (start === mondayOf(today)) return MEALS_BASE_HREF
  return `${MEALS_BASE_HREF}?start=${encodeURIComponent(start)}`
}

/** 献立詳細の編集画面から、編集中の日付を含む月曜始まりの週へ戻る。
 * URLに開始日が無ければ今週へ。日付が壊れているときはその値を使わない。
 * `today` があれば今週はクエリ無しの正規URLに揃える。
 */
export function scheduleReturnHref(planStart: string | null, today?: string): string {
  if (planStart === null || !isValidYmd(planStart)) return MEALS_BASE_HREF
  const monday = mondayOf(planStart)
  return today !== undefined && isValidYmd(today)
    ? scheduleHref(monday, today)
    : `${MEALS_BASE_HREF}?start=${monday}`
}

export function scheduleWeekBounds(today: string) {
  const { min, max } = planStartBounds(today)
  return { min: mondayOf(min), max: mondayOf(max) }
}
