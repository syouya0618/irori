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
