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

import { NotificationCard, type PushDeviceView } from "../notification-card"
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

/**
 * 通知を受け取れる端末が 1 台在る状態。
 *
 * ⚠️ **`devices` はこの利用者の全端末じゃ**（`page.tsx` は `.eq("user_id", userId)`
 * のみ）。空配列は「この人は絶対に受け取れぬ」と同義ゆえ、届く前提の assert を
 * `devices={[]}` で書くと**画面が嘘をつく状態を正解として固定してしまう**。
 */
const DEVICE: PushDeviceView = {
  id: "sub-1",
  userAgent: "iPhone",
  createdAt: "2026-08-01T00:00:00.000Z",
  lastSuccessLabel: "3分前",
  lastFailureLabel: null,
  failureCount: 0,
}

function renderCard(
  props: {
    digestTime?: string | null
    unknown?: boolean
    devices?: PushDeviceView[]
  } = {},
) {
  return render(
    <NotificationCard
      devices={props.devices ?? []}
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

  /**
   * ★ **帯を朝（05:00〜10:00）へ絞ったことで新たに「外」へ出た値**（12:00）。
   *
   * ⚠️ **上の 2 本（07:13 / 07:00:00）はこの回帰を弁別できぬ。**
   * `digestItemsFor` を消しても**トリガの文字は変わらぬ** —— base-ui の
   * `Select.Value` は `items` に一致が無いとき生の値をそのまま描くゆえじゃ
   * （このリポジトリの版で計測。docstring が言うておった「空欄になる」は**誤り**
   * じゃった。仕込みで実測: 配慮を外しても 07:13 のテストは緑のまま）。
   *
   * 実際に壊れるのは**開いた時**じゃ。今の設定が一覧のどこにも無く、印も付かぬ。
   * 主は「一覧に無い ＝ 設定が消えた」と読んで選び直し、**本人の意図でなく毎朝の
   * 時刻が動く**（12:00 は昨日まで選べた値ゆえ、実際に設定しておった人が居りうる）。
   * ゆえにここは**開いて option の実在まで**見る。
   */
  it("**帯の外になった保存済みの時刻も、開けば一覧に在る**（12:00）", async () => {
    renderCard({ digestTime: "12:00" })
    // 表示（安い側）。これだけでは配慮の有無を弁別できぬ —— 下が本体じゃ。
    expect(digestValueText()).toBe("12:00")

    const trigger = digestTrigger() as HTMLButtonElement
    fireEvent.pointerDown(trigger, { button: 0 })
    fireEvent.click(trigger)

    // ★ 本体: 帯の外の値が選択肢として足されておること。
    expect(await screen.findByRole("option", { name: "12:00" })).toBeInTheDocument()
    // 帯そのものが広がってしもうておらぬこと（この 1 行が無いと、帯を戻す
    // 変更でもこのテストが緑になる）。
    expect(screen.queryByRole("option", { name: "12:30" })).not.toBeInTheDocument()
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
    // ⚠️ **端末を 1 台持たせる。** 購読ゼロで「お届けします」を固定すると、
    // 届かぬ状態の嘘を正解として据えることになる（下の対を見よ）。
    renderCard({ devices: [DEVICE] })

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

  /**
   * ⚠️ **両向きの対で置く。** 購読ゼロ側だけを書けば「常に届かぬと言う」実装でも
   * 緑になり、届く側だけを書けば嘘の約束が戻ってきても緑になる。
   */
  it("**受け取る端末が無ければ「お届けします」と言わぬ**（届かぬことを述べる）", async () => {
    mockedUpdate.mockResolvedValue({ success: true })
    renderCard({ devices: [] })

    await choose("07:00")

    // 保存自体は成功しておる（設定は残る）ゆえ success で伝えるが、約束はせぬ。
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith("07:00"))
    await waitFor(() =>
      expect(mockedToast.success).toHaveBeenCalledWith(
        "毎朝 07:00 に設定しました。通知を受け取る端末がないため、まだ届きません。",
      ),
    )
  })
})

/**
 * ## 「既定は 7 時」を、画面が嘘をつかぬ形で満たす
 *
 * 未設定（DB が NULL）のとき Select の**選択**を 07:00 にすれば、主は
 * 「設定済み」と読む —— そして毎朝来ぬ通知を待つ。ゆえに選択は「送らない」の
 * ままに保ち、代わりに **1 タップの導線**を出す。押されて初めて保存されるゆえ
 * opt-in は割れておらぬ。
 *
 * ここは 3 本で挟む（1 本では「常に出す」「常に出さぬ」実装が素通りする）:
 *   1. 未設定なら出る、しかも Select は「送らない」のまま（＝嘘をついておらぬ）
 *   2. 設定済みなら出さぬ
 *   3. 押せば 07:00 が保存され、導線は消える
 */
describe("07:00 で始める（未設定のときだけの導線）", () => {
  const startButton = () =>
    screen.queryByRole("button", { name: "07:00 で始める" })

  it("未設定なら導線が出る。**それでも選択は「送らない」のまま**", () => {
    renderCard({ digestTime: null })
    expect(startButton()).toBeInTheDocument()
    // ★ ここが要じゃ。ボタンが在っても、設定済みには見せておらぬ。
    expect(digestValueText()).toBe("送らない")
  })

  it("設定済みなら出さぬ（済んだ主に勧め続けぬ）", () => {
    renderCard({ digestTime: "08:00" })
    expect(startButton()).not.toBeInTheDocument()
  })

  it("**読めなかったときは出さぬ**（1 タップで知らぬ間に上書きさせぬ）", () => {
    // B-4 の診断と同じ筋。Select を disabled にしておきながら、隣のボタンで
    // 書けてしまえば守りの意味が無い。
    renderCard({ unknown: true })
    expect(startButton()).not.toBeInTheDocument()
  })

  it("押すと 07:00 が保存され、導線は消える", async () => {
    mockedUpdate.mockResolvedValue({ success: true })
    renderCard({ digestTime: null, devices: [DEVICE] })

    fireEvent.click(startButton() as HTMLButtonElement)

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith("07:00"))
    await waitFor(() => expect(digestValueText()).toBe("07:00"))
    expect(startButton()).not.toBeInTheDocument()
  })

  it("保存に失敗したら導線は残る（押せば直るゆえ）", async () => {
    mockedUpdate.mockResolvedValue({ error: "通知の設定に失敗しました" })
    renderCard({ digestTime: null, devices: [DEVICE] })

    fireEvent.click(startButton() as HTMLButtonElement)

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith("通知の設定に失敗しました"),
    )
    // 巻き戻しが効いておれば「送らない」へ戻り、導線もまた出る。
    await waitFor(() => expect(digestValueText()).toBe("送らない"))
    expect(startButton()).toBeInTheDocument()
  })
})

