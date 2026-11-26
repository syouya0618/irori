import { useState } from "react"
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
    const grid = screen.getByRole("group", { name: "2026年11月の家事カレンダー" })
    expect(within(grid).getAllByRole("button")).toHaveLength(30)
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
    expect(screen.getByRole("group", { name: "2026年12月の家事カレンダー" })).toBeInTheDocument()
    expect(screen.getByText(/履歴の一部を読み込めていません/)).toBeInTheDocument()
  })

  it("日付のマスに実施した掃除名と次回目安を分けて表示し、取消済みは載せない", () => {
    render(<CleaningCalendar today="2026-11-11" items={items} logs={logs} historyFailed={false} historyTruncated={false}
      onOpenRoutine={() => {}} />)
    const grid = screen.getByRole("group", { name: "2026年11月の家事カレンダー" })
    const done = within(grid).getByRole("button", { name: /11月1日: 完了1件・次回目安0件。実施済み: キッチン掃除/ })
    expect(within(done).getByText("キッチン")).toHaveAttribute("data-cleaning-mark", "done")
    expect(within(done).getByText("キッチン")).toHaveAttribute("title", "キッチン掃除")
    const due = within(grid).getByRole("button", { name: /11月15日: 完了0件・次回目安1件。次回目安: キッチン掃除/ })
    expect(within(due).getByText("キッチン")).toHaveAttribute("data-cleaning-mark", "scheduled")
    expect(within(grid).getByRole("button", { name: "11月2日: 完了0件・次回目安0件" })).not.toHaveTextContent("キッチン掃除")
    expect(screen.getByRole("heading", { name: "掃除カレンダー" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "家事項目を設定" })).not.toBeInTheDocument()
  })

  it("既知名はマス内だけ短縮し、自由名・詳細・読み上げには正式名称を保つ", async () => {
    const namedItems: CleaningCalendarItem[] = [
      { id: "a", name: "トイレ掃除", dueOn: null, lastDoneOn: "2026-11-01" },
      { id: "b", name: "床掃除", dueOn: null, lastDoneOn: "2026-11-01" },
      { id: "c", name: "トイレ掃除（念入り）", dueOn: null, lastDoneOn: "2026-11-02" },
    ]
    render(<CleaningCalendar today="2026-11-11" items={namedItems} logs={[]} historyFailed={false} historyTruncated={false}
      onOpenRoutine={() => {}} />)
    const first = screen.getByRole("button", { name: /11月1日: 完了2件/ })
    expect(within(first).getByText("トイレ")).toHaveAttribute("title", "トイレ掃除")
    expect(within(first).getByText("床掃除")).toBeInTheDocument()
    expect(first).toHaveAccessibleName(/実施済み: トイレ掃除、床掃除/)
    const second = screen.getByRole("button", { name: /11月2日: 完了1件/ })
    expect(within(second).getByText("トイレ掃除（念入り）")).toBeInTheDocument()
    await act(async () => { fireEvent.click(first) })
    expect(within(screen.getByRole("list")).getByText("トイレ掃除")).toBeInTheDocument()
    expect(namedItems[0].name).toBe("トイレ掃除")
  })

  it("混み合うセルは1件と残り件数に絞り、正式名称と全件は読み上げ・選択日詳細で確認できる", async () => {
    const crowdedItems: CleaningCalendarItem[] = [
      { id: "a", name: "キッチンの換気扇とコンロの拭き掃除", dueOn: null, lastDoneOn: "2026-11-01" },
      { id: "b", name: "トイレ掃除", dueOn: null, lastDoneOn: "2026-11-01" },
      { id: "c", name: "洗濯槽掃除", dueOn: null, lastDoneOn: "2026-11-01" },
      { id: "d", name: "玄関掃除", dueOn: "2026-11-01", lastDoneOn: null },
    ]
    const onOpenRoutine = vi.fn()
    render(<CleaningCalendar today="2026-11-11" items={crowdedItems} logs={logs} historyFailed={false} historyTruncated={false}
      onOpenRoutine={onOpenRoutine} />)
    const cell = screen.getByRole("button", { name: /11月1日: 完了3件・次回目安1件/ })
    expect(cell).toHaveAccessibleName(/キッチンの換気扇とコンロの拭き掃除、トイレ掃除、洗濯槽掃除。次回目安: 玄関掃除/)
    expect(cell.querySelectorAll("[data-cleaning-mark]")).toHaveLength(1)
    expect(within(cell).getByText("+3件")).toBeInTheDocument()
    expect(within(cell).queryByText("洗濯槽掃除")).not.toBeInTheDocument()
    await act(async () => { fireEvent.click(cell) })
    const details = screen.getByRole("list")
    for (const item of crowdedItems) expect(within(details).getByText(item.name)).toBeInTheDocument()
    await act(async () => { fireEvent.click(within(details).getByRole("button", { name: /洗濯槽掃除/ })) })
    expect(onOpenRoutine).toHaveBeenCalledWith("c")
  })

  it("親の選択日と月送り・今日への移動を共有し、別月を親が選んでも追従する", async () => {
    const onSelectDate = vi.fn()
    function Parent() {
      const [selectedDate, setSelectedDate] = useState("2026-10-20")
      return <>
        <button type="button" onClick={() => setSelectedDate("2027-01-03")}>親から日付を選ぶ</button>
        <CleaningCalendar today="2026-11-11" selectedDate={selectedDate}
          onSelectDate={(date) => { onSelectDate(date); setSelectedDate(date) }}
          items={items} logs={logs} historyFailed={false} historyTruncated={false} onOpenRoutine={() => {}} />
      </>
    }
    render(<Parent />)
    expect(screen.getByRole("group", { name: "2026年10月の家事カレンダー" })).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /10月21日:/ })) })
    expect(onSelectDate).toHaveBeenLastCalledWith("2026-10-21")
    expect(screen.getByRole("button", { name: /10月21日:/ })).toHaveAttribute("aria-pressed", "true")
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "次の月を見る" })) })
    expect(onSelectDate).toHaveBeenLastCalledWith("2026-11-11")
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "次の月を見る" })) })
    expect(onSelectDate).toHaveBeenLastCalledWith("2026-12-01")
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "今日に戻る" })) })
    expect(onSelectDate).toHaveBeenLastCalledWith("2026-11-11")
    expect(screen.getByRole("button", { name: /11月11日:/ })).toHaveAttribute("aria-current", "date")
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "親から日付を選ぶ" })) })
    expect(screen.getByRole("group", { name: "2027年1月の家事カレンダー" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /1月3日:/ })).toHaveAttribute("aria-pressed", "true")
  })
})
