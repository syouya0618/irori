import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
vi.mock("@/app/(main)/settings/actions", () => ({ updateFeedingReminder: vi.fn() }))
import { updateFeedingReminder } from "@/app/(main)/settings/actions"
import { FeedingReminderControl } from "../feeding-reminder-control"
const update = vi.mocked(updateFeedingReminder)
function show(minutes: number | null = null, unknown = false, reachable = true) {
  return render(<FeedingReminderControl minutes={minutes} unknown={unknown} reachable={reachable} reachabilityKnown />)
}
beforeEach(() => { update.mockReset() })
afterEach(cleanup)
describe("次の授乳を通知", () => {
  it("既定OFFで勝手に保存/権限要求せず、明示操作で15分前を保存", async () => {
    update.mockResolvedValue({ success: true }); show()
    expect(screen.getByRole("combobox")).toHaveTextContent("通知しない")
    expect(update).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "15分前で始める" }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(15))
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveTextContent("15分前"))
  })
  it("5/10/15/30分前とOFFだけを選べる", async () => {
    show(15)
    fireEvent.click(screen.getByRole("combobox"))
    await waitFor(() => expect(screen.getAllByRole("option").map((e) => e.textContent)).toEqual(["通知しない", "5分前", "10分前", "15分前", "30分前"]))
  })
  it("取得失敗をOFFとせず、操作を止める", () => {
    show(null, true)
    expect(screen.getByRole("combobox")).toBeDisabled()
    expect(screen.getByRole("combobox")).toHaveTextContent("確認できません")
    expect(screen.queryByRole("button", { name: "15分前で始める" })).not.toBeInTheDocument()
  })
  it("応答喪失は保存結果不明とし、OFF表示へ巻き戻さない", async () => {
    update.mockRejectedValue(new Error("network")); show()
    fireEvent.click(screen.getByRole("button", { name: "15分前で始める" }))
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveTextContent("確認できません"))
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("保存結果を確認できません"))
    expect(screen.getByRole("combobox")).toBeDisabled()
  })
  it("購読ゼロは設定ONと区別して知らせる", () => {
    show(15, false, false)
    expect(screen.getByText(/通知を受け取る端末がありません/)).toBeVisible()
  })
})
