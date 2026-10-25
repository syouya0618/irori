/**
 * 通知カードの「この端末」と「受け取る端末」の言い分け（Agent C）。
 *
 * 許可（ブラウザの権限）・登録（購読）・配信（届いたか）は別物じゃ。1 つの「有効/無効」に
 * 潰すと、許可したのに登録が無い・登録したのに届いておらぬ、を利用者が区別できぬ。
 * また端末一覧を**読めなかった**ことを「端末が無い」と描かぬ。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, waitFor, act } from "@testing-library/react"

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))
vi.mock("@/app/(main)/settings/push-actions", () => ({
  savePushSubscriptionAndSendTest: vi.fn(),
  deletePushSubscription: vi.fn(),
}))
vi.mock("@/app/(main)/settings/actions", () => ({
  updateDigestTime: vi.fn(),
}))

import { NotificationCard, type PushDeviceView } from "../notification-card"
import { toast } from "sonner"
import type { NotificationHealthView } from "@/lib/domain/notification-health"

const healthy: NotificationHealthView = {
  runState: "healthy",
  ranAtLabel: "3分前",
  failedCount: 0,
  deliveryState: "sent",
  lastSentLabel: "1時間前",
}

function device(o: Partial<PushDeviceView> = {}): PushDeviceView {
  return {
    id: "d1",
    userAgent: "iPhone の Safari",
    createdAt: "2026-08-01T00:00:00.000Z",
    lastSuccessLabel: "1時間前",
    lastFailureLabel: null,
    failureCount: 0,
    ...o,
  }
}

/** この端末のブラウザを用意する（権限と購読の有無を選ぶ）。 */
function stubBrowser(permission: NotificationPermission, subscribed: boolean) {
  vi.stubGlobal("navigator", {
    userAgent: "test",
    serviceWorker: {
      ready: Promise.resolve({
        pushManager: {
          getSubscription: () =>
            Promise.resolve(subscribed ? { endpoint: "https://push.example/x" } : null),
        },
      }),
      getRegistration: () => Promise.resolve(undefined),
    },
  })
  vi.stubGlobal("PushManager", class {})
  vi.stubGlobal("Notification", { permission, requestPermission: vi.fn() })
}

/** 「この端末」の状態の塊（正常時は 1 行に畳まれ、見出し「この端末」を持たぬ）。 */
const thisDevice = () => {
  const el = screen
    .getAllByRole("status")
    .find((s) => (s.textContent ?? "").includes("この端末") || /確認|設定が未完了|拒否|開き方/.test(s.textContent ?? ""))
  if (!el) throw new Error("この端末の状態の塊が見つからぬ")
  return el
}

function renderCard(o: Partial<Parameters<typeof NotificationCard>[0]> = {}) {
  return render(
    <NotificationCard
      devices={[]}
      health={healthy}
      digestTime={null}
      digestTimeUnknown={false}
      {...o}
    />,
  )
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "BElocal-test-key")
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("この端末: 権限と登録を分けて言う", () => {
  it("管理者の設定（VAPID）が無ければ未完了と言い、受け取るボタンを出さぬ", () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "")
    renderCard()
    expect(thisDevice()).toHaveTextContent("通知の設定が未完了です")
    expect(screen.queryByRole("button", { name: /この端末で通知を受け取る/ })).toBeNull()
  })

  it("Push の無い開き方（iOS の Safari タブ等）ではホーム画面への追加を案内する", async () => {
    // jsdom の既定 navigator には serviceWorker が無い
    renderCard()
    await waitFor(() =>
      expect(thisDevice()).toHaveTextContent("この開き方では通知を受け取れません"),
    )
    expect(thisDevice()).toHaveTextContent("ホーム画面に追加")
  })

  it("権限が拒否されていれば、ブラウザの設定から戻すよう案内する", async () => {
    stubBrowser("denied", false)
    renderCard()
    await waitFor(() => expect(thisDevice()).toHaveTextContent("通知が拒否されています"))
  })

  it("まだ聞いていなければ「まだ受け取っていません」", async () => {
    stubBrowser("default", false)
    renderCard()
    await waitFor(() =>
      expect(thisDevice()).toHaveTextContent("この端末ではまだ受け取っていません"),
    )
    expect(screen.getByRole("button", { name: /この端末で通知を受け取る/ })).toBeEnabled()
  })

  it("許可はあるが登録が無い状態を「受け取れる」と偽らぬ", async () => {
    stubBrowser("granted", false)
    renderCard()
    await waitFor(() =>
      expect(thisDevice()).toHaveTextContent("許可済みですが、まだ登録されていません"),
    )
    expect(thisDevice()).not.toHaveTextContent("この端末で受け取れます")
  })

  it("SW の準備が解決せぬ環境でも「確認しています」で固めず、期限後にボタンを押せる", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      vi.stubGlobal("navigator", {
        userAgent: "test",
        serviceWorker: {
          ready: new Promise<never>(() => {}),
          getRegistration: () => Promise.resolve(undefined),
        },
      })
      vi.stubGlobal("PushManager", class {})
      vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn() })
      renderCard()
      expect(thisDevice()).toHaveTextContent("確認しています")
      expect(screen.getByRole("button", { name: /この端末で通知を受け取る/ })).toBeDisabled()
      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      expect(thisDevice()).toHaveTextContent("この端末の状態を確認できませんでした")
      expect(screen.getByRole("button", { name: /この端末で通知を受け取る/ })).toBeEnabled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("期限切れの後にボタンを押しても「設定中…」で固まらず、理由を告げて戻る", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      vi.stubGlobal("navigator", {
        userAgent: "test",
        serviceWorker: {
          ready: new Promise<never>(() => {}),
          getRegistration: () => Promise.resolve(undefined),
        },
      })
      vi.stubGlobal("PushManager", class {})
      vi.stubGlobal("Notification", {
        permission: "default",
        requestPermission: vi.fn().mockResolvedValue("granted"),
      })
      renderCard()
      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      const button = screen.getByRole("button", { name: /この端末で通知を受け取る/ })
      await act(async () => {
        button.click()
      })
      expect(screen.getByRole("button", { name: /設定中/ })).toBeDisabled()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/通知の準備が整いませんでした/))
      expect(screen.getByRole("button", { name: /この端末で通知を受け取る/ })).toBeEnabled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("登録済みなら受け取れると言い、届いたかは端末一覧を見るよう添える", async () => {
    stubBrowser("granted", true)
    renderCard({ devices: [device()] })
    await waitFor(() => expect(thisDevice()).toHaveTextContent("この端末で受け取れます"))
    // 正常時は 1 行に畳み、説明の文を重ねぬ（届いたかは端末一覧の「最終受信」が言う）
    expect(thisDevice()).not.toHaveTextContent("届いているかは")
    expect(screen.getByText(/最終受信/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /この端末へテスト通知を送る/ })).toBeInTheDocument()
  })
})

