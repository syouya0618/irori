import { toJstDateString, formatTimeJst } from "@/lib/utils/date-jst"
import { minutesBetween } from "@/lib/utils/baby-log-labels"
import type { BabyLogType, FeedingType, DiaperType } from "@/lib/types/database"

/** 集計に必要な最小ログ型 */
export interface AggregationLogInput {
  log_type: BabyLogType
  logged_at: string
  feeding_type: FeedingType | null
  amount_ml: number | null
  diaper_type: DiaperType | null
  ended_at: string | null
  temperature: number | null
  weight_g: number | null
  height_cm: number | null
}

export interface DailyFeedingSummary {
  date: string
  totalCount: number
  breastCount: number
  bottleCount: number
  solidCount: number
  totalBottleMl: number
  avgBottleMl: number | null
}

export interface DailySleepSummary {
  date: string
  totalMinutes: number
  sessionCount: number
}

export interface DailyDiaperSummary {
  date: string
  totalCount: number
  peeCount: number
  poopCount: number
  bothCount: number
}

export interface TemperatureRecord {
  date: string
  time: string
  temperature: number
}

export interface GrowthRecord {
  date: string
  weightG: number | null
  heightCm: number | null
}

/** log_type + JST 日付範囲でフィルタ */
function filterLogs(
  logs: AggregationLogInput[],
  logType: BabyLogType,
  startDate: string,
  endDate: string,
): AggregationLogInput[] {
  return logs.filter((log) => {
    if (log.log_type !== logType) return false
    const d = toJstDateString(log.logged_at)
    return d >= startDate && d <= endDate
  })
}

/** ログを JST 日付でグループ化 */
function groupByDate(
  logs: AggregationLogInput[],
): Map<string, AggregationLogInput[]> {
  const map = new Map<string, AggregationLogInput[]>()
  for (const log of logs) {
    const d = toJstDateString(log.logged_at)
    const list = map.get(d) ?? []
    list.push(log)
    map.set(d, list)
  }
  return map
}

/** Map のキーを昇順ソートして返す */
function sortedDates(map: Map<string, unknown>): string[] {
  return [...map.keys()].sort()
}

export function aggregateFeedings(
  logs: AggregationLogInput[],
  startDate: string,
  endDate: string,
): DailyFeedingSummary[] {
  const filtered = filterLogs(logs, "feeding", startDate, endDate)
  const grouped = groupByDate(filtered)

  return sortedDates(grouped).map((date) => {
    const dayLogs = grouped.get(date)!
    let breastCount = 0
    let bottleCount = 0
    let solidCount = 0
    let totalBottleMl = 0

    for (const log of dayLogs) {
      if (log.feeding_type === "breast_left" || log.feeding_type === "breast_right") {
        breastCount++
      } else if (log.feeding_type === "bottle") {
        bottleCount++
        if (log.amount_ml != null && log.amount_ml > 0) {
          totalBottleMl += log.amount_ml
        }
      } else if (log.feeding_type === "solid") {
        solidCount++
      }
    }

    return {
      date,
      totalCount: dayLogs.length,
      breastCount,
      bottleCount,
      solidCount,
      totalBottleMl,
      avgBottleMl: bottleCount > 0 ? Math.round(totalBottleMl / bottleCount) : null,
    }
  })
}

export function aggregateSleep(
  logs: AggregationLogInput[],
  startDate: string,
  endDate: string,
): DailySleepSummary[] {
  const filtered = filterLogs(logs, "sleep", startDate, endDate)
  const grouped = groupByDate(filtered)

  return sortedDates(grouped).map((date) => {
    const dayLogs = grouped.get(date)!
    let totalMinutes = 0
    let sessionCount = 0

    for (const log of dayLogs) {
      if (log.ended_at) {
        totalMinutes += minutesBetween(log.logged_at, log.ended_at)
        sessionCount++
      }
    }

    return { date, totalMinutes, sessionCount }
  })
}

export function aggregateDiapers(
  logs: AggregationLogInput[],
  startDate: string,
  endDate: string,
): DailyDiaperSummary[] {
  const filtered = filterLogs(logs, "diaper", startDate, endDate)
  const grouped = groupByDate(filtered)

  return sortedDates(grouped).map((date) => {
    const dayLogs = grouped.get(date)!
    let peeCount = 0
    let poopCount = 0
    let bothCount = 0

    for (const log of dayLogs) {
      if (log.diaper_type === "pee") peeCount++
      else if (log.diaper_type === "poop") poopCount++
      else if (log.diaper_type === "both") bothCount++
    }

    return {
      date,
      totalCount: dayLogs.length,
      peeCount,
      poopCount,
      bothCount,
    }
  })
}

export function extractTemperatures(
  logs: AggregationLogInput[],
  startDate: string,
  endDate: string,
): TemperatureRecord[] {
  return filterLogs(logs, "temperature", startDate, endDate)
    .filter((log) => log.temperature != null)
    .sort((a, b) => a.logged_at.localeCompare(b.logged_at))
    .map((log) => ({
      date: toJstDateString(log.logged_at),
      time: formatTimeJst(log.logged_at),
      temperature: log.temperature!,
    }))
}

export function extractGrowth(
  logs: AggregationLogInput[],
  startDate: string,
  endDate: string,
): GrowthRecord[] {
  return filterLogs(logs, "growth", startDate, endDate)
    .filter((log) => log.weight_g != null || log.height_cm != null)
    .sort((a, b) => a.logged_at.localeCompare(b.logged_at))
    .map((log) => ({
      date: toJstDateString(log.logged_at),
      weightG: log.weight_g,
      heightCm: log.height_cm,
    }))
}

/**
 * 生年月日から月齢文字列を算出。
 * @param birthDate "YYYY-MM-DD"
 * @param referenceDate "YYYY-MM-DD"
 */
export function calculateAge(birthDate: string, referenceDate: string): string {
  const [by, bm, bd] = birthDate.split("-").map(Number)
  const [ry, rm, rd] = referenceDate.split("-").map(Number)

  let months = (ry - by) * 12 + (rm - bm)
  if (rd < bd) months--
  if (months < 0) return "0ヶ月"

  const years = Math.floor(months / 12)
  const remainMonths = months % 12

  if (years === 0) return `${remainMonths}ヶ月`
  if (remainMonths === 0) return `${years}歳`
  return `${years}歳${remainMonths}ヶ月`
}
