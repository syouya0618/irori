import { describe, expect, it } from "vitest"
import { exportEventId, hasCalendarExportScope, GOOGLE_CALENDAR_EXPORT_SCOPE, isExportMirror, planExport, toExportEvent } from "../google-calendar-export"

const id = "11111111-2222-4333-8444-555555555555"
const owner = "aaaa"
const base = { id, title: "家族の予定", is_all_day: true, start_date: "2026-12-31", end_date: "2027-01-01", start_at: null, end_at: null }

describe("Google 専用カレンダーへの共有", () => {
  it("権限を完全一致で判定する", () => {
    expect(hasCalendarExportScope(GOOGLE_CALENDAR_EXPORT_SCOPE)).toBe(true)
    expect(hasCalendarExportScope(GOOGLE_CALENDAR_EXPORT_SCOPE + ".fake")).toBe(false)
  })
  it("終日は排他的な終了日へ変換し、安定したIDを使う", () => {
    const event = toExportEvent(base, owner)
    expect(event.id).toBe(exportEventId(id))
    expect(event.end).toEqual({ date: "2027-01-02" })
    expect(isExportMirror(event)).toBe(true)
    expect(event).not.toHaveProperty("description")
  })
  it("時刻付きの終了が無い場合は1分の目印とする", () => {
    const event = toExportEvent({ ...base, is_all_day: false, start_at: "2026-12-31T12:00:00+09:00" }, owner)
    expect(event.start).toEqual({ dateTime: "2026-12-31T03:00:00.000Z" })
    expect(event.end).toEqual({ dateTime: "2026-12-31T03:01:00.000Z" })
  })
  it("差分のみを反映し、自分の印が無い予定は削除しない", () => {
    const event = toExportEvent(base, owner)
    const existing = { ...event, etag: "v1" }
    expect(planExport([event], [existing], owner)).toEqual([])
    expect(planExport([{ ...event, summary: "変更" }], [existing], owner)).toMatchObject([{ kind: "patch", etag: "v1" }])
    expect(planExport([], [existing, { id: "unrelated", etag: "other" }], owner)).toEqual([{ kind: "delete", id: event.id, etag: "v1" }])
    expect(planExport([], [existing], "another")).toEqual([])
    expect(planExport([event], [], owner)).toEqual([{ kind: "insert", event }])
  })
  it("ゲストのいる予定を変更・削除せず、版の無い断面も拒む", () => {
    const event = toExportEvent(base, owner)
    expect(() => planExport([], [{ ...event, etag: "v1", attendees: [{}] }], owner)).toThrow()
    expect(() => planExport([], [event], owner)).toThrow()
  })
})
