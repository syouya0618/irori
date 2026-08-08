/**
 * 通知カードの「毎朝のまとめ」（B-5）。
 *
 * ここで固定するのは、主が画面だけを見て次を取り違えぬことじゃ:
 *   1. **既定は無効**（自ら選ぶまで毎朝の通知は出さぬ）
 *   2. 保存済みの時刻が**そのまま見えておる**（DB は "07:00:00" で返す。
 *      正規化を落とすと空欄になり、主は「保存できておらぬ」と誤解する）
 *   3. **「読めなかった」を「送らない」と描かぬ**（B-4 の診断と同じ筋）
 *   4. 保存に失敗したら表示を**巻き戻す**（保存済みに見える嘘を残さぬ）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"

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

import { NotificationCard } from "../notification-card"
import { updateDigestTime } from "@/app/(main)/settings/actions"
import { toast } from "sonner"
import type { NotificationHealthView } from "@/lib/domain/notification-health"

const health: NotificationHealthView = {
  runState: "healthy",
  ranAtLabel: "3分前",
  failedCount: 0,
  deliveryState: "sent",
  lastSentLabel: "1時間前",
}

const mockedUpdate = vi.mocked(updateDigestTime)
const mockedToast = vi.mocked(toast)

/** 時刻の Select（`id` で掴む。端末一覧のボタンと取り違えぬため）。 */
const digestTrigger = () =>
  document.getElementById("digest-time") as HTMLButtonElement | null

/**
 * 選択中の値**だけ**を取り出す。
 *
 * ⚠️ トリガの `textContent` には矢印（▼）が混じるうえ、部分一致では
 * "07:00:00" が "07:00" を含んで緑になる（実測）。完全一致で見たい assert は
 * 必ずこちらを使うこと。
 */
const digestValueText = () =>
  digestTrigger()
    ?.querySelector('[data-slot="select-value"]')
    ?.textContent?.trim() ?? null

