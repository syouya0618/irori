/**
 * 通知カードの**診断表示**（B-4）。
 *
 * ここで固定するのは「主が画面だけを見て、次の 3 つを区別できること」じゃ:
 *   1. 配信基盤が止まっておる（心拍が古い）
 *   2. 走ってはおるが、まだ何も送っておらぬ（＝ 平穏。壊れてはおらぬ）
 *   3. 両方在って健康
 * `最終実行` と `最終配信` を**並べて**出すのは、片方だけではこの 3 つが
 * 分かれぬからじゃ（最終配信だけを見せると 1 と 2 が同じ顔になる）。
 *
 * 加えて **色に頼っておらぬこと**を、文言そのものの存在で確かめる。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  render,
  screen,
  cleanup,
  within,
  waitFor,
  fireEvent,
} from "@testing-library/react"

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))
vi.mock("@/app/(main)/settings/push-actions", () => ({
  savePushSubscriptionAndSendTest: vi.fn(),
  deletePushSubscription: vi.fn(),
}))

import {
  NotificationCard,
  type PushDeviceView,
} from "../notification-card"
import { deletePushSubscription } from "@/app/(main)/settings/push-actions"
import { toast } from "sonner"
import { PUSH_OPT_OUT_MARKER_KEY } from "@/lib/pwa/push-reconcile"
import type { NotificationHealthView } from "@/lib/domain/notification-health"

function health(overrides: Partial<NotificationHealthView> = {}): NotificationHealthView {
  return {
    runState: "healthy",
    ranAtLabel: "3分前",
    failedCount: 0,
    deliveryState: "sent",
    lastSentLabel: "1時間前",
    ...overrides,
  }
}

/**
 * 毎朝のまとめ（B-5）は無効の既定。**この診断テストの関心ではない**ゆえ、
 * 固定値をまとめて渡す（まとめ自体の検査は `notification-card-digest.test.tsx`）。
 */
const digestOff = { digestTime: null, digestTimeUnknown: false } as const

function device(overrides: Partial<PushDeviceView> = {}): PushDeviceView {
  return {
    id: "sub-1",
    userAgent: "iPhone/iPad の Safari",
    createdAt: "2026-08-01T00:00:00.000Z",
    lastSuccessLabel: "1時間前",
    lastFailureLabel: null,
    failureCount: 0,
    ...overrides,
  }
}

/** 「配信の状況」ブロックだけを掴む（端末一覧の相対表記と取り違えぬため）。 */
function diagnostics(): HTMLElement {
  const heading = screen.getByText("配信の状況")
  const block = heading.parentElement
  if (!block) throw new Error("配信の状況ブロックが見つかりません")
  return block
}

