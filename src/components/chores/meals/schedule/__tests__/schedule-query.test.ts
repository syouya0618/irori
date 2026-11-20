import { describe, expect, it } from "vitest"

import { mondayOf, resolveScheduleStart, scheduleHref } from "../schedule-query"

describe("週間スケジュールのURLとJST暦日", () => {
  const today = "2026-11-20" // 金曜

  it("月曜から日曜の週を返す。端末のタイムゾーンは使わない", () => {
    expect(mondayOf("2026-11-20")).toBe("2026-11-16")
    expect(mondayOf("2026-11-22")).toBe("2026-11-16")
    expect(mondayOf("2026-11-23")).toBe("2026-11-23")
  })

  it("初回は今週、共有リンクは指定週。無効なクエリは今週へ戻す", () => {
    expect(resolveScheduleStart(undefined, today)).toBe("2026-11-16")
    expect(resolveScheduleStart("2026-11-23", today)).toBe("2026-11-23")
    expect(resolveScheduleStart("2026-11-25", today)).toBe("2026-11-23")
    expect(resolveScheduleStart(["2026-11-23", "2026-11-30"], today)).toBe("2026-11-23")
    expect(resolveScheduleStart("2026-11-31", today)).toBe("2026-11-16")
    expect(resolveScheduleStart("2001-01-01", today)).toBe("2026-11-16")
  })

  it("初期の週はquery無し、翌週はURLに日付を保持", () => {
    expect(scheduleHref("2026-11-16", today)).toBe("/chores/meals")
    expect(scheduleHref("2026-11-23", today)).toBe("/chores/meals?start=2026-11-23")
  })
})
