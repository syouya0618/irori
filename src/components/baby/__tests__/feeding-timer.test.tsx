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
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /停止して記録|記録中/ }))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(toast.success).toHaveBeenCalled()
  })
})
