import { shiftYmd, weekStartMonday, todayJstString } from "@/lib/utils/date-jst"
import type { CalendarEventSource } from "@/lib/types/database"

export interface CalendarGridCell {
  date: string // YYYY-MM-DD (JST)
  inMonth: boolean // false = 前月/翌月の埋め日
  isToday: boolean
}

/** カレンダーで扱う最小イベント形(グリッド/アジェンダ用) */
export interface CalendarEventLite {
  id: string
  title: string
  is_all_day: boolean
  start_date: string // YYYY-MM-DD
  end_date: string // YYYY-MM-DD (inclusive)
  start_at: string | null // ISO
  source: CalendarEventSource
}

/** "YYYY-MM-DD" | "YYYY-MM" を当月 1 日の "YYYY-MM-01" へ正規化 */
export function monthFirstOf(ymdOrMonth: string): string {
  return `${ymdOrMonth.slice(0, 7)}-01`
}

/** JST の今日が属する月の 1 日 "YYYY-MM-01" */
export function currentMonthFirstJst(now: Date = new Date()): string {
  return monthFirstOf(todayJstString(now))
}

/** 月を delta ヶ月シフト(年跨ぎ対応・TZ 非依存の整数演算) */
export function shiftMonth(monthFirstYmd: string, delta: number): string {
  const [y, m] = monthFirstYmd.split("-").map(Number)
  const total = y * 12 + (m - 1) + delta
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  return `${ny}-${String(nm).padStart(2, "0")}-01`
}

/**
 * 月グリッド(月曜始まり・常に 6 週 × 7 日 = 42 セル)を生成。
 * 高さ固定でレイアウトシフトを防ぐ。全て文字列演算で TZ 非依存。
 */
export function buildMonthGrid(
  monthFirstYmd: string,
  todayYmd: string,
): CalendarGridCell[][] {
  const first = monthFirstOf(monthFirstYmd)
  const gridStart = weekStartMonday(first)
  if (gridStart === null) {
    throw new Error(`buildMonthGrid: 不正な月 ${monthFirstYmd}`)
  }
  const month = first.slice(0, 7)
  const weeks: CalendarGridCell[][] = []
  for (let w = 0; w < 6; w++) {
    const row: CalendarGridCell[] = []
    for (let d = 0; d < 7; d++) {
      const date = shiftYmd(gridStart, w * 7 + d)
      row.push({
        date,
        inMonth: date.slice(0, 7) === month,
        isToday: date === todayYmd,
      })
    }
    weeks.push(row)
  }
  return weeks
}

/** イベントが指定日に重なるか(YYYY-MM-DD の辞書順比較で日付順として正しい) */
export function eventOverlapsDate(
  ev: CalendarEventLite,
  dateYmd: string,
): boolean {
  return ev.start_date <= dateYmd && ev.end_date >= dateYmd
}

/** 同一日内の並び: 終日を先頭 → 時刻付きは start_at 昇順 → タイトル(ja) */
export function sortDayEvents(
  a: CalendarEventLite,
  b: CalendarEventLite,
): number {
  if (a.is_all_day !== b.is_all_day) return a.is_all_day ? -1 : 1
  const at = a.start_at ?? ""
  const bt = b.start_at ?? ""
  if (at !== bt) return at < bt ? -1 : 1
  return a.title.localeCompare(b.title, "ja")
}

/** 指定日に重なるイベントを整列して返す */
export function eventsForDate(
  events: readonly CalendarEventLite[],
  dateYmd: string,
): CalendarEventLite[] {
  return events.filter((e) => eventOverlapsDate(e, dateYmd)).sort(sortDayEvents)
}

/** グリッド範囲 [gridStart, gridEnd] の各日 → イベント配列 の Map */
export function bucketEventsByDate(
  events: readonly CalendarEventLite[],
  gridStart: string,
  gridEnd: string,
): Map<string, CalendarEventLite[]> {
  const map = new Map<string, CalendarEventLite[]>()
  for (let date = gridStart; date <= gridEnd; date = shiftYmd(date, 1)) {
    map.set(date, eventsForDate(events, date))
  }
  return map
}
