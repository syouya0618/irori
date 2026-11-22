import { describe, expect, it } from "vitest"

import { mondayOf, resolveScheduleStart, scheduleHref, scheduleReturnHref } from "../schedule-query"

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

  it("詳細編集から戻る週は日曜を含む同一週、未来週も失わない", () => {
    expect(scheduleReturnHref("2026-11-22", today)).toBe("/chores/meals")
    expect(scheduleReturnHref("2026-11-25", today)).toBe("/chores/meals?start=2026-11-23")
    expect(scheduleReturnHref("2026-11-25")).toBe("/chores/meals?start=2026-11-23")
    expect(scheduleReturnHref(null)).toBe("/chores/meals")
    expect(scheduleReturnHref("2026-11-31")).toBe("/chores/meals")
  })

  it("初期の週はquery無し、翌週はURLに日付を保持", () => {
    expect(scheduleHref("2026-11-16", today)).toBe("/chores/meals")
    expect(scheduleHref("2026-11-23", today)).toBe("/chores/meals?start=2026-11-23")
  })
})
