/**
 * CalendarView の描画・選択・google read-only の回帰テスト。
 * 初期描画は initialEvents を使い refetch を発火させないため、client は最小 mock で足りる。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react"

// 最小 client mock: realtime 購読が throw しないだけの chainable スタブ
vi.mock("@/lib/supabase/client", () => {
  const channel = {
    on: () => channel,
    subscribe: () => channel,
  }
  return {
    createClient: () => ({
      channel: () => channel,
      removeChannel: () => {},
      from: () => ({
        select: () => ({
          eq: () => ({
            lte: () => ({
              gte: () => ({ order: () => Promise.resolve({ data: [], error: null }) }),
            }),
          }),
        }),
      }),
    }),
  }
})
vi.mock("@/app/(main)/calendar/actions", () => ({
  createCalendarEvent: vi.fn().mockResolvedValue({ error: null, eventId: "x" }),
  updateCalendarEvent: vi.fn().mockResolvedValue({ error: null }),
  deleteCalendarEvent: vi.fn().mockResolvedValue({ error: null }),
}))
vi.mock("sonner", async () => {
  const { vi: viMod } = await import("vitest")
  return { toast: { error: viMod.fn(), success: viMod.fn() } }
})

import { CalendarView } from "../calendar-view"
import type { CalendarEventRecord } from "../use-month-events"

function ev(o: Partial<CalendarEventRecord> & { id: string }): CalendarEventRecord {
  return {
    title: o.title ?? "予定",
    memo: o.memo ?? null,
    is_all_day: o.is_all_day ?? true,
    start_date: o.start_date ?? "2026-07-15",
    end_date: o.end_date ?? o.start_date ?? "2026-07-15",
    start_at: o.start_at ?? null,
    end_at: o.end_at ?? null,
    source: o.source ?? "native",
    ...o,
  }
}

beforeEach(() => cleanup())

const base = {
  householdId: "house-1",
  initialMonthFirst: "2026-07-01",
}

describe("CalendarView", () => {
  it("曜日ヘッダと月グリッド(42セル)を描画する", () => {
    render(<CalendarView {...base} initialEvents={[]} />)
    expect(screen.getByText("2026年7月")).toBeInTheDocument()
    for (const w of ["月", "火", "水", "木", "金", "土", "日"]) {
      expect(screen.getAllByText(w).length).toBeGreaterThan(0)
    }
    // 日セル(aria-label "…を選択")が 42 個
    expect(screen.getAllByRole("button", { name: /を選択$/ })).toHaveLength(42)
  })

  it("日をタップするとアジェンダがその日に更新される", () => {
    render(
      <CalendarView
        {...base}
        initialEvents={[ev({ id: "e1", title: "検診", start_date: "2026-07-15" })]}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "2026-07-15 を選択" }))
    const agenda = screen.getByText(/7月15日 の予定/).closest("section")!
    expect(within(agenda).getByText("検診")).toBeInTheDocument()
  })

  it("google 予定はタップしても read-only(更新ボタンなし・閉じるのみ)", () => {
    render(
      <CalendarView
        {...base}
        initialEvents={[
          ev({ id: "g1", title: "会議", start_date: "2026-07-15", source: "google" }),
        ]}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "2026-07-15 を選択" }))
    fireEvent.click(screen.getByText("会議"))
    expect(screen.getByRole("button", { name: "閉じる" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "更新" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "削除" })).not.toBeInTheDocument()
  })
})
