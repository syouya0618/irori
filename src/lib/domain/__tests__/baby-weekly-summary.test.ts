import { describe, expect, it } from "vitest"
import {
  buildBabyWeeklySummary,
  totalBabyWeeklySummary,
  type BabyWeeklySummaryLogInput,
} from "../baby-weekly-summary"

function log(
  log_type: BabyWeeklySummaryLogInput["log_type"],
  logged_at: string,
): BabyWeeklySummaryLogInput {
  return { log_type, logged_at }
}

describe("buildBabyWeeklySummary", () => {
  it("終了日を含む7日分をゼロ埋めで返す", () => {
    const result = buildBabyWeeklySummary([], "2026-04-11")

    expect(result).toEqual([
      { date: "2026-04-05", feedingCount: 0, diaperCount: 0 },
      { date: "2026-04-06", feedingCount: 0, diaperCount: 0 },
      { date: "2026-04-07", feedingCount: 0, diaperCount: 0 },
      { date: "2026-04-08", feedingCount: 0, diaperCount: 0 },
      { date: "2026-04-09", feedingCount: 0, diaperCount: 0 },
      { date: "2026-04-10", feedingCount: 0, diaperCount: 0 },
      { date: "2026-04-11", feedingCount: 0, diaperCount: 0 },
    ])
  })

  it("授乳・おむつを日別に集計する", () => {
    const logs = [
      log("feeding", "2026-04-10T08:00:00+09:00"),
      log("feeding", "2026-04-10T11:00:00+09:00"),
      log("diaper", "2026-04-10T12:00:00+09:00"),
      log("diaper", "2026-04-11T07:00:00+09:00"),
    ]

    const result = buildBabyWeeklySummary(logs, "2026-04-11")

    expect(result[5]).toEqual({
      date: "2026-04-10",
      feedingCount: 2,
      diaperCount: 1,
    })
    expect(result[6]).toEqual({
      date: "2026-04-11",
      feedingCount: 0,
      diaperCount: 1,
    })
  })

  it("範囲外のログを除外する", () => {
    const logs = [
      log("feeding", "2026-04-04T23:59:00+09:00"),
      log("diaper", "2026-04-12T00:01:00+09:00"),
    ]

    const result = buildBabyWeeklySummary(logs, "2026-04-11")

    expect(totalBabyWeeklySummary(result)).toEqual({
      feedingCount: 0,
      diaperCount: 0,
    })
  })

  it("週間日数が0以下なら空配列を返す", () => {
    expect(buildBabyWeeklySummary([], "2026-04-11", 0)).toEqual([])
    expect(buildBabyWeeklySummary([], "2026-04-11", -1)).toEqual([])
  })

  it("週間サマリー対象外のログ種別を無視する", () => {
    const result = buildBabyWeeklySummary(
      [
        log("temperature", "2026-04-10T08:00:00+09:00"),
        log("growth", "2026-04-10T09:00:00+09:00"),
        log("memo", "2026-04-10T10:00:00+09:00"),
      ],
      "2026-04-11",
    )

    expect(totalBabyWeeklySummary(result)).toEqual({
      feedingCount: 0,
      diaperCount: 0,
    })
  })
})

describe("totalBabyWeeklySummary", () => {
  it("週間合計を返す", () => {
    const days = buildBabyWeeklySummary(
      [
        log("feeding", "2026-04-10T08:00:00+09:00"),
        log("diaper", "2026-04-10T09:00:00+09:00"),
      ],
      "2026-04-11",
    )

    expect(totalBabyWeeklySummary(days)).toEqual({
      feedingCount: 1,
      diaperCount: 1,
    })
  })
})
