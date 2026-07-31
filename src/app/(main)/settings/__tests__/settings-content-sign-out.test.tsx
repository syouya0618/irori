/**
 * I-02: 圏外でログアウトを叩いたときの SettingsContent の挙動を固定する。
 *
 * `handleSignOut` は startTransition 内で `purgeHouseholdCaches()` → `signOut()`
 * を await する。未処理の reject は最寄りの error boundary へ bubble し
 * (node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md:375)、
 * さらに `setIsSigningOut(true)` を戻さないとボタンが永久 disabled になる。
 *
 * `signOut()` は成功時 `redirect("/login")` を throw するため、catch は
 * **先頭で `unstable_rethrow(err)`** を呼ばねばならない。順序が崩れると
 * 「ログアウトボタンが無反応」という無音の破壊になる（setup-form.test.tsx と同型）。
 * 「redirect の内部エラーを実際に再送出する」半分は
 * src/lib/__tests__/rethrow-contract.test.ts が実物で検証済み。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"

const signOut = vi.fn()
const purgeHouseholdCaches = vi.fn().mockResolvedValue(undefined)

vi.mock("@/app/(main)/settings/actions", () => ({
  signOut: (...args: unknown[]) => signOut(...args),
}))
vi.mock("@/lib/pwa/sw-messages", () => ({
  purgeHouseholdCaches: (...args: unknown[]) => purgeHouseholdCaches(...args),
  LAST_USER_ID_STORAGE_KEY: "irori_last_user_id",
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

// 子カードは各々 server action を呼ぶため無効化する（検証対象はログアウト経路のみ）
vi.mock("@/components/settings/profile-card", () => ({ ProfileCard: () => null }))
vi.mock("@/components/settings/invite-card", () => ({ InviteCard: () => null }))
vi.mock("@/components/settings/approval-card", () => ({ ApprovalCard: () => null }))
vi.mock("@/components/settings/default-page-card", () => ({
  DefaultPageCard: () => null,
}))
vi.mock("@/components/settings/auto-stock-card", () => ({
  AutoStockCategoriesCard: () => null,
}))
vi.mock("@/components/settings/ocr-provider-card", () => ({
  OcrProviderCard: () => null,
}))
vi.mock("@/components/settings/baby-profile-card", () => ({
  BabyProfileCard: () => null,
}))
vi.mock("@/components/settings/export-card", () => ({ ExportCard: () => null }))
vi.mock("@/components/settings/theme-card", () => ({ ThemeCard: () => null }))
vi.mock("@/components/settings/help-card", () => ({ HelpCard: () => null }))

import { SettingsContent } from "../settings-content"
import { unstable_rethrow } from "next/navigation"
import { toast } from "sonner"

const mockedRethrow = vi.mocked(unstable_rethrow)
const mockedToast = vi.mocked(toast)

beforeEach(() => {
  vi.clearAllMocks()
  purgeHouseholdCaches.mockResolvedValue(undefined)
})
afterEach(cleanup)

const OFFLINE_MESSAGE = "通信できませんでした。電波の良い場所でもう一度お試しください"

function renderSettings() {
  render(
    <SettingsContent
      profile={{
        id: "u1",
        displayName: "テスト",
        avatarUrl: null,
        role: "owner",
        defaultPage: "meals",
      }}
      household={{ id: "h1", name: "我が家" }}
      email="test@example.com"
      pendingUsers={[]}
      autoStockCategories={[]}
      babyProfile={{ name: null, birthDate: null, feedingIntervalMin: 180 }}
    />,
  )
  return screen.getByRole("button", { name: "ログアウト" })
}

describe("SettingsContent の通信断 reject 握り（I-02）", () => {
  it("signOut が reject → 圏外トースト + ログアウトボタンが再び押せる", async () => {
    signOut.mockRejectedValueOnce(new Error("network down"))
    const button = renderSettings()

    fireEvent.click(button)

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE),
    )
    expect(button).not.toBeDisabled()
  })

  it("catch は toast より先に unstable_rethrow を呼ぶ（redirect を握り潰さない）", async () => {
    signOut.mockRejectedValueOnce(new Error("network down"))
    fireEvent.click(renderSettings())

    await waitFor(() => expect(mockedRethrow).toHaveBeenCalledTimes(1))
    expect(mockedRethrow.mock.invocationCallOrder[0]).toBeLessThan(
      mockedToast.error.mock.invocationCallOrder[0],
    )
  })

  it("purgeHouseholdCaches が reject しても握られる（signOut 前段の失敗）", async () => {
    purgeHouseholdCaches.mockRejectedValueOnce(new Error("sw unreachable"))
    const button = renderSettings()

    fireEvent.click(button)

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE),
    )
    expect(signOut).not.toHaveBeenCalled()
    expect(button).not.toBeDisabled()
  })
})
