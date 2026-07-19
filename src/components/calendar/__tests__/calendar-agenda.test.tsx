/**
 * CalendarAgenda の時刻セル表示(6分岐)の回帰テスト。
 * selectedDate 視点で、単日/多日 timed の開始・終了・継続中を正しく描き分ける。
 * 特に「多日 timed の中日に初日の開始時刻(14:00)が引きずられて出る」バグの固定。
 */

import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { CalendarAgenda } from "../calendar-agenda"
import type { CalendarEventRecord } from "../use-month-events"
import { jstWallClockToIso } from "@/lib/utils/date-jst"

function ev(o: Partial<CalendarEventRecord> & { id: string }): CalendarEventRecord {
  return {
    title: o.title ?? "予定",
    memo: o.memo ?? null,
    is_all_day: o.is_all_day ?? false,
    start_date: o.start_date ?? "2026-07-15",
    end_date: o.end_date ?? o.start_date ?? "2026-07-15",
    start_at: o.start_at ?? null,
    end_at: o.end_at ?? null,
    source: o.source ?? "native",
    ...o,
  }
}

function renderAgenda(e: CalendarEventRecord, selectedDate: string) {
  return render(
    <CalendarAgenda
      dateLabel="テスト"
      events={[e]}
      selectedDate={selectedDate}
      onTapEvent={() => {}}
    />,
  )
}

describe("CalendarAgenda 時刻表示の6分岐", () => {
  afterEach(() => cleanup())

  it("[1] 終日 → 「終日」", () => {
    renderAgenda(
      ev({ id: "e1", is_all_day: true, start_date: "2026-07-15", end_date: "2026-07-15" }),
      "2026-07-15",
    )
    expect(screen.getByText("終日")).toBeInTheDocument()
  })

  it("[2a] timed・当日開始・end 同日 → 「14:00」+ 2段目「〜15:00」", () => {
    renderAgenda(
      ev({
        id: "e2a",
        start_date: "2026-07-15",
        end_date: "2026-07-15",
        start_at: jstWallClockToIso("2026-07-15", "14:00"),
        end_at: jstWallClockToIso("2026-07-15", "15:00"),
      }),
      "2026-07-15",
    )
    expect(screen.getByText("14:00")).toBeInTheDocument()
    expect(screen.getByText("〜15:00")).toBeInTheDocument()
  })

  it("[2b] timed・当日開始・end なし → 「14:00」のみ(2段目なし)", () => {
    renderAgenda(
      ev({
        id: "e2b",
        start_date: "2026-07-15",
        end_date: "2026-07-15",
        start_at: jstWallClockToIso("2026-07-15", "14:00"),
        end_at: null,
      }),
      "2026-07-15",
    )
    expect(screen.getByText("14:00")).toBeInTheDocument()
    expect(screen.queryByText(/〜/)).not.toBeInTheDocument()
  })

  it("[3] timed・当日開始・end 翌日以降 → 「14:00 →」", () => {
    renderAgenda(
      ev({
        id: "e3",
        start_date: "2026-07-15",
        end_date: "2026-07-17",
        start_at: jstWallClockToIso("2026-07-15", "14:00"),
        end_at: jstWallClockToIso("2026-07-17", "10:00"),
      }),
      "2026-07-15",
    )
    expect(screen.getByText("14:00 →")).toBeInTheDocument()
  })

  it("[4] timed・開始日<selectedDate・end JST 日>selectedDate(中日) → 「→」(14:00 を引きずらない)", () => {
    renderAgenda(
      ev({
        id: "e4",
        start_date: "2026-07-15",
        end_date: "2026-07-17",
        start_at: jstWallClockToIso("2026-07-15", "14:00"),
        end_at: jstWallClockToIso("2026-07-17", "10:00"),
      }),
      "2026-07-16",
    )
    expect(screen.getByText("→")).toBeInTheDocument()
    // 初日の開始時刻が中日に引きずられない(このバグの本体)
    expect(screen.queryByText("14:00")).not.toBeInTheDocument()
  })

  it("[5] timed・開始日<selectedDate・end JST 日=selectedDate → 「→ 02:00」", () => {
    renderAgenda(
      ev({
        id: "e5",
        start_date: "2026-07-15",
        end_date: "2026-07-17",
        start_at: jstWallClockToIso("2026-07-15", "14:00"),
        end_at: jstWallClockToIso("2026-07-17", "02:00"),
      }),
      "2026-07-17",
    )
    expect(screen.getByText("→ 02:00")).toBeInTheDocument()
    expect(screen.queryByText("14:00")).not.toBeInTheDocument()
  })

  it("[6] timed・開始日<selectedDate・end_at なし → 「→」(継続中フォールバック)", () => {
    renderAgenda(
      ev({
        id: "e6",
        start_date: "2026-07-15",
        end_date: "2026-07-16",
        start_at: jstWallClockToIso("2026-07-15", "14:00"),
        end_at: null,
      }),
      "2026-07-16",
    )
    expect(screen.getByText("→")).toBeInTheDocument()
    expect(screen.queryByText("14:00")).not.toBeInTheDocument()
  })
})
