import { describe, it, expect } from "vitest"
import {
  sameCalendarEventContent,
  type CalendarEventEditableValue,
  type CalendarEventStoredContent,
} from "../calendar-event-conflict"

const stored: CalendarEventStoredContent = {
  title: "検診",
  memo: "母子手帳",
  is_all_day: false,
  start_date: "2026-07-09",
  end_date: "2026-07-09",
  start_at: "2026-07-09T01:00:00+00:00",
  end_at: "2026-07-09T02:00:00+00:00",
}

const sent: CalendarEventEditableValue = {
  title: "検診",
  memo: "母子手帳",
  isAllDay: false,
  startDate: "2026-07-09",
  endDate: "2026-07-09",
  startAt: "2026-07-09T10:00:00+09:00",
  endAt: "2026-07-09T02:00:00.000Z",
}

describe("sameCalendarEventContent", () => {
  it("時刻の表記揺れ（+00:00 / +09:00 / Z / 秒未満）は同じ瞬間なら同じ中身", () => {
    expect(sameCalendarEventContent(stored, sent)).toBe(true)
  })

  it.each([
    ["件名", { title: "検診（変更）" }],
    ["メモ", { memo: null }],
    ["終日", { isAllDay: true }],
    ["開始日", { startDate: "2026-07-10" }],
    ["終了日", { endDate: "2026-07-10" }],
    ["開始時刻", { startAt: "2026-07-09T10:30:00+09:00" }],
    ["終了時刻（片方だけ null）", { endAt: null }],
  ] as [string, Partial<CalendarEventEditableValue>][])(
    "%s が違えば別の中身（衝突として扱う）",
    (_name, patch) => {
      expect(sameCalendarEventContent(stored, { ...sent, ...patch })).toBe(false)
    },
  )

  it("終日予定の時刻は両方 null なら同じ", () => {
    expect(
      sameCalendarEventContent(
        { ...stored, is_all_day: true, start_at: null, end_at: null },
        { ...sent, isAllDay: true, startAt: null, endAt: null },
      ),
    ).toBe(true)
  })

  it("読めぬ時刻は同じとみなさぬ（NaN 同士を一致にせぬ）", () => {
    expect(
      sameCalendarEventContent(
        { ...stored, start_at: "garbage" },
        { ...sent, startAt: "garbage" },
      ),
    ).toBe(false)
  })
})
