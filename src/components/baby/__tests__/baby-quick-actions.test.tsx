import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react"

import { BabyQuickActions } from "../baby-quick-actions"
import { recordFeeding, recordDiaper, deleteLog } from "@/app/(main)/baby/actions"
import { toast } from "sonner"

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
        onCreateLog={() => {}}
        onStartTimer={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())
    expect(lastSuccessOptions()?.action).toBeUndefined()
  })
})
