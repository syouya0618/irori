import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react"

import { BabyLogFormSheet } from "../baby-log-form-sheet"
import {
  updateLog,
  deleteLog,
  recordMemo,
} from "@/app/(main)/baby/actions"
import { toast } from "sonner"
import type { BabyLogData } from "@/lib/types/baby"

vi.mock("@/app/(main)/baby/actions", () => ({
  updateLog: vi.fn(),
  deleteLog: vi.fn(),
  recordTemperature: vi.fn(),
  recordGrowth: vi.fn(),
  recordMemo: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const mockedUpdateLog = vi.mocked(updateLog)
const mockedDeleteLog = vi.mocked(deleteLog)
const mockedRecordMemo = vi.mocked(recordMemo)
const mockedToast = vi.mocked(toast)

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(cleanup)

function bottleFeedingLog(overrides: Partial<BabyLogData> = {}): BabyLogData {
  return {
    id: "log-1",
    log_type: "feeding",
    logged_at: "2026-07-18T12:00:00+09:00",
    logged_by: "user-1",
    feeding_type: "bottle",
    amount_ml: 80,
    diaper_type: null,
    ended_at: null,
    temperature: null,
    weight_g: null,
    height_cm: null,
    duration_min: null,
    memo: null,
    created_at: "2026-07-18T12:00:00+09:00",
    ...overrides,
  }
}

describe("BabyLogFormSheet の amountMl 0ml falsy 衝突", () => {
  it("量に「0」を入力して更新すると amountMl: 0 が updateLog に渡る", async () => {
    mockedUpdateLog.mockResolvedValue({ error: null })
    render(
      <BabyLogFormSheet userId="u1" open={true} onOpenChange={() => {}} log={bottleFeedingLog()} />,
    )

    const input = screen.getByLabelText("量 (ml)")
    fireEvent.change(input, { target: { value: "0" } })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))

    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalled())
    expect(mockedUpdateLog).toHaveBeenCalledWith(
      "log-1",
      expect.objectContaining({ amountMl: 0 }),
    )
  })

  it("量を空文字にして更新すると amountMl: null が updateLog に渡る（回帰）", async () => {
    mockedUpdateLog.mockResolvedValue({ error: null })
    render(
      <BabyLogFormSheet userId="u1" open={true} onOpenChange={() => {}} log={bottleFeedingLog()} />,
    )

    const input = screen.getByLabelText("量 (ml)")
    fireEvent.change(input, { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))

    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalled())
    expect(mockedUpdateLog).toHaveBeenCalledWith(
      "log-1",
      expect.objectContaining({ amountMl: null }),
    )
  })
})

// B-07: startTransition 内の Server Action が reject（通信断）すると error boundary へ
// bubble する（error-handling.md:375）。作成/更新/削除の 3 ハンドラが try/catch で
// 握り、圏外トーストへ倒すことを固定する。toast.error(OFFLINE_MESSAGE) が呼ばれる
// こと自体が catch 発火（= reject 未処理漏れなし）の証跡。
const OFFLINE_MESSAGE =
  "通信できませんでした。電波の良い場所でもう一度お試しください"

describe("BabyLogFormSheet の通信断 reject 握り（B-07）", () => {
  it("作成（メモ）の recordMemo が reject → 圏外トースト", async () => {
    mockedRecordMemo.mockRejectedValue(new Error("network down"))
    render(
      <BabyLogFormSheet
        userId="u1"
        open={true}
        onOpenChange={() => {}}
        log={null}
        createLogType="memo"
      />,
    )
    fireEvent.change(screen.getByLabelText("メモ"), {
      target: { value: "テストメモ" },
    })
    fireEvent.click(screen.getByRole("button", { name: "記録する" }))

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE),
    )
    expect(mockedToast.success).not.toHaveBeenCalled()
  })

  it("更新（updateLog）が reject → 圏外トースト", async () => {
    mockedUpdateLog.mockRejectedValue(new Error("network down"))
    render(
      <BabyLogFormSheet userId="u1" open={true} onOpenChange={() => {}} log={bottleFeedingLog()} />,
    )
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE),
    )
    expect(mockedToast.success).not.toHaveBeenCalled()
  })

  it("削除（deleteLog）が reject → 圏外トースト", async () => {
    mockedDeleteLog.mockRejectedValue(new Error("network down"))
    render(
      <BabyLogFormSheet userId="u1" open={true} onOpenChange={() => {}} log={bottleFeedingLog()} />,
    )
    fireEvent.click(screen.getByRole("button", { name: "この記録を削除" }))
    fireEvent.click(screen.getByRole("button", { name: "削除する" }))

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE),
    )
    expect(mockedToast.success).not.toHaveBeenCalled()
  })
})
