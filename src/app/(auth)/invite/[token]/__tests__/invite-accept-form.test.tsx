/**
 * InviteAcceptForm の「永久ローディング」回帰テスト。
 * acceptInvitation は成功時 redirect() を throw、失敗時 { error } を返す。
 * reject 時に「参加する」ボタンが永久 disabled にならないことを固定する。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"

const acceptInvitation = vi.fn()
vi.mock("../actions", () => ({
  acceptInvitation: (...args: unknown[]) => acceptInvitation(...args),
}))
vi.mock("sonner", async () => {
  const { vi: viMod } = await import("vitest")
  return { toast: { error: viMod.fn(), success: viMod.fn() } }
})

import { InviteAcceptForm } from "../invite-accept-form"
import { toast } from "sonner"

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("InviteAcceptForm 永久ローディング防止", () => {
  it("acceptInvitation が例外を投げても参加ボタンが再び押せる", async () => {
    acceptInvitation.mockRejectedValueOnce(new Error("network down"))
    render(
      <InviteAcceptForm
        invitationId="inv-1"
        householdName="田中家"
        role="member"
      />,
    )

    const button = screen.getByRole("button", { name: /参加/ })
    fireEvent.click(button)

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(button).not.toBeDisabled()
  })
})
