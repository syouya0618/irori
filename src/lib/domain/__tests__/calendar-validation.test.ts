import { describe, it, expect } from "vitest"
import { validateCalendarEventInput } from "@/lib/domain/calendar-validation"

describe("validateCalendarEventInput", () => {
  it("空タイトルを弾く", () => {
    const r = validateCalendarEventInput({
      title: "  ",
      isAllDay: true,
      startDate: "2026-07-09",
      endDate: "2026-07-09",
    })
    expect(r.error).toBe("タイトルを入力してください")
  })

  it("日付逆転を弾く", () => {
    const r = validateCalendarEventInput({
      title: "検診",
      isAllDay: true,
      startDate: "2026-07-10",
      endDate: "2026-07-09",
    })
    expect(r.error).toBe("終了日は開始日以降にしてください")
  })

  it("終日: 正常系は trim + start_at/end_at を null 化", () => {
    const r = validateCalendarEventInput({
      title: "  検診  ",
      memo: "  メモ  ",
      isAllDay: true,
      startDate: "2026-07-09",
      endDate: "2026-07-09",
      startAt: "2026-07-09T00:00:00Z", // 終日なので無視される
    })
    expect(r.error).toBeNull()
    expect(r.value).toMatchObject({
      title: "検診",
      memo: "メモ",
      isAllDay: true,
      startAt: null,
      endAt: null,
    })
  })

  it("時刻付き: start_at 必須", () => {
    const r = validateCalendarEventInput({
      title: "会議",
      isAllDay: false,
      startDate: "2026-07-09",
      endDate: "2026-07-09",
      startAt: null,
    })
    expect(r.error).toBe("開始時刻を入力してください")
  })

  it("時刻付き: 終了 < 開始 を弾く", () => {
    const r = validateCalendarEventInput({
      title: "会議",
      isAllDay: false,
      startDate: "2026-07-09",
      endDate: "2026-07-09",
      startAt: "2026-07-09T05:00:00Z",
      endAt: "2026-07-09T04:00:00Z",
    })
    expect(r.error).toBe("終了時刻は開始時刻以降にしてください")
  })

  it("時刻付き: 正常系", () => {
    const r = validateCalendarEventInput({
      title: "会議",
      isAllDay: false,
      startDate: "2026-07-09",
      endDate: "2026-07-09",
      startAt: "2026-07-09T05:00:00Z",
    })
    expect(r.error).toBeNull()
    expect(r.value).toMatchObject({ isAllDay: false, endAt: null })
  })
})
