import { describe, it, expect } from "vitest"
import {
  calculateDailyRate,
  calculateMilkDailyMl,
  estimateRemainingDays,
  type ConsumptionLogInput,
} from "../consumption-rate"

// 基準日: 2026-04-11 (UTC)
const TODAY = new Date("2026-04-11T03:00:00Z") // JST 12:00

/** テスト用ログファクトリ */
function mkLog(
  logType: ConsumptionLogInput["log_type"],
  daysAgo: number,
  overrides: Partial<ConsumptionLogInput> = {},
): ConsumptionLogInput {
  const date = new Date(TODAY)
  date.setUTCDate(date.getUTCDate() - daysAgo)
  return {
    log_type: logType,
    logged_at: date.toISOString(),
    ...overrides,
  }
}

// ─── calculateDailyRate ──────────────────────────────────

describe("calculateDailyRate", () => {
  it("7日間毎日3回のおむつ → 3.0/日", () => {
    const logs: ConsumptionLogInput[] = []
    for (let day = 0; day < 7; day++) {
      for (let i = 0; i < 3; i++) {
        logs.push(mkLog("diaper", day))
      }
    }
    expect(calculateDailyRate(logs, "diaper", TODAY)).toBe(3)
  })

  it("3日間だけデータがある場合、3日で割る", () => {
    const logs = [
      mkLog("diaper", 1),
      mkLog("diaper", 1),
      mkLog("diaper", 3),
      mkLog("diaper", 3),
      mkLog("diaper", 5),
    ]
    // 5件 / 3日 ≈ 1.666...
    const rate = calculateDailyRate(logs, "diaper", TODAY)
    expect(rate).toBeCloseTo(5 / 3)
  })

  it("ログ0件 → null", () => {
    expect(calculateDailyRate([], "diaper", TODAY)).toBeNull()
  })

  it("7日より古いログは除外される", () => {
    const logs = [
      mkLog("diaper", 8), // 8日前 → ウィンドウ外
      mkLog("diaper", 1), // 1日前 → ウィンドウ内
    ]
    expect(calculateDailyRate(logs, "diaper", TODAY)).toBe(1)
  })

  it("異なるlog_typeはフィルタされる", () => {
    const logs = [
      mkLog("diaper", 1),
      mkLog("feeding", 1), // feedingはカウントしない
      mkLog("sleep", 1),
    ]
    expect(calculateDailyRate(logs, "diaper", TODAY)).toBe(1)
  })

  it("カスタムウィンドウ日数を使用できる", () => {
    const logs = [
      mkLog("diaper", 1),
      mkLog("diaper", 2),
      mkLog("diaper", 4), // 3日ウィンドウ外
    ]
    const rate = calculateDailyRate(logs, "diaper", TODAY, { windowDays: 3 })
    expect(rate).toBe(1) // 2件 / 2日
  })
})

// ─── calculateMilkDailyMl ────────────────────────────────

describe("calculateMilkDailyMl", () => {
  it("3日間のミルクログ → 日平均ml", () => {
    const logs = [
      mkLog("feeding", 1, { amount_ml: 100 }),
      mkLog("feeding", 1, { amount_ml: 120 }),
      mkLog("feeding", 2, { amount_ml: 80 }),
      mkLog("feeding", 3, { amount_ml: 200 }),
    ]
    // 500ml / 3日 ≈ 166.67
    expect(calculateMilkDailyMl(logs, TODAY)).toBeCloseTo(500 / 3)
  })

  it("amount_mlがnullのログは除外", () => {
    const logs = [
      mkLog("feeding", 1, { amount_ml: 100 }),
      mkLog("feeding", 1, { amount_ml: null }), // 母乳（量不明）
    ]
    expect(calculateMilkDailyMl(logs, TODAY)).toBe(100)
  })

  it("amount_mlが0のログは除外", () => {
    const logs = [
      mkLog("feeding", 1, { amount_ml: 0 }),
      mkLog("feeding", 2, { amount_ml: 150 }),
    ]
    expect(calculateMilkDailyMl(logs, TODAY)).toBe(150)
  })

  it("ミルクログなし → null", () => {
    const logs = [mkLog("diaper", 1)]
    expect(calculateMilkDailyMl(logs, TODAY)).toBeNull()
  })
})

// ─── estimateRemainingDays ───────────────────────────────

describe("estimateRemainingDays", () => {
  it("在庫15、日次5 → 3日", () => {
    expect(estimateRemainingDays(15, 5)).toBe(3)
  })

  it("在庫7、日次3 → 2日（小数切り捨て）", () => {
    expect(estimateRemainingDays(7, 3)).toBe(2)
  })

  it("日次レート0 → null", () => {
    expect(estimateRemainingDays(10, 0)).toBeNull()
  })

  it("日次レートnull → null", () => {
    expect(estimateRemainingDays(10, null)).toBeNull()
  })

  it("日次レート負 → null", () => {
    expect(estimateRemainingDays(10, -1)).toBeNull()
  })

  it("在庫0 → 0日", () => {
    expect(estimateRemainingDays(0, 5)).toBe(0)
  })

  it("在庫が負 → 0日", () => {
    expect(estimateRemainingDays(-3, 5)).toBe(0)
  })
})
