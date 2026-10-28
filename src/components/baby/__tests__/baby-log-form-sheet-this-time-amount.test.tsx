/**
 * 「今回だけ別の量」（2026-10-27 C2 / 受入 AC11）: いつもの量 160ml のまま、今回だけ 140ml で記録する。
 * 記録シートはいつもの量で開き、直した量を今回の行へだけ送る。いつもの量（世帯の設定）には触れぬ。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"

vi.mock("@/app/(main)/baby/actions", () => ({
  updateLog: vi.fn(),
  deleteLog: vi.fn(),
  recordFeeding: vi.fn(),
  recordDiaper: vi.fn(),
  recordTemperature: vi.fn(),
  recordGrowth: vi.fn(),
  recordMemo: vi.fn(),
  updateBottleDefault: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { BabyLogFormSheet } from "../baby-log-form-sheet"
import { recordFeeding, updateBottleDefault } from "@/app/(main)/baby/actions"

const mockedRecordFeeding = vi.mocked(recordFeeding)

beforeEach(() => {
  vi.clearAllMocks()
  mockedRecordFeeding.mockReset()
})
afterEach(cleanup)

function renderSheet() {
  render(
    <BabyLogFormSheet
      open
      onOpenChange={vi.fn()}
      log={null}
      createLogType="feeding"
      createFeedingType="bottle"
      createAmountMl={160}
      userId="u1"
      householdId="h1"
    />,
  )
}

describe("今回だけ別の量（AC11）", () => {
  it("いつもの量で開き、いつもの量は変わらぬことを押す前に読める", () => {
    renderSheet()
    expect(screen.getByLabelText(/量/)).toHaveValue(160)
    expect(screen.getByText("今回の量だけを記録します。いつもの量（160ml）は変わりません")).toBeInTheDocument()
  })

  it("140ml に直して記録すると、今回の行だけ 140ml。いつもの量の保存は呼ばぬ", async () => {
    mockedRecordFeeding.mockResolvedValueOnce({ error: null, id: "log-1" })
    renderSheet()
    fireEvent.change(screen.getByLabelText(/量/), { target: { value: "140" } })
    fireEvent.click(screen.getByRole("button", { name: "記録する" }))
    await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(1))
    expect(mockedRecordFeeding.mock.calls[0][0]).toMatchObject({ feedingType: "bottle", amountMl: 140 })
    expect(vi.mocked(updateBottleDefault)).not.toHaveBeenCalled()
  })

  it("授乳の時刻は「開始時刻」で、終わった時刻ではないことを入力欄に結び付けて示す（U07）", () => {
    renderSheet()
    const time = screen.getByLabelText("開始時刻")
    expect(time).toHaveAccessibleDescription("授乳を始めた時刻を入れてください（終わった時刻ではありません）")
  })
})