describe("受け取る端末: 無い・読めない・在る を言い分ける", () => {
  it("この端末が登録済みなのに一覧がまだ空（再描画前）なら、「届きません」と食い違わせぬ", async () => {
    stubBrowser("granted", true)
    renderCard({ devices: [] })
    await waitFor(() => expect(thisDevice()).toHaveTextContent("この端末で受け取れます"))
    expect(screen.queryByText(/通知を受け取れる端末がまだありません/)).toBeNull()
    expect(screen.queryByText(/（0台）/)).toBeNull()
  })

  it("端末が 0 台なら、通知が届かぬことをカードに書く", () => {
    renderCard({ devices: [] })
    expect(screen.getByText("通知を受け取る端末（0台）")).toBeInTheDocument()
    expect(screen.getByText(/通知を受け取れる端末がまだありません/)).toBeInTheDocument()
  })

  it("**一覧を読めなかった時は「端末が無い」と言わず、まとめの「届きません」も出さぬ**", () => {
    renderCard({ devices: [], devicesUnknown: true, digestTime: "07:00" })
    expect(screen.getByRole("alert")).toHaveTextContent("端末の一覧を取得できませんでした")
    expect(screen.queryByText(/通知を受け取れる端末がまだありません/)).toBeNull()
    expect(screen.queryByText(/この時刻に設定してもまだ届きません/)).toBeNull()
    expect(screen.queryByText(/（0台）/)).toBeNull()
  })

  it("対照: 読めて 0 台なら、まとめに「まだ届きません」を出す", () => {
    renderCard({ devices: [], digestTime: "07:00" })
    expect(screen.getByText(/この時刻に設定してもまだ届きません/)).toBeInTheDocument()
  })

  it("端末ごとに状態の札を文字で出す（送信エラー・受信できています・未受信）", () => {
    renderCard({
      devices: [
        device({ id: "a", userAgent: "A", failureCount: 2, lastFailureLabel: "5分前" }),
        device({ id: "b", userAgent: "B" }),
        device({ id: "c", userAgent: "C", lastSuccessLabel: null }),
      ],
    })
    expect(screen.getByText("通知を受け取る端末（3台）")).toBeInTheDocument()
    expect(screen.getByText("送信エラー")).toBeInTheDocument()
    expect(screen.getByText("受信できています")).toBeInTheDocument()
    expect(screen.getByText("未受信")).toBeInTheDocument()
    // 「一覧から外す」は解除ではないことを常に書いておく（他端末は開けば戻る）
    expect(screen.getByText(/その端末でアプリを開くと再び登録されます/)).toBeInTheDocument()
    // ボタンは「通知を解除」と名乗らぬ（既存の契約）
    expect(screen.queryByRole("button", { name: /通知を解除/ })).toBeNull()
  })
})
