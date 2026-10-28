import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react"
import { FeedingTimer } from "../feeding-timer"
import { recordFeeding } from "@/app/(main)/baby/actions"

vi.mock("@/app/(main)/baby/actions", () => ({ recordFeeding: vi.fn() }))
vi.mock("@/lib/hooks/use-server-clock", () => ({
  useServerClock: () => ({ serverNowIso: () => new Date().toISOString(), toServerIso: () => null, deviceSkewMs: null }),
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))

const A = { userId: "user-a", householdId: "house-a" }
const B = { userId: "user-b", householdId: "house-b" }
const KEY = "irori:feeding-timer"
const read = () => JSON.parse(localStorage.getItem(KEY) ?? "null")
const stop = () => fireEvent.click(screen.getByRole("button", { name: /停止して記録/ }))
const onLogRecorded = vi.fn()
const props = { open: true, onOpenChange: vi.fn(), initialFeedingType: "breast_left" as const, onLogRecorded }

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.mocked(recordFeeding).mockReset()
  vi.mocked(recordFeeding).mockImplementation(() => new Promise(() => {}))
})
afterEach(cleanup)

describe("タイマーの持ち主交代（V9-TIMER-OWNER-RELABEL）", () => {
  it.each(["open", "closed", "unknown"] as const)("%s中に持ち主が変わっても旧ID・左右回数を新しい名義へ付け替えぬ", async (phase) => {
    const ui = render(<FeedingTimer {...props} {...A} />)
    fireEvent.click(screen.getByRole("button", { name: "右" }))
    const old = read()
    if (phase === "unknown") {
      vi.mocked(recordFeeding).mockRejectedValueOnce(new TypeError("Failed to fetch"))
      stop()
      await waitFor(() => expect(read().submission?.phase).toBe("unknown"))
    }
    if (phase === "closed") ui.rerender(<FeedingTimer {...props} {...A} open={false} />)
    vi.mocked(recordFeeding).mockClear()
    ui.rerender(<FeedingTimer {...props} {...B} />)
    const current = read()
    expect(current).toMatchObject({ ...B, leftCount: 1, rightCount: 0 })
    expect(current.clientId).not.toBe(old.clientId)
    expect(current.submission).toBeUndefined()
    stop()
    await waitFor(() => expect(recordFeeding).toHaveBeenCalledTimes(1))
    expect(vi.mocked(recordFeeding).mock.calls[0][0]).toMatchObject({ clientId: current.clientId, breastLeftCount: 1, breastRightCount: 0 })
    expect(vi.mocked(recordFeeding).mock.calls[0][0].clientId).not.toBe(old.clientId)
  })

  it.each(["success", "unknown"] as const)("Aの送信の後着%sがBの計測を消したり上書きしたり親へAの行を渡したりせぬ", async (outcome) => {
    let resolve!: (value: Awaited<ReturnType<typeof recordFeeding>>) => void
    let reject!: (reason: Error) => void
    vi.mocked(recordFeeding).mockImplementationOnce(() => new Promise((ok, fail) => { resolve = ok; reject = fail }))
    const ui = render(<FeedingTimer {...props} {...A} />)
    stop()
    await waitFor(() => expect(recordFeeding).toHaveBeenCalledTimes(1))
    ui.rerender(<FeedingTimer {...props} {...B} />)
    const current = localStorage.getItem(KEY)
    await act(async () => {
      if (outcome === "success") resolve({ error: null, id: "a-record", loggedAt: new Date().toISOString(), updatedAt: "2026-10-28T00:00:00.000Z" })
      else reject(new TypeError("Failed to fetch"))
    })
    expect(localStorage.getItem(KEY)).toBe(current)
    expect(read()).toMatchObject(B)
    expect(onLogRecorded).not.toHaveBeenCalled()
    expect(props.onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
