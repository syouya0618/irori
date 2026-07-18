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
import { createCalendarEvent } from "@/app/(main)/calendar/actions"
import { toast } from "sonner"
import { jstWallClockToIso } from "@/lib/utils/date-jst"

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

  it("google 詳細シートに終日イベントの日時行が出る", () => {
    render(
      <CalendarView
        {...base}
        initialEvents={[
          ev({
            id: "g1",
            title: "会議",
            is_all_day: true,
            start_date: "2026-07-15",
            end_date: "2026-07-15",
            source: "google",
          }),
        ]}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "2026-07-15 を選択" }))
    fireEvent.click(screen.getByText("会議"))
    expect(screen.getByText("7月15日・終日")).toBeInTheDocument()
  })

  it("google 詳細シートに時刻付きイベントの日時行が出る", () => {
    render(
      <CalendarView
        {...base}
        initialEvents={[
          ev({
            id: "g2",
            title: "会議",
            is_all_day: false,
            start_date: "2026-07-15",
            end_date: "2026-07-15",
            start_at: jstWallClockToIso("2026-07-15", "14:00"),
            end_at: jstWallClockToIso("2026-07-15", "15:00"),
            source: "google",
          }),
        ]}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "2026-07-15 を選択" }))
    fireEvent.click(screen.getByText("会議"))
    expect(screen.getByText("7月15日 14:00〜15:00")).toBeInTheDocument()
  })

  it("時刻付き予定で開始時刻を空にして保存してもクラッシュせず toast で弾く", () => {
    render(<CalendarView {...base} initialEvents={[]} />)
    fireEvent.click(screen.getByRole("button", { name: "予定を追加" }))
    fireEvent.change(screen.getByLabelText("タイトル"), {
      target: { value: "会議" },
    })
    // 終日を外して時刻フィールドを出す(セグメント「時刻あり」)
    fireEvent.click(screen.getByRole("button", { name: "時刻あり" }))
    // 既定 09:00 を空にする(date/time input は required 無しでクリア可能)
    const startTime = document.getElementById("cal-start-time") as HTMLInputElement
    fireEvent.change(startTime, { target: { value: "" } })
    // 追加(修正前は jstWallClockToIso の RangeError で無反応・保存も toast もなし)
    // testing-library の name 文字列は既定で完全一致のため FAB「予定を追加」とは衝突しない
    fireEvent.click(screen.getByRole("button", { name: "追加" }))
    expect(toast.error).toHaveBeenCalledWith("開始時刻を入力してください")
    expect(createCalendarEvent).not.toHaveBeenCalled()
  })

  it("月送りで選択日がその月へ寄り、アジェンダが範囲外日を誤表示しない", () => {
    render(<CalendarView {...base} initialEvents={[]} />)
    fireEvent.click(screen.getByRole("button", { name: "次の月" }))
    expect(screen.getByText("2026年8月")).toBeInTheDocument()
    // アジェンダの対象日が 8月1日 に寄る(今日=7月のままにしない)
    expect(screen.getByText(/8月1日 の予定/)).toBeInTheDocument()
  })
})
