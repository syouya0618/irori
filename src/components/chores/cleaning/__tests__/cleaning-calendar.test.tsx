import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { CleaningLog } from "@/lib/domain/cleaning-schedule"
import { CleaningCalendar, calendarMarksForDate, type CleaningCalendarItem } from "../cleaning-calendar"

const items: CleaningCalendarItem[] = [
  { id: "a", name: "キッチン掃除", dueOn: "2026-11-15", lastDoneOn: "2026-11-08" },
  { id: "b", name: "換気扇フィルター", dueOn: "2026-11-22", lastDoneOn: null },
]
const logs: CleaningLog[] = [
  { id: "l1", routine_id: "a", kind: "done", done_on: "2026-11-01", occurrence: "2026-11-01", note: null, voided_at: null, created_by: null, created_at: "2026-11-01T00:00:00+00:00", updated_at: "2026-11-01T00:00:00+00:00" },
  { id: "l2", routine_id: "a", kind: "done", done_on: "2026-11-02", occurrence: "2026-11-02", note: null, voided_at: "2026-11-03T00:00:00+00:00", created_by: null, created_at: "2026-11-02T00:00:00+00:00", updated_at: "2026-11-02T00:00:00+00:00" },
]

describe("自分で設定した家事の月間カレンダー", () => {
  it("取り消した完了は表示せず、次回目安と実施の印を分ける", () => {
    expect(calendarMarksForDate("2026-11-01", items, logs).completed.map(x => x.id)).toEqual(["a"])
    expect(calendarMarksForDate("2026-11-02", items, logs).completed).toEqual([])
    expect(calendarMarksForDate("2026-11-08", items, []).completed.map(x => x.id)).toEqual(["a"])
    expect(calendarMarksForDate("2026-11-15", items, logs).scheduled.map(x => x.id)).toEqual(["a"])
    expect(calendarMarksForDate("2026-11-22", items, logs).scheduled.map(x => x.id)).toEqual(["b"])
  })

  it("日付を選ぶと家事が見え、詳細と自由設定フォームへ進める", async () => {
    const onOpenRoutine = vi.fn()
    const onAddRoutine = vi.fn()
    render(<CleaningCalendar today="2026-11-11" items={items} logs={logs} historyFailed={false} historyTruncated={false}
      onOpenRoutine={onOpenRoutine} onAddRoutine={onAddRoutine} />)
    const grid = screen.getByRole("grid", { name: "2026年11月の家事カレンダー" })
    expect(within(grid).getAllByRole("gridcell")).toHaveLength(30)
    await act(async () => { fireEvent.click(within(grid).getByRole("button", { name: /11月15日: 完了0件・次回目安1件/ })) })
    expect(screen.getByText("11月15日の記録・予定")).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /キッチン掃除.*次回目安/ })) })
    expect(onOpenRoutine).toHaveBeenCalledWith("a")
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "家事項目を設定" })) })
    expect(onAddRoutine).toHaveBeenCalledTimes(1)
  })

  it("月送りと履歴未取得の注意を表示し、履歴を勝手に完了へ変えない", async () => {
    render(<CleaningCalendar today="2026-11-11" items={items} logs={[]} historyFailed={true} historyTruncated={true}
      onOpenRoutine={() => {}} onAddRoutine={() => {}} />)
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "次の月を見る" })) })
    expect(screen.getByRole("grid", { name: "2026年12月の家事カレンダー" })).toBeInTheDocument()
    expect(screen.getByText(/履歴の一部を読み込めていません/)).toBeInTheDocument()
  })
})
