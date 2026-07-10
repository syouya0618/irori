import { describe, it, expect } from "vitest"
import {
  buildMonthGrid,
  shiftMonth,
  monthFirstOf,
  eventOverlapsDate,
  sortDayEvents,
  eventsForDate,
  bucketEventsByDate,
  type CalendarEventLite,
} from "@/lib/domain/calendar-grid"

function ev(o: Partial<CalendarEventLite> & { id: string }): CalendarEventLite {
  return {
    title: o.title ?? "予定",
    is_all_day: o.is_all_day ?? true,
    start_date: o.start_date ?? "2026-07-09",
    end_date: o.end_date ?? o.start_date ?? "2026-07-09",
    start_at: o.start_at ?? null,
    source: o.source ?? "native",
    ...o,
  }
}

describe("buildMonthGrid", () => {
  it("常に 6 週 × 7 日 = 42 セル、先頭は月曜", () => {
    const grid = buildMonthGrid("2026-07-01", "2026-07-09")
    expect(grid).toHaveLength(6)
    expect(grid.every((w) => w.length === 7)).toBe(true)
    // 2026-07-01 は水曜。月曜始まりの週頭は 2026-06-29(月)
    expect(grid[0][0].date).toBe("2026-06-29")
  })

  it("inMonth と isToday を正しく立てる", () => {
    const grid = buildMonthGrid("2026-07-01", "2026-07-09")
    const flat = grid.flat()
    expect(flat.find((c) => c.date === "2026-06-29")?.inMonth).toBe(false)
    expect(flat.find((c) => c.date === "2026-07-01")?.inMonth).toBe(true)
    expect(flat.find((c) => c.date === "2026-07-09")?.isToday).toBe(true)
  })

  it("8月グリッドの先頭が 7/27(月)(月境界 JST)", () => {
    // 2026-08-01 は土曜。週頭は 2026-07-27(月)
    expect(buildMonthGrid("2026-08-01", "2026-08-01")[0][0].date).toBe(
      "2026-07-27",
    )
  })
})

describe("shiftMonth / monthFirstOf", () => {
  it("年跨ぎ", () => {
    expect(shiftMonth("2026-12-01", 1)).toBe("2027-01-01")
    expect(shiftMonth("2026-01-01", -1)).toBe("2025-12-01")
  })
  it("YYYY-MM-DD を当月1日へ", () => {
    expect(monthFirstOf("2026-07-09")).toBe("2026-07-01")
  })
})

describe("eventOverlapsDate / sortDayEvents / eventsForDate", () => {
  it("多日イベントは全該当日に重なる", () => {
    const e = ev({ id: "a", start_date: "2026-07-08", end_date: "2026-07-10" })
    expect(eventOverlapsDate(e, "2026-07-07")).toBe(false)
    expect(eventOverlapsDate(e, "2026-07-08")).toBe(true)
    expect(eventOverlapsDate(e, "2026-07-10")).toBe(true)
    expect(eventOverlapsDate(e, "2026-07-11")).toBe(false)
  })

  it("整列: 終日先頭 → start_at 昇順 → タイトル", () => {
    const timed14 = ev({ id: "t14", is_all_day: false, start_at: "2026-07-09T05:00:00Z" })
    const timed09 = ev({ id: "t09", is_all_day: false, start_at: "2026-07-09T00:00:00Z" })
    const allday = ev({ id: "ad", is_all_day: true })
    const sorted = [timed14, allday, timed09].sort(sortDayEvents)
    expect(sorted.map((e) => e.id)).toEqual(["ad", "t09", "t14"])
  })

  it("eventsForDate は該当日のみ整列して返す", () => {
    const events = [
      ev({ id: "x", start_date: "2026-07-09", end_date: "2026-07-09" }),
      ev({ id: "y", start_date: "2026-07-10", end_date: "2026-07-10" }),
    ]
    expect(eventsForDate(events, "2026-07-09").map((e) => e.id)).toEqual(["x"])
  })
})

describe("bucketEventsByDate", () => {
  it("範囲内の各日にイベントを割り当てる(多日は複数日に出る)", () => {
    const events = [ev({ id: "m", start_date: "2026-07-08", end_date: "2026-07-09" })]
    const map = bucketEventsByDate(events, "2026-07-08", "2026-07-10")
    expect(map.get("2026-07-08")?.map((e) => e.id)).toEqual(["m"])
    expect(map.get("2026-07-09")?.map((e) => e.id)).toEqual(["m"])
    expect(map.get("2026-07-10")).toEqual([])
  })
})
