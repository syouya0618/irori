import {
  toJstDateString,
  formatTimeJst,
  daysBetweenYmd,
} from "@/lib/utils/date-jst"
import type { BabyLogType, FeedingType, DiaperType } from "@/lib/types/database"

/** 集計に必要な最小ログ型 */
export interface AggregationLogInput {
  log_type: BabyLogType
  logged_at: string
  feeding_type: FeedingType | null
  amount_ml: number | null
  diaper_type: DiaperType | null
  temperature: number | null
  weight_g: number | null
  height_cm: number | null
}

/**
 * 母乳系の授乳種別か。'breast'（サイクル行）と、移行前の片側行
 * breast_left / breast_right を同じバケットへ集約する。
 *
 * 片側行は本来「1サイクルの片側」だが、DB にサイクル境界の情報が無く復元できない
 * ため 1 行 = 1 回として近似する。移行後は 'breast' のみが生成される。
 */
function isBreastFeedingType(type: FeedingType | null): boolean {
  return (
    type === "breast" || type === "breast_left" || type === "breast_right"
  )
}

export interface DailyFeedingSummary {
  date: string
  totalCount: number
  breastCount: number
  bottleCount: number
  solidCount: number
  /** 搾乳（pumped）の回数。母乳/ミルク/離乳食とは独立に集計する */
  pumpedCount: number
  totalBottleMl: number
  avgBottleMl: number | null
  /** 搾乳の総量・平均（ml）。ミルクとは別に持つ */
  totalPumpedMl: number
  avgPumpedMl: number | null
}

export interface DailyDiaperSummary {
  date: string
  totalCount: number
  peeCount: number
  poopCount: number
  bothCount: number
}

export interface DiaperBreakdown {
  /** おしっこ（pee + both）の回数 */
  peeCount: number
  /** うんち（poop + both）の回数 */
  poopCount: number
}

/**
 * aggregateDiapers の日別出力（複数日ぶん）から、pee/poop の内訳合計を導出する。
 * both は両方に加算されるため、`peeCount + poopCount` は交換回数合計（totalCount の
 * 総和）を超えうる（「今日のまとめ」「週間サマリー」の2値表示で共通利用）。
 */
