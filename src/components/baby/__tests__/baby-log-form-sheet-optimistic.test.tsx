/**
 * B-03: BabyLogFormSheet の作成成功で楽観 append、削除成功で除去する経路の単体テスト。
 * quick-actions と同一パターン（Server Action の返却 id → onLogRecorded / 削除 → onLogRemoved）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import type { BabyLogData } from "@/lib/types/baby"

vi.mock("@/app/(main)/baby/actions", () => ({
  updateLog: vi.fn(),
  deleteLog: vi.fn(),
  recordTemperature: vi.fn(),
  recordGrowth: vi.fn(),
  recordMemo: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { BabyLogFormSheet } from "../baby-log-form-sheet"
import { recordMemo, deleteLog } from "@/app/(main)/baby/actions"

const mockedRecordMemo = vi.mocked(recordMemo)
const mockedDeleteLog = vi.mocked(deleteLog)

const memoLog: BabyLogData = {
  id: "log-del-1",
  log_type: "memo",
  logged_at: "2026-07-19T02:00:00+09:00",
  logged_by: "u1",
  feeding_type: null,
  amount_ml: null,
  diaper_type: null,
  ended_at: null,
  temperature: null,
  weight_g: null,
  height_cm: null,
  duration_min: null,
  duration_sec: null,
  memo: "既存メモ",
  created_at: "2026-07-19T02:00:00+09:00",
}

beforeEach(() => {
  vi.clearAllMocks()
  cleanup()
})
afterEach(cleanup)

describe("BabyLogFormSheet の楽観 append/remove (B-03)", () => {
  it("メモ作成成功で onLogRecorded に返却 id 付きの memo 行を渡す", async () => {
    mockedRecordMemo.mockResolvedValue({ error: null, id: "memo-created" })
    const onLogRecorded = vi.fn<(log: BabyLogData) => void>()
    render(
      <BabyLogFormSheet
        open
        onOpenChange={vi.fn()}
        log={null}
        createLogType="memo"
        userId="u1"
        onLogRecorded={onLogRecorded}
      />,
    )

    fireEvent.change(screen.getByLabelText("メモ"), {
      target: { value: "ミルク多め" },
    })
    fireEvent.click(screen.getByRole("button", { name: "記録する" }))

    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    const log = onLogRecorded.mock.calls[0][0]
    expect(log.id).toBe("memo-created")
    expect(log.log_type).toBe("memo")
    expect(log.memo).toBe("ミルク多め")
    expect(log.logged_by).toBe("u1")
  })

  it("削除成功で onLogRemoved に対象 id を渡す", async () => {
    mockedDeleteLog.mockResolvedValue({ error: null })
    const onLogRemoved = vi.fn<(id: string) => void>()
    render(
      <BabyLogFormSheet
        open
        onOpenChange={vi.fn()}
        log={memoLog}
        userId="u1"
        onLogRemoved={onLogRemoved}
      />,
    )

    // 「この記録を削除」→ 確認 →「削除する」
    fireEvent.click(screen.getByRole("button", { name: /この記録を削除/ }))
    fireEvent.click(screen.getByRole("button", { name: "削除する" }))

    await waitFor(() =>
      expect(mockedDeleteLog).toHaveBeenCalledWith("log-del-1"),
    )
    expect(onLogRemoved).toHaveBeenCalledWith("log-del-1")
  })
})
