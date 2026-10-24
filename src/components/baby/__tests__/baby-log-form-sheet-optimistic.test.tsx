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
  recordFeeding: vi.fn(),
  recordDiaper: vi.fn(),
  recordTemperature: vi.fn(),
  recordGrowth: vi.fn(),
  recordMemo: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { BabyLogFormSheet } from "../baby-log-form-sheet"
import { recordMemo, recordFeeding, deleteLog } from "@/app/(main)/baby/actions"
import { toast } from "sonner"

const mockedRecordMemo = vi.mocked(recordMemo)
const mockedRecordFeeding = vi.mocked(recordFeeding)
const mockedDeleteLog = vi.mocked(deleteLog)

/** 編集を開いた時点の行の版（PostgREST の表記）。削除もこの版でしか消せぬ。 */
const MEMO_VERSION = "2026-07-19T02:00:00.123456+00:00"
/** 家族が先に保存した後の版 */
const NEWER_VERSION = "2026-07-19T02:05:00.654321+00:00"

const memoLog: BabyLogData = {
  id: "log-del-1",
  log_type: "memo",
  logged_at: "2026-07-19T02:00:00+09:00",
  logged_by: "u1",
  feeding_type: null,
  amount_ml: null,
  breast_left_count: null,
  breast_right_count: null,
  breast_left_sec: null,
  breast_right_sec: null,
  breast_start_side: null,
  diaper_type: null,
  poop_amount: null,
  temperature: null,
  weight_g: null,
  height_cm: null,
  duration_min: null,
  duration_sec: null,
  memo: "既存メモ",
  created_at: "2026-07-19T02:00:00+09:00",
  updated_at: MEMO_VERSION,
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

  it("母乳サイクル作成成功で onLogRecorded に左右の回数入りの行を渡す", async () => {
    // counts を楽観行へ乗せ忘れると、Realtime が上書きするまで
    // タイムラインが「母乳」だけ（内訳なし）で表示されてしまう。
    mockedRecordFeeding.mockResolvedValue({ error: null, id: "breast-created" })
    const onLogRecorded = vi.fn<(log: BabyLogData) => void>()
    render(
      <BabyLogFormSheet
        open
        onOpenChange={vi.fn()}
        log={null}
        createLogType="feeding"
        createFeedingType="breast"
        userId="u1"
        onLogRecorded={onLogRecorded}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "右の回数を1増やす" }))
    fireEvent.click(screen.getByRole("button", { name: "右の回数を1増やす" }))
    fireEvent.click(screen.getByRole("button", { name: "記録する" }))

    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    const log = onLogRecorded.mock.calls[0][0]
    expect(log.id).toBe("breast-created")
    expect(log.log_type).toBe("feeding")
    expect(log.feeding_type).toBe("breast")
    expect(log.breast_left_count).toBe(1)
    expect(log.breast_right_count).toBe(2)
    expect(log.amount_ml).toBeNull()
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

    // 削除も開いた時点の版を送る（版を見ぬ削除で家族の新しい編集を消させぬ）
    await waitFor(() =>
      expect(mockedDeleteLog).toHaveBeenCalledWith("log-del-1", MEMO_VERSION),
    )
    expect(onLogRemoved).toHaveBeenCalledWith("log-del-1")
  })

  it("他端末で既に削除済み（alreadyDeleted）でも onLogRemoved で画面から外し、理由を伝えて閉じる（幽霊行を残さない）", async () => {
    mockedDeleteLog.mockResolvedValue({
      error: "既に削除されています。",
      alreadyDeleted: true,
    })
    const onLogRemoved = vi.fn<(id: string) => void>()
    const onOpenChange = vi.fn()
    render(
      <BabyLogFormSheet
        open
        onOpenChange={onOpenChange}
        log={memoLog}
        userId="u1"
        onLogRemoved={onLogRemoved}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /この記録を削除/ }))
    fireEvent.click(screen.getByRole("button", { name: "削除する" }))

    await waitFor(() => expect(onLogRemoved).toHaveBeenCalledWith("log-del-1"))
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("既に削除されています。")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("対照: 通常の削除失敗（alreadyDeleted なし）は行を外さず、シートも閉じない", async () => {
    mockedDeleteLog.mockResolvedValue({ error: "ログの削除に失敗しました。" })
    const onLogRemoved = vi.fn<(id: string) => void>()
    const onOpenChange = vi.fn()
    render(
      <BabyLogFormSheet
        open
        onOpenChange={onOpenChange}
        log={memoLog}
        userId="u1"
        onLogRemoved={onLogRemoved}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /この記録を削除/ }))
    fireEvent.click(screen.getByRole("button", { name: "削除する" }))

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith("ログの削除に失敗しました。"),
    )
    expect(onLogRemoved).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})

/**
 * 削除の版ガード（PR #235 敵対レビュー P1）。A と B が同じ記録を開き、A が先に更新した後、
 * B が古い画面から削除する。サーバは 0 行を衝突として返す — B のシートは A の記録を
 * 画面から外さず、入力を残し、削除の確認を閉じ、先に保存された最新版を見せる。
 */