function renderCard(props: { digestTime?: string | null; unknown?: boolean } = {}) {
  return render(
    <NotificationCard
      devices={[]}
      health={health}
      digestTime={props.digestTime ?? null}
      digestTimeUnknown={props.unknown ?? false}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal("navigator", { userAgent: "node", serviceWorker: undefined })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("表示", () => {
  it("既定は「送らない」（主が選ぶまで毎朝の通知は出さぬ）", () => {
    renderCard()
    expect(screen.getByText("毎朝のまとめ")).toBeInTheDocument()
    expect(digestTrigger()).toHaveTextContent("送らない")
  })

  it("予定が無い日は送らぬことを文言で伝える", () => {
    renderCard()
    expect(screen.getByText(/予定がない日は送りません/)).toBeInTheDocument()
  })

  it("保存済みの時刻が選ばれておる", () => {
    renderCard({ digestTime: "07:00" })
    expect(digestTrigger()).toHaveTextContent("07:00")
  })

  it("**DB の TIME 表記（秒つき）でも空欄にせぬ**", () => {
    // Postgres は "07:00:00" で返す。ページ側でも均しておるが、上流の 1 箇所が
    // 抜けただけで Select はどの item にも一致せず空欄を描き、主は
    // 「保存できておらぬ」と誤解する。ゆえにこの階層でも塞ぐ。
    renderCard({ digestTime: "07:00:00" })
    // ⚠️ **完全一致で見る。** 部分一致だと "07:00:00" がそのまま出ておっても
    // "07:00" を含むゆえ緑になり、正規化を外した回帰を取り逃がす（実測）。
    expect(digestValueText()).toBe("07:00")
  })

  it("**選択肢に無い時刻でも空欄にせぬ**（設定が消えたように見せぬ）", () => {
    // SQL から直に入った 30 分刻みでない値。素の選択肢だけを渡すと
    // base-ui Select はどの item にも一致せず空欄を描く。
    renderCard({ digestTime: "07:13" })
    expect(digestTrigger()).toHaveTextContent("07:13")
  })

  it("**読めなかったときは「送らない」と描かず、理由を出して止める**", () => {
    renderCard({ unknown: true })
    expect(
      screen.getByText(/まとめの設定を取得できませんでした/),
    ).toBeInTheDocument()
    // 触らせれば、主の 1 クリックが知らぬ間に設定を上書きすることになる。
    expect(digestTrigger()).toBeDisabled()
  })

  it("触れる領域は 44px（**min-h-11**。h-11 では足りぬ）", () => {
    // ⚠️ プリミティブは `data-[size=default]:h-8` を持っており、素の `h-11` は
    // tailwind-merge の別キーゆえ両方が残る → 属性セレクタつきの変種が詳細度で
    // 勝ち 32px になる。`min-h-11` ならどちらが勝っても 44px を下回らぬ。
    // ⚠️ `toContain("h-11")` は `min-h-11` にも当たるゆえ弁別できぬ。完全な語で見る。
    renderCard()
    const trigger = digestTrigger()
    expect(trigger).not.toBeNull() // 描かれておらぬのを「クラス無し」と混同せぬ
    expect(trigger?.className.split(/\s+/)).toContain("min-h-11")
  })

  it("アイコンだけに頼らず、操作の名前を持つ", () => {
    renderCard()
    expect(
      screen.getByRole("combobox", { name: "毎朝のまとめを送る時刻" }),
    ).toBeInTheDocument()
  })
})

describe("保存", () => {
  /**
   * Select を開いて選択肢を選ぶ。
   *
   * ⚠️ base-ui の Select は**ポインタの往復**（move → down → up → click）で選択が
   * 成立する。`click` だけでは開くところまでで、`onValueChange` は発火せぬ
   * （実測。キーボード経路も jsdom では通らなんだ）。
   */
  async function choose(label: string) {
    const trigger = digestTrigger() as HTMLButtonElement
    fireEvent.pointerDown(trigger, { button: 0 })
    fireEvent.click(trigger)
    const option = await screen.findByRole("option", { name: label })
    fireEvent.pointerMove(option)
    fireEvent.pointerDown(option, { button: 0 })
    fireEvent.pointerUp(option, { button: 0 })
    fireEvent.click(option)
  }

  it("選んだ時刻で Server Action を呼び、結果を伝える", async () => {
    mockedUpdate.mockResolvedValue({ success: true })
    renderCard()

    await choose("07:00")

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith("07:00"))
    await waitFor(() =>
      expect(mockedToast.success).toHaveBeenCalledWith(
        "毎朝 07:00 にまとめをお届けします。",
      ),
    )
    expect(digestTrigger()).toHaveTextContent("07:00")
  })

  it("「送らない」を選べば無効化を送る", async () => {
    mockedUpdate.mockResolvedValue({ success: true })
    renderCard({ digestTime: "07:00" })

    await choose("送らない")

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith("none"))
    await waitFor(() =>
      expect(mockedToast.success).toHaveBeenCalledWith(
        "毎朝のまとめを止めました。",
      ),
    )
  })

  it("**保存に失敗したら表示を元へ戻す**（保存済みに見える嘘を残さぬ）", async () => {
    mockedUpdate.mockResolvedValue({ error: "通知の設定に失敗しました" })
    renderCard({ digestTime: "07:00" })

    await choose("08:00")

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith("通知の設定に失敗しました"),
    )
    await waitFor(() => expect(digestTrigger()).toHaveTextContent("07:00"))
  })

  it("通信が切れて reject しても表示を元へ戻す", async () => {
    mockedUpdate.mockRejectedValue(new TypeError("Failed to fetch"))
    renderCard({ digestTime: "07:00" })

    await choose("08:00")

    await waitFor(() => expect(mockedToast.error).toHaveBeenCalled())
    await waitFor(() => expect(digestTrigger()).toHaveTextContent("07:00"))
  })
})
