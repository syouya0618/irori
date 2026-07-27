/**
 * FeedingTimer（母乳サイクル）の回帰テスト。
 *
 * 1) 永久ローディング防止: recordFeeding は redirect せず { error } を返す server
 *    action。通信断で reject した場合、従来は isSaving/isSavingRef が true のまま
 *    残り、停止ボタンが永久 disabled・スワイプでも復帰不能になっていた。
 *    try/catch/finally で必ず戻す。
 * 2) 母乳サイクル: 1回の授乳を feeding_type='breast' の 1 行として記録し、左右の
 *    吸わせ回数（stint）を自動カウントする。logged_at は「終了時刻」ではなく
 *    「サイクル開始時刻」。
 * 3) 深夜跨ぎ: 開始時刻が JST で前日なら当日 timeline へ楽観 append せず、
 *    トースト文言で前日保存を明示する（無言スキップは「記録されていない」と
 *    誤解させ再タップ二重記録を誘発するため禁止）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"

const recordFeeding = vi.fn()
vi.mock("@/app/(main)/baby/actions", () => ({
  recordFeeding: (...args: unknown[]) => recordFeeding(...args),
}))
vi.mock("sonner", async () => {
  const { vi: viMod } = await import("vitest")
  return { toast: { error: viMod.fn(), success: viMod.fn() } }
})

import { FeedingTimer } from "../feeding-timer"
import { toast } from "sonner"
import type { FeedingType } from "@/lib/types/database"

const STORAGE_KEY = "irori:feeding-timer"

// JST 13:00（日跨ぎの影響を受けない日中）に時計を固定する describe で使う。
const FIXED_NOW = new Date("2026-07-19T04:00:00.000Z")
const FIXED_NOW_ISO = FIXED_NOW.toISOString()
// FIXED_NOW から 5 分前 / 3.5 時間前（後者は MAX_TIMER_AGE_MS 超で stale）
const STARTED_5MIN_AGO = "2026-07-19T03:55:00.000Z"
const STARTED_3H30_AGO = "2026-07-19T00:30:00.000Z"

// JST 2026-07-20 00:10（= UTC 前日 15:10）。深夜跨ぎの再現に使う。
const MIDNIGHT_NOW = new Date("2026-07-19T15:10:00.000Z")
// JST 2026-07-19 23:50 開始（= 前日の行）。MIDNIGHT_NOW から 20 分前ゆえ stale ではない。
const PREV_DAY_STARTED_AT = "2026-07-19T14:50:00.000Z"

function seedTimerState(state: Record<string, unknown>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

function savedTimerState() {
  const raw = localStorage.getItem(STORAGE_KEY)
  return raw === null ? null : JSON.parse(raw)
}

function renderTimer(
  props: {
    initialFeedingType?: FeedingType
    onOpenChange?: () => void
    onLogRecorded?: (log: unknown) => void
    onPrevDayLogRecorded?: (log: unknown) => void
  } = {},
) {
  return render(
    <FeedingTimer
      open
      onOpenChange={props.onOpenChange ?? vi.fn()}
      initialFeedingType={props.initialFeedingType ?? "breast_left"}
      userId="u1"
      onLogRecorded={props.onLogRecorded}
      onPrevDayLogRecorded={props.onPrevDayLogRecorded}
    />,
  )
}

function stopButton() {
  return screen.getByRole("button", { name: /停止して記録|記録中/ })
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

describe("FeedingTimer 永久ローディング防止", () => {
  it("recordFeeding が例外を投げても停止ボタンが再び押せる", async () => {
    renderTimer()

    // open で自動的にタイマーが開始し、停止ボタンが出る
    const stop = stopButton()

    recordFeeding.mockRejectedValueOnce(new Error("network down"))
    fireEvent.click(stop)

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    // finally で isSaving が戻り、再度押せる
    expect(stop).not.toBeDisabled()
  })

  it("成功時は記録して onOpenChange(false) で閉じる", async () => {
    const onOpenChange = vi.fn()
    recordFeeding.mockResolvedValueOnce({ error: null })
    renderTimer({ onOpenChange })
    fireEvent.click(stopButton())

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(toast.success).toHaveBeenCalled()
  })

  it("記録成功時に onLogRecorded へ返却 id 付きの breast サイクル行を渡す（B-03 楽観 append）", async () => {
    recordFeeding.mockResolvedValueOnce({ error: null, id: "ft-1" })
    const onLogRecorded = vi.fn()
    renderTimer({ onLogRecorded })
    fireEvent.click(stopButton())

    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    const log = onLogRecorded.mock.calls[0][0]
    expect(log.id).toBe("ft-1")
    expect(log.log_type).toBe("feeding")
    // 母乳は片側行（breast_left/right）ではなくサイクル行として記録する
    expect(log.feeding_type).toBe("breast")
    expect(log.breast_left_count).toBe(1)
    expect(log.breast_right_count).toBe(0)
    expect(log.logged_by).toBe("u1")
    expect(typeof log.duration_min).toBe("number")
  })
})

describe("FeedingTimer の stint 自動カウント（母乳サイクル）", () => {
  it("開始側を1回で seed する（左開始なら 左1回）", () => {
    renderTimer({ initialFeedingType: "breast_left" })
    expect(screen.getByText(/左1回 \d\d:\d\d・右0回 \d\d:\d\d/)).toBeInTheDocument()
  })

  it("開始側を1回で seed する（右開始なら 右1回）", () => {
    renderTimer({ initialFeedingType: "breast_right" })
    expect(screen.getByText(/左0回 \d\d:\d\d・右1回 \d\d:\d\d/)).toBeInTheDocument()
  })

  it("反対側のタップでその側のカウントが増え、現在側が切り替わる", () => {
    renderTimer({ initialFeedingType: "breast_left" })
    fireEvent.click(screen.getByRole("button", { name: "右" }))
    expect(screen.getByText(/左1回 .+・右1回 /)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "左" }))
    expect(screen.getByText(/左2回 .+・右1回 /)).toBeInTheDocument()
  })

  it("同じ側の再タップでは stint が増えない（no-op）", async () => {
    recordFeeding.mockResolvedValueOnce({ error: null, id: "ft-noop" })
    renderTimer({ initialFeedingType: "breast_left" })
    const right = screen.getByRole("button", { name: "右" })
    fireEvent.click(right)
    fireEvent.click(right)
    fireEvent.click(right)
    // 連続タップで右が 3 回に水増しされない
    expect(screen.getByText(/左1回 .+・右1回 /)).toBeInTheDocument()

    fireEvent.click(stopButton())
    await waitFor(() => expect(recordFeeding).toHaveBeenCalled())
    expect(recordFeeding.mock.calls[0][0]).toMatchObject({
      breastLeftCount: 1,
      breastRightCount: 1,
    })
  })

  it("側の切替を localStorage へ保存する（リロードで回数が消えない）", () => {
    renderTimer({ initialFeedingType: "breast_left" })
    fireEvent.click(screen.getByRole("button", { name: "右" }))

    const saved = savedTimerState()
    expect(saved.feedingType).toBe("breast_right")
    expect(saved.leftCount).toBe(1)
    expect(saved.rightCount).toBe(1)
    expect(typeof saved.startedAt).toBe("string")
  })
})

describe("FeedingTimer の localStorage 復元", () => {
  beforeEach(() => {
    // Date のみ固定（経過秒・logged_at を決定化）。setInterval は実タイマーのまま
    // にして waitFor の flush を実挙動に保つ（baby-dashboard-datenav.test と同流儀）。
    vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("旧形式（counts なし）から復元しても throw せず現在側を1で seed する", () => {
    seedTimerState({ startedAt: STARTED_5MIN_AGO, feedingType: "breast_right" })
    renderTimer({ initialFeedingType: "breast_left" })

    expect(screen.getByText("右1")).toBeInTheDocument()
    // 復元した開始時刻から経過を数える（5分 = 05:00）
    expect(screen.getByText("05:00")).toBeInTheDocument()
  })

  it("新形式は左右カウントをそのまま復元する", () => {
    seedTimerState({
      startedAt: STARTED_5MIN_AGO,
      feedingType: "breast_left",
      leftCount: 2,
      rightCount: 1,
    })
    renderTimer({ initialFeedingType: "breast_left" })

    expect(screen.getByText("左2・右1")).toBeInTheDocument()
  })

  it("合計0の壊れたカウントは現在側を1にして救済する（記録不能なタイマーを作らない）", async () => {
    seedTimerState({
      startedAt: STARTED_5MIN_AGO,
      feedingType: "breast_right",
      leftCount: 0,
      rightCount: 0,
    })
    recordFeeding.mockResolvedValueOnce({ error: null, id: "ft-rescue" })
    renderTimer({ initialFeedingType: "breast_left" })

    expect(screen.getByText("右1")).toBeInTheDocument()
    // 救済されているので停止＝記録が通る（合計0だとサーバ検証/DB CHECK に必ず弾かれる）
    fireEvent.click(stopButton())
    await waitFor(() => expect(recordFeeding).toHaveBeenCalled())
    expect(recordFeeding.mock.calls[0][0]).toMatchObject({
      breastLeftCount: 0,
      breastRightCount: 1,
    })
  })

  it("MAX_TIMER_AGE_MS を超えた stale タイマーは破棄して開始し直す", () => {
    seedTimerState({
      startedAt: STARTED_3H30_AGO,
      feedingType: "breast_right",
      leftCount: 3,
      rightCount: 2,
    })
    renderTimer({ initialFeedingType: "breast_left" })

    // 復元されず 00:00 から開始し、カウントも initialFeedingType の seed に戻る
    expect(screen.getByText("00:00")).toBeInTheDocument()
    expect(screen.getByText(/左1回 00:00・右0回 00:00/)).toBeInTheDocument()
    expect(savedTimerState().startedAt).toBe(FIXED_NOW_ISO)
  })

  it("停止時の logged_at はサイクル開始時刻（復元した startedAt）を渡す", async () => {
    seedTimerState({
      startedAt: STARTED_5MIN_AGO,
      feedingType: "breast_left",
      leftCount: 2,
      rightCount: 1,
    })
    recordFeeding.mockResolvedValueOnce({ error: null, id: "ft-start" })
    renderTimer({ initialFeedingType: "breast_left" })

    fireEvent.click(stopButton())
    await waitFor(() => expect(recordFeeding).toHaveBeenCalled())
    expect(recordFeeding).toHaveBeenCalledWith({
      feedingType: "breast",
      breastLeftCount: 2,
      breastRightCount: 1,
      durationSec: 300,
      loggedAt: STARTED_5MIN_AGO,
    })
  })
})

describe("FeedingTimer の左右別授乳時間（stint banking）", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("切替のたびに前の側へ経過を banking し、停止で sides を送る（durationSec は送らない）", async () => {
    recordFeeding.mockResolvedValueOnce({ error: null, id: "bank-1" })
    renderTimer({ initialFeedingType: "breast_left" })
    // 開始から 5 分後に右へ切替（左へ 300 秒 banking）
    vi.setSystemTime(new Date(FIXED_NOW.getTime() + 300_000))
    fireEvent.click(screen.getByRole("button", { name: "右" }))
    // さらに 200 秒後に停止（右へ 200 秒 banking）
    vi.setSystemTime(new Date(FIXED_NOW.getTime() + 500_000))
    fireEvent.click(stopButton())

    await waitFor(() => expect(recordFeeding).toHaveBeenCalled())
    expect(recordFeeding).toHaveBeenCalledWith({
      feedingType: "breast",
      breastLeftCount: 1,
      breastRightCount: 1,
      breastLeftSec: 300,
      breastRightSec: 200,
      loggedAt: FIXED_NOW_ISO,
    })
  })

  it("切替で banked した側の時間が画面に出る（左1回 05:00）", () => {
    renderTimer({ initialFeedingType: "breast_left" })
    vi.setSystemTime(new Date(FIXED_NOW.getTime() + 300_000))
    fireEvent.click(screen.getByRole("button", { name: "右" }))
    expect(screen.getByText(/左1回 05:00/)).toBeInTheDocument()
  })

  it("切替ごとに leftSec/rightSec/sideSince を localStorage へ保存する", () => {
    renderTimer({ initialFeedingType: "breast_left" })
    vi.setSystemTime(new Date(FIXED_NOW.getTime() + 300_000))
    fireEvent.click(screen.getByRole("button", { name: "右" }))
    const saved = savedTimerState()
    expect(saved.leftSec).toBe(300)
    expect(saved.rightSec).toBe(0)
    expect(saved.sideSince).toBe(
      new Date(FIXED_NOW.getTime() + 300_000).toISOString(),
    )
  })

  it("新形式の復元は sideSince から banking を継続する（閉じていた区間は現在側へ帰属）", async () => {
    // 5 分前開始・右側・左に 60 秒 banked・右は 2 分前から継続中
    seedTimerState({
      startedAt: STARTED_5MIN_AGO,
      feedingType: "breast_right",
      leftCount: 1,
      rightCount: 1,
      leftSec: 60,
      rightSec: 0,
      sideSince: new Date(FIXED_NOW.getTime() - 120_000).toISOString(),
    })
    recordFeeding.mockResolvedValueOnce({ error: null, id: "bank-2" })
    renderTimer({ initialFeedingType: "breast_left" })
    fireEvent.click(stopButton())

    await waitFor(() => expect(recordFeeding).toHaveBeenCalled())
    expect(recordFeeding).toHaveBeenCalledWith({
      feedingType: "breast",
      breastLeftCount: 1,
      breastRightCount: 1,
      breastLeftSec: 60,
      breastRightSec: 120,
      loggedAt: STARTED_5MIN_AGO,
    })
  })

  it("旧形式（sideSince なし）の復元は粘着的に sides を持たず、切替しても localStorage に sec を書かない", async () => {
    // 過去の配分が復元不能なサイクルは途中から banking を始めない（嘘の配分を作らない）。
    // 保存も旧形式のまま = 再度開いても sidesUnknown が維持される（粘着）。
    seedTimerState({
      startedAt: STARTED_5MIN_AGO,
      feedingType: "breast_left",
      leftCount: 1,
      rightCount: 0,
    })
    renderTimer({ initialFeedingType: "breast_left" })
    fireEvent.click(screen.getByRole("button", { name: "右" }))
    const saved = savedTimerState()
    expect(saved.leftSec).toBeUndefined()
    expect(saved.sideSince).toBeUndefined()
    expect(saved.rightCount).toBe(1)

    // 停止は従来どおり durationSec（合計のみ）で記録される
    recordFeeding.mockResolvedValueOnce({ error: null, id: "bank-3" })
    fireEvent.click(stopButton())
    await waitFor(() => expect(recordFeeding).toHaveBeenCalled())
    const payload = recordFeeding.mock.calls[0][0]
    expect(payload.breastLeftSec).toBeUndefined()
    expect(payload.durationSec).toBe(300)
  })
})

describe("FeedingTimer 手動入力モード（分・秒 + 左右回数）", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function openManual(feedingType: FeedingType = "breast_left") {
    renderTimer({ initialFeedingType: feedingType })
    fireEvent.click(screen.getByRole("button", { name: "手動入力" }))
  }

  function recordButton() {
    return screen.getByRole("button", { name: /記録する|記録中/ })
  }

  it("手動入力に切り替えると左右それぞれの分・秒セレクトと記録ボタンが出る", () => {
    openManual()
    expect(screen.getByLabelText("左の分")).toBeInTheDocument()
    expect(screen.getByLabelText("左の秒")).toBeInTheDocument()
    expect(screen.getByLabelText("右の分")).toBeInTheDocument()
    expect(screen.getByLabelText("右の秒")).toBeInTheDocument()
    expect(recordButton()).toBeInTheDocument()
    // タイマーの停止ボタンは手動入力中は出ない
    expect(
      screen.queryByRole("button", { name: /停止して記録/ }),
    ).not.toBeInTheDocument()
  })

  it("分の選択肢は左右とも0〜60分", () => {
    openManual()
    for (const label of ["左の分", "右の分"]) {
      const minSelect = screen.getByLabelText(label) as HTMLSelectElement
      expect(minSelect.options).toHaveLength(61)
      expect(minSelect.options[60].value).toBe("60")
    }
  })

  it("左右回数のステッパーで回数を増減できる（既定は開始側1・反対0）", () => {
    openManual("breast_right")
    expect(screen.getByLabelText("左の回数")).toHaveTextContent("0")
    expect(screen.getByLabelText("右の回数")).toHaveTextContent("1")

    fireEvent.click(screen.getByRole("button", { name: "左の回数を1増やす" }))
    fireEvent.click(screen.getByRole("button", { name: "左の回数を1増やす" }))
    expect(screen.getByLabelText("左の回数")).toHaveTextContent("2")

    fireEvent.click(screen.getByRole("button", { name: "左の回数を1減らす" }))
    expect(screen.getByLabelText("左の回数")).toHaveTextContent("1")
  })

  it("上限は 20: 19 から + で 20 に到達でき、20 で + が disabled になる（MAX_BREAST_COUNT ドリフトの回帰固定）", () => {
    // 「20 で増えない」だけの検証だと、上限定数が 5 へ壊れても disabled のまま全緑で
    // 生き残る（ミューテーション実測 M24 — 上から近づく形は上限値を識別できない）。
    // 19 で押せる→20 に到達→disabled、と下から挟んで上限が 20 であることを固定する。
    seedTimerState({
      startedAt: STARTED_5MIN_AGO,
      feedingType: "breast_left",
      leftCount: 19,
      rightCount: 0,
    })
    renderTimer({ initialFeedingType: "breast_left" })
    fireEvent.click(screen.getByRole("button", { name: "手動入力" }))

    // 復元 clamp（restoreCycle）が 19 を保持していること自体も上限 20 の証左
    expect(screen.getByLabelText("左の回数")).toHaveTextContent("19")
    const plus = screen.getByRole("button", { name: "左の回数を1増やす" })
    expect(plus).not.toBeDisabled()
    fireEvent.click(plus)
    expect(screen.getByLabelText("左の回数")).toHaveTextContent("20")
    expect(plus).toBeDisabled()
  })

  it("左右の分・秒を選んで記録すると sides で recordFeeding に渡る（合計はサーバ導出・durationSec は送らない）", async () => {
    recordFeeding.mockResolvedValueOnce({ error: null, id: "m-1" })
    openManual("breast_right")
    // 右 2分40秒 = 160秒・左 1分 = 60秒（開始側=右の既定 5:00 を上書き）
    fireEvent.change(screen.getByLabelText("右の分"), { target: { value: "2" } })
    fireEvent.change(screen.getByLabelText("右の秒"), { target: { value: "40" } })
    fireEvent.change(screen.getByLabelText("左の分"), { target: { value: "1" } })
    fireEvent.change(screen.getByLabelText("左の秒"), { target: { value: "0" } })
    fireEvent.click(recordButton())

    await waitFor(() => expect(recordFeeding).toHaveBeenCalled())
    expect(recordFeeding).toHaveBeenCalledWith({
      feedingType: "breast",
      breastLeftCount: 0,
      breastRightCount: 1,
      breastLeftSec: 60,
      breastRightSec: 160,
      // logged_at は「記録時刻 − 授乳時間(左+右)」= サイクル開始時刻
      loggedAt: new Date(FIXED_NOW.getTime() - 220_000).toISOString(),
    })
  })

  it("既定は開始側 5:00・反対側 0:00", () => {
    openManual("breast_left")
    expect((screen.getByLabelText("左の分") as HTMLSelectElement).value).toBe("5")
    expect((screen.getByLabelText("左の秒") as HTMLSelectElement).value).toBe("0")
    expect((screen.getByLabelText("右の分") as HTMLSelectElement).value).toBe("0")
    expect((screen.getByLabelText("右の秒") as HTMLSelectElement).value).toBe("0")
  })

  it("左右とも0分0秒では記録せずエラートーストを出す", () => {
    openManual()
    fireEvent.change(screen.getByLabelText("左の分"), { target: { value: "0" } })
    fireEvent.change(screen.getByLabelText("左の秒"), { target: { value: "0" } })
    fireEvent.click(recordButton())

    expect(toast.error).toHaveBeenCalledWith("授乳時間を選んでください")
    expect(recordFeeding).not.toHaveBeenCalled()
  })

  it("左右の回数が合計0では記録せず専用のエラートーストを出す", () => {
    openManual("breast_left")
    fireEvent.click(screen.getByRole("button", { name: "左の回数を1減らす" }))
    expect(screen.getByLabelText("左の回数")).toHaveTextContent("0")

    fireEvent.click(recordButton())
    expect(toast.error).toHaveBeenCalledWith(
      "左右の回数は合計1回以上にしてください",
    )
    expect(recordFeeding).not.toHaveBeenCalled()
  })
})

describe("FeedingTimer の深夜跨ぎ（前日の記録として保存）", () => {
  beforeEach(() => {
    // JST 2026-07-20 00:10 に固定。日付だけが異なる同条件の positive control と
    // 対にして、not.toHaveBeenCalled() が空振りでないことを担保する。
    vi.useFakeTimers({ now: MIDNIGHT_NOW, toFake: ["Date"] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("開始が前日（JST）のサイクルは onLogRecorded を呼ばず、前日保存をトーストで示す", async () => {
    seedTimerState({
      startedAt: PREV_DAY_STARTED_AT,
      feedingType: "breast_left",
      leftCount: 1,
      rightCount: 1,
    })
    recordFeeding.mockResolvedValueOnce({ error: null, id: "cross-1" })
    const onLogRecorded = vi.fn()
    renderTimer({ initialFeedingType: "breast_left", onLogRecorded })

    fireEvent.click(stopButton())
    await waitFor(() => expect(toast.success).toHaveBeenCalled())

    expect(recordFeeding).toHaveBeenCalledWith({
      feedingType: "breast",
      breastLeftCount: 1,
      breastRightCount: 1,
      durationSec: 1200,
      loggedAt: PREV_DAY_STARTED_AT,
    })
    // 当日 timeline の入場条件（logged_at の JST 日付一致）を満たさないため append しない
    expect(onLogRecorded).not.toHaveBeenCalled()
    // 無言スキップ禁止: 前日に保存されたことが分かる文言にする
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining("前日の記録として保存"),
    )
  })

  it("開始が前日のサイクルは onPrevDayLogRecorded へ渡す（最終授乳 fallback の即時更新・P3）", async () => {
    // timeline へは入れない（上のテスト）が、「最終授乳」まで見えなくなると
    // 記録直後に「---」へ落ちる。fallback 更新用の別コールバックで渡すことを固定する。
    seedTimerState({
      startedAt: PREV_DAY_STARTED_AT,
      feedingType: "breast_left",
      leftCount: 1,
      rightCount: 1,
    })
    recordFeeding.mockResolvedValueOnce({ error: null, id: "cross-2" })
    const onLogRecorded = vi.fn()
    const onPrevDayLogRecorded = vi.fn()
    renderTimer({
      initialFeedingType: "breast_left",
      onLogRecorded,
      onPrevDayLogRecorded,
    })

    fireEvent.click(stopButton())
    await waitFor(() => expect(onPrevDayLogRecorded).toHaveBeenCalledTimes(1))

    const log = onPrevDayLogRecorded.mock.calls[0][0] as {
      id: string
      logged_at: string
      feeding_type: string
    }
    expect(log.id).toBe("cross-2")
    expect(log.logged_at).toBe(PREV_DAY_STARTED_AT)
    expect(log.feeding_type).toBe("breast")
    expect(onLogRecorded).not.toHaveBeenCalled()
  })

  it("開始が当日なら onPrevDayLogRecorded は呼ばない（positive/negative の対）", async () => {
    const sameDayStartedAt = new Date(
      MIDNIGHT_NOW.getTime() - 5 * 60_000,
    ).toISOString()
    seedTimerState({
      startedAt: sameDayStartedAt,
      feedingType: "breast_left",
      leftCount: 1,
      rightCount: 0,
    })
    recordFeeding.mockResolvedValueOnce({ error: null, id: "same-2" })
    const onPrevDayLogRecorded = vi.fn()
    renderTimer({ initialFeedingType: "breast_left", onPrevDayLogRecorded })

    fireEvent.click(stopButton())
    await waitFor(() => expect(toast.success).toHaveBeenCalled())

    expect(onPrevDayLogRecorded).not.toHaveBeenCalled()
  })

  it("同じ時計でも開始が当日（JST）なら従来どおり楽観 append する（positive control）", async () => {
    // MIDNIGHT_NOW から 5 分前 = JST 2026-07-20 00:05（当日）
    const sameDayStartedAt = new Date(
      MIDNIGHT_NOW.getTime() - 5 * 60_000,
    ).toISOString()
    seedTimerState({
      startedAt: sameDayStartedAt,
      feedingType: "breast_left",
      leftCount: 1,
      rightCount: 1,
    })
    recordFeeding.mockResolvedValueOnce({ error: null, id: "same-1" })
    const onLogRecorded = vi.fn()
    renderTimer({ initialFeedingType: "breast_left", onLogRecorded })

    fireEvent.click(stopButton())
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    const log = onLogRecorded.mock.calls[0][0] as {
      logged_at: string
      breast_left_count: number
      breast_right_count: number
    }
    // 楽観行の logged_at も開始時刻（now ではない）
    expect(log.logged_at).toBe(sameDayStartedAt)
    expect(log.breast_left_count).toBe(1)
    expect(log.breast_right_count).toBe(1)
    expect(toast.success).toHaveBeenCalledWith(
      expect.not.stringContaining("前日の記録として保存"),
    )
  })
})