describe("BabyLogFormSheet の削除の版ガード", () => {
  // A が先に保存した後の行（版が進み、メモも変わっておる）
  const currentByA: BabyLogData = {
    ...memoLog,
    memo: "A が先に直したメモ",
    updated_at: NEWER_VERSION,
  }

  function renderEdit(
    props: Partial<{
      log: BabyLogData
      onLogRemoved: (id: string) => void
      onLogUpdated: (log: BabyLogData) => void
      onReloadLog: (log: BabyLogData) => void
      onOpenChange: (open: boolean) => void
    }> = {},
  ) {
    render(
      <BabyLogFormSheet
        open
        onOpenChange={props.onOpenChange ?? vi.fn()}
        log={props.log ?? memoLog}
        userId="u1"
        onLogRemoved={props.onLogRemoved}
        onLogUpdated={props.onLogUpdated}
        onReloadLog={props.onReloadLog}
      />,
    )
  }

  function confirmDelete() {
    fireEvent.click(screen.getByRole("button", { name: /この記録を削除/ }))
    fireEvent.click(screen.getByRole("button", { name: "削除する" }))
  }

  it("⭐ 削除が衝突 → A の記録を画面から外さず閉じず、入力を残し、確認を閉じ、最新版を見せる", async () => {
    mockedDeleteLog.mockResolvedValue({
      error: "この記録は別の端末で先に更新されていたため、削除しませんでした（家族またはご自身）。",
      conflict: { current: currentByA },
    })
    const onLogRemoved = vi.fn<(id: string) => void>()
    const onLogUpdated = vi.fn<(log: BabyLogData) => void>()
    const onReloadLog = vi.fn<(log: BabyLogData) => void>()
    const onOpenChange = vi.fn()
    renderEdit({ onLogRemoved, onLogUpdated, onReloadLog, onOpenChange })

    // B は削除の前にメモも打っておった（入力は捨てぬ）
    fireEvent.change(screen.getByLabelText("メモ"), {
      target: { value: "B の古い画面での入力" },
    })
    confirmDelete()

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("別の端末で先に更新されていました")
    // 先に保存された内容（A の新しいメモ）を見せる
    expect(alert).toHaveTextContent("A が先に直したメモ")
    // A の記録は消えておらぬ — 画面から外さず、シートも閉じぬ
    expect(onLogRemoved).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
    // 背後の画面は最新版へ揃える
    expect(onLogUpdated).toHaveBeenCalledWith(currentByA)
    // 入力は残る
    expect(screen.getByLabelText("メモ")).toHaveValue("B の古い画面での入力")
    // 削除の確認は閉じ、古い版のまま押し直せぬ
    expect(screen.queryByRole("button", { name: "削除する" })).toBeNull()
    expect(screen.getByRole("button", { name: /この記録を削除/ })).toBeDisabled()
    // 再編集の導線は既存の onReloadLog を使う。React 19 の async transition では alert
    // （await 後の setState）が isPending=false より先にコミットされうるゆえ、ボタンが
    // 押せるようになるのを待ってから押す（disabled のままの click は無言で捨てられる）
    const reload = screen.getByRole("button", { name: "最新の内容で編集し直す" })
    await waitFor(() => expect(reload).not.toBeDisabled())
    fireEvent.click(reload)
    expect(onReloadLog).toHaveBeenCalledWith(currentByA)
  })

  it("版を持たぬ行（作成の応答に版が無かった楽観行）の削除は deleteLog を呼ばず「画面が古い」で止める", async () => {
    const onLogRemoved = vi.fn<(id: string) => void>()
    renderEdit({ log: { ...memoLog, updated_at: null }, onLogRemoved })
    confirmDelete()
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "画面が古いため保存できませんでした。再読み込みしてからもう一度お試しください。",
      ),
    )
    expect(mockedDeleteLog).not.toHaveBeenCalled()
    expect(onLogRemoved).not.toHaveBeenCalled()
  })

  it("読み直しに失敗（衝突とも削除済みとも言えぬ）→ 行を外さず閉じず、削除を押し直せる", async () => {
    mockedDeleteLog.mockResolvedValue({
      error: "記録を削除できませんでした（最新の状態を確かめられませんでした）。画面を更新して記録を確かめてください。",
    })
    const onLogRemoved = vi.fn<(id: string) => void>()
    const onOpenChange = vi.fn()
    renderEdit({ onLogRemoved, onOpenChange })
    confirmDelete()

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringContaining("確かめられませんでした"),
      ),
    )
    expect(onLogRemoved).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.queryByRole("alert")).toBeNull()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "削除する" })).not.toBeDisabled(),
    )
  })

  it("通信断で reject した後の再試行は、同じ版で削除し直して成功する", async () => {
    mockedDeleteLog
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ error: null })
    const onLogRemoved = vi.fn<(id: string) => void>()
    renderEdit({ onLogRemoved })
    confirmDelete()

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "通信できませんでした。電波の良い場所でもう一度お試しください",
      ),
    )
    expect(onLogRemoved).not.toHaveBeenCalled()

    const retry = await screen.findByRole("button", { name: "削除する" })
    await waitFor(() => expect(retry).not.toBeDisabled())
    fireEvent.click(retry)
    await waitFor(() => expect(onLogRemoved).toHaveBeenCalledWith("log-del-1"))
    expect(mockedDeleteLog).toHaveBeenNthCalledWith(2, "log-del-1", MEMO_VERSION)
  })
})
