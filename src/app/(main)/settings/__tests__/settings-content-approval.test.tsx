/**
 * SettingsContent の承認カードと「読めなかった」の描き分け（P1-02 / P2-31）。
 *
 * 承認カードの可否は**運用者かどうか**だけで決まる。世帯の owner であることは
 * 根拠にならぬ（相互に信頼せぬ他世帯の新規登録者を見せることになる）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import type { PendingUser } from "@/components/settings/approval-card"

vi.mock("@/app/(main)/settings/actions", () => ({ signOut: vi.fn() }))
vi.mock("@/app/(main)/settings/push-actions", () => ({
  unsubscribeCurrentDevice: vi.fn(),
}))
vi.mock("@/lib/pwa/sw-messages", () => ({
  purgeHouseholdCaches: vi.fn(),
  setCacheOwner: vi.fn(),
  clearCacheOwner: vi.fn(),
  LAST_USER_ID_STORAGE_KEY: "irori-last-user-id",
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  unstable_rethrow: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

// 検証対象は「どのカードに何が渡るか」だけ。子カードは印だけを描く
vi.mock("@/components/settings/approval-card", () => ({
  ApprovalCard: ({ pendingUsers }: { pendingUsers: PendingUser[] | null }) => (
    <div data-testid="approval-card">
      {pendingUsers === null ? "unknown" : String(pendingUsers.length)}
    </div>
  ),
}))
vi.mock("@/components/settings/baby-profile-card", () => ({
  BabyProfileCard: ({ initialProfile }: { initialProfile: unknown }) => (
    <div data-testid="baby-profile-card">
      {initialProfile === null ? "unknown" : "ready"}
    </div>
  ),
}))
vi.mock("@/components/settings/profile-card", () => ({ ProfileCard: () => null }))
vi.mock("@/components/settings/invite-card", () => ({ InviteCard: () => null }))
vi.mock("@/components/settings/default-page-card", () => ({
  DefaultPageCard: () => null,
}))
vi.mock("@/components/settings/export-card", () => ({ ExportCard: () => null }))
vi.mock("@/components/settings/theme-card", () => ({ ThemeCard: () => null }))
vi.mock("@/components/settings/help-card", () => ({ HelpCard: () => null }))
vi.mock("@/components/settings/notification-card", () => ({
  NotificationCard: () => null,
}))
vi.mock("@/components/settings/google-calendar-card", () => ({
  GoogleCalendarCard: () => null,
}))

import { SettingsContent } from "../settings-content"

const PENDING: PendingUser = {
  id: "p1",
  display_name: "しんき",
  email: "new@example.com",
  created_at: "2026-10-01T00:00:00.000Z",
}

function renderContent(
  overrides: Partial<{
    role: "owner" | "member" | "viewer"
    isAppOperator: boolean
    pendingUsers: PendingUser[] | null
    household: { id: string; name: string } | null
    babyProfile: {
      name: string | null
      birthDate: string | null
      feedingIntervalMin: number
    } | null
  }> = {},
) {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(overrides, key)
  render(
    <SettingsContent
      profile={{
        id: "u1",
        displayName: "テスト",
        avatarUrl: null,
        role: overrides.role ?? "owner",
        defaultPage: "baby",
      }}
      household={has("household") ? overrides.household! : { id: "h1", name: "我が家" }}
      email="me@example.com"
      isAppOperator={overrides.isAppOperator ?? false}
      pendingUsers={has("pendingUsers") ? overrides.pendingUsers! : []}
      babyProfile={
        has("babyProfile")
          ? overrides.babyProfile!
          : { name: null, birthDate: null, feedingIntervalMin: 180 }
      }
      googleConnections={[]}
      googleNotice={null}
      pushDevices={[]}
      pushHealth={{
        runState: "healthy",
        ranAtLabel: "3分前",
        failedCount: 0,
        deliveryState: "sent",
        lastSentLabel: "1時間前",
      }}
      digestTime={null}
      digestTimeUnknown={false}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(cleanup)

describe("承認カードは運用者だけ（P1-02）", () => {
  it("運用者でない owner には、一覧が在っても出さぬ", () => {
    renderContent({ role: "owner", isAppOperator: false, pendingUsers: [PENDING] })
    expect(screen.queryByTestId("approval-card")).toBeNull()
  })

  it("運用者には出す（世帯の役割が member でも）", () => {
    renderContent({ role: "member", isAppOperator: true, pendingUsers: [PENDING] })
    expect(screen.getByTestId("approval-card")).toHaveTextContent("1")
  })

  it("運用者でも 0 件なら出さぬ（従来どおり）", () => {
    renderContent({ isAppOperator: true, pendingUsers: [] })
    expect(screen.queryByTestId("approval-card")).toBeNull()
  })

  it("運用者が一覧を読めなかった時は「読めなかった」を描く（0 件と偽らぬ）", () => {
    renderContent({ isAppOperator: true, pendingUsers: null })
    expect(screen.getByTestId("approval-card")).toHaveTextContent("unknown")
  })
})

describe("世帯を読めなかった時（P2-31）", () => {
  it("赤ちゃん情報カードへ null を渡し、世帯名を「未設定」と偽らぬ", () => {
    renderContent({ household: null, babyProfile: null })

    expect(screen.getByTestId("baby-profile-card")).toHaveTextContent("unknown")
    expect(screen.queryByText("世帯名未設定")).toBeNull()
    // 世帯カードの中（role=alert）と、先頭の「確認が必要な項目」の両方に出す
    expect(screen.getByRole("alert")).toHaveTextContent(/世帯の情報を取得できませんでした/)
    expect(
      screen.getByRole("link", { name: /世帯の情報を取得できませんでした/ }),
    ).toHaveAttribute("href", "#settings-family")
  })

  it("読めた時は世帯名を出す（対照）", () => {
    renderContent()
    expect(screen.getByText("我が家")).toBeInTheDocument()
    expect(screen.getByTestId("baby-profile-card")).toHaveTextContent("ready")
  })
})
