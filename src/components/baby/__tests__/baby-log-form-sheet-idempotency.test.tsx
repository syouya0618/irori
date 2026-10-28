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
import { listPendingSaves } from "@/lib/domain/pending-saves-storage"

const mockedRecordMemo = vi.mocked(recordMemo)
const mockedToast = vi.mocked(toast)

beforeEach(() => {
  vi.clearAllMocks()
  // clearAllMocks は Once の待ち行列を消さぬ。落ちたテストの未消費の応答が次のテストへ漏れて
  // 連鎖して赤になるゆえ、記録の mock は実装ごと戻す
  mockedRecordMemo.mockReset()
  localStorage.clear()
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

/**
 * 「記録する」を押す。送信中は釦の名前が「記録中...」に変わるゆえ、送信中でない名前が戻るまで待ってから押す。
 * React 19 では await の後の setState（toast の呼び出し等）が isPending=false より先に commit されうる。
 * 負荷の下では、toast を見た直後でも釦はまだ送信中のことがある（全件の実行でだけ落ちる揺れの原因）
 */
async function pressRecord() {
  fireEvent.click(await screen.findByRole("button", { name: "記録する" }))
}

describe("BabyLogFormSheet の冪等 id（P2-08）", () => {
  it("通信断の後、同じ入力のまま押し直すと同じ冪等 id を送る", async () => {
    mockedRecordMemo
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ error: null, id: "m1" })
    renderMemoSheet()

    typeMemo("ミルク多め")
    await pressRecord()
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalled())
    await pressRecord()
    await waitFor(() => expect(mockedRecordMemo).toHaveBeenCalledTimes(2))

    expect(clientIdOf(0)).toMatch(/^[0-9a-f-]{36}$/)
    expect(clientIdOf(1)).toBe(clientIdOf(0))
  })


  it("結果の分からぬ送信の後に入力を直しても id は作り直さぬ（新しい id は本当の二重記録になる。2026-10-27 A2）", async () => {
    // 旧版はここで新しい id を作っていた。先の保存が成立しておれば、新しい id の直した内容が 2 件目に
    // なる。同じ id なら、成立しておればサーバが conflict と確定行を返し、成立しておらねば直した内容で
    // 1 件だけ記録される（どちらでも 1 件）
    mockedRecordMemo
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ error: null, id: "m2" })
    renderMemoSheet()

    typeMemo("ミルク多め")
    await pressRecord()
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalled())
    // 失敗とも記録済みとも言わず、押し直しが二重にならぬことを示す
    expect(screen.getByRole("status")).toHaveTextContent("保存できたか確認できていません")
    typeMemo("ミルク多め・ぐずり")
    await pressRecord()
    await waitFor(() => expect(mockedRecordMemo).toHaveBeenCalledTimes(2))

    expect(clientIdOf(1)).toBe(clientIdOf(0))
    expect(mockedRecordMemo.mock.calls[1][0]).toMatchObject({ memo: "ミルク多め・ぐずり" })
  })

  it("対照: 通信断の前の入力変更では id は変わらぬ（開いた 1 回 = 1 つの意図）", async () => {
    mockedRecordMemo.mockResolvedValueOnce({ error: null, id: "m3" })
    renderMemoSheet()
    typeMemo("a")
    typeMemo("ab")
    await pressRecord()
    await waitFor(() => expect(mockedRecordMemo).toHaveBeenCalledTimes(1))
    expect(clientIdOf(0)).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("「既に記録済み」（replayed）なら楽観 append せず、知らせて閉じる", async () => {
    mockedRecordMemo.mockResolvedValueOnce({ error: null, id: "m4", replayed: true })
    const onOpenChange = vi.fn()
    const onLogRecorded = vi.fn()
    renderMemoSheet({ onOpenChange, onLogRecorded })

    typeMemo("ミルク多め")
    await pressRecord()
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))

    expect(mockedToast.success).toHaveBeenCalledWith(
      expect.stringContaining("記録済みでした"),
    )
    // 確定行を持たぬ応答（古い形）では時刻を知らぬゆえ行を組まぬ
    expect(onLogRecorded).not.toHaveBeenCalled()
  })

  it("replayed が確定行を持てば、その行（DB の版・時刻）を画面へ出す", async () => {
    const stored = {
      id: "m5",
      log_type: "memo",
      logged_at: "2026-10-27T03:00:00+00:00",
      logged_by: "u1",
      memo: "ミルク多め",
      updated_at: "2026-10-27T03:00:00.123456+00:00",
    }
    mockedRecordMemo.mockResolvedValueOnce({
      error: null,
      id: "m5",
      replayed: true,
      log: stored as never,
    })
    const onLogRecorded = vi.fn()
    renderMemoSheet({ onLogRecorded })
    typeMemo("ミルク多め")
    await pressRecord()
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledWith(stored))
  })

  it("サーバが「別の内容で記録済み」（conflict）と返した時は確定行を出してエラーを見せ、入力を残して閉じぬ", async () => {
    const current = {
      id: "m6",
      log_type: "memo",
      logged_at: "2026-10-27T03:00:00+00:00",
      logged_by: "u1",
      memo: "前の内容",
      updated_at: "2026-10-27T03:00:00.123456+00:00",
    }
    mockedRecordMemo.mockResolvedValueOnce({
      error: "この操作は少し前に別の内容で記録済みです。画面を更新して記録を確かめてください。",
      id: null,
      failure: "conflict",
      conflict: { current: current as never },
    })
    const onOpenChange = vi.fn()
    const onLogRecorded = vi.fn()
    renderMemoSheet({ onOpenChange, onLogRecorded })
    typeMemo("ミルク多め")
    await pressRecord()
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalled())
    expect(mockedToast.error).toHaveBeenCalledWith(expect.stringContaining("別の内容で記録済み"))
    expect(onLogRecorded).toHaveBeenCalledWith(current)
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.getByLabelText("メモ")).toHaveValue("ミルク多め")
  })

  it("結果不明の後に直して送り、それが拒まれても、控えは最初の内容のまま残す（独立レビュー 2 周目 S1 を反転）", async () => {
    mockedRecordMemo
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ error: "認証されていません", id: null, failure: "rejected" })
    render(
      <BabyLogFormSheet open onOpenChange={vi.fn()} log={null} createLogType="memo" userId="u1" householdId="h1" />,
    )
    typeMemo("最初に送った本文")
    await pressRecord()
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalled())
    typeMemo("直した本文")
    await pressRecord()
    await waitFor(() => expect(mockedRecordMemo).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenLastCalledWith(expect.stringContaining("認証されていません（前の送信が保存されたかは")),
    )
    const raw = listPendingSaves({ userId: "u1", householdId: "h1" })
    expect(raw).toHaveLength(1)
    expect(raw[0]).toMatchObject({ phase: "unknown", payload: { memo: "最初に送った本文" } })
    expect(raw[0].payload.clientId).toBe(clientIdOf(0))
  })

  it("持ち主（householdId）を渡せば、結果の分からぬ作成を端末に残し、確定したら消す（AC06）", async () => {
    mockedRecordMemo
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ error: null, id: "m7" })
    render(
      <BabyLogFormSheet
        open
        onOpenChange={vi.fn()}
        log={null}
        createLogType="memo"
        userId="u1"
        householdId="h1"
      />,
    )
    typeMemo("ミルク多め")
    await pressRecord()
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalled())
    const raw = listPendingSaves({ userId: "u1", householdId: "h1" })
    expect(raw).toHaveLength(1)
    // 要約に本文は入れぬ（端末に残る一覧は種別だけ）
    expect(raw[0]).toMatchObject({ action: "recordMemo", summary: "メモ", owner: { userId: "u1", householdId: "h1" } })
    await pressRecord()
    await waitFor(() => expect(mockedRecordMemo).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(listPendingSaves({ userId: "u1", householdId: "h1" })).toHaveLength(0))
  })
})
