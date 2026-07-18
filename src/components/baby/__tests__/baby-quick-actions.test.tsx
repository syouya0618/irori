import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react"

import { BabyQuickActions } from "../baby-quick-actions"
import {
  recordFeeding,
  recordDiaper,
  startSleep,
  endSleep,
  deleteLog,
} from "@/app/(main)/baby/actions"
import { toast } from "sonner"
import type { BabyLogData } from "@/lib/types/baby"

vi.mock("@/app/(main)/baby/actions", () => ({
  recordFeeding: vi.fn(),
  recordDiaper: vi.fn(),
  startSleep: vi.fn(),
  endSleep: vi.fn(),
  deleteLog: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const mockedRecordFeeding = vi.mocked(recordFeeding)
const mockedRecordDiaper = vi.mocked(recordDiaper)
const mockedStartSleep = vi.mocked(startSleep)
const mockedEndSleep = vi.mocked(endSleep)
const mockedDeleteLog = vi.mocked(deleteLog)
const mockedToast = vi.mocked(toast)

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(cleanup)

function lastSuccessOptions() {
  const call = mockedToast.success.mock.calls.at(-1)
  return call?.[1] as
    | { action?: { label: string; onClick: () => void } }
    | undefined
}

describe("BabyQuickActions の押し間違い取り消し", () => {
  it("授乳記録後のトーストの「取り消す」が deleteLog を呼ぶ", async () => {
    mockedRecordFeeding.mockResolvedValue({ error: null, id: "log-1" })
    mockedDeleteLog.mockResolvedValue({ error: null })
    render(
      <BabyQuickActions
        activeSleep={null}
        now={new Date()}
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalled())
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())

    const opts = lastSuccessOptions()
    expect(opts?.action?.label).toBe("取り消す")
    opts?.action?.onClick()
    await waitFor(() =>
      expect(mockedDeleteLog).toHaveBeenCalledWith("log-1"),
    )
  })

  it("おむつ記録後も id 付きで「取り消す」を提示する", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "log-2" })
    render(
      <BabyQuickActions
        activeSleep={null}
        now={new Date()}
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())
    expect(lastSuccessOptions()?.action?.label).toBe("取り消す")
  })

  it("id が無い場合は取り消しアクションを付けない", async () => {
    // 実アクションは成功時に必ず string id を返すため { error: null, id: null }
    // は到達不能。だが successWithUndo は id 欠落を防御ガードしており、その分岐を
    // 固定するため二段キャストで意図的に到達不能な状態を注入する。
    mockedRecordFeeding.mockResolvedValue({
      error: null,
      id: null,
    } as unknown as Awaited<ReturnType<typeof recordFeeding>>)
    render(
      <BabyQuickActions
        activeSleep={null}
        now={new Date()}
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())
    expect(lastSuccessOptions()?.action).toBeUndefined()
  })
})

describe("BabyQuickActions の楽観 append (B-03)", () => {
  it("おむつ記録成功で onLogRecorded に返却 id 付きの diaper 行を渡す", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-33" })
    const onLogRecorded = vi.fn<(log: BabyLogData) => void>()
    render(
      <BabyQuickActions
        activeSleep={null}
        now={new Date()}
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
        onLogRecorded={onLogRecorded}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "うんち" }))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    const log = onLogRecorded.mock.calls[0][0]
    expect(log.id).toBe("diaper-33")
    expect(log.log_type).toBe("diaper")
    expect(log.diaper_type).toBe("poop")
    expect(log.logged_by).toBe("u1")
  })

  it("睡眠開始成功で onLogRecorded に ended_at=null の sleep 行を渡す", async () => {
    mockedStartSleep.mockResolvedValue({ error: null, id: "sleep-33" })
    const onLogRecorded = vi.fn<(log: BabyLogData) => void>()
    render(
      <BabyQuickActions
        activeSleep={null}
        now={new Date()}
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
        onLogRecorded={onLogRecorded}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "ねんね" }))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    const log = onLogRecorded.mock.calls[0][0]
    expect(log.id).toBe("sleep-33")
    expect(log.log_type).toBe("sleep")
    expect(log.ended_at).toBeNull()
  })

  it("睡眠終了成功で onSleepEnded(id, endedAt) を渡す（logs の楽観更新用）", async () => {
    const activeSleep: BabyLogData = {
      id: "sleep-active",
      log_type: "sleep",
      logged_at: "2026-07-19T00:00:00+09:00",
      logged_by: "u1",
      feeding_type: null,
      amount_ml: null,
      diaper_type: null,
      ended_at: null,
      temperature: null,
      weight_g: null,
      height_cm: null,
      duration_min: null,
      memo: null,
      created_at: "2026-07-19T00:00:00+09:00",
    }
    mockedEndSleep.mockResolvedValue({ error: null })
    const onSleepEnded = vi.fn<(id: string, endedAt: string) => void>()
    render(
      <BabyQuickActions
        activeSleep={activeSleep}
        now={new Date()}
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
        onSleepEnded={onSleepEnded}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /(時間|分|起こす)/ }))
    await waitFor(() => expect(mockedEndSleep).toHaveBeenCalledWith("sleep-active"))
    expect(onSleepEnded).toHaveBeenCalledTimes(1)
    expect(onSleepEnded.mock.calls[0][0]).toBe("sleep-active")
    expect(typeof onSleepEnded.mock.calls[0][1]).toBe("string")
  })

  it("Undo 成功で onLogRemoved(id) を渡す", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-77" })
    mockedDeleteLog.mockResolvedValue({ error: null })
    const onLogRemoved = vi.fn<(id: string) => void>()
    render(
      <BabyQuickActions
        activeSleep={null}
        now={new Date()}
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
        onLogRemoved={onLogRemoved}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())
    lastSuccessOptions()?.action?.onClick()
    await waitFor(() => expect(onLogRemoved).toHaveBeenCalledWith("diaper-77"))
  })
})
