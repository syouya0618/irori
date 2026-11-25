import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CleaningRequest, CleaningSaveSuccess } from "@/lib/domain/cleaning"
import type { CleaningLog, CleaningMarks, CleaningRoutine } from "@/lib/domain/cleaning-schedule"
import type { ChoreSaveFailure } from "@/lib/domain/rpc-outcome"

const { saveCleaning, refresh } = vi.hoisted(() => ({
  saveCleaning: vi.fn<(request: CleaningRequest) => Promise<CleaningSaveSuccess | ChoreSaveFailure>>(),
  refresh: vi.fn(),
}))
vi.mock("@/app/(main)/chores/cleaning/actions", () => ({ saveCleaning, loadCleaningHistory: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))

import { CleaningView, type CleaningViewProps } from "../cleaning-view"

const TODAY = "2026-11-24"
const ROUTINE = "c2000000-0000-4000-8000-000000000001"
const VERSION = "2026-11-01T00:00:00.123456+00:00"
const SAVED_VERSION = "2026-11-24T02:00:00.654321+00:00"
const OWNER = { userId: "c1000000-0000-4000-8000-000000000001", householdId: "c1000000-0000-4000-8000-0000000000a1" }
const ROUTINE_ROW: CleaningRoutine = {
  id: ROUTINE, name: "トイレ掃除", location: "トイレ", cadence_unit: "week", cadence_interval: 1,
  schedule_mode: "after_done", anchor_date: TODAY, postponed_occurrence: null, postponed_until: null,
  paused_at: null, resume_floor: null, archived: false, updated_at: VERSION, created_at: VERSION,
}

function props(over: Partial<CleaningViewProps> = {}): CleaningViewProps {
  return { owner: OWNER, today: TODAY, routines: [ROUTINE_ROW], marks: {}, logs: [],
    unreadableRoutines: 0, routinesTruncated: false, historyFailed: false, historyTruncated: false, ...over }
}
function recorded(request: CleaningRequest, over: Partial<CleaningLog> = {}): CleaningLog {
  return { id: request.id, routine_id: ROUTINE, kind: "done", done_on: request.op === "backfill" ? request.doneOn : TODAY,
    occurrence: request.op === "close" ? request.seenOccurrence : null, note: null, voided_at: null,
    created_by: OWNER.userId, updated_at: SAVED_VERSION, created_at: SAVED_VERSION, ...over }
}
const quick = () => within(screen.getByRole("region", { name: "掃除を記録" }))
const recordButton = () => quick().getByRole("button", { name: "トイレ掃除を選択日に記録" })
const doneButton = () => quick().getByRole("button", { name: "トイレ掃除はこの日記録済み" })
async function ready() { await waitFor(() => expect(recordButton()).toBeEnabled()) }
async function click(element: HTMLElement) { await act(async () => { fireEvent.click(element) }) }
async function selectDate(date: string) {
  await act(async () => { fireEvent.change(quick().getByLabelText("実施日"), { target: { value: date } }) })
}

beforeEach(() => {
  localStorage.clear()
  vi.resetAllMocks()
  vi.setSystemTime(new Date("2026-11-24T03:00:00.000Z"))
})
afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("カレンダーの選択日へ掃除を記録", () => {
  it("今日を1タップで記録し、再取得前からカレンダーと記録済み表示へ反映して連打を止める", async () => {
    saveCleaning.mockImplementation(async (request) => ({ status: "saved", log: recorded(request) }))
    render(<CleaningView {...props()} />)
    await ready()
    await act(async () => {
      fireEvent.click(recordButton())
      fireEvent.click(recordButton())
    })
    expect(saveCleaning).toHaveBeenCalledTimes(1)
    expect(saveCleaning.mock.calls[0][0]).toMatchObject({ op: "close", routineId: ROUTINE,
      routineVersion: VERSION, kind: "done", seenOccurrence: TODAY, pressedOn: TODAY })
    await waitFor(() => expect(doneButton()).toBeDisabled())
    expect(doneButton()).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: /11月24日: 完了1件.*トイレ掃除/ })).toBeInTheDocument()
    await click(doneButton())
    expect(saveCleaning).toHaveBeenCalledTimes(1)
  })

  it("過去日を選ぶとその日だけを追記し、返された行の版で取り消す", async () => {
    let saved: CleaningLog
    saveCleaning.mockImplementation(async (request) => {
      if (request.op === "log_void") return { status: "saved", log: { ...saved, voided_at: SAVED_VERSION } }
      saved = recorded(request)
      return { status: "saved", log: saved }
    })
    render(<CleaningView {...props()} />)
    await ready()
    await selectDate("2026-11-21")
    await click(recordButton())
    expect(saveCleaning.mock.calls[0][0]).toMatchObject({ op: "backfill", routineId: ROUTINE,
      routineVersion: VERSION, doneOn: "2026-11-21", note: null })
    expect(saveCleaning.mock.calls[0][0]).not.toHaveProperty("seenOccurrence")
    expect(doneButton()).toBeDisabled()
    expect(screen.getByRole("button", { name: /11月21日: 完了1件.*トイレ掃除/ })).toBeInTheDocument()
    await click(quick().getByRole("button", { name: "直前の記録を取り消す" }))
    expect(saveCleaning.mock.calls[1][0]).toEqual({ op: "log_void", id: saveCleaning.mock.calls[0][0].id, version: SAVED_VERSION })
    await waitFor(() => expect(recordButton()).toBeEnabled())
    expect(screen.getByRole("button", { name: /11月21日: 完了0件/ })).toBeInTheDocument()
  })

  it("カレンダーで未来日を見られるが実施は送信できない", async () => {
    render(<CleaningView {...props()} />)
    await ready()
    await click(screen.getByRole("button", { name: /11月25日: 完了/ }))
    expect(quick().getByLabelText("実施日")).toHaveValue("2026-11-25")
    expect(recordButton()).toBeDisabled()
    expect(quick().getByText(/未来の日は実施を記録できません/)).toBeInTheDocument()
    await click(recordButton())
    expect(saveCleaning).not.toHaveBeenCalled()
    await click(screen.getByRole("button", { name: "今日に戻る" }))
    expect(quick().getByLabelText("実施日")).toHaveValue(TODAY)
    expect(recordButton()).toBeEnabled()
  })

  it("ログ一覧が切り詰められても集計で実施済みと分かる日は再記録しない", async () => {
    render(<CleaningView {...props({ marks: { [ROUTINE]: { lastDoneOn: TODAY, maxOccurrence: TODAY, maxSkipOccurrence: null } }, historyTruncated: true })} />)
    await waitFor(() => expect(quick().getByRole("button", { name: "掃除項目を追加" })).toBeEnabled())
    expect(doneButton()).toBeDisabled()
    expect(screen.getByText(/履歴の一部を読み込めていません/)).toBeInTheDocument()
    await click(doneButton())
    expect(saveCleaning).not.toHaveBeenCalled()
  })

  it.each<{ label: string; routines: CleaningRoutine[]; marks: Record<string, CleaningMarks> }>([
    { label: "休止中", routines: [{ ...ROUTINE_ROW, paused_at: VERSION }], marks: {} },
    { label: "予定回の上限", routines: [ROUTINE_ROW], marks: { [ROUTINE]: { lastDoneOn: null, maxOccurrence: "2027-01-01", maxSkipOccurrence: null } } },
  ])("$labelでも実際に今日行った掃除は記録できる", async ({ routines, marks }) => {
    saveCleaning.mockImplementation(async (request) => ({ status: "saved", log: recorded(request) }))
    render(<CleaningView {...props({ routines, marks })} />)
    await ready()
    await click(recordButton())
    expect(saveCleaning.mock.calls[0][0]).toMatchObject({ op: "backfill", doneOn: TODAY, routineId: ROUTINE })
    expect(doneButton()).toBeDisabled()
  })

  it("結果不明は完了に見せず、選択日を変えても再送は元の日付・操作IDのまま", async () => {
    saveCleaning.mockRejectedValueOnce(new Error("response lost"))
      .mockImplementation(async (request) => ({ status: "replayed", log: recorded(request) }))
    render(<CleaningView {...props()} />)
    await ready()
    await selectDate("2026-11-20")
    await click(recordButton())
    await waitFor(() => expect(screen.getByRole("button", { name: "同じ操作で確認" })).toBeInTheDocument())
    expect(quick().queryByRole("button", { name: "トイレ掃除はこの日記録済み" })).not.toBeInTheDocument()
    const sent = saveCleaning.mock.calls[0][0]
    await selectDate("2026-11-21")
    expect(recordButton()).toBeDisabled()
    await click(screen.getByRole("button", { name: "同じ操作で確認" }))
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(2))
    expect(saveCleaning.mock.calls[1][0]).toEqual(sent)
    expect(sent).toMatchObject({ op: "backfill", doneOn: "2026-11-20" })
    expect(recordButton()).toBeEnabled()
    await selectDate("2026-11-20")
    expect(doneButton()).toBeDisabled()
  })

  it("保存中に別の日を選んでも応答は記録した日にだけ表示する", async () => {
    let settle!: (value: CleaningSaveSuccess) => void
    saveCleaning.mockImplementation(() => new Promise((resolve) => { settle = resolve }))
    render(<CleaningView {...props()} />)
    await ready()
    await selectDate("2026-11-20")
    await click(recordButton())
    const sent = saveCleaning.mock.calls[0][0]
    await selectDate("2026-11-21")
    await act(async () => { settle({ status: "saved", log: recorded(sent) }) })
    expect(recordButton()).toBeEnabled()
    expect(screen.getByRole("button", { name: /11月20日: 完了1件.*トイレ掃除/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /11月21日: 完了0件/ })).toBeInTheDocument()
  })

  it("自分の項目を追加でき、6件目以降も同じ順序で選べる", async () => {
    const routines = Array.from({ length: 7 }, (_, index) => ({ ...ROUTINE_ROW,
      id: `c2000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, name: index === 0 ? "トイレ掃除" : `自由な掃除${index}` }))
    render(<CleaningView {...props({ routines })} />)
    await ready()
    expect(quick().queryByRole("button", { name: "自由な掃除6を選択日に記録" })).not.toBeInTheDocument()
    await click(quick().getByRole("button", { name: "全項目を見る（7件）" }))
    expect(quick().getByRole("button", { name: "自由な掃除6を選択日に記録" })).toBeEnabled()
    const order = quick().getAllByRole("button").filter((button) => button.hasAttribute("aria-pressed")).map((button) => button.textContent)
    expect(order).toEqual(routines.map((routine) => routine.name))
    await click(quick().getByRole("button", { name: "掃除項目を追加" }))
    expect(within(screen.getByRole("dialog")).getByRole("heading", { name: "掃除の項目を追加" })).toBeInTheDocument()
    expect(saveCleaning).not.toHaveBeenCalled()
  })

  it("掃除状況は全履歴の集計から日数を表示し、取り消しの再取得で未記録へ戻る", async () => {
    const base = props({ view: "status", marks: { [ROUTINE]: { lastDoneOn: "2026-11-21", maxOccurrence: null, maxSkipOccurrence: null } } })
    const { rerender } = render(<CleaningView {...base} />)
    expect(screen.getByText("3日前")).toBeInTheDocument()
    expect(screen.queryByTestId("cleaning-calendar")).not.toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "掃除を記録" })).not.toBeInTheDocument()
    rerender(<CleaningView {...base} marks={{}} logs={[]} />)
    expect(screen.getByText("未記録")).toBeInTheDocument()
    expect(screen.queryByText("3日前")).not.toBeInTheDocument()
  })
})
