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

function activeSleepLog(overrides: Partial<BabyLogData> = {}): BabyLogData {
  return {
    id: "sleep-1",
    log_type: "sleep",
    logged_at: "2026-07-19T08:30:00Z",
    logged_by: "user-1",
    feeding_type: null,
    amount_ml: null,
    diaper_type: null,
    ended_at: null,
    temperature: null,
    weight_g: null,
    height_cm: null,
    duration_min: null,
    memo: null,
    created_at: "2026-07-19T08:30:00Z",
    ...overrides,
  }
}

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

// B-07: startTransition 内で Server Action が reject（通信断）すると、
// unhandled reject が error boundary へ bubble し全画面エラー化 + 記録無言喪失する
// (node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md:375)。
// 各ハンドラが try/catch で握って圏外トーストへ倒すことを固定する。
// toast.error(OFFLINE_MESSAGE) が呼ばれること自体が「catch が発火した=reject が
// 未処理で漏れていない」ことの証跡になる（catch 内でしか呼ばれない文言）。
const OFFLINE_MESSAGE =
  "通信できませんでした。電波の良い場所でもう一度お試しください"

describe("BabyQuickActions の通信断 reject 握り（B-07）", () => {
  it("授乳（ミルク）記録が reject → 圏外トースト", async () => {
    mockedRecordFeeding.mockRejectedValue(new Error("network down"))
    render(
      <BabyQuickActions
        activeSleep={null}
        now={new Date()}
        onCreateLog={() => {}}
        onStartTimer={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE),
    )
    expect(mockedToast.success).not.toHaveBeenCalled()
  })

  it("おむつ記録が reject → 圏外トースト", async () => {
    mockedRecordDiaper.mockRejectedValue(new Error("network down"))
    render(
      <BabyQuickActions
        activeSleep={null}
        now={new Date()}
        onCreateLog={() => {}}
        onStartTimer={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE),
    )
    expect(mockedToast.success).not.toHaveBeenCalled()
  })

  it("睡眠開始（ねんね）が reject → 圏外トースト", async () => {
    mockedStartSleep.mockRejectedValue(new Error("network down"))
    render(
      <BabyQuickActions
        activeSleep={null}
        now={new Date()}
        onCreateLog={() => {}}
        onStartTimer={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "ねんね" }))
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE),
    )
    expect(mockedToast.success).not.toHaveBeenCalled()
  })

  it("睡眠終了（起こす）が reject → 圏外トースト", async () => {
    mockedEndSleep.mockRejectedValue(new Error("network down"))
    // logged_at 08:30 / now 10:00 = 90 分経過 → トグルの表示名は「1時間30分」
    render(
      <BabyQuickActions
        activeSleep={activeSleepLog()}
        now={new Date("2026-07-19T10:00:00Z")}
        onCreateLog={() => {}}
        onStartTimer={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "1時間30分" }))
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE),
    )
    expect(mockedToast.success).not.toHaveBeenCalled()
  })

  it("記録取り消し（undoLog）の deleteLog が reject → 圏外トースト", async () => {
    // まず記録成功で「取り消す」アクション付きトーストを得る
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "log-9" })
    mockedDeleteLog.mockRejectedValue(new Error("network down"))
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

    const undoOpts = mockedToast.success.mock.calls.at(-1)?.[1] as
      | { action?: { onClick: () => void } }
      | undefined
    undoOpts?.action?.onClick()
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE),
    )
  })
})

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
