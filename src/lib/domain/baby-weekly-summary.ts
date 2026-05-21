import { shiftYmd, toJstDateString } from "@/lib/utils/date-jst"
import type { BabyLogType } from "@/lib/types/database"

export interface BabyWeeklySummaryLogInput {
  log_type: BabyLogType
  logged_at: string
  ended_at: string | null
}

export interface BabyWeeklySummaryDay {
  date: string
  feedingCount: number
  diaperCount: number
  sleepMinutes: number
}

/**
 * 週間サマリーの棒グラフ y 軸スケールの最低基準値（baseline）。
 *
 * 疎データ（例: 6日ゼロ・1日だけ授乳1回）でローカル最大値正規化すると
 * 「1回」が画面いっぱいに伸び誤認を招くため、最低スケールを設ける。
 * データがこの値を上回ればグラフは伸びる（BarChart 側で
 * `Math.max(maxValue ?? 0, ...data values, 1)` を計算）。
 *
 * これらは Issue #15 由来の暫定デフォルト値であり、実運用後に
 * ユーザーのフィードバックを踏まえて再調整する想定。
 */
export const WEEKLY_CHART_BASELINE = {
  feedingCount: 8, // 授乳: 一日の目安上限（回）
  diaperCount: 10, // おむつ: 一日の目安上限（回）
  sleepMinutes: 840, // 睡眠: 14時間 = 840分
} as const

function createEmptyDay(date: string): BabyWeeklySummaryDay {
  return {
    date,
    feedingCount: 0,
    diaperCount: 0,
    sleepMinutes: 0,
  }
}

function jstDayStartMs(date: string): number {
  return new Date(`${date}T00:00:00+09:00`).getTime()
}

function addSleepMinutesByDay(
  day: BabyWeeklySummaryDay,
  sleepStartMs: number,
  sleepEndMs: number,
) {
  const dayStartMs = jstDayStartMs(day.date)
  const dayEndMs = jstDayStartMs(shiftYmd(day.date, 1))
  const overlapMs =
    Math.min(sleepEndMs, dayEndMs) - Math.max(sleepStartMs, dayStartMs)

  if (overlapMs > 0) {
    day.sleepMinutes += Math.round(overlapMs / 60000)
  }
}

export function buildBabyWeeklySummary(
  logs: BabyWeeklySummaryLogInput[],
  endDate: string,
  days = 7,
): BabyWeeklySummaryDay[] {
  if (days <= 0) return []

  const startDate = shiftYmd(endDate, -(days - 1))
  const byDate = new Map<string, BabyWeeklySummaryDay>()

  for (let i = 0; i < days; i++) {
    const date = shiftYmd(startDate, i)
    byDate.set(date, createEmptyDay(date))
  }

  for (const log of logs) {
    if (log.log_type === "sleep" && log.ended_at) {
      const sleepStartMs = new Date(log.logged_at).getTime()
      const sleepEndMs = new Date(log.ended_at).getTime()
      if (sleepEndMs <= sleepStartMs) continue

      for (const day of byDate.values()) {
        addSleepMinutesByDay(day, sleepStartMs, sleepEndMs)
      }
    } else if (log.log_type === "feeding") {
      const date = toJstDateString(log.logged_at)
      const day = byDate.get(date)
      if (!day) continue
      day.feedingCount++
    } else if (log.log_type === "diaper") {
      const date = toJstDateString(log.logged_at)
      const day = byDate.get(date)
      if (!day) continue
      day.diaperCount++
    }
  }

  return [...byDate.values()]
}

export function totalBabyWeeklySummary(days: BabyWeeklySummaryDay[]) {
  return days.reduce(
    (total, day) => ({
      feedingCount: total.feedingCount + day.feedingCount,
      diaperCount: total.diaperCount + day.diaperCount,
      sleepMinutes: total.sleepMinutes + day.sleepMinutes,
    }),
    { feedingCount: 0, diaperCount: 0, sleepMinutes: 0 },
  )
}
