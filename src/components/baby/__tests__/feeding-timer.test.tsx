/**
 * FeedingTimer の「永久ローディング」回帰テスト。
 *
 * recordFeeding は redirect せず { error } を返す server action。通信断で reject
 * した場合、従来は isSaving/isSavingRef が true のまま残り、停止ボタンが永久
 * disabled・スワイプでも復帰不能になっていた。try/catch/finally で必ず戻す。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"

const recordFeeding = vi.fn()
vi.mock("@/app/(main)/baby/actions", () => ({
  recordFeeding: (...args: unknown[]) => recordFeeding(...args),
}))
vi.mock("sonner", async () => {
  const { vi: viMod } = await import("vitest")
  return { toast: { error: viMod.fn(), success: viMod.fn() } }
})

import { FeedingTimer } from "../feeding-timer"
import { toast } from "sonner"
import type { FeedingType } from "@/lib/types/database"

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

describe("FeedingTimer 永久ローディング防止", () => {
  it("recordFeeding が例外を投げても停止ボタンが再び押せる", async () => {
    render(
      <FeedingTimer
        open
        onOpenChange={vi.fn()}
        initialFeedingType="breast_left"
        userId="u1"
      />,
    )

    // open で自動的にタイマーが開始し、停止ボタンが出る
    const stop = screen.getByRole("button", { name: /停止して記録|記録中/ })

    recordFeeding.mockRejectedValueOnce(new Error("network down"))
    fireEvent.click(stop)

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    // finally で isSaving が戻り、再度押せる
    expect(stop).not.toBeDisabled()
  })

  it("成功時は記録して onOpenChange(false) で閉じる", async () => {
    const onOpenChange = vi.fn()
    recordFeeding.mockResolvedValueOnce({ error: null })
    render(
      <FeedingTimer
        open
        onOpenChange={onOpenChange}
        initialFeedingType="breast_left"
        userId="u1"
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /停止して記録|記録中/ }))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(toast.success).toHaveBeenCalled()
  })

  it("記録成功時に onLogRecorded へ返却 id 付きの feeding 行を渡す（B-03 楽観 append）", async () => {
    recordFeeding.mockResolvedValueOnce({ error: null, id: "ft-1" })
    const onLogRecorded = vi.fn()
    render(
      <FeedingTimer
        open
        onOpenChange={vi.fn()}
        initialFeedingType="breast_left"
        userId="u1"
        onLogRecorded={onLogRecorded}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /停止して記録|記録中/ }))

    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    const log = onLogRecorded.mock.calls[0][0]
    expect(log.id).toBe("ft-1")
    expect(log.log_type).toBe("feeding")
    expect(log.feeding_type).toBe("breast_left")
    expect(log.logged_by).toBe("u1")
    expect(typeof log.duration_min).toBe("number")
  })
})

describe("FeedingTimer 手動入力モード（分・秒）", () => {
  function openManual(feedingType: FeedingType = "breast_left") {
    render(
      <FeedingTimer
        open
        onOpenChange={vi.fn()}
        initialFeedingType={feedingType}
        userId="u1"
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "手動入力" }))
  }

  it("手動入力に切り替えると分・秒セレクトと記録ボタンが出る", () => {
    openManual()
    expect(screen.getByLabelText("分")).toBeInTheDocument()
    expect(screen.getByLabelText("秒")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /記録する|記録中/ }),
    ).toBeInTheDocument()
    // タイマーの停止ボタンは手動入力中は出ない
    expect(
      screen.queryByRole("button", { name: /停止して記録/ }),
    ).not.toBeInTheDocument()
  })

  it("分・秒を選んで記録すると duration_min（分）へ丸めて recordFeeding に渡る", async () => {
    recordFeeding.mockResolvedValueOnce({ error: null, id: "m-1" })
    openManual("breast_right")
    // 2分40秒 = 160秒 → 160/60 = 2.67分 → round → 3分
    fireEvent.change(screen.getByLabelText("分"), { target: { value: "2" } })
    fireEvent.change(screen.getByLabelText("秒"), { target: { value: "40" } })
    fireEvent.click(screen.getByRole("button", { name: /記録する|記録中/ }))

    await waitFor(() => expect(recordFeeding).toHaveBeenCalled())
    expect(recordFeeding).toHaveBeenCalledWith({
      feedingType: "breast_right",
      durationMin: 3,
    })
  })

  it("15分を超える選択は15分に丸める（15分まで）", async () => {
    recordFeeding.mockResolvedValueOnce({ error: null, id: "m-2" })
    openManual()
    fireEvent.change(screen.getByLabelText("分"), { target: { value: "15" } })
    fireEvent.change(screen.getByLabelText("秒"), { target: { value: "45" } })
    fireEvent.click(screen.getByRole("button", { name: /記録する|記録中/ }))

    await waitFor(() => expect(recordFeeding).toHaveBeenCalled())
    expect(recordFeeding).toHaveBeenCalledWith({
      feedingType: "breast_left",
      durationMin: 15,
    })
  })

  it("0分0秒では記録せずエラートーストを出す", () => {
    openManual()
    fireEvent.change(screen.getByLabelText("分"), { target: { value: "0" } })
    fireEvent.change(screen.getByLabelText("秒"), { target: { value: "0" } })
    fireEvent.click(screen.getByRole("button", { name: /記録する|記録中/ }))

    expect(toast.error).toHaveBeenCalledWith("授乳時間を選んでください")
    expect(recordFeeding).not.toHaveBeenCalled()
  })
})
