/**
 * 予定画面の表示文言を組み立てる純関数（境界指令を持たぬ中立モジュール）。
 *
 * - すべて "YYYY-MM-DD" の文字列演算と `Date.UTC` で曜日を出す。
 *   `new Date("YYYY-MM-DD")` は使わぬ（UTC 罠: CLAUDE.md）。
 * - 時刻は既存の JST 整形（`formatTimeJst`）だけを使う。真値は変えぬ。
 * - 不正な入力では throw せず `null` / 素の値へ退化させる（画面を倒さぬ）。
 */
import { formatTimeJst } from "@/lib/utils/date-jst"
import {
  generateRecurrenceDates,
  type RecurrenceRepeat,
} from "@/lib/domain/calendar-recurrence"

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"] as const

function parseYmd(ymd: string): { y: number; m: number; d: number } | null {
  const match = YMD_RE.exec(ymd)
  if (!match) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  const t = new Date(Date.UTC(y, m - 1, d))
  // 2026-02-31 のような繰り上がりは不正として退化させる
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    return null
  }
  return { y, m, d }
}

/** "YYYY-MM-DD" の曜日（"土" など）。不正なら null。 */
export function weekdayJa(ymd: string): string | null {
  const p = parseYmd(ymd)
  if (!p) return null
  return WEEKDAYS_JA[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()]
}

/** "YYYY-MM-DD" → "10月24日（土）"。不正なら入力をそのまま返す。 */
export function formatDayJa(ymd: string): string {
  const p = parseYmd(ymd)
  const w = weekdayJa(ymd)
  if (!p || !w) return ymd
  return `${p.m}月${p.d}日（${w}）`
}

/** "YYYY-MM-DD" → "10/24"。不正なら入力をそのまま返す。 */
export function formatShortDay(ymd: string): string {
  const p = parseYmd(ymd)
  return p ? `${p.m}/${p.d}` : ymd
}

/** start〜end（両端含む）の日数。不正・逆転なら null。 */
export function spanDays(startYmd: string, endYmd: string): number | null {
  const a = parseYmd(startYmd)
  const b = parseYmd(endYmd)
  if (!a || !b) return null
  const diff =
    (Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000
  return diff < 0 ? null : diff + 1
}

/** 日付ごと表示に使う最小の予定形。 */
export interface EventWhenInput {
  is_all_day: boolean
  start_date: string
  end_date: string
  start_at: string | null
  end_at: string | null
}

function safeTime(iso: string | null): string | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return formatTimeJst(iso)
}

/**
 * 予定の日時を 1 行で言う。
 * - 終日単日: 「10月24日（土）・終日」
 * - 終日多日: 「10月23日（金）〜10月26日（月）・終日（4日間）」
 * - 時刻付き単日: 「10月24日（土）10:00〜11:00」
 * - 時刻付き多日: 「10月24日（土）22:00〜10月25日（日）2:00」
 */
export function eventWhenLabel(e: EventWhenInput): string {
  const start = formatDayJa(e.start_date)
  const multiDay = e.end_date !== e.start_date
  if (e.is_all_day) {
    if (!multiDay) return `${start}・終日`
    const days = spanDays(e.start_date, e.end_date)
    const span = days ? `（${days}日間）` : ""
    return `${start}〜${formatDayJa(e.end_date)}・終日${span}`
  }
  const startTime = safeTime(e.start_at)
  const endTime = safeTime(e.end_at)
  const head = startTime ? `${start}${startTime}` : start
  if (!endTime) return head
  return multiDay
    ? `${head}〜${formatDayJa(e.end_date)}${endTime}`
    : `${head}〜${endTime}`
}

/**
 * 複数日にまたがる予定の「何日目か」。単日・不正値は null。
 * 例: 10/23〜10/26 の予定を 10/24 に見ると { day: 2, total: 4 }。
 */
export function multiDayProgress(
  e: Pick<EventWhenInput, "start_date" | "end_date">,
  dateYmd: string,
): { day: number; total: number } | null {
  if (e.start_date === e.end_date) return null
  const total = spanDays(e.start_date, e.end_date)
  const day = spanDays(e.start_date, dateYmd)
  if (!total || !day || day > total) return null
  return { day, total }
}

const REPEAT_LABELS: Record<RecurrenceRepeat, string> = {
  daily: "毎日",
  weekly: "毎週",
  monthly: "毎月",
}

/**
 * 繰り返しの予告（作成前の確認用）。
 * 例: 「毎週土曜日・12月26日（土）まで・全10回」
 *
 * 回数はサーバが展開に使うのと**同じ純関数**（generateRecurrenceDates）で数える。
 * 入力が未完成・範囲外で throw したときは null（予告を出さず、保存時の検証に委ねる）。
 */
export function repeatSummary(
  startDate: string,
  repeat: RecurrenceRepeat,
  until: string,
): string | null {
  if (!parseYmd(startDate) || !parseYmd(until)) return null
  let count: number
  try {
    count = generateRecurrenceDates(startDate, repeat, until).length
  } catch {
    // 期間外・逆転は保存前検証が文言付きで止める。ここは予告を出さぬだけ。
    return null
  }
  const p = parseYmd(startDate)
  const w = weekdayJa(startDate)
  const rule =
    repeat === "weekly" && w
      ? `毎週${w}曜日`
      : repeat === "monthly" && p
        ? `毎月${p.d}日`
        : REPEAT_LABELS[repeat]
  return `${rule}・${formatDayJa(until)}まで・全${count}回`
}
