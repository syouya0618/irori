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
import { render, screen, cleanup, within } from "@testing-library/react"

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
    render(<NotificationCard devices={[]} health={health()} />)

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

  it("走ってはおるが失敗が在る: 件数を出す（ran_at だけ見て平穏と誤読させぬ）", () => {
    render(
      <NotificationCard
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
        devices={[device({ failureCount: 3, lastFailureLabel: "5分前" })]}
        health={health()}
      />,
    )
    expect(screen.getByText("送信エラー 3回・最終エラー 5分前")).toBeInTheDocument()
  })

  it("失敗が 0 なら最終受信を出す", () => {
    render(<NotificationCard devices={[device()]} health={health()} />)
    expect(screen.getByText("最終受信 1時間前")).toBeInTheDocument()
  })

  it("一度も届いておらぬ端末はそう書く（空欄にせぬ）", () => {
    render(
      <NotificationCard
        devices={[device({ lastSuccessLabel: null })]}
        health={health()}
      />,
    )
    expect(screen.getByText("まだ届いていません")).toBeInTheDocument()
  })

  it("端末ごとに独立して出る（1 台だけ死んでおるを切り分けられる）", () => {
    render(
      <NotificationCard
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
      screen.getByRole("button", { name: "Android の Chromeの通知を解除" }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Mac の Chromeの通知を解除" }),
    ).toBeInTheDocument()
  })
})
