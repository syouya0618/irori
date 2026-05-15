import { describe, it, expect } from "vitest"
import {
  aggregateFeedings,
  aggregateSleep,
  aggregateDiapers,
  extractTemperatures,
  extractGrowth,
  calculateAge,
  type AggregationLogInput,
} from "../baby-log-aggregation"
import type { BabyLogType } from "@/lib/types/database"

// 基準日: 2026-04-11 JST 12:00 (UTC 03:00)
const BASE = new Date("2026-04-11T03:00:00Z")

function mkLog(
  logType: BabyLogType,
  hoursAgo: number,
  overrides: Partial<AggregationLogInput> = {},
): AggregationLogInput {
  const date = new Date(BASE.getTime() - hoursAgo * 3600_000)
  return {
    log_type: logType,
    logged_at: date.toISOString(),
    feeding_type: null,
    amount_ml: null,
    diaper_type: null,
    ended_at: null,
    temperature: null,
    weight_g: null,
    height_cm: null,
    ...overrides,
  }
}

const START = "2026-04-04"
const END = "2026-04-11"

// ─── aggregateFeedings ──────────────────────────────────

describe("aggregateFeedings", () => {
  it("空ログ → 空配列", () => {
    expect(aggregateFeedings([], START, END)).toEqual([])
  })

  it("授乳種別を正しくカウント", () => {
    const logs = [
      mkLog("feeding", 2, { feeding_type: "breast_left" }),
      mkLog("feeding", 3, { feeding_type: "breast_right" }),
      mkLog("feeding", 4, { feeding_type: "bottle", amount_ml: 100 }),
      mkLog("feeding", 5, { feeding_type: "bottle", amount_ml: 120 }),
      mkLog("feeding", 6, { feeding_type: "solid" }),
    ]
    const result = aggregateFeedings(logs, START, END)
    expect(result).toHaveLength(1)
    expect(result[0].totalCount).toBe(5)
    expect(result[0].breastCount).toBe(2)
    expect(result[0].bottleCount).toBe(2)
    expect(result[0].solidCount).toBe(1)
    expect(result[0].totalBottleMl).toBe(220)
    expect(result[0].avgBottleMl).toBe(110)
  })

  it("ミルクなし → avgBottleMl は null", () => {
    const logs = [mkLog("feeding", 2, { feeding_type: "breast_left" })]
    const result = aggregateFeedings(logs, START, END)
    expect(result[0].avgBottleMl).toBeNull()
  })

  it("日付範囲外のログは除外", () => {
    const logs = [
      mkLog("feeding", 24 * 10, { feeding_type: "bottle", amount_ml: 50 }), // 10日前 → 範囲外
      mkLog("feeding", 2, { feeding_type: "bottle", amount_ml: 100 }),
    ]
    const result = aggregateFeedings(logs, START, END)
    expect(result).toHaveLength(1)
    expect(result[0].totalBottleMl).toBe(100)
  })

  it("他のlog_typeは除外", () => {
    const logs = [
      mkLog("feeding", 2, { feeding_type: "bottle", amount_ml: 100 }),
      mkLog("diaper", 2, { diaper_type: "pee" }),
    ]
    const result = aggregateFeedings(logs, START, END)
    expect(result).toHaveLength(1)
    expect(result[0].totalCount).toBe(1)
  })

  it("複数日のデータを日付昇順で返す", () => {
    const logs = [
      mkLog("feeding", 2, { feeding_type: "bottle", amount_ml: 100 }),     // 4/11
      mkLog("feeding", 24 + 2, { feeding_type: "breast_left" }),            // 4/10
    ]
    const result = aggregateFeedings(logs, START, END)
    expect(result).toHaveLength(2)
    expect(result[0].date).toBe("2026-04-10")
    expect(result[1].date).toBe("2026-04-11")
  })
})

// ─── aggregateSleep ─────────────────────────────────────

