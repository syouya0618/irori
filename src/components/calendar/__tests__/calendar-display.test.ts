import { describe, it, expect } from "vitest"
import {
  eventWhenLabel,
  formatDayJa,
  formatShortDay,
  multiDayProgress,
  repeatSummary,
  spanDays,
  weekdayJa,
} from "../calendar-display"
import { jstWallClockToIso } from "@/lib/utils/date-jst"

describe("calendar-display", () => {
  it("曜日は JST の暦日で出す（UTC 解釈で 1 日ずれぬ）", () => {
    expect(weekdayJa("2026-10-24")).toBe("土")
    expect(weekdayJa("2026-07-15")).toBe("水")
    expect(weekdayJa("2026-01-01")).toBe("木")
  })

  it("不正な日付は throw せず退化させる", () => {
    expect(weekdayJa("2026-02-31")).toBeNull()
    expect(formatDayJa("abc")).toBe("abc")
    expect(formatShortDay("2026-13-01")).toBe("2026-13-01")
    expect(spanDays("2026-07-17", "2026-07-15")).toBeNull()
  })

  it("日数は両端を含む", () => {
    expect(spanDays("2026-07-15", "2026-07-15")).toBe(1)
    expect(spanDays("2026-07-30", "2026-08-02")).toBe(4)
  })

  it("日時の 1 行: 終日単日・終日多日・時刻付き単日・時刻付き多日", () => {
    expect(
      eventWhenLabel({
        is_all_day: true,
        start_date: "2026-10-24",
        end_date: "2026-10-24",
        start_at: null,
        end_at: null,
      }),
    ).toBe("10月24日（土）・終日")
    expect(
      eventWhenLabel({
        is_all_day: true,
        start_date: "2026-10-23",
        end_date: "2026-10-26",
        start_at: null,
        end_at: null,
      }),
    ).toBe("10月23日（金）〜10月26日（月）・終日（4日間）")
    expect(
      eventWhenLabel({
        is_all_day: false,
        start_date: "2026-10-24",
        end_date: "2026-10-24",
        start_at: jstWallClockToIso("2026-10-24", "10:00"),
        end_at: jstWallClockToIso("2026-10-24", "11:30"),
      }),
    ).toBe("10月24日（土）10:00〜11:30")
    expect(
      eventWhenLabel({
        is_all_day: false,
        start_date: "2026-10-24",
        end_date: "2026-10-25",
        start_at: jstWallClockToIso("2026-10-24", "22:00"),
        end_at: jstWallClockToIso("2026-10-25", "02:00"),
      }),
    ).toBe("10月24日（土）22:00〜10月25日（日）02:00")
  })

  it("時刻が壊れていても日付だけで言う（画面を倒さぬ）", () => {
    expect(
      eventWhenLabel({
        is_all_day: false,
        start_date: "2026-10-24",
        end_date: "2026-10-24",
        start_at: "not-a-date",
        end_at: null,
      }),
    ).toBe("10月24日（土）")
  })

  it("複数日の何日目か。単日・範囲外は null", () => {
    const e = { start_date: "2026-10-23", end_date: "2026-10-26" }
    expect(multiDayProgress(e, "2026-10-23")).toEqual({ day: 1, total: 4 })
    expect(multiDayProgress(e, "2026-10-26")).toEqual({ day: 4, total: 4 })
    expect(multiDayProgress(e, "2026-10-27")).toBeNull()
    expect(multiDayProgress({ start_date: "2026-10-23", end_date: "2026-10-23" }, "2026-10-23")).toBeNull()
  })

  it("繰り返しの予告はサーバと同じ展開で回数を数える", () => {
    expect(repeatSummary("2026-10-24", "weekly", "2026-12-26")).toBe(
      "毎週土曜日・12月26日（土）まで・全10回",
    )
    expect(repeatSummary("2026-10-24", "daily", "2026-10-26")).toBe(
      "毎日・10月26日（月）まで・全3回",
    )
    // 31 日起点の毎月は存在しない月を飛ばす（Google 流儀と同じ）
    expect(repeatSummary("2026-01-31", "monthly", "2026-05-31")).toBe(
      "毎月31日・5月31日（日）まで・全3回",
    )
  })

  it("繰り返しの予告: 未完成・範囲外の入力では出さぬ（検証は保存時に任せる）", () => {
    expect(repeatSummary("2026-10-24", "weekly", "")).toBeNull()
    expect(repeatSummary("2026-10-24", "weekly", "2026-10-24")).toBeNull()
    expect(repeatSummary("2026-10-24", "weekly", "2028-01-01")).toBeNull()
  })
})
