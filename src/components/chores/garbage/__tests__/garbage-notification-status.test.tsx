/**
 * ごみの画面の通知の状態（A-10）。未対応 / 未許可 / 拒否 / 登録済みを区別して言い、
 * **権限を求めず・端末を登録せず**（読むだけ）、設定画面へ案内する。
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { thisDeviceStateOf } from "@/lib/domain/push-device-state"
import { GarbageNotificationStatus } from "../garbage-notification-status"

const requestPermission = vi.fn()
const subscribe = vi.fn()

function stubPush(permission: NotificationPermission, subscription: unknown) {
  vi.stubGlobal("PushManager", function PushManager() {})
  vi.stubGlobal("Notification", { permission, requestPermission })
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      ready: Promise.resolve({
        pushManager: { getSubscription: () => Promise.resolve(subscription), subscribe },
      }),
    },
  })
}

const status = () => screen.getByTestId("garbage-notification-status")

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "synthetic-public-key")
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  Reflect.deleteProperty(navigator, "serviceWorker")
})

describe("GarbageNotificationStatus", () => {
  it.each([
    ["default", null, "not-asked", "この端末ではまだ通知を受け取っていません"],
    ["denied", null, "denied", "この端末では通知が拒否されています"],
    ["granted", null, "granted-unsubscribed", "通知は許可済みですが、この端末はまだ登録されていません"],
    ["granted", { endpoint: "https://push.example.invalid/x" }, "subscribed", "この端末は通知を受け取る登録が済んでいます"],
  ] as const)("権限 %s・購読 %o → %s", async (permission, subscription, state, title) => {
    stubPush(permission, subscription)
    render(<GarbageNotificationStatus />)
    await waitFor(() => expect(status()).toHaveAttribute("data-state", state))
    expect(status()).toHaveTextContent(title)
    // どの状態でも、権限の要求と端末の登録はここからは行わぬ
    expect(requestPermission).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
    expect(screen.getByRole("link", { name: /設定の「通知」を開く/ })).toHaveAttribute("href", "/settings")
  })

  it("登録済みでも、実際に届くことは保証せぬと言う", async () => {
    stubPush("granted", { endpoint: "https://push.example.invalid/x" })
    render(<GarbageNotificationStatus />)
    await waitFor(() => expect(status()).toHaveAttribute("data-state", "subscribed"))
    expect(status()).toHaveTextContent("実際に届くかは端末の設定や通信の状態にもよります")
  })

  it("通知に対応しておらぬ開き方（serviceWorker / PushManager が無い）は未対応", async () => {
    render(<GarbageNotificationStatus />)
    await waitFor(() => expect(status()).toHaveAttribute("data-state", "unsupported"))
    expect(status()).toHaveTextContent("この開き方では通知を受け取れません")
  })

  it("管理者の設定（VAPID）が無ければ、端末の状態より先にそう言う", async () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "")
    stubPush("granted", { endpoint: "https://push.example.invalid/x" })
    render(<GarbageNotificationStatus />)
    expect(status()).toHaveAttribute("data-state", "unconfigured")
    expect(status()).toHaveTextContent("通知の設定が未完了です")
  })
})

describe("thisDeviceStateOf（設定画面の通知カードと共有する判定）", () => {
  const base = { vapid: true, supported: true as boolean | null, denied: false, permission: "default" as NotificationPermission | null, subscribedHere: false, checkTimedOut: false }

  it("判定の順: 未設定 → 未対応 → 確認中 / 確認失敗 → 拒否 → 登録済み → 許可済み未登録 → 未許可", () => {
    expect(thisDeviceStateOf({ ...base, vapid: false, supported: false })).toBe("unconfigured")
    expect(thisDeviceStateOf({ ...base, supported: false })).toBe("unsupported")
    expect(thisDeviceStateOf({ ...base, supported: null })).toBe("checking")
    expect(thisDeviceStateOf({ ...base, supported: null, checkTimedOut: true })).toBe("check-failed")
    // 拒否は購読の有無より先（古い購読が残っていても「受け取れる」と言わぬ）
    expect(thisDeviceStateOf({ ...base, permission: "denied", subscribedHere: true })).toBe("denied")
    expect(thisDeviceStateOf({ ...base, permission: "granted", subscribedHere: true })).toBe("subscribed")
    expect(thisDeviceStateOf({ ...base, permission: "granted" })).toBe("granted-unsubscribed")
    expect(thisDeviceStateOf(base)).toBe("not-asked")
  })
})
