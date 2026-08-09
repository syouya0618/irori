import { describe, expect, it } from "vitest"
import {
  AVERAGE_WINDOW_DAYS,
  WEEKLY_DISPLAY_DAYS,
  WEEKLY_FETCH_DAYS,
  averageBabyWeeklySummary,
  buildBabyWeeklySummary,
  totalBabyWeeklySummary,
  type BabyWeeklySummaryDay,
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

describe("週間サマリーの窓定数", () => {
  it("取得窓は表示窓より 1 日だけ長い（平均が今日を除けるようにするため）", () => {
    expect(WEEKLY_FETCH_DAYS).toBe(WEEKLY_DISPLAY_DAYS + 1)
    expect(AVERAGE_WINDOW_DAYS).toBe(WEEKLY_DISPLAY_DAYS)
  })

  it("既定の days は 7 のまま（8 日は呼び出し側が明示的に渡す契約）", () => {
    // 既定値を 8 に変えると、この関数を使う他の経路が無音で 8 日集計に化ける。
    expect(buildBabyWeeklySummary([], "2026-04-11")).toHaveLength(
      WEEKLY_DISPLAY_DAYS,
    )
    expect(
      buildBabyWeeklySummary([], "2026-04-11", WEEKLY_FETCH_DAYS),
    ).toHaveLength(WEEKLY_FETCH_DAYS)
  })

  it("8 日窓の先頭は today-7、末尾 7 件は 7 日窓と一致する", () => {
    const eight = buildBabyWeeklySummary([], "2026-04-11", WEEKLY_FETCH_DAYS)
    const seven = buildBabyWeeklySummary([], "2026-04-11")

    expect(eight[0].date).toBe("2026-04-04")
    expect(eight.slice(WEEKLY_FETCH_DAYS - WEEKLY_DISPLAY_DAYS)).toEqual(seven)
    // 平均が使う先頭 7 件は「昨日まで」＝末尾（今日）を含まぬ
    expect(eight.slice(0, AVERAGE_WINDOW_DAYS).at(-1)?.date).toBe("2026-04-10")
  })
})

describe("averageBabyWeeklySummary", () => {
  function day(
    date: string,
    feedingCount: number,
    diaperCount: number,
  ): BabyWeeklySummaryDay {
    return { date, feedingCount, diaperCount }
  }

  it("記録が 1 日も無ければ null（0.0 を返して「本当に0回」と誤読させない）", () => {
    const days = buildBabyWeeklySummary([], "2026-04-11")
    expect(averageBabyWeeklySummary(days)).toBeNull()
    expect(averageBabyWeeklySummary([])).toBeNull()
  })

  it("分母は配列長ではなく『記録のあった日数』", () => {
    // 7 日窓のうち記録があるのは 2 日だけ。7 で割ると平均が半分以下に化ける。
    const days = [
      day("2026-04-05", 0, 0),
      day("2026-04-06", 0, 0),
      day("2026-04-07", 0, 0),
      day("2026-04-08", 0, 0),
      day("2026-04-09", 0, 0),
      day("2026-04-10", 8, 10),
      day("2026-04-11", 6, 8),
    ]

    expect(averageBabyWeeklySummary(days)).toEqual({
      feedingPerDay: 7,
      diaperPerDay: 9,
      sampleDays: 2,
    })
  })

  it("記録の飛んだ日は分母から外す（乳児が丸一日飲まぬことはない＝未記録と読む）", () => {
    const days = [
      day("2026-04-09", 8, 10),
      day("2026-04-10", 0, 0), // 未記録
      day("2026-04-11", 6, 8),
    ]

    const result = averageBabyWeeklySummary(days)
    expect(result?.sampleDays).toBe(2)
    expect(result?.feedingPerDay).toBe(7)
  })

  it("おむつだけの日も『記録のあった日』として数える", () => {
    const days = [day("2026-04-10", 0, 5), day("2026-04-11", 4, 5)]

    expect(averageBabyWeeklySummary(days)).toEqual({
      feedingPerDay: 2,
      diaperPerDay: 5,
      sampleDays: 2,
    })
  })

  it("小数第1位で丸める", () => {
    // 25 / 3 = 8.333… → 8.3 / 26 / 3 = 8.666… → 8.7
    const days = [
      day("2026-04-09", 8, 8),
      day("2026-04-10", 8, 9),
      day("2026-04-11", 9, 9),
    ]

    expect(averageBabyWeeklySummary(days)).toEqual({
      feedingPerDay: 8.3,
      diaperPerDay: 8.7,
      sampleDays: 3,
    })
  })

  it("7 日すべてに記録があれば sampleDays は 7", () => {
    const days = Array.from({ length: AVERAGE_WINDOW_DAYS }, (_, i) =>
      day(`2026-04-0${i + 1}`, 8, 10),
    )

    expect(averageBabyWeeklySummary(days)).toEqual({
      feedingPerDay: 8,
      diaperPerDay: 10,
      sampleDays: AVERAGE_WINDOW_DAYS,
    })
  })
})