describe("aggregateSleep", () => {
  it("空ログ → 空配列", () => {
    expect(aggregateSleep([], START, END)).toEqual([])
  })

  it("完了した睡眠の合計時間を算出", () => {
    const start1 = new Date("2026-04-11T00:00:00Z") // JST 09:00
    const end1 = new Date("2026-04-11T01:30:00Z")   // JST 10:30 → 90分
    const start2 = new Date("2026-04-11T05:00:00Z")  // JST 14:00
    const end2 = new Date("2026-04-11T06:00:00Z")    // JST 15:00 → 60分

    const logs: AggregationLogInput[] = [
      { ...mkLog("sleep", 0), logged_at: start1.toISOString(), ended_at: end1.toISOString() },
      { ...mkLog("sleep", 0), logged_at: start2.toISOString(), ended_at: end2.toISOString() },
    ]
    const result = aggregateSleep(logs, START, END)
    expect(result).toHaveLength(1)
    expect(result[0].totalMinutes).toBe(150)
    expect(result[0].sessionCount).toBe(2)
  })

  it("未完了の睡眠（ended_at なし）はセッション数に含まない", () => {
    const logs = [
      mkLog("sleep", 2), // ended_at = null
    ]
    const result = aggregateSleep(logs, START, END)
    expect(result).toHaveLength(1)
    expect(result[0].totalMinutes).toBe(0)
    expect(result[0].sessionCount).toBe(0)
  })
})

// ─── aggregateDiapers ───────────────────────────────────

describe("aggregateDiapers", () => {
  it("空ログ → 空配列", () => {
    expect(aggregateDiapers([], START, END)).toEqual([])
  })

  it("おむつ種別を正しくカウント", () => {
    const logs = [
      mkLog("diaper", 1, { diaper_type: "pee" }),
      mkLog("diaper", 2, { diaper_type: "pee" }),
      mkLog("diaper", 3, { diaper_type: "poop" }),
      mkLog("diaper", 4, { diaper_type: "both" }),
    ]
    const result = aggregateDiapers(logs, START, END)
    expect(result).toHaveLength(1)
    expect(result[0].totalCount).toBe(4)
    expect(result[0].peeCount).toBe(2)
    expect(result[0].poopCount).toBe(1)
    expect(result[0].bothCount).toBe(1)
  })
})

// ─── extractTemperatures ────────────────────────────────

describe("extractTemperatures", () => {
  it("空ログ → 空配列", () => {
    expect(extractTemperatures([], START, END)).toEqual([])
  })

  it("体温記録を抽出", () => {
    const logs = [
      mkLog("temperature", 2, { temperature: 36.5 }),
      mkLog("temperature", 26, { temperature: 37.2 }), // 前日
    ]
    const result = extractTemperatures(logs, START, END)
    expect(result).toHaveLength(2)
    expect(result[0].temperature).toBe(37.2)
    expect(result[1].temperature).toBe(36.5)
  })

  it("temperature が null のログは除外", () => {
    const logs = [mkLog("temperature", 2, { temperature: null })]
    expect(extractTemperatures(logs, START, END)).toHaveLength(0)
  })
})

// ─── extractGrowth ──────────────────────────────────────

describe("extractGrowth", () => {
  it("空ログ → 空配列", () => {
    expect(extractGrowth([], START, END)).toEqual([])
  })

  it("成長記録を抽出", () => {
    const logs = [
      mkLog("growth", 2, { weight_g: 5200, height_cm: 58.5 }),
    ]
    const result = extractGrowth(logs, START, END)
    expect(result).toHaveLength(1)
    expect(result[0].weightG).toBe(5200)
    expect(result[0].heightCm).toBe(58.5)
  })

  it("体重のみでも抽出される", () => {
    const logs = [mkLog("growth", 2, { weight_g: 5200 })]
    expect(extractGrowth(logs, START, END)).toHaveLength(1)
  })

  it("weight_g も height_cm も null なら除外", () => {
    const logs = [mkLog("growth", 2)]
    expect(extractGrowth(logs, START, END)).toHaveLength(0)
  })
})

// ─── calculateAge ───────────────────────────────────────

describe("calculateAge", () => {
  it("同月 → 0ヶ月", () => {
    expect(calculateAge("2026-04-01", "2026-04-11")).toBe("0ヶ月")
  })

  it("3ヶ月", () => {
    expect(calculateAge("2026-01-11", "2026-04-11")).toBe("3ヶ月")
  })

  it("日が足りない場合は1ヶ月引く", () => {
    expect(calculateAge("2026-01-15", "2026-04-11")).toBe("2ヶ月")
  })

  it("1歳ちょうど", () => {
    expect(calculateAge("2025-04-11", "2026-04-11")).toBe("1歳")
  })

  it("1歳2ヶ月", () => {
    expect(calculateAge("2025-02-11", "2026-04-11")).toBe("1歳2ヶ月")
  })

  it("未来の生年月日 → 0ヶ月", () => {
    expect(calculateAge("2026-05-01", "2026-04-11")).toBe("0ヶ月")
  })
})
