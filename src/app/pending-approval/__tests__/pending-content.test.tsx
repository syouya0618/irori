/**
 * I-02: 圏外でログアウトを叩いたときの PendingContent の挙動を固定する。
 *
 * `handleSignOut` は startTransition ではなく **プレーンな async onClick** ゆえ、
 * reject は error boundary へ bubble せず無言の unhandled rejection になる（機序が別）。
 * さらに `setIsSigningOut(true)` を戻さないとボタンが永久 disabled になる
 * （setup-form.test.tsx と同型の「永久ローディング」）。
 *
 * `signOut()` は成功時 `redirect("/login")` を throw するため、catch は
 * **先頭で `unstable_rethrow(err)`** を呼ばねばならない。順序が崩れると
 * 「ログアウトボタンが無反応」という無音の破壊になる。
 * ここでは (1) 通常 reject の握り (2) catch 先頭が unstable_rethrow であること
 * を固定する。「redirect の内部エラーを実際に再送出する」半分は
 * src/lib/__tests__/rethrow-contract.test.ts が実物で検証済み。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"

const signOut = vi.fn()
vi.mock("../actions", () => ({
  signOut: (...args: unknown[]) => signOut(...args),
}))

// unstable_rethrow は「呼ばれたか・いつ呼ばれたか」を見るため spy 化する
// （実物の throw 挙動は rethrow-contract.test.ts が担保）。
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  unstable_rethrow: vi.fn(),
}))
vi.mock("sonner", async () => {
  const { vi: viMod } = await import("vitest")
  return { toast: { error: viMod.fn(), success: viMod.fn() } }
})

import { PendingContent } from "../pending-content"
import { unstable_rethrow } from "next/navigation"
import { toast } from "sonner"

const mockedRethrow = vi.mocked(unstable_rethrow)
const mockedToast = vi.mocked(toast)

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(cleanup)

const OFFLINE_MESSAGE = "通信できませんでした。電波の良い場所でもう一度お試しください"

describe("PendingContent の通信断 reject 握り（I-02）", () => {
  it("signOut が reject → 圏外トースト + ログアウトボタンが再び押せる", async () => {
    signOut.mockRejectedValueOnce(new Error("network down"))
    render(<PendingContent />)

    const button = screen.getByRole("button", { name: "ログアウト" })
    fireEvent.click(button)

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE),
    )
    expect(button).not.toBeDisabled()
  })

  it("catch は toast より先に unstable_rethrow を呼ぶ（redirect を握り潰さない）", async () => {
    signOut.mockRejectedValueOnce(new Error("network down"))
    render(<PendingContent />)

    fireEvent.click(screen.getByRole("button", { name: "ログアウト" }))

    await waitFor(() => expect(mockedRethrow).toHaveBeenCalledTimes(1))
    expect(mockedRethrow.mock.invocationCallOrder[0]).toBeLessThan(
      mockedToast.error.mock.invocationCallOrder[0],
    )
  })
})
