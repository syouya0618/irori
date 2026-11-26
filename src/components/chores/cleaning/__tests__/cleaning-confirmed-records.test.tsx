/** 保存の確定と再取得の間を検査する。読み取り失敗・取消・訂正を「記録なし」にすり替えない。 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CleaningRequest, CleaningSaveSuccess } from "@/lib/domain/cleaning"
import type { CleaningLog, CleaningRoutine } from "@/lib/domain/cleaning-schedule"
import type { ChoreSaveFailure } from "@/lib/domain/rpc-outcome"

const { saveCleaning, loadCleaningHistory, refresh } = vi.hoisted(() => ({
  saveCleaning: vi.fn<(request: CleaningRequest) => Promise<CleaningSaveSuccess | ChoreSaveFailure>>(),
  loadCleaningHistory: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock("@/app/(main)/chores/cleaning/actions", () => ({ saveCleaning, loadCleaningHistory }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))

import { CLEANING_UNDO_WINDOW_MS, CleaningView, type CleaningViewProps } from "../cleaning-view"

const TODAY = "2026-11-11"
const V1 = "2026-11-11T01:00:00.123456+00:00"
const V2 = "2026-11-11T02:00:00.123456+00:00"
const OWNER = { userId: "c1000000-0000-4000-8000-000000000001", householdId: "c1000000-0000-4000-8000-000000000002" }
const ROUTINE: CleaningRoutine = {
  id: "c2000000-0000-4000-8000-000000000001", name: "トイレ掃除", location: null,
  cadence_unit: "week", cadence_interval: 1, schedule_mode: "fixed", anchor_date: "2026-11-07",
  postponed_occurrence: null, postponed_until: null, paused_at: null, resume_floor: null,
  archived: false, updated_at: V1, created_at: V1,
}
function log(over: Partial<CleaningLog> = {}): CleaningLog {
  return {
    id: "c3000000-0000-4000-8000-000000000001", routine_id: ROUTINE.id,
    kind: "done", done_on: TODAY, occurrence: "2026-11-07", note: null, voided_at: null,
    created_by: OWNER.userId, updated_at: V1, created_at: V1, ...over,
  }
}
function props(over: Partial<CleaningViewProps> = {}): CleaningViewProps {
  return {
    owner: OWNER, today: TODAY, routines: [ROUTINE], marks: {}, logs: [],
    unreadableRoutines: 0, routinesTruncated: false, historyFailed: false, historyTruncated: false,
    ...over,
  }
}
const marks = (lastDoneOn: string | null) => ({ [ROUTINE.id]: { lastDoneOn, maxOccurrence: "2026-11-07", maxSkipOccurrence: null } })
const recordButton = () => screen.getByRole("button", { name: "トイレ掃除を選択日に記録" })
const recordedButton = () => screen.getByRole("button", { name: "トイレ掃除はこの日記録済み" })
async function click(element: HTMLElement) {
  await act(async () => { fireEvent.click(element) })
}
async function record() {
  await waitFor(() => expect(recordButton()).toBeEnabled())
  await click(recordButton())
}
async function openHistoryRow() {
  await click(screen.getByRole("button", { name: "トイレ掃除の詳細を開く" }))
  const dialog = await screen.findByRole("dialog")
  const row = within(dialog).getAllByTestId("cleaning-log")[0]
  await waitFor(() => expect(within(row).getByRole("button", { name: /を取り消す$/ })).toBeEnabled())
  return { dialog, row }
}
async function voidFirstLog() {
  const { dialog, row } = await openHistoryRow()
  await click(within(row).getByRole("button", { name: /を取り消す$/ }))
  await click(within(dialog).getByRole("button", { name: "この記録を取り消す" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
}
async function correctFirstLog(doneOn: string) {
  const { row } = await openHistoryRow()
  await click(within(row).getByRole("button", { name: /を訂正$/ }))
  fireEvent.change(within(row).getByLabelText("実施した日"), { target: { value: doneOn } })
  await click(within(row).getByRole("button", { name: "訂正を保存" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
}

beforeEach(() => {
  localStorage.clear()
  vi.resetAllMocks()
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-11T03:00:00.000Z"))
})
afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.useRealTimers()
})

describe("確定した掃除記録と再取得", () => {
  it("記録済みのサーバー断面を受けた後の取り消しでも、古い前回日が実施済みを復活させない", async () => {
    const previous = log({ done_on: "2026-11-01", occurrence: null })
    const base = props({ logs: [previous], marks: marks("2026-11-01") })
    let saved = log()
    saveCleaning.mockImplementation(async (request) => {
      if (request.op === "close") {
        saved = log({ id: request.id })
        return { status: "saved", log: saved }
      }
      return { status: "saved", log: { ...saved, voided_at: V2, updated_at: V2 } }
    })
    const view = render(<CleaningView {...base} />)
    await record()
    expect(recordedButton()).toBeDisabled()
    // 保存後の再取得。以降の取消は、この「今日が前回」の要約に対して行う。
    view.rerender(<CleaningView {...base} logs={[previous, saved]} marks={marks(TODAY)} />)
    await click(screen.getByRole("button", { name: "直前の記録を取り消す" }))
    await waitFor(() => expect(recordButton()).toBeEnabled())
    expect(screen.getByRole("button", { name: /^11月11日: 完了0件/ })).toBeInTheDocument()
    const card = screen.getByTestId("cleaning-item")
    expect(within(card).getByText("11月1日（日）（10日前）")).toBeInTheDocument()
    expect(saveCleaning.mock.calls[1][0]).toEqual({ op: "log_void", id: saved.id, version: V1 })
  })

  it("過去日の保存後に履歴取得だけ失敗しても確定行を保ち、次の正常な取得では家族の取消を受け入れる", async () => {
    const current = log()
    const base = props({ logs: [current], marks: marks(TODAY) })
    saveCleaning.mockImplementation(async (request) => ({
      status: "saved", log: log({ id: request.id, done_on: request.op === "backfill" ? request.doneOn : TODAY, occurrence: null }),
    }))
    const view = render(<CleaningView {...base} />)
    fireEvent.change(screen.getByLabelText("実施日"), { target: { value: "2026-11-10" } })
    await record()
    expect(recordedButton()).toBeDisabled()
    view.rerender(<CleaningView {...base} logs={[]} historyFailed={true} />)
    expect(recordedButton()).toBeDisabled()
    await click(recordedButton())
    expect(saveCleaning).toHaveBeenCalledTimes(1)
    // 正常に読めた次の断面には過去日の記録がない（家族が取り消した）。いつまでも確定行を重ねない。
    view.rerender(<CleaningView {...base} logs={[current]} />)
    await waitFor(() => expect(recordButton()).toBeEnabled())
  })

  it("全履歴を読めている時の実施日訂正は、古い日を消して前回日とカレンダーを訂正後へ合わせる", async () => {
    const current = log()
    const earlier = log({ id: "c3000000-0000-4000-8000-000000000002", done_on: "2026-11-01", occurrence: null })
    saveCleaning.mockResolvedValue({ status: "saved", log: { ...current, done_on: "2026-11-10", updated_at: V2 } })
    render(<CleaningView {...props({ logs: [current, earlier], marks: marks(TODAY) })} />)
    await correctFirstLog("2026-11-10")
    expect(recordButton()).toBeEnabled()
    expect(screen.getByRole("button", { name: /^11月11日: 完了0件/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^11月10日: 完了1件/ })).toHaveAccessibleName(/実施済み: トイレ掃除/)
    expect(within(screen.getByTestId("cleaning-item")).getByText("11月10日（火）（昨日）")).toBeInTheDocument()
  })

  it("部分履歴で前回を取り消した時は未記録と断定せず確認中にし、再取得後に正しい前回を表示する", async () => {
    const current = log()
    const base = props({ view: "status", logs: [current], marks: marks(TODAY), historyTruncated: true })
    saveCleaning.mockResolvedValue({ status: "saved", log: { ...current, voided_at: V2, updated_at: V2 } })
    const view = render(<CleaningView {...base} />)
    await voidFirstLog()
    const row = screen.getByTestId("cleaning-status-item")
    expect(within(row).getByText("確認中")).toBeInTheDocument()
    expect(within(row).queryByText("未記録")).not.toBeInTheDocument()
    expect(within(row).queryByText("実施履歴なし")).not.toBeInTheDocument()
    expect(screen.getByText("確認済みの今日の実施")).toBeInTheDocument()
    const beforeRefresh = refresh.mock.calls.length
    await click(screen.getByRole("button", { name: "もう一度読み込む" }))
    expect(refresh).toHaveBeenCalledTimes(beforeRefresh + 1)
    const older = log({ done_on: "2026-10-01", occurrence: null, updated_at: V2 })
    view.rerender(<CleaningView {...base} logs={[older]} marks={marks("2026-10-01")} />)
    expect(within(screen.getByTestId("cleaning-status-item")).getByText("41日前")).toBeInTheDocument()
    expect(screen.queryByText("確認中")).not.toBeInTheDocument()
  })

  it("部分履歴の実施日訂正でも旧集計から復活させず、確認できない項目のクイック記録を止める", async () => {
    const current = log()
    saveCleaning.mockResolvedValue({ status: "saved", log: { ...current, done_on: "2026-11-09", updated_at: V2 } })
    render(<CleaningView {...props({ logs: [current], marks: marks(TODAY), historyTruncated: true })} />)
    await correctFirstLog("2026-11-09")
    expect(screen.getByRole("button", { name: "トイレ掃除の記録を確認中" })).toBeDisabled()
    expect(screen.getByRole("button", { name: /^11月11日: 完了0件/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^11月9日: 完了1件/ })).toHaveAccessibleName(/実施済み: トイレ掃除/)
    const card = screen.getByTestId("cleaning-item")
    expect(within(card).queryByText("未記録")).not.toBeInTheDocument()
    expect(within(card).getAllByText("確認中")).toHaveLength(2)
  })

  it("対照: 一部の履歴しかなくても同日の別の実施が残っていれば、その日は実施済みと分かる", async () => {
    const current = log()
    const another = log({ id: "c3000000-0000-4000-8000-000000000002", occurrence: null })
    saveCleaning.mockImplementation(async (request) => ({ status: "saved", log: { ...(request.id === current.id ? current : another), voided_at: V2, updated_at: V2 } }))
    render(<CleaningView {...props({ logs: [current, another], marks: marks(TODAY), historyTruncated: true })} />)
    await voidFirstLog()
    expect(recordedButton()).toBeDisabled()
    expect(screen.queryByRole("button", { name: "トイレ掃除の記録を確認中" })).not.toBeInTheDocument()
  })

  it("直後の取り消し期限は保存応答から測り、期限を過ぎたクリックは新しい取消を送らない", async () => {
    saveCleaning.mockImplementation(async (request) => ({ status: "saved", log: log({ id: request.id }) }))
    render(<CleaningView {...props()} />)
    await record()
    vi.setSystemTime(new Date(Date.now() + CLEANING_UNDO_WINDOW_MS + 1))
    await click(screen.getByRole("button", { name: "直前の記録を取り消す" }))
    expect(saveCleaning).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("alert")).toHaveTextContent("取り消せる時間を過ぎました")
  })
})