beforeEach(() => {
  // ブラウザ機能の有無はこのテストの関心ではない（未対応として描かせる）。
  vi.stubGlobal("navigator", { userAgent: "node", serviceWorker: undefined })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("診断表示 — 最終実行 と 最終配信 を並べて出す", () => {
  it("両方在る（健康）: 2 つの相対表記が並び、警告は出ぬ", () => {
    render(<NotificationCard devices={[]} health={health()} {...digestOff} />)

    const block = diagnostics()
    expect(within(block).getByText("最終実行")).toBeInTheDocument()
    expect(within(block).getByText("3分前")).toBeInTheDocument()
    expect(within(block).getByText("最終配信")).toBeInTheDocument()
    expect(within(block).getByText("1時間前")).toBeInTheDocument()
    // 平穏な時に警告を出すと、本当の警告が薄まる。
    expect(
      screen.queryByText(/動いていません|失敗がありました|一度も実行されていません/),
    ).not.toBeInTheDocument()
  })

  it("心拍が古い（停止）: **文言で**「動いていません」と言う（色だけに頼らぬ）", () => {
    render(
      <NotificationCard
        {...digestOff}
        devices={[]}
        health={health({ runState: "stale", ranAtLabel: "3時間前" })}
      />,
    )

    const block = diagnostics()
    expect(within(block).getByText("3時間前")).toBeInTheDocument()
    expect(
      screen.getByText(
        "配信の処理が3時間前から動いていません。通知が届かない可能性があります。",
      ),
    ).toBeInTheDocument()
  })

  it("配信が無い（が心拍は新しい）: 『まだありません』と出し、**警告はせぬ**", () => {
    render(
      <NotificationCard
        {...digestOff}
        devices={[]}
        health={health({ deliveryState: "never", lastSentLabel: null })}
      />,
    )

    const block = diagnostics()
    // ★ これが「送るものが無かっただけ」じゃ。心拍が新しいゆえ壊れてはおらぬ。
    expect(within(block).getByText("まだありません")).toBeInTheDocument()
    expect(within(block).getByText("3分前")).toBeInTheDocument()
    expect(screen.queryByText(/動いていません/)).not.toBeInTheDocument()
  })

  it("一度も走っておらぬ（心拍の行が無い）: 古い時刻ではなく専用の文言", () => {
    render(
      <NotificationCard
        {...digestOff}
        devices={[]}
        health={health({
          runState: "never",
          ranAtLabel: null,
          deliveryState: "never",
          lastSentLabel: null,
        })}
      />,
    )

    expect(
      screen.getByText("通知の配信はまだ一度も実行されていません。"),
    ).toBeInTheDocument()
    // 最終実行・最終配信の両方が「まだありません」になる。
    expect(within(diagnostics()).getAllByText("まだありません")).toHaveLength(2)
  })

  // ── 診断が読めなかった時（SEC-3）─────────────────────────────
  // 「取得できませんでした」と「まだ一度も実行されていません」は、主の次の一手が
  // 正反対になる（前者は表示の故障・後者は pg_cron 未登録）。断言してはならぬ。
  it("心拍が読めなかった: **「まだ一度も」と言わぬ**", () => {
    render(
      <NotificationCard
        {...digestOff}
        devices={[]}
        health={health({ runState: "unknown", ranAtLabel: null })}
      />,
    )

    expect(within(diagnostics()).getByText("取得できませんでした")).toBeInTheDocument()
    expect(
      screen.queryByText("通知の配信はまだ一度も実行されていません。"),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(
        "配信の状況を取得できませんでした。通知が止まっているとは限りません。",
      ),
    ).toBeInTheDocument()
  })

  it("最終配信だけ読めなかった: そちらだけ「取得できませんでした」", () => {
    render(
      <NotificationCard
        {...digestOff}
        devices={[]}
        health={health({ deliveryState: "unknown", lastSentLabel: null })}
      />,
    )

    const block = diagnostics()
    // 心拍は読めておるゆえ相対表記のまま（片方の故障で全部を塗り潰さぬ）。
    expect(within(block).getByText("3分前")).toBeInTheDocument()
    expect(within(block).getByText("取得できませんでした")).toBeInTheDocument()
    expect(within(block).queryByText("まだありません")).not.toBeInTheDocument()
  })

  it("走ってはおるが失敗が在る: 件数を出す（ran_at だけ見て平穏と誤読させぬ）", () => {
    render(
      <NotificationCard
        {...digestOff}
        devices={[]}
        health={health({ runState: "failing", failedCount: 4 })}
      />,
    )
    expect(screen.getByText("直近の配信で 4 件の失敗がありました。")).toBeInTheDocument()
  })
})

describe("端末ごとの failure_count（B-1 で列は在ったが誰も読んでおらなんだ）", () => {
  it("失敗が在る端末は回数と最終エラーを出す", () => {
    render(
      <NotificationCard
        {...digestOff}
        devices={[device({ failureCount: 3, lastFailureLabel: "5分前" })]}
        health={health()}
      />,
    )
    expect(screen.getByText("送信エラー 3回・最終エラー 5分前")).toBeInTheDocument()
  })

  it("失敗が 0 なら最終受信を出す", () => {
    render(<NotificationCard devices={[device()]} health={health()} {...digestOff} />)
    expect(screen.getByText("最終受信 1時間前")).toBeInTheDocument()
  })

  it("一度も届いておらぬ端末はそう書く（空欄にせぬ）", () => {
    render(
      <NotificationCard
        {...digestOff}
        devices={[device({ lastSuccessLabel: null })]}
        health={health()}
      />,
    )
    expect(screen.getByText("まだ届いていません")).toBeInTheDocument()
  })

  it("端末ごとに独立して出る（1 台だけ死んでおるを切り分けられる）", () => {
    render(
      <NotificationCard
        {...digestOff}
        devices={[
          device({ id: "a", userAgent: "Android の Chrome", failureCount: 0 }),
          device({
            id: "b",
            userAgent: "Mac の Chrome",
            failureCount: 7,
            lastFailureLabel: "2分前",
            lastSuccessLabel: "3日前",
          }),
        ]}
        health={health()}
      />,
    )
    expect(screen.getByText("最終受信 1時間前")).toBeInTheDocument()
    expect(screen.getByText("送信エラー 7回・最終エラー 2分前")).toBeInTheDocument()
    // 解除ボタンの aria-label は端末ごとに異なる（getByRole が割れぬこと）。
    expect(
      screen.getByRole("button", { name: "Android の Chromeを一覧から外す" }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Mac の Chromeを一覧から外す" }),
    ).toBeInTheDocument()
  })
})

/**
 * ## 「解除」が恒久的に効くこと（SEC-1 / B1）—— **効くのは自分の端末だけ**
 *
 * DB 行を消すだけでは解除にならぬ。ブラウザの購読が生きたままなら、起動時の
 * 突き合わせ（`PushSubscriptionReconciler`）が同じ endpoint を登録し直し、
 * **主が切ったはずの通知が戻る**（`upsert_push_subscription` は
 * `failure_count = 0` を書くゆえ、健康な顔で戻ってくる）。
 *
 * ゆえにここで縛るのは 3 つ:
 *   1. 自分の endpoint を**添えて**消す（サーバ側でしか「どの行が自分か」は
 *      判定できぬ。endpoint は列 GRANT の外ゆえ返させぬ）
 *   2. この端末だった時だけ `unsubscribe()` を呼ぶ（他端末を消した拍子に
 *      自分の購読を畳んではならぬ）
 *   3. 併せて localStorage に解除の印を残す（`unsubscribe()` が圏外・権限で
 *      落ちた時、突き合わせを止められるのはこの印だけじゃ）
 *
 * ★ **2 の裏返しが文言の制約じゃ。** 他端末には `unsubscribe()` も印も届かぬ
 * ゆえ、その端末が次に開けば行は戻る。ボタンが「一覧から外す」と名乗り、成功の
 * 文言が自端末・他端末で割れておるのはそれゆえで、**下の 2 本がその割れ目を
 * 対で固定しておる**（片方だけなら「常にこちらを出す」実装で緑になる）。
 */
describe("端末の解除は恒久的に効く", () => {
  const ENDPOINT = "https://fcm.googleapis.com/fcm/send/this-device"

  function stubSubscribedBrowser() {
    const unsubscribe = vi.fn().mockResolvedValue(true)
    const subscription = { endpoint: ENDPOINT, unsubscribe }
    vi.stubGlobal("navigator", {
      userAgent: "node",
      serviceWorker: {
        getRegistration: () =>
          Promise.resolve({
            pushManager: { getSubscription: () => Promise.resolve(subscription) },
          }),
        // ⚠️ `ready` へ戻した実装は、この永久に解決せぬ promise で赤くなる。
        ready: new Promise<never>(() => {}),
      },
    })
    vi.stubGlobal("PushManager", class {})
    return { unsubscribe }
  }

  beforeEach(() => {
    localStorage.clear()
    vi.mocked(deletePushSubscription).mockReset()
    vi.mocked(toast.success).mockClear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  /**
   * ★ **自端末には「解除しました」と言うてよい。**
   * 印（`PUSH_OPT_OUT_MARKER_KEY`）と `unsubscribe()` が対にしてあるゆえ、
   * この端末の購読は本当に戻らぬ —— 印だけでも突き合わせは退く（下の
   * 「`unsubscribe()` が落ちても」を見よ）。
   */
  it("自端末を外したら「この端末の通知を解除しました。」と告げる", async () => {
    stubSubscribedBrowser()
    vi.mocked(deletePushSubscription).mockResolvedValue({
      error: null,
      deletedCurrentDevice: true,
    })

    render(
      <NotificationCard
        devices={[device({ id: "sub-1", userAgent: "この端末" })]}
        health={health()}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "この端末を一覧から外す" }))

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("この端末の通知を解除しました。"),
    )
  })

  /**
   * ★ **他端末に「解除しました」と言うてはならぬ。**
   * 配偶者の端末・手放した古い端末のブラウザには `unsubscribe()` も印も届かず、
   * その端末が次に開いた瞬間、突き合わせが冪等に登録し直す（サーバ側の失効
   * テーブルは主の裁定で**作らぬ**）。「解除しました」と告げれば、戻ってきた
   * ときに主は「解除が効かぬ」と読み、通知基盤の故障を疑って追えぬ道へ入る。
   */
  it("**他端末には「解除」と言わず、戻ることまで告げる**", async () => {
    stubSubscribedBrowser()
    vi.mocked(deletePushSubscription).mockResolvedValue({
      error: null,
      deletedCurrentDevice: false,
    })

    render(
      <NotificationCard
        devices={[device({ id: "sub-2", userAgent: "配偶者の端末" })]}
        health={health()}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "配偶者の端末を一覧から外す" }))

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "一覧から外しました（その端末で再度開くと戻ります）。",
      ),
    )
    // 嘘の側が**混ざっておらぬ**ことまで見る（両方出す実装を素通しせぬ）。
    expect(toast.success).not.toHaveBeenCalledWith(
      "この端末の通知を解除しました。",
    )
  })

  it("この端末の行を消したら、ブラウザ側の購読も畳み、解除の印を残す", async () => {
    const { unsubscribe } = stubSubscribedBrowser()
    vi.mocked(deletePushSubscription).mockResolvedValue({
      error: null,
      deletedCurrentDevice: true,
    })

    render(
      <NotificationCard
        {...digestOff}
        devices={[device({ id: "sub-1", userAgent: "この端末" })]}
        health={health()}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "この端末を一覧から外す" }))

    // 自分の endpoint を添えて呼ぶ（サーバはこれと突き合わせて 1 ビットを返す）。
    await waitFor(() =>
      expect(deletePushSubscription).toHaveBeenCalledWith("sub-1", ENDPOINT),
    )
    // ★ 本丸: ブラウザ側も畳む。ここが無いと次の起動で行が復活する。
    await waitFor(() => expect(unsubscribe).toHaveBeenCalled())
    expect(localStorage.getItem(PUSH_OPT_OUT_MARKER_KEY)).toBe(ENDPOINT)
  })

  it("**他端末**の行を消した時は自分の購読を畳まぬ（印も残さぬ）", async () => {
    const { unsubscribe } = stubSubscribedBrowser()
    vi.mocked(deletePushSubscription).mockResolvedValue({
      error: null,
      deletedCurrentDevice: false,
    })

    render(
      <NotificationCard
        {...digestOff}
        devices={[device({ id: "sub-2", userAgent: "配偶者の端末" })]}
        health={health()}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "配偶者の端末を一覧から外す" }))

    await waitFor(() => expect(deletePushSubscription).toHaveBeenCalled())
    expect(unsubscribe).not.toHaveBeenCalled()
    expect(localStorage.getItem(PUSH_OPT_OUT_MARKER_KEY)).toBeNull()
  })

  it("`unsubscribe()` が落ちても解除は成立扱い（印は残る）", async () => {
    const { unsubscribe } = stubSubscribedBrowser()
    unsubscribe.mockRejectedValue(new Error("offline"))
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.mocked(deletePushSubscription).mockResolvedValue({
      error: null,
      deletedCurrentDevice: true,
    })

    render(
      <NotificationCard
        {...digestOff}
        devices={[device({ id: "sub-1", userAgent: "この端末" })]}
        health={health()}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "この端末を一覧から外す" }))

    // 印が残っておれば、突き合わせは次の起動でも退く（最後の砦）。
    await waitFor(() =>
      expect(localStorage.getItem(PUSH_OPT_OUT_MARKER_KEY)).toBe(ENDPOINT),
    )
    vi.mocked(console.warn).mockRestore()
  })

  it("サーバが失敗を返したら、ブラウザ側は何も畳まぬ", async () => {
    const { unsubscribe } = stubSubscribedBrowser()
    vi.mocked(deletePushSubscription).mockResolvedValue({
      error: "対象の端末が見つかりませんでした。",
      deletedCurrentDevice: false,
    })

    render(
      <NotificationCard
        {...digestOff}
        devices={[device({ id: "sub-1", userAgent: "この端末" })]}
        health={health()}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "この端末を一覧から外す" }))

    await waitFor(() => expect(deletePushSubscription).toHaveBeenCalled())
    expect(unsubscribe).not.toHaveBeenCalled()
    expect(localStorage.getItem(PUSH_OPT_OUT_MARKER_KEY)).toBeNull()
  })
})
