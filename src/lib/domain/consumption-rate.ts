import { todayJstString, toJstDateString } from "@/lib/utils/date-jst"
import type { BabyLogType } from "@/lib/types/database"

/** 消耗品レート算出の入力となるログの最小型 */
export interface ConsumptionLogInput {
  log_type: BabyLogType
  logged_at: string // ISO 8601
  amount_ml?: number | null
}

export interface ConsumptionRateConfig {
  /** 計算対象の日数（デフォルト7日） */
  windowDays: number
}

export const DEFAULT_RATE_CONFIG: ConsumptionRateConfig = {
  windowDays: 7,
}

/**
 * ウィンドウ内のログを日付別にグループ化し、
 * 「実データがある日数」を分母として日次レートを算出する。
 */
function filterLogsInWindow(
  logs: ConsumptionLogInput[],
  logType: BabyLogType,
  today: Date,
  config: ConsumptionRateConfig,
): ConsumptionLogInput[] {
  const todayStr = todayJstString(today)
  // windowDays日前の日付文字列を生成
  const [y, m, d] = todayStr.split("-").map(Number)
  const cutoffDate = new Date(Date.UTC(y, m - 1, d - config.windowDays))
  const cutoffStr = cutoffDate.toISOString().slice(0, 10)

  return logs.filter((log) => {
    if (log.log_type !== logType) return false
    const logDate = toJstDateString(log.logged_at)
    return logDate > cutoffStr && logDate <= todayStr
  })
}

/** ログ群からユニークな日付数をカウント */
function countUniqueDays(logs: ConsumptionLogInput[]): number {
  const dates = new Set(logs.map((log) => toJstDateString(log.logged_at)))
  return dates.size
}

/**
 * 指定ログタイプの1日あたりの回数を算出する（過去 windowDays 日間）。
 * おむつ交換回数の算出に使用。
 *
 * 実データがある日数を分母に使う（7日窓でも3日分のデータなら÷3）。
 * ログ0件の場合は null。
 */
export function calculateDailyRate(
  logs: ConsumptionLogInput[],
  logType: BabyLogType,
  today: Date = new Date(),
  config: Partial<ConsumptionRateConfig> = {},
): number | null {
  const mergedConfig = { ...DEFAULT_RATE_CONFIG, ...config }
  const filtered = filterLogsInWindow(logs, logType, today, mergedConfig)

  if (filtered.length === 0) return null

  const uniqueDays = countUniqueDays(filtered)
  if (uniqueDays === 0) return null

  return filtered.length / uniqueDays
}

/**
 * ミルク（feeding の bottle タイプで amount_ml あり）の1日あたり平均 ml を算出。
 * 過去 windowDays 日間。
 *
 * ログ0件の場合は null。
 */
export function calculateMilkDailyMl(
  logs: ConsumptionLogInput[],
  today: Date = new Date(),
  config: Partial<ConsumptionRateConfig> = {},
): number | null {
  const mergedConfig = { ...DEFAULT_RATE_CONFIG, ...config }
  const feedingLogs = filterLogsInWindow(logs, "feeding", today, mergedConfig)

  // amount_ml が正の値のものだけ集計
  const milkLogs = feedingLogs.filter(
    (log) => log.amount_ml != null && log.amount_ml > 0,
  )

  if (milkLogs.length === 0) return null

  const totalMl = milkLogs.reduce((sum, log) => sum + (log.amount_ml ?? 0), 0)
  const uniqueDays = countUniqueDays(milkLogs)
  if (uniqueDays === 0) return null

  return totalMl / uniqueDays
}

/**
 * 在庫数量と日次消費レートから残日数を算出。
 *
 * @returns 残日数（小数切り捨て）。dailyRate が null または 0 以下の場合は null。
 */
export function estimateRemainingDays(
  stockQuantity: number,
  dailyRate: number | null,
): number | null {
  if (dailyRate == null || dailyRate <= 0) return null
  if (stockQuantity <= 0) return 0
  return Math.floor(stockQuantity / dailyRate)
}
