import { addDays, formatDateKey } from "@/lib/utils/date"
import { todayJstString } from "@/lib/utils/date-jst"

export const DAY_NAMES = ["月", "火", "水", "木", "金", "土", "日"]

export function formatDayHeader(d: Date): string {
  const formatter = new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
  })
  const dayOfWeek = DAY_NAMES[(d.getDay() + 6) % 7]
  return `${formatter.format(d)}（${dayOfWeek}）`
}

export function formatWeekRange(monday: Date): string {
  const sunday = addDays(monday, 6)
  const f = new Intl.DateTimeFormat("ja-JP", {
    month: "long",
    day: "numeric",
  })
  return `${f.format(monday)}\u301C${f.format(sunday)}`
}

export function isToday(d: Date): boolean {
  // JST 固定: SSR (UTC) とクライアントで同一判定になり hydration 不整合を防ぐ
  return formatDateKey(d) === todayJstString()
}
