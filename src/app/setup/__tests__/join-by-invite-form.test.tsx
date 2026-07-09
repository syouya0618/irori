/**
 * JoinByInviteForm の「永久ローディング」回帰テスト。
 * joinByInviteToken は成功時 redirect() を throw、失敗時 { error } を返す。
 * reject 時に送信ボタンが永久 disabled にならないことを固定する。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"

const joinByInviteToken = vi.fn()
vi.mock("../actions", () => ({
  joinByInviteToken: (...args: unknown[]) => joinByInviteToken(...args),
}))
vi.mock("sonner", async () => {
  const { vi: viMod } = await import("vitest")
  return { toast: { error: viMod.fn(), success: viMod.fn() } }
})

import { JoinByInviteForm } from "../join-by-invite-form"
import { toast } from "sonner"

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("JoinByInviteForm 永久ローディング防止", () => {
  it("joinByInviteToken が例外を投げても送信ボタンが再び押せる", async () => {
    joinByInviteToken.mockRejectedValueOnce(new Error("network down"))
    render(<JoinByInviteForm />)

    fireEvent.change(screen.getByLabelText("招待リンク"), {
      target: { value: "https://example.com/invite/abc" },
    })
    const button = screen.getByRole("button")
    fireEvent.click(button)

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(button).not.toBeDisabled()
  })
})
