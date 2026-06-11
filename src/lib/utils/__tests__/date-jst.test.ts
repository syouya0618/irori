import { describe, it, expect } from "vitest"
import {
  todayJstString,
  daysBetweenYmd,
  daysFromTodayJst,
  weekStartMonday,
  currentWeekRangeJst,
} from "../date-jst"

describe("todayJstString", () => {
  it("JST 00:30 の時刻でも当日の日付を返す（UTC 前日 15:30 相当）", () => {
    // 2026-04-09 00:30 JST = 2026-04-08 15:30 UTC
    const now = new Date("2026-04-08T15:30:00Z")
    expect(todayJstString(now)).toBe("2026-04-09")
  })

  it("JST 23:30 でも当日の日付を返す（UTC 当日 14:30 相当）", () => {
    // 2026-04-09 23:30 JST = 2026-04-09 14:30 UTC
    const now = new Date("2026-04-09T14:30:00Z")
    expect(todayJstString(now)).toBe("2026-04-09")
  })

  it("JST 00:00 ちょうどで当日の日付を返す", () => {
    // 2026-04-09 00:00 JST = 2026-04-08 15:00 UTC
    const now = new Date("2026-04-08T15:00:00Z")
    expect(todayJstString(now)).toBe("2026-04-09")
  })
})

describe("daysBetweenYmd", () => {
  it("当日は 0", () => {
    expect(daysBetweenYmd("2026-04-09", "2026-04-09")).toBe(0)
  })

  it("未来は正の値", () => {
    expect(daysBetweenYmd("2026-04-09", "2026-04-12")).toBe(3)
  })

  it("過去は負の値", () => {
    expect(daysBetweenYmd("2026-04-09", "2026-04-06")).toBe(-3)
  })

  it("月を跨いでも正しく計算", () => {
    expect(daysBetweenYmd("2026-04-30", "2026-05-02")).toBe(2)
  })

  it("年を跨いでも正しく計算", () => {
    expect(daysBetweenYmd("2025-12-31", "2026-01-01")).toBe(1)
  })

  it("閏年の2月も正しく計算", () => {
    expect(daysBetweenYmd("2024-02-28", "2024-03-01")).toBe(2)
  })

  it("不正なフォーマットは null を返す", () => {
    expect(daysBetweenYmd("2026/04/09", "2026-04-10")).toBe(null)
    expect(daysBetweenYmd("invalid", "2026-04-10")).toBe(null)
    expect(daysBetweenYmd("2026-4-9", "2026-04-10")).toBe(null)
  })
})

describe("weekStartMonday", () => {
  it("月曜自身はそのまま返す", () => {
    expect(weekStartMonday("2026-06-08")).toBe("2026-06-08")
  })

  it("土曜は同週の月曜を返す", () => {
    expect(weekStartMonday("2026-06-13")).toBe("2026-06-08")
  })

  it("日曜は進行中週の月曜を返す（前週に巻き戻さない）", () => {
    // flutter/lib/core/utils/jst_date.dart の weekStartMonday と同値
    // (日曜 = 進行中週の末尾セマンティクス)
    expect(weekStartMonday("2026-06-14")).toBe("2026-06-08")
  })

  it("月を跨いでも正しく計算", () => {
    expect(weekStartMonday("2026-06-02")).toBe("2026-06-01")
    expect(weekStartMonday("2026-05-01")).toBe("2026-04-27")
  })

  it("年を跨いでも正しく計算", () => {
    expect(weekStartMonday("2026-01-01")).toBe("2025-12-29")
  })

  it("不正なフォーマットは null を返す", () => {
    expect(weekStartMonday("2026/06/08")).toBe(null)
  })
})

describe("currentWeekRangeJst", () => {
  it("UTC 日曜 15:30 (= JST 月曜 00:30) は JST の今週を返す【issue #23 核心境界】", () => {
    // 2026-06-07 15:30 UTC = 2026-06-08 00:30 JST (月曜)
    // 旧実装（ローカル TZ 依存の週範囲計算）は UTC プロセスで "2026-06-01" を返していた窓
    const now = new Date("2026-06-07T15:30:00Z")
    expect(currentWeekRangeJst(now)).toEqual({
      startDate: "2026-06-08",
      endDate: "2026-06-14",
    })
  })

  it("バグ窓の終端 UTC 日曜 23:59 (= JST 月曜 08:59) も JST の今週を返す", () => {
    const now = new Date("2026-06-07T23:59:00Z")
    expect(currentWeekRangeJst(now).startDate).toBe("2026-06-08")
  })

  it("JST 日曜 23:59 (= UTC 日曜 14:59) は前の週のまま", () => {
    // 2026-06-07 14:59 UTC = 2026-06-07 23:59 JST (日曜)
    const now = new Date("2026-06-07T14:59:00Z")
    expect(currentWeekRangeJst(now)).toEqual({
      startDate: "2026-06-01",
      endDate: "2026-06-07",
    })
  })

  it("JST 日曜 0:00 (= UTC 土曜 15:00) は日曜が属する週を返す", () => {
    // 2026-06-13 15:00 UTC = 2026-06-14 00:00 JST (日曜)
    const now = new Date("2026-06-13T15:00:00Z")
    expect(currentWeekRangeJst(now)).toEqual({
      startDate: "2026-06-08",
      endDate: "2026-06-14",
    })
  })
})

describe("daysFromTodayJst", () => {
  it("JST基準で明日までの日数を返す", () => {
    const now = new Date("2026-04-09T14:00:00Z") // 2026-04-09 23:00 JST
    expect(daysFromTodayJst("2026-04-10", now)).toBe(1)
  })

  it("JST基準で期限切れは負の値", () => {
    const now = new Date("2026-04-09T14:00:00Z") // 2026-04-09 23:00 JST
    expect(daysFromTodayJst("2026-04-07", now)).toBe(-2)
  })

  it("JST 00:30 でも同日判定が正しい（TZバグ防止の要）", () => {
    // UTC では 2026-04-08 15:30 だが、JST では 2026-04-09 00:30
    const now = new Date("2026-04-08T15:30:00Z")
    expect(daysFromTodayJst("2026-04-09", now)).toBe(0)
    expect(daysFromTodayJst("2026-04-10", now)).toBe(1)
  })
})