describe("届かぬのに届くと描かぬ（購読ゼロ）", () => {
  it("端末が無く時刻が選ばれておれば、届かぬ理由が画面に残る", () => {
    // toast は消える。毎朝待つ主が見るのは**この行**じゃ。
    renderCard({ digestTime: "07:00", devices: [] })
    expect(
      screen.getByText(/この時刻に設定してもまだ届きません/),
    ).toBeInTheDocument()
  })

  it("端末が在れば出さぬ（本当の警告を薄めぬ）", () => {
    renderCard({ digestTime: "07:00", devices: [DEVICE] })
    expect(
      screen.queryByText(/この時刻に設定してもまだ届きません/),
    ).not.toBeInTheDocument()
  })

  it("「送らない」のままなら出さぬ（守れぬ約束が無いゆえ）", () => {
    renderCard({ digestTime: null, devices: [] })
    expect(
      screen.queryByText(/この時刻に設定してもまだ届きません/),
    ).not.toBeInTheDocument()
  })

  it("時刻は選べる（ノートで選び iPhone で受け取る道を塞がぬ）", () => {
    // ⚠️ **`disabled` にはせぬ。** `digest_time` は利用者ごとの設定ゆえ、
    // 受け取る端末を後から足す順序を妨げてはならぬ（「読めなかった」ときだけ止める）。
    renderCard({ digestTime: "07:00", devices: [] })
    expect(digestTrigger()).not.toBeDisabled()
  })
})