export function sumDiaperBreakdown(
  diapers: Pick<DailyDiaperSummary, "peeCount" | "poopCount" | "bothCount">[],
): DiaperBreakdown {
  return diapers.reduce<DiaperBreakdown>(
    (total, day) => ({
      peeCount: total.peeCount + day.peeCount + day.bothCount,
      poopCount: total.poopCount + day.poopCount + day.bothCount,
    }),
    { peeCount: 0, poopCount: 0 },
  )
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
    let pumpedCount = 0
    let totalBottleMl = 0
    let totalPumpedMl = 0

    for (const log of dayLogs) {
      if (isBreastFeedingType(log.feeding_type)) {
        // 'breast' はサイクル行（1行 = 1回の授乳）。移行前の片側行
        // breast_left/breast_right も同じバケットへ集約する（→ isBreastFeedingType）。
        breastCount++
      } else if (log.feeding_type === "bottle") {
        bottleCount++
        if (log.amount_ml != null && log.amount_ml > 0) {
          totalBottleMl += log.amount_ml
        }
      } else if (log.feeding_type === "pumped") {
        // 搾乳は母乳を哺乳瓶で与える volumetric な授乳。ミルクとは別バケットで
        // 回数・総量を集計する（PDF レポートで独立列として表示するため）。
        // enum 全6値（breast / breast_left / breast_right / bottle / solid / pumped）を
        // 網羅するので breast+bottle+solid+pumped === totalCount が保たれる。
        pumpedCount++
        if (log.amount_ml != null && log.amount_ml > 0) {
          totalPumpedMl += log.amount_ml
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
      pumpedCount,
      totalBottleMl,
      avgBottleMl: bottleCount > 0 ? Math.round(totalBottleMl / bottleCount) : null,
      totalPumpedMl,
      avgPumpedMl: pumpedCount > 0 ? Math.round(totalPumpedMl / pumpedCount) : null,
    }
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

export interface GrowthPoint {
  date: string
  value: number
}

export interface GrowthSeries {
  /** 体重 (g) の時系列（logged_at 昇順） */
  weight: GrowthPoint[]
  /** 身長 (cm) の時系列（logged_at 昇順） */
  height: GrowthPoint[]
}

/**
 * 成長曲線用に、体重(g)と身長(cm)を独立した時系列に分離する。
 * 体重のみ・身長のみのログはそれぞれの系列にのみ入る。
 */
export function buildGrowthSeries(
  logs: AggregationLogInput[],
  startDate: string,
  endDate: string,
): GrowthSeries {
  const records = extractGrowth(logs, startDate, endDate)
  const weight: GrowthPoint[] = []
  const height: GrowthPoint[] = []
  for (const r of records) {
    if (r.weightG != null) weight.push({ date: r.date, value: r.weightG })
    if (r.heightCm != null) height.push({ date: r.date, value: r.heightCm })
  }
  return { weight, height }
}

export interface TodayCounts {
  feedingCount: number
  diaperCount: number
  /** おしっこ（pee + both）の当日回数 */
  peeCount: number
  /** うんち（poop + both）の当日回数 */
  poopCount: number
  /**
   * 母乳サイクルの当日回数（feeding_type が 'breast' / 'breast_left' /
   * 'breast_right' の行数）。
   *
   * 移行前の片側行は「1サイクルの片側」ゆえ本来 2 行で 1 サイクルだが、DB に
   * サイクル境界の情報が無く復元できないため 1 行 = 1 回として**近似**する
   * （移行日を挟む日だけ回数が実際より多く出うる。移行後の日は正確）。
   */
  breastCycleCount: number
  /** ミルク（bottle）の当日回数 */
  bottleCount: number
  /** 搾乳（pumped）の当日回数 */
  pumpedCount: number
  /** 離乳食（solid）の当日回数 */
  solidCount: number
}

/**
 * 「今日の状況ひと目化」用の、指定 JST 日付 `date` の集計。
 *
 * 契約は全種別で「`date` 当日分のみ数える」に統一する:
 * - feeding / diaper は `toJstDateString(logged_at) === date` のもののみ計上。
 * - diaper はさらに `diaper_type` で pee/poop の内訳（peeCount/poopCount）も
 *   同時に集計する。both は pee/poop 双方に加算するため（aggregateDiapers と
 *   同じ規約）、`peeCount + poopCount` は `diaperCount` を超えうる。
 * - feeding は `feeding_type` で種別内訳（breastCycleCount / bottleCount /
 *   pumpedCount / solidCount）も集計する。こちらは diaper と違い**排他分割**で、
 *   `breastCycleCount + bottleCount + pumpedCount + solidCount === feedingCount`
 *   が成り立つ（feeding_type が null の行を除く）。母乳サイクル数を bottle/pumped/
 *   solid と混ぜて「授乳 N 回」と見せていた欠陥を分離するために足した内訳ゆえ、
 *   この排他性はテストで固定してある。
 *
 * 入力は選択日の logs をそのまま渡してよい（`date` に属さない行は date フィルタで
 * 弾かれるため、前後日の行が混ざっても二重計上しない）。
 */
export function summarizeTodayCounts(
  logs: Pick<
    AggregationLogInput,
    "log_type" | "logged_at" | "diaper_type" | "feeding_type"
  >[],
  date: string,
): TodayCounts {
  let feedingCount = 0
  let diaperCount = 0
  let peeCount = 0
  let poopCount = 0
  let breastCycleCount = 0
  let bottleCount = 0
  let pumpedCount = 0
  let solidCount = 0

  for (const log of logs) {
    if (log.log_type === "feeding") {
      if (toJstDateString(log.logged_at) === date) {
        feedingCount++
        // 種別内訳は排他分割（aggregateFeedings と同じバケット定義）。
        // feeding_type が null の行はどのバケットにも入らない（DB の chk_feeding では
        // 起こらないが、未知 enum 値の null 退化 #159 で届きうるため素通しさせる）。
        if (isBreastFeedingType(log.feeding_type)) breastCycleCount++
        else if (log.feeding_type === "bottle") bottleCount++
        else if (log.feeding_type === "pumped") pumpedCount++
        else if (log.feeding_type === "solid") solidCount++
      }
    } else if (log.log_type === "diaper") {
      if (toJstDateString(log.logged_at) === date) {
        diaperCount++
        // both は pee/poop 双方に加算する（aggregateDiapers と同じ規約）。
        if (log.diaper_type === "pee") peeCount++
        else if (log.diaper_type === "poop") poopCount++
        else if (log.diaper_type === "both") {
          peeCount++
          poopCount++
        }
      }
    }
  }

  return {
    feedingCount,
    diaperCount,
    peeCount,
    poopCount,
    breastCycleCount,
    bottleCount,
    pumpedCount,
    solidCount,
  }
}

export interface BabyAge {
  years: number
  months: number
  days: number
  label: string
}

const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** その年月の日数を返す（TZ 非依存）。month は 1-12。 */
function daysInMonth(year: number, month: number): number {
  // Date.UTC(y, month, 0) は「month 月の 0 日目」= 前月末日ゆえ month の日数
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * 生年月日から「生後○ヶ月○日 / ○歳○ヶ月」を暦計算で求める。
 * 日数の借りは実日付演算（月末クランプ）で正しく処理する。
 * @param birthDate "YYYY-MM-DD"
 * @param referenceDate "YYYY-MM-DD"
 * @returns 不正な日付文字列なら null。未来の生年月日は 生後0日 にフォールバック。
 */
export function getBabyAge(
  birthDate: string,
  referenceDate: string,
): BabyAge | null {
  if (!YMD_PATTERN.test(birthDate) || !YMD_PATTERN.test(referenceDate)) {
    return null
  }

  const [by, bm, bd] = birthDate.split("-").map(Number)
  const [ry, rm, rd] = referenceDate.split("-").map(Number)

  // 未来の生年月日は 生後0日 に丸める（DB の CHECK 前提だが多層防御）
  if (birthDate > referenceDate) {
    return { years: 0, months: 0, days: 0, label: "生後0日" }
  }

  let monthsTotal = (ry - by) * 12 + (rm - bm)
  if (rd < bd) monthsTotal -= 1

  // 誕生日から monthsTotal ヶ月後の「直近の月齢記念日」を月末クランプで求める
  const anchorMonthIndex = bm - 1 + monthsTotal
  const anchorYear = by + Math.floor(anchorMonthIndex / 12)
  const anchorMonth = (anchorMonthIndex % 12) + 1
  const anchorDay = Math.min(bd, daysInMonth(anchorYear, anchorMonth))
  const anchorYmd = `${anchorYear}-${String(anchorMonth).padStart(2, "0")}-${String(anchorDay).padStart(2, "0")}`

  const days = daysBetweenYmd(anchorYmd, referenceDate) ?? 0
  const years = Math.floor(monthsTotal / 12)
  const months = monthsTotal % 12

  let label: string
  if (years >= 1) {
    label = months === 0 ? `${years}歳` : `${years}歳${months}ヶ月`
  } else if (months >= 1) {
    label = days === 0 ? `生後${months}ヶ月` : `生後${months}ヶ月${days}日`
  } else {
    label = `生後${days}日`
  }

  return { years, months, days, label }
}
