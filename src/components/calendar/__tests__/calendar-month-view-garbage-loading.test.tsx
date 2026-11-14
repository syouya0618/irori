/**
 * 月のマスの印は、読み込み中・失敗の間（件数が当てにならぬ間）も、通常の予定とごみの日で同じ扱いにする。
 * 通常の予定の帯・丸だけを残してごみのアイコンを消すと、ごみの日が「何も無い日」に見える。
 * 読み上げは件数も種別も言わぬ（「予定を確認できません」）。
 */
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { buildMonthGrid } from "@/lib/domain/calendar-grid"
import { attachEventPurposes, type EventPurposeRow } from "@/lib/domain/garbage"
import { CalendarMonthView } from "../calendar-month-view"
import type { CalendarEventRecord } from "../use-month-events"

const DAY = "2026-12-03"
const GARBAGE = "ca000000-0000-4000-8000-000000000001"
const NORMAL = "ca000000-0000-4000-8000-000000000002"

function row(id: string, title: string): CalendarEventRecord {
  return {
    id,
    title,
    is_all_day: true,
    start_date: DAY,
    end_date: DAY,
    start_at: null,
    end_at: null,
    memo: null,
    source: "native",
    series_id: null,
    updated_at: "2026-11-10T00:00:00.000000+00:00",
    event_uid: id,
  } as CalendarEventRecord
}

const purpose: EventPurposeRow = {
  id: "da000000-0000-4000-8000-000000000001",
  scope: "event",
  targetKey: GARBAGE,
  purpose: "garbage",
  garbageKind: "燃えるごみ",
  remindDefault: null,
  reminderOptOut: false,
  updatedAt: "2026-11-10T00:00:00.000000+00:00",
}

function renderMonth(countsUnknown: boolean) {
  const events = attachEventPurposes([row(GARBAGE, "収集"), row(NORMAL, "通院")], {
    status: "ok",
    rows: [purpose],
  }) as CalendarEventRecord[]
  const view = render(
    <CalendarMonthView
      grid={buildMonthGrid("2026-12-01", "2026-11-14")}
      eventsByDate={new Map([[DAY, events]])}
      selectedDate={DAY}
      onSelectDate={() => {}}
      countsUnknown={countsUnknown}
    />,
  )
  return view.container.querySelector<HTMLButtonElement>(`button[data-date="${DAY}"]`)!
}

afterEach(() => cleanup())

describe("CalendarMonthView: 読み込み中・失敗の間の、ごみの日の印", () => {
  it("件数が当てにならぬ間も、ごみのアイコンと通常の予定の印を同じく描き、読み上げは件数も種別も言わぬ", () => {
    const cell = renderMonth(true)
    expect(cell.querySelectorAll("[data-mark]")).toHaveLength(1)
    expect(cell.querySelector("[data-garbage-mark] svg")).not.toBeNull()
    expect(cell.getAttribute("aria-label")).toBe("12月3日（木）、予定を確認できません")
  })

  it("読めておる時は、ごみのアイコン・通常の予定の印・読み上げの種別がそろう", () => {
    const cell = renderMonth(false)
    expect(cell.querySelectorAll("[data-mark]")).toHaveLength(1)
    expect(cell.querySelector("[data-garbage-mark] svg")).not.toBeNull()
    expect(cell.getAttribute("aria-label")).toBe("12月3日（木）、予定2件、ごみ（燃えるごみ）")
  })
})
