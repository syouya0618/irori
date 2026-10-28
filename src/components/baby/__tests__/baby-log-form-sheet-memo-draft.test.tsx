/**
 * 記録シートのメモの書きかけ（2026-10-27 テーマ B: 長文メモ / AC07・AC09・AC21）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react"

vi.mock("@/app/(main)/baby/actions", () => ({
  updateLog: vi.fn(),
  deleteLog: vi.fn(),
  recordFeeding: vi.fn(),
  recordDiaper: vi.fn(),
  recordTemperature: vi.fn(),
  recordGrowth: vi.fn(),
  recordMemo: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { BabyLogFormSheet } from "../baby-log-form-sheet"
import { recordMemo, recordTemperature } from "@/app/(main)/baby/actions"
import { DRAFT_SAVE_DEBOUNCE_MS } from "@/lib/hooks/use-draft"

const mockedRecordMemo = vi.mocked(recordMemo)

function renderMemo(props: { userId?: string; householdId?: string } = {}) {
  return render(
    <BabyLogFormSheet
      open
      onOpenChange={vi.fn()}
      log={null}
      createLogType="memo"
      userId={props.userId ?? "u1"}
      householdId={props.householdId ?? "h1"}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedRecordMemo.mockReset()
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("記録シートのメモの書きかけ", () => {
  it("閉じて開き直すと、同じ利用者・世帯に書きかけを示し、選んだ時だけ戻す", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const first = renderMemo()
    fireEvent.change(screen.getByLabelText("メモ"), { target: { value: "夜は 3 時に起きた。ミルク少なめ" } })
    act(() => {
      vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS + 10)
    })
    first.unmount()
    vi.useRealTimers()

    renderMemo()
    // 自動では入れ替えぬ
    expect(screen.getByLabelText("メモ")).toHaveValue("")
    expect(screen.getByText("前回のメモの書きかけがあります（この端末）")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "戻す" }))
    expect(screen.getByLabelText("メモ")).toHaveValue("夜は 3 時に起きた。ミルク少なめ")
  })

  it("別の利用者・別の世帯には示さぬ", () => {
    const first = renderMemo()
    fireEvent.change(screen.getByLabelText("メモ"), { target: { value: "A のメモ" } })
    first.unmount() // アンマウントで書き切る
    renderMemo({ userId: "u2" })
    expect(screen.queryByText(/前回のメモの書きかけ/)).toBeNull()
    cleanup()
    renderMemo({ householdId: "h2" })
    expect(screen.queryByText(/前回のメモの書きかけ/)).toBeNull()
  })

  it("記録に成功したらその書きかけを消す（次に開いても示さぬ）", async () => {
    mockedRecordMemo.mockResolvedValueOnce({ error: null, id: "m1" })
    const first = renderMemo()
    fireEvent.change(screen.getByLabelText("メモ"), { target: { value: "記録する本文" } })
    fireEvent.click(screen.getByRole("button", { name: "記録する" }))
    await waitFor(() => expect(mockedRecordMemo).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(Object.keys(localStorage).some((k) => k.startsWith("irori:draft:v1:"))).toBe(false))
    first.unmount()
    renderMemo()
    expect(screen.queryByText(/前回のメモの書きかけ/)).toBeNull()
  })

  it("戻すか決めるまでメモ欄を止め、前の書きかけを上書きも取りこぼしもせぬ", () => {
    const first = renderMemo()
    fireEvent.change(screen.getByLabelText("メモ"), { target: { value: "前の長いメモ" } })
    first.unmount()
    const second = renderMemo()
    expect(screen.getByLabelText("メモ")).toBeDisabled()
    expect(screen.getByText("上の「戻す」か「破棄」を選ぶとメモを入力できます")).toBeInTheDocument()
    second.unmount()
    renderMemo()
    fireEvent.click(screen.getByRole("button", { name: "戻す" }))
    expect(screen.getByLabelText("メモ")).not.toBeDisabled()
    expect(screen.getByLabelText("メモ")).toHaveValue("前の長いメモ")
  })

  it("止めたメモ欄は、理由の注記に読み上げで結び付く", () => {
    const first = renderMemo()
    fireEvent.change(screen.getByLabelText("メモ"), { target: { value: "前のメモ" } })
    first.unmount()
    renderMemo()
    expect(screen.getByLabelText("メモ")).toHaveAccessibleDescription(
      "上の「戻す」か「破棄」を選ぶとメモを入力できます",
    )
  })

  it("「戻す/破棄」を選ばずに記録しても、選んでおらぬ前回の書きかけは消さぬ（独立レビュー 3 周目）", async () => {
    // 体温の記録シート（メモ欄は任意）。前回のメモの書きかけを選ばずに、体温だけ入れて記録する
    vi.mocked(recordTemperature).mockResolvedValueOnce({ error: null, id: "t-1" })
    const temp = () =>
      render(
        <BabyLogFormSheet open onOpenChange={vi.fn()} log={null} createLogType="temperature" userId="u1" householdId="h1" />,
      )
    const first = temp()
    fireEvent.change(screen.getByLabelText("メモ"), { target: { value: "残すべき書きかけ" } })
    first.unmount()
    temp()
    expect(screen.getByText("前回のメモの書きかけがあります（この端末）")).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("体温 (℃)"), { target: { value: "36.8" } })
    fireEvent.click(screen.getByRole("button", { name: "記録する" }))
    await waitFor(() => expect(vi.mocked(recordTemperature)).toHaveBeenCalledTimes(1))
    // 送っておらぬ書きかけは残る
    cleanup()
    temp()
    fireEvent.click(screen.getByRole("button", { name: "戻す" }))
    expect(screen.getByLabelText("メモ")).toHaveValue("残すべき書きかけ")
  })

  it("「破棄」の後に打ったメモは書きかけとして残る", () => {
    const first = renderMemo()
    fireEvent.change(screen.getByLabelText("メモ"), { target: { value: "捨てるメモ" } })
    first.unmount()
    const second = renderMemo()
    fireEvent.click(screen.getByRole("button", { name: "破棄" }))
    fireEvent.change(screen.getByLabelText("メモ"), { target: { value: "新しいメモ" } })
    second.unmount()
    renderMemo()
    fireEvent.click(screen.getByRole("button", { name: "戻す" }))
    expect(screen.getByLabelText("メモ")).toHaveValue("新しいメモ")
  })

  it("「破棄」はその書きかけだけを消す", () => {
    const first = renderMemo()
    fireEvent.change(screen.getByLabelText("メモ"), { target: { value: "捨てる" } })
    first.unmount()
    renderMemo()
    fireEvent.click(screen.getByRole("button", { name: "破棄" }))
    expect(screen.queryByText(/前回のメモの書きかけ/)).toBeNull()
    expect(Object.keys(localStorage).some((k) => k.startsWith("irori:draft:v1:"))).toBe(false)
  })

  it("端末に書けぬ時は「下書きを残した」と言わず、閉じると消えることを示す", async () => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function () {
      throw new DOMException("full", "QuotaExceededError")
    }
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      renderMemo()
      fireEvent.change(screen.getByLabelText("メモ"), { target: { value: "残らぬ" } })
      act(() => {
        vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS + 10)
      })
      expect(screen.getByText(/端末の空きが足りず、下書きを残せませんでした/)).toBeInTheDocument()
      expect(screen.queryByText(/7日間残ります/)).toBeNull()
    } finally {
      Storage.prototype.setItem = original
    }
  })
})
