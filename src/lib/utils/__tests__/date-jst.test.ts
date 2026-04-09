import { describe, it, expect } from "vitest"
import {
  todayJstString,
  daysBetweenYmd,
  daysFromTodayJst,
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
