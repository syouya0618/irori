import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EMPTY_CLEANING_MARKS, routineStatusFromMarks, type CleaningRoutine } from "@/lib/domain/cleaning-schedule"
import { CleaningStatus, type CleaningStatusEntry } from "../cleaning-status"

const TODAY = "2026-11-24"
const VERSION = "2026-11-01T00:00:00.123456+00:00"

function entry(id: string, name: string, lastDoneOn: string | null, paused = false): CleaningStatusEntry {
  const routine: CleaningRoutine = {
    id,
    name,
    location: null,
    cadence_unit: "week",
    cadence_interval: 1,
    schedule_mode: "after_done",
    anchor_date: TODAY,
    postponed_occurrence: null,
    postponed_until: null,
    paused_at: paused ? VERSION : null,
    resume_floor: null,
    archived: false,
    created_at: VERSION,
    updated_at: VERSION,
  }
  return { routine, status: routineStatusFromMarks(routine, { ...EMPTY_CLEANING_MARKS, lastDoneOn }, TODAY) }
}

const entries = [
  entry("toilet", "トイレ掃除", "2026-11-21"),
  entry("floor", "床掃除", TODAY),
  entry("fan", "換気扇掃除", null),
  entry("window", "窓拭き", "2026-11-16", true),
  entry("bath", "お風呂掃除", "2026-11-23"),
]

function view(overrides: Partial<Parameters<typeof CleaningStatus>[0]> = {}) {
  return render(<CleaningStatus today={TODAY} entries={entries} onOpenRoutine={vi.fn()} onAddRoutine={vi.fn()} {...overrides} />)
}

const rows = () => screen.getAllByTestId("cleaning-status-item")
const rowNames = () => rows().map((row) => within(row).getByRole("button").getAttribute("aria-label"))
const row = (name: string) => within(screen.getByRole("button", { name: `${name}の詳細を開く` }))

afterEach(cleanup)

describe("掃除状況", () => {
  it("有効な前回実施日から今日の項目数と、休止中を含む登録済み項目数を表示する", () => {
    view()
    const totals = screen.getByLabelText("掃除の状況の集計")
    expect(within(totals).getByText("今日の実施").nextElementSibling).toHaveTextContent("1項目")
    expect(within(totals).getByText("登録済み").nextElementSibling).toHaveTextContent("5項目")
    expect(row("窓拭き").getByText("休止中")).toBeInTheDocument()
  })

  it("今日・昨日・暦日数と実施日を表示し、未記録を作成日や予定日で埋めない", () => {
    view()
    expect(row("床掃除").getByText("今日")).toBeInTheDocument()
    expect(row("床掃除").getByText("11/24（火）")).toBeInTheDocument()
    expect(row("お風呂掃除").getByText("昨日")).toBeInTheDocument()
    expect(row("トイレ掃除").getByText("3日前")).toBeInTheDocument()
    expect(row("窓拭き").getByText("8日前")).toBeInTheDocument()
    expect(row("換気扇掃除").getByText("未記録")).toBeInTheDocument()
    expect(row("換気扇掃除").getByText("実施履歴なし")).toBeInTheDocument()
    expect(row("換気扇掃除").queryByText(/11\/1|11\/24/)).not.toBeInTheDocument()
  })

  it("最初は古い順、日付順では未記録を末尾に保ち、名前順にも切り替えられる", () => {
    view()
    expect(rowNames()).toEqual(["窓拭き", "トイレ掃除", "お風呂掃除", "床掃除", "換気扇掃除"].map((name) => `${name}の詳細を開く`))
    fireEvent.change(screen.getByRole("combobox", { name: "掃除状況の並び順" }), { target: { value: "newest" } })
    expect(rowNames()).toEqual(["床掃除", "お風呂掃除", "トイレ掃除", "窓拭き", "換気扇掃除"].map((name) => `${name}の詳細を開く`))
    fireEvent.change(screen.getByRole("combobox", { name: "掃除状況の並び順" }), { target: { value: "name" } })
    expect(rowNames()).toEqual(entries.map(({ routine }) => routine.name).sort((a, b) => a.localeCompare(b, "ja")).map((name) => `${name}の詳細を開く`))
    // 表示順の変更で、受け取った配列自体を並べ替えない。
    expect(entries[0].routine.id).toBe("toilet")
  })

  it("年をまたいだ履歴は年を省略せず、サーバーの今日が変われば今日の件数も変わる", () => {
    const past = entry("past", "年末の大掃除", "2025-12-31")
    const { rerender } = view({ entries: [past, entries[1]] })
    expect(row("年末の大掃除").getByText("2025年12/31（水）")).toBeInTheDocument()
    rerender(<CleaningStatus today="2026-11-25" entries={[past, entries[1]]} onOpenRoutine={vi.fn()} onAddRoutine={vi.fn()} />)
    expect(screen.getByText("今日の実施").nextElementSibling).toHaveTextContent("0項目")
  })

  it("自由入力の長い名前を保ち、行から正しい詳細、追加ボタンからフォームを開く", () => {
    const onOpenRoutine = vi.fn()
    const onAddRoutine = vi.fn()
    const name = "二階の廊下と階段の手すりを隅まで拭き掃除する".repeat(2)
    view({ entries: [entry("custom", name, null)], onOpenRoutine, onAddRoutine })
    expect(screen.getByText(name)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: `${name}の詳細を開く` }))
    expect(onOpenRoutine).toHaveBeenCalledWith("custom")
    fireEvent.click(screen.getByRole("button", { name: "掃除項目を追加" }))
    expect(onAddRoutine).toHaveBeenCalledTimes(1)
  })

  it("空の一覧でも追加でき、一部しか読めない時は0件を全体の総数と言わない", () => {
    const { rerender } = view({ entries: [] })
    expect(screen.getByText("掃除の項目がまだありません")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "掃除項目を追加" })).toBeEnabled()
    rerender(<CleaningStatus today={TODAY} entries={[]} routinesTruncated onOpenRoutine={vi.fn()} onAddRoutine={vi.fn()} />)
    expect(screen.queryByText("掃除の項目がまだありません")).not.toBeInTheDocument()
    expect(screen.getByText("表示できる項目がありません")).toBeInTheDocument()
    expect(screen.getByText("表示中の今日の実施")).toBeInTheDocument()
    expect(screen.getByText("表示中の登録済み")).toBeInTheDocument()
    expect(screen.getByRole("note")).toHaveTextContent("上の件数は表示中の項目の集計です")
  })
})
