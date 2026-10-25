/**
 * 設定画面の分類と「確認が必要な項目」（Agent C）。
 *
 * - カードは利用目的ごとの見出し（h2）の下に並ぶ
 * - 先頭の要確認は**手を打つべきもの**だけを拾う（平穏な時は出さぬ）
 * - Google の判定は denylist（active 以外は全て要注意・enum drift 防御）
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup, within } from "@testing-library/react"
import type { GoogleConnectionView } from "@/components/settings/google-calendar-card"
import type { PushDeviceView } from "@/components/settings/notification-card"
import type { NotificationHealthView } from "@/lib/domain/notification-health"

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

// 子カードは「どの見出しの下に来るか」だけを見るため印だけを描く
for (const [path, name] of [
  ["@/components/settings/approval-card", "ApprovalCard"],
  ["@/components/settings/baby-profile-card", "BabyProfileCard"],
  ["@/components/settings/profile-card", "ProfileCard"],
  ["@/components/settings/invite-card", "InviteCard"],
  ["@/components/settings/default-page-card", "DefaultPageCard"],
  ["@/components/settings/export-card", "ExportCard"],
  ["@/components/settings/theme-card", "ThemeCard"],
  ["@/components/settings/help-card", "HelpCard"],
  ["@/components/settings/notification-card", "NotificationCard"],
  ["@/components/settings/google-calendar-card", "GoogleCalendarCard"],
] as const) {
  vi.doMock(path, () => ({ [name]: () => <div data-testid={name} /> }))
}

const { SettingsContent } = await import("../settings-content")

const healthy: NotificationHealthView = {
  runState: "healthy",
  ranAtLabel: "3分前",
  failedCount: 0,
  deliveryState: "sent",
  lastSentLabel: "1時間前",
}

function connection(o: Partial<GoogleConnectionView> = {}): GoogleConnectionView {
  return {
    id: "c1",
    googleEmail: "a@example.com",
    connectionStatus: "active",
    syncStatus: "idle",
    lastErrorKind: null,
    lastSyncedAt: null,
    calendars: [],
    ...o,
  }
}

function renderContent(
  o: Partial<{
    googleConnections: GoogleConnectionView[]
    googleConnectionsUnknown: boolean
    pushDevices: PushDeviceView[]
    pushHealth: NotificationHealthView
    isAppOperator: boolean
    pendingUsers: { id: string; display_name: string; email: string; created_at: string }[] | null
  }> = {},
) {
  render(
    <SettingsContent
      profile={{ id: "u1", displayName: "A", avatarUrl: null, role: "owner", defaultPage: "baby" }}
      household={{ id: "h1", name: "我が家" }}
      email="a@example.com"
      isAppOperator={o.isAppOperator ?? false}
      pendingUsers={o.pendingUsers === undefined ? [] : o.pendingUsers}
      babyProfile={{ name: null, birthDate: null, feedingIntervalMin: 180 }}
      googleConnections={o.googleConnections ?? []}
      googleConnectionsUnknown={o.googleConnectionsUnknown}
      googleNotice={null}
      pushDevices={o.pushDevices ?? []}
      pushHealth={o.pushHealth ?? healthy}
      digestTime={null}
      digestTimeUnknown={false}
    />,
  )
}

const attention = () =>
  screen.queryByRole("region", { name: "確認が必要な項目" })

afterEach(cleanup)

describe("利用目的ごとの分類", () => {
  it("各カードは見出しの下にまとまる", () => {
    renderContent({ isAppOperator: true, pendingUsers: [{ id: "p", display_name: "", email: "x", created_at: "" }] })
    const section = (name: string) => screen.getByRole("region", { name })
    expect(within(section("あなたと赤ちゃん")).getByTestId("ProfileCard")).toBeInTheDocument()
    expect(within(section("あなたと赤ちゃん")).getByTestId("BabyProfileCard")).toBeInTheDocument()
    expect(within(section("家族・世帯")).getByTestId("InviteCard")).toBeInTheDocument()
    expect(within(section("家族・世帯")).getByText("我が家")).toBeInTheDocument()
    expect(within(section("Google カレンダー連携")).getByTestId("GoogleCalendarCard")).toBeInTheDocument()
    expect(within(section("通知と端末")).getByTestId("NotificationCard")).toBeInTheDocument()
    expect(within(section("データの書き出し")).getByTestId("ExportCard")).toBeInTheDocument()
    expect(within(section("表示")).getByTestId("ThemeCard")).toBeInTheDocument()
    expect(within(section("表示")).getByTestId("DefaultPageCard")).toBeInTheDocument()
    expect(within(section("運用者の管理")).getByTestId("ApprovalCard")).toBeInTheDocument()
    expect(within(section("ヘルプとアカウント")).getByTestId("HelpCard")).toBeInTheDocument()
    expect(
      within(section("ヘルプとアカウント")).getByRole("button", { name: "ログアウト" }),
    ).toBeInTheDocument()
  })

  it("運用者でなければ運用者の見出しごと出さぬ（承認は家族の招待と別物）", () => {
    renderContent({ isAppOperator: false })
    expect(screen.queryByRole("region", { name: "運用者の管理" })).toBeNull()
    expect(screen.queryByTestId("ApprovalCard")).toBeNull()
  })
})

describe("確認が必要な項目", () => {
  it("平穏な時は出さぬ（本当の警告を薄めぬ）", () => {
    renderContent({ googleConnections: [connection()] })
    expect(attention()).toBeNull()
  })

  it("Google の再接続が必要なら、該当のカードへの導線を出す", () => {
    renderContent({ googleConnections: [connection({ connectionStatus: "needs_reauth" })] })
    expect(
      within(attention()!).getByRole("link", { name: /Google カレンダーの再接続が必要です/ }),
    ).toHaveAttribute("href", "#settings-google")
  })

  it("**未知の connection_status も要確認に入れる（denylist）**", () => {
    renderContent({ googleConnections: [connection({ connectionStatus: "revoked_future" })] })
    expect(within(attention()!).getByText(/再接続が必要です/)).toBeInTheDocument()
  })

  it("接続を読めなかった時は「確認できなかった」と言う（再接続とは断定せぬ）", () => {
    renderContent({ googleConnectionsUnknown: true })
    expect(within(attention()!).getByText(/接続状態を確認できませんでした/)).toBeInTheDocument()
    expect(within(attention()!).queryByText(/再接続が必要です/)).toBeNull()
  })

  it("配信基盤の停止・送れていない端末・承認待ちを拾う", () => {
    renderContent({
      pushHealth: { ...healthy, runState: "stale", ranAtLabel: "2日前" },
      pushDevices: [
        {
          id: "d",
          userAgent: "X",
          createdAt: "2026-08-01T00:00:00Z",
          lastSuccessLabel: null,
          lastFailureLabel: "1日前",
          failureCount: 2,
        },
      ],
      isAppOperator: true,
      pendingUsers: [{ id: "p", display_name: "", email: "x", created_at: "" }],
    })
    const box = attention()!
    expect(within(box).getByText(/通知の配信に問題/)).toBeInTheDocument()
    expect(within(box).getByText(/通知を送れていない端末があります/)).toBeInTheDocument()
    expect(within(box).getByRole("link", { name: /承認待ちが 1 人います/ })).toHaveAttribute(
      "href",
      "#settings-operator",
    )
  })

  it("運用者でない利用者には承認待ちを数えぬ", () => {
    renderContent({
      isAppOperator: false,
      pendingUsers: [{ id: "p", display_name: "", email: "x", created_at: "" }],
    })
    expect(attention()).toBeNull()
  })
})
