/**
 * プロフィールカード（P2-30）。
 *
 * `<form action={fn}>` は React 19 が action の後でフォームを reset し、表示名の入力が
 * 初回描画時の値へ戻る。保存に失敗した時は打ち直しを強い、成功した時も
 * router.refresh() が戻るまで古い名前が見える。保存ボタンを押して React の form
 * 処理を実際に通す（React は mock せぬ）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"
import { renderToString } from "react-dom/server"

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock("@/app/(main)/settings/actions", () => ({
  updateProfile: vi.fn(),
}))

import { ProfileCard } from "../profile-card"
import { updateProfile } from "@/app/(main)/settings/actions"
import { toast } from "sonner"

const mockedUpdate = vi.mocked(updateProfile)
const mockedToast = vi.mocked(toast)

const nameInput = () => screen.getByLabelText("表示名") as HTMLInputElement

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(cleanup)

describe("ProfileCard — 保存後に古い値へ戻らぬ（P2-30）", () => {
  it("保存に成功した直後も入力は保存した名前のまま", async () => {
    mockedUpdate.mockResolvedValue({ success: true })
    render(<ProfileCard profile={{ displayName: "テスト" }} email="a@example.com" />)

    fireEvent.change(nameInput(), { target: { value: "新しい名前" } })
    fireEvent.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() => expect(mockedToast.success).toHaveBeenCalledTimes(1))
    expect((mockedUpdate.mock.calls[0][0] as FormData).get("display_name")).toBe(
      "新しい名前",
    )
    expect(nameInput().value).toBe("新しい名前")
  })

  it("SSR の form は action を javascript: の番兵にする（onSubmit 化で素の GET にせぬ）", () => {
    const html = renderToString(
      <ProfileCard profile={{ displayName: "テスト" }} email="a@example.com" />,
    )
    expect(html).toMatch(/<form[^>]*action="javascript:/)
  })

  it("保存に失敗しても入力は残る（打ち直しを強いぬ）", async () => {
    mockedUpdate.mockResolvedValue({ error: "プロフィールの更新に失敗しました" })
    render(<ProfileCard profile={{ displayName: "テスト" }} email="a@example.com" />)

    fireEvent.change(nameInput(), { target: { value: "新しい名前" } })
    fireEvent.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith("プロフィールの更新に失敗しました"),
    )
    expect(nameInput().value).toBe("新しい名前")
  })
})
