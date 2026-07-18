import { describe, it, expect } from "vitest"
import {
  aggregateFeedings,
  aggregateSleep,
  aggregateDiapers,
  extractTemperatures,
  extractGrowth,
  calculateAge,
  getBabyAge,
  summarizeTodayCounts,
  buildGrowthSeries,
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

  it("未完了の睡眠（ended_at なし）は時間・セッション数に含めない", () => {
    // B-02: 按分後は「完了睡眠が重なる日」のみ行を返す。未完了のみの日は行が出ない。
    const start = new Date("2026-04-11T00:00:00Z") // JST 09:00
    const end = new Date("2026-04-11T01:00:00Z") // JST 10:00 → 60分
    const logs: AggregationLogInput[] = [
      { ...mkLog("sleep", 0), logged_at: start.toISOString(), ended_at: end.toISOString() },
      mkLog("sleep", 2), // 未完了（ended_at = null）は加算されない
    ]
    const result = aggregateSleep(logs, START, END)
    expect(result).toHaveLength(1)
    expect(result[0].totalMinutes).toBe(60)
    expect(result[0].sessionCount).toBe(1)
  })

  it("日跨ぎ睡眠は開始日・終了日へ JST 窓で按分する（AUDIT-019/072）", () => {
    // 2026-04-10 19:30 JST → 2026-04-11 06:30 JST（合計 660 分）
    const logs: AggregationLogInput[] = [
      {
        ...mkLog("sleep", 0),
        logged_at: "2026-04-10T19:30:00+09:00",
        ended_at: "2026-04-11T06:30:00+09:00",
      },
    ]
    const result = aggregateSleep(logs, START, END)
    const byDate = new Map(result.map((d) => [d.date, d.totalMinutes]))
    // 開始日は 19:30→24:00 = 270 分、終了日は 00:00→06:30 = 390 分
    expect(byDate.get("2026-04-10")).toBe(270)
    expect(byDate.get("2026-04-11")).toBe(390)
  })

  it("集計開始日より前に始まった睡眠も範囲内の重なりだけ計上する（AUDIT-067 窓端）", () => {
    // START = 2026-04-04。前日 04-03 22:00 開始 → 04-04 01:30 終了（90分は窓内）
    const logs: AggregationLogInput[] = [
      {
        ...mkLog("sleep", 0),
        logged_at: "2026-04-03T22:00:00+09:00",
        ended_at: "2026-04-04T01:30:00+09:00",
      },
    ]
    const result = aggregateSleep(logs, START, END)
    const byDate = new Map(result.map((d) => [d.date, d.totalMinutes]))
    expect(byDate.get("2026-04-04")).toBe(90)
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

// ─── getBabyAge（月齢＋日数の詳細）────────────────────────

describe("getBabyAge", () => {
  it("新生児は日数のみ表示（生後10日）", () => {
    expect(getBabyAge("2026-04-01", "2026-04-11")).toEqual({
      years: 0,
      months: 0,
      days: 10,
      label: "生後10日",
    })
  })

  it("当日誕生 → 生後0日", () => {
    expect(getBabyAge("2026-04-11", "2026-04-11")).toEqual({
      years: 0,
      months: 0,
      days: 0,
      label: "生後0日",
    })
  })

  it("1ヶ月以上は「生後○ヶ月○日」", () => {
    expect(getBabyAge("2026-01-01", "2026-04-11")).toEqual({
      years: 0,
      months: 3,
      days: 10,
      label: "生後3ヶ月10日",
    })
  })

  it("ちょうど1ヶ月（日数0）は「生後1ヶ月」", () => {
    expect(getBabyAge("2026-03-11", "2026-04-11")).toEqual({
      years: 0,
      months: 1,
      days: 0,
      label: "生後1ヶ月",
    })
  })

  it("月末→翌月頭の借り（1/31→3/1）を暦で正しく処理", () => {
    // 2026-02 は 28 日。1/31 + 1ヶ月 = 2/28（クランプ）→ 3/1 まで 1 日
    expect(getBabyAge("2026-01-31", "2026-03-01")).toEqual({
      years: 0,
      months: 1,
      days: 1,
      label: "生後1ヶ月1日",
    })
  })

  it("1歳以上は「○歳○ヶ月」（日数は省略）", () => {
    expect(getBabyAge("2025-02-11", "2026-04-11")).toEqual({
      years: 1,
      months: 2,
      days: 0,
      label: "1歳2ヶ月",
    })
  })

  it("1歳ちょうどは「1歳」", () => {
    expect(getBabyAge("2025-04-11", "2026-04-11")).toEqual({
      years: 1,
      months: 0,
      days: 0,
      label: "1歳",
    })
  })

  it("未来の生年月日は 生後0日 にフォールバック", () => {
    expect(getBabyAge("2026-04-12", "2026-04-11")).toEqual({
      years: 0,
      months: 0,
      days: 0,
      label: "生後0日",
    })
  })

  it("不正な日付文字列は null を返す", () => {
    expect(getBabyAge("invalid", "2026-04-11")).toBeNull()
  })
})

// ─── summarizeTodayCounts（今日の状況ひと目化）────────────

describe("summarizeTodayCounts", () => {
  // BASE = 2026-04-11 JST 12:00。当日 = "2026-04-11"。
  const TODAY = "2026-04-11"

  it("空ログ → 全て 0", () => {
    expect(summarizeTodayCounts([], TODAY)).toEqual({
      feedingCount: 0,
      diaperCount: 0,
      sleepCount: 0,
      totalSleepMinutes: 0,
    })
  })

  it("授乳2・おむつ1・完了睡眠90分1・進行中睡眠1 を集計", () => {
    const logs = [
      mkLog("feeding", 1, { feeding_type: "breast_left" }),
      mkLog("feeding", 3, { feeding_type: "bottle", amount_ml: 120 }),
      mkLog("diaper", 2, { diaper_type: "pee" }),
      // 完了睡眠: 90分（logged_at → ended_at）
      {
        ...mkLog("sleep", 5),
        ended_at: new Date(BASE.getTime() - 3.5 * 3600_000).toISOString(),
      },
      // 進行中睡眠（ended_at なし）は睡眠時間に含めない
      mkLog("sleep", 0),
    ]
    expect(summarizeTodayCounts(logs, TODAY)).toEqual({
      feedingCount: 2,
      diaperCount: 1,
      sleepCount: 1,
      totalSleepMinutes: 90,
    })
  })

  it("進行中睡眠のみなら睡眠回数・時間は 0", () => {
    const logs = [mkLog("sleep", 0)]
    expect(summarizeTodayCounts(logs, TODAY)).toEqual({
      feedingCount: 0,
      diaperCount: 0,
      sleepCount: 0,
      totalSleepMinutes: 0,
    })
  })

  it("前夜開始の日跨ぎ睡眠は当日窓分だけ按分計上する（22:00→翌06:30 で 390分）", () => {
    // B-02 core: 前日開始の overlap 睡眠を入力に合流させても当日分（390分）のみ数える。
    const logs: Pick<AggregationLogInput, "log_type" | "logged_at" | "ended_at">[] = [
      {
        log_type: "sleep",
        logged_at: "2026-04-11T22:00:00+09:00",
        ended_at: "2026-04-12T06:30:00+09:00",
      },
    ]
    // 翌日（2026-04-12）視点: 00:00→06:30 = 390分
    expect(summarizeTodayCounts(logs, "2026-04-12")).toMatchObject({
      sleepCount: 1,
      totalSleepMinutes: 390,
    })
    // 開始日（2026-04-11）視点: 22:00→24:00 = 120分
    expect(summarizeTodayCounts(logs, "2026-04-11")).toMatchObject({
      sleepCount: 1,
      totalSleepMinutes: 120,
    })
  })

  it("feeding/diaper も date 当日分のみ数える（前日ログは混ぜても加算しない）", () => {
    const logs: Pick<AggregationLogInput, "log_type" | "logged_at" | "ended_at">[] = [
      { log_type: "feeding", logged_at: "2026-04-11T08:00:00+09:00", ended_at: null },
      { log_type: "feeding", logged_at: "2026-04-10T23:00:00+09:00", ended_at: null }, // 前日
      { log_type: "diaper", logged_at: "2026-04-11T09:00:00+09:00", ended_at: null },
    ]
    expect(summarizeTodayCounts(logs, "2026-04-11")).toMatchObject({
      feedingCount: 1,
      diaperCount: 1,
    })
  })
})

// ─── buildGrowthSeries（成長曲線）────────────────────────

describe("buildGrowthSeries", () => {
  it("空ログ → 空系列", () => {
    expect(buildGrowthSeries([], START, END)).toEqual({ weight: [], height: [] })
  })

  it("体重と身長を別系列に分離し、logged_at 昇順で並べる", () => {
    const logs = [
      mkLog("growth", 1, { weight_g: 5200, height_cm: 58.0 }),
      mkLog("growth", 48, { weight_g: 5000, height_cm: null }),
    ]
    const series = buildGrowthSeries(logs, START, END)
    // 古い順（48h前 → 1h前）
    expect(series.weight).toEqual([
      { date: "2026-04-09", value: 5000 },
      { date: "2026-04-11", value: 5200 },
    ])
    expect(series.height).toEqual([{ date: "2026-04-11", value: 58.0 }])
  })

  it("体重のみ / 身長のみのログはそれぞれの系列にだけ入る", () => {
    const logs = [
      mkLog("growth", 2, { weight_g: 6000 }),
      mkLog("growth", 1, { height_cm: 62.5 }),
    ]
    const series = buildGrowthSeries(logs, START, END)
    expect(series.weight).toEqual([{ date: "2026-04-11", value: 6000 }])
    expect(series.height).toEqual([{ date: "2026-04-11", value: 62.5 }])
  })

  it("growth 以外のログ種別は無視する", () => {
    const logs = [
      mkLog("feeding", 1, { feeding_type: "bottle", amount_ml: 100 }),
      mkLog("growth", 1, { weight_g: 5500 }),
    ]
    const series = buildGrowthSeries(logs, START, END)
    expect(series.weight).toEqual([{ date: "2026-04-11", value: 5500 }])
    expect(series.height).toEqual([])
  })
})
