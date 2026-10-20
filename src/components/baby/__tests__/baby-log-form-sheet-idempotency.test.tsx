/**
 * BabyLogFormSheet の冪等 id（P2-08）と、再試行の受理（replayed）の扱い。
 *
 * - 通信断の後に**同じ入力のまま**押し直す = 同じ意図ゆえ同じ id（二重記録を作らぬ）
 * - 通信断の後に**入力を直して**押し直す = 別の意図ゆえ新しい id。同じ id で違う内容を
 *   送るとサーバは fail-loud に拒む（前回の保存が成立していた場合、画面と DB が無言で
 *   食い違うのを防ぐ。レビュー P2-3）
 * - サーバが「既に記録済み」（replayed）と返した時は楽観 append せず、知らせて閉じる
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
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { BabyLogFormSheet } from "../baby-log-form-sheet"
import { recordMemo } from "@/app/(main)/baby/actions"
import { toast } from "sonner"

const mockedRecordMemo = vi.mocked(recordMemo)
const mockedToast = vi.mocked(toast)

beforeEach(() => {
  vi.clearAllMocks()
  cleanup()
})
afterEach(cleanup)

function renderMemoSheet(props: {
  onOpenChange?: (open: boolean) => void
  onLogRecorded?: (log: unknown) => void
} = {}) {
  render(
    <BabyLogFormSheet
      open
      onOpenChange={props.onOpenChange ?? vi.fn()}
      log={null}
      createLogType="memo"
      userId="u1"
      onLogRecorded={props.onLogRecorded}
    />,
  )
}

function clientIdOf(index: number): string | undefined {
  return (mockedRecordMemo.mock.calls[index]?.[0] as { clientId?: string } | undefined)?.clientId
}

function typeMemo(value: string) {
  fireEvent.change(screen.getByLabelText("メモ"), { target: { value } })
}

function pressRecord() {
  fireEvent.click(screen.getByRole("button", { name: "記録する" }))
}

describe("BabyLogFormSheet の冪等 id（P2-08）", () => {
  it("通信断の後、同じ入力のまま押し直すと同じ冪等 id を送る", async () => {
    mockedRecordMemo
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ error: null, id: "m1" })
    renderMemoSheet()

    typeMemo("ミルク多め")
    pressRecord()
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalled())
    pressRecord()
    await waitFor(() => expect(mockedRecordMemo).toHaveBeenCalledTimes(2))

    expect(clientIdOf(0)).toMatch(/^[0-9a-f-]{36}$/)
    expect(clientIdOf(1)).toBe(clientIdOf(0))
  })

  it("通信断の後に入力を直して押し直すと新しい冪等 id を送る（別の意図）", async () => {
    mockedRecordMemo
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ error: null, id: "m2" })
    renderMemoSheet()

    typeMemo("ミルク多め")
    pressRecord()
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalled())
    typeMemo("ミルク多め・ぐずり")
    pressRecord()
    await waitFor(() => expect(mockedRecordMemo).toHaveBeenCalledTimes(2))

    expect(clientIdOf(1)).toMatch(/^[0-9a-f-]{36}$/)
    expect(clientIdOf(1)).not.toBe(clientIdOf(0))
    expect(mockedRecordMemo.mock.calls[1][0]).toMatchObject({ memo: "ミルク多め・ぐずり" })
  })

  it("対照: 通信断の前の入力変更では id は変わらぬ（開いた 1 回 = 1 つの意図）", async () => {
    mockedRecordMemo.mockResolvedValueOnce({ error: null, id: "m3" })
    renderMemoSheet()
    typeMemo("a")
    typeMemo("ab")
    pressRecord()
    await waitFor(() => expect(mockedRecordMemo).toHaveBeenCalledTimes(1))
    expect(clientIdOf(0)).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("「既に記録済み」（replayed）なら楽観 append せず、知らせて閉じる", async () => {
    mockedRecordMemo.mockResolvedValueOnce({ error: null, id: "m4", replayed: true })
    const onOpenChange = vi.fn()
    const onLogRecorded = vi.fn()
    renderMemoSheet({ onOpenChange, onLogRecorded })

    typeMemo("ミルク多め")
    pressRecord()
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))

    expect(mockedToast.success).toHaveBeenCalledWith(
      expect.stringContaining("既に記録されています"),
    )
    expect(onLogRecorded).not.toHaveBeenCalled()
  })

  it("サーバが「別の内容で記録済み」と拒んだ時はエラーとして見せ、閉じぬ", async () => {
    mockedRecordMemo.mockResolvedValueOnce({
      error: "この操作は少し前に別の内容で記録済みです。画面を更新して記録を確かめてください。",
      id: null,
    })
    const onOpenChange = vi.fn()
    renderMemoSheet({ onOpenChange })
    typeMemo("ミルク多め")
    pressRecord()
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalled())
    expect(mockedToast.error).toHaveBeenCalledWith(expect.stringContaining("別の内容で記録済み"))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
