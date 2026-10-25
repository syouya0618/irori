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
import { act } from "react"

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
    userId?: string
    onOpenChange?: () => void
    onLogRecorded?: (log: unknown) => void
    onRunningChange?: (running: unknown) => void
  } = {},
) {
  return render(
    <FeedingTimer
      open
      onOpenChange={props.onOpenChange ?? vi.fn()}
      initialFeedingType={props.initialFeedingType ?? "breast_left"}
      userId={props.userId ?? "u1"}
      onLogRecorded={props.onLogRecorded}
      onRunningChange={props.onRunningChange}
    />,
  )
}

/** recordFeeding の完全一致 assert 用: 計測ごとの冪等 id は値を予見できぬため形だけ固定する */
const ANY_CLIENT_ID = { clientId: expect.any(String) }

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

  // 旧テストは「MAX_TIMER_AGE_MS を超えた stale タイマーは破棄して開始し直す」を固定していた。
  // 無言の破棄は「停め忘れた授乳が消えた」事故ゆえ改めた（P3-08）: 捨てず、本当の開始時刻を
  // 保ったまま授乳時間を手で入れて記録するか、明示に破棄するかを利用者が選ぶ。
  it("MAX_TIMER_AGE_MS を超えた停め忘れは黙って捨てず、開始時刻を保って手動入力で記録できる", async () => {
    seedTimerState({
      startedAt: STARTED_3H30_AGO,
      feedingType: "breast_right",
      leftCount: 3,
      rightCount: 2,
    })
    recordFeeding.mockResolvedValueOnce({ error: null, id: "stale-1" })
    const onRunningChange = vi.fn()
    renderTimer({ initialFeedingType: "breast_left", onRunningChange })

    // 案内が出て、手動入力だけになる（タイマーの経過で記録させない）
    expect(screen.getByText(/09:30 に始めた計測が残っています（3時間30分前）/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "タイマー" })).toBeNull()
    expect(screen.queryByRole("button", { name: /停止して記録/ })).toBeNull()
    // 端末保存は捨てていない。親へも停め忘れとして知らせる
    expect(savedTimerState().startedAt).toBe(STARTED_3H30_AGO)
    expect(onRunningChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ startedAt: STARTED_3H30_AGO, stale: true }),
    )

    // 授乳時間を入れて記録 → logged_at は本当の開始時刻（「今 − 時間」ではない）
    fireEvent.change(screen.getByLabelText("右の分"), { target: { value: "10" } })
    fireEvent.click(screen.getByRole("button", { name: /記録する/ }))
    await waitFor(() => expect(recordFeeding).toHaveBeenCalled())
    expect(recordFeeding).toHaveBeenCalledWith(
      expect.objectContaining({
        loggedAt: STARTED_3H30_AGO,
        breastLeftCount: 3,
        breastRightCount: 2,
        breastRightSec: 600,
      }),
    )
    await waitFor(() => expect(savedTimerState()).toBeNull())
    await waitFor(() => expect(onRunningChange).toHaveBeenLastCalledWith(null))
  })

  it("停め忘れは明示の破棄でも消せる", () => {
    seedTimerState({
      startedAt: STARTED_3H30_AGO,
      feedingType: "breast_right",
      leftCount: 3,
      rightCount: 2,
    })
    const onOpenChange = vi.fn()
    renderTimer({ initialFeedingType: "breast_left", onOpenChange })
    fireEvent.click(screen.getByRole("button", { name: "キャンセル（記録しない）" }))
    fireEvent.click(screen.getByRole("button", { name: "破棄する" }))
    expect(savedTimerState()).toBeNull()
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(recordFeeding).not.toHaveBeenCalled()
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
      // 旧形式（startSide なし）で両側とも吸わせ済み → 開始側は復元不能 = 不明（null）
      breastStartSide: null,
      durationSec: 300,
      loggedAt: STARTED_5MIN_AGO,
      ...ANY_CLIENT_ID,
    })
  })
})

describe("FeedingTimer の開始側（breast_start_side）", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("左でタイマーを始めて右へ切替えても、開始側は左のまま記録する", async () => {
    recordFeeding.mockResolvedValueOnce({ error: null, id: "ss-1" })
    renderTimer({ initialFeedingType: "breast_left" })
    expect(screen.getByText(/左から開始/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "右" }))
    // 現在側は右へ動くが開始側は動かない
    expect(screen.getByText(/左から開始/)).toBeInTheDocument()
    fireEvent.click(stopButton())
    await waitFor(() => expect(recordFeeding).toHaveBeenCalled())
    expect(recordFeeding).toHaveBeenCalledWith(
      expect.objectContaining({ breastStartSide: "left" }),
    )
    // トーストにも開始側が出る
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining("左から・"),
    )
  })

  it("右でタイマーを始めると開始側は右", async () => {
    recordFeeding.mockResolvedValueOnce({ error: null, id: "ss-2" })
    renderTimer({ initialFeedingType: "breast_right" })
    fireEvent.click(stopButton())
    await waitFor(() => expect(recordFeeding).toHaveBeenCalled())
    expect(recordFeeding).toHaveBeenCalledWith(
      expect.objectContaining({ breastStartSide: "right" }),
    )
  })

  it("開始側は localStorage に保存され、復元後もそのまま記録される", async () => {
    renderTimer({ initialFeedingType: "breast_right" })
    fireEvent.click(screen.getByRole("button", { name: "左" }))
    expect(savedTimerState()).toMatchObject({
      feedingType: "breast_left",
      startSide: "breast_right",
    })
    cleanup()

    recordFeeding.mockResolvedValueOnce({ error: null, id: "ss-3" })
    // 復元時の initialFeedingType（左）は開始側を上書きしない
    renderTimer({ initialFeedingType: "breast_left" })
    fireEvent.click(stopButton())
    await waitFor(() => expect(recordFeeding).toHaveBeenCalled())
    expect(recordFeeding).toHaveBeenCalledWith(
      expect.objectContaining({ breastStartSide: "right" }),
    )
  })

  it("旧形式（startSide なし）でも片側しか吸わせていなければその側を開始側と推定する", async () => {
    seedTimerState({
      startedAt: STARTED_5MIN_AGO,
      feedingType: "breast_right",
      leftCount: 0,
      rightCount: 2,
    })
    recordFeeding.mockResolvedValueOnce({ error: null, id: "ss-4" })
    renderTimer({ initialFeedingType: "breast_left" })
    fireEvent.click(stopButton())
    await waitFor(() => expect(recordFeeding).toHaveBeenCalled())
    expect(recordFeeding).toHaveBeenCalledWith(
      expect.objectContaining({ breastStartSide: "right" }),
    )
  })

  it("手動入力では開始側を選び直せる（既定はタップした側）", async () => {
    recordFeeding.mockResolvedValueOnce({ error: null, id: "ss-5" })
    renderTimer({ initialFeedingType: "breast_left" })
    fireEvent.click(screen.getByRole("button", { name: "手動入力" }))
    fireEvent.click(screen.getByRole("button", { name: "右から" }))
    fireEvent.click(screen.getByRole("button", { name: /記録する/ }))
    await waitFor(() => expect(recordFeeding).toHaveBeenCalled())
    expect(recordFeeding).toHaveBeenCalledWith(
      expect.objectContaining({ breastStartSide: "right" }),
    )
  })

  it("楽観 append する行にも開始側が乗る", async () => {
    recordFeeding.mockResolvedValueOnce({ error: null, id: "ss-6" })
    const onLogRecorded = vi.fn()
    renderTimer({ initialFeedingType: "breast_left", onLogRecorded })
    fireEvent.click(stopButton())
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(onLogRecorded.mock.calls[0][0].breast_start_side).toBe("left")
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
      breastStartSide: "left",
      breastLeftSec: 300,
      breastRightSec: 200,
      loggedAt: FIXED_NOW_ISO,
      ...ANY_CLIENT_ID,
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
      // startSide を持たぬ保存形式で両側 1 回ずつ → 開始側は推定不能（null）
      breastStartSide: null,
      breastLeftSec: 60,
      breastRightSec: 120,
      loggedAt: STARTED_5MIN_AGO,
      ...ANY_CLIENT_ID,
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

  /**
   * シートは max-h-[85dvh] overflow-hidden ゆえ、本文がスクロール領域でないと、はみ出た
   * 下端（記録ボタン）が切れて押せぬ。#230 で開始側ブロックが足され、背の低い画面で
   * 実際に「記録する」が画面外へ出た。jsdom は寸法を測れぬゆえ構造の契約で固定する
   * （BabyLogFormSheet と同じ形: 本文 div が overflow-y-auto）。
   */
  it("手動入力の記録ボタンはシート内のスクロール領域に入っておる（下端が切れても届く）", () => {
    openManual()
    const sheet = recordButton().closest('[data-slot="sheet-content"]')
    expect(sheet).not.toBeNull()
    const scroller = recordButton().closest(".overflow-y-auto")
    expect(scroller).not.toBeNull()
    expect(sheet?.contains(scroller as Node)).toBe(true)
  })

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
      // 手動入力の開始側はタップした側（右）が既定
      breastStartSide: "right",
      breastLeftSec: 60,
      breastRightSec: 160,
      // logged_at は「記録時刻 − 授乳時間(左+右)」= サイクル開始時刻
      loggedAt: new Date(FIXED_NOW.getTime() - 220_000).toISOString(),
      ...ANY_CLIENT_ID,
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

  it("開始が前日（JST）のサイクルも onLogRecorded へ渡し（振り分けは親の appendLog）、前日保存をトーストで示す", async () => {
    // かつては前日行を onLogRecorded から外し、別の callback で fallback だけ更新しておった。
    // 親の appendLog が行の日付で logs・週窓・fallback を振り分けるようになったため、
    // 日付で分岐せず常に渡す（昨日を表示中なら昨日の行が即時に出る。レビュー P3-8）
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
      breastStartSide: null,
      durationSec: 1200,
      loggedAt: PREV_DAY_STARTED_AT,
      ...ANY_CLIENT_ID,
    })
    expect(onLogRecorded).toHaveBeenCalledTimes(1)
    const log = onLogRecorded.mock.calls[0][0] as {
      id: string
      logged_at: string
      feeding_type: string
    }
    expect(log.id).toBe("cross-1")
    expect(log.logged_at).toBe(PREV_DAY_STARTED_AT)
    expect(log.feeding_type).toBe("breast")
    // 無言スキップ禁止: 前日に保存されたことが分かる文言にする
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining("前日の記録として保存"),
    )
  })

  it("2 日以上前の停め忘れを記録した時は「前日」と偽らず、その日付（M/D）で示す", async () => {
    // JST 2026-07-17 23:50 開始（今日 07-20 から見て 3 日前）。停め忘れゆえ手動入力で記録する
    seedTimerState({
      startedAt: "2026-07-17T14:50:00.000Z",
      feedingType: "breast_left",
      leftCount: 1,
      rightCount: 1,
    })
    recordFeeding.mockResolvedValueOnce({ error: null, id: "old-1" })
    renderTimer({ initialFeedingType: "breast_left" })

    fireEvent.change(screen.getByLabelText("右の分"), { target: { value: "10" } })
    fireEvent.click(screen.getByRole("button", { name: /記録する/ }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())

    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("7/17の記録として保存"))
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringContaining("前日"))
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

// 旧テスト群（P1-05）は「1 分以上計測したタイマーは閉じる操作そのものを断る」を固定していた。
// 指示（§7.1 / 計画 UX-04a）は「シートを閉じて予定を見ても、進行中のタイマーを見つけて
// 戻れる」ゆえ改めた: 閉じる操作は**計測を捨てずに閉じ**、ダッシュボードのチップから戻る。
// 破棄は明示の「キャンセル（記録しない）→ 破棄する」だけ、1 分未満かつ未操作の誤タップ
// だけは閉じる操作で取り消す、という不変条件は据え置く。
describe("FeedingTimer の閉じる操作は計測を捨てず、破棄は明示の操作だけ（P1-05 / UX-04a）", () => {
  /** シート外（暗幕）への押下。Base UI の outside-press は pointerdown → click で判定する */
  function pressOutside() {
    const backdrop = document.querySelector('[data-slot="sheet-overlay"]')
    const target = backdrop ?? document.body
    fireEvent.pointerDown(target)
    fireEvent.mouseDown(target)
    fireEvent.pointerUp(target)
    fireEvent.mouseUp(target)
    fireEvent.click(target)
  }

  function pressEscape() {
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
      code: "Escape",
    })
  }

  /** 5 分前から計測中のタイマー（1 分以上 = 閉じる操作では破棄しない側）を仕込む。 */
  function seedRunningFiveMinutes() {
    seedTimerState({
      startedAt: STARTED_5MIN_AGO,
      feedingType: "breast_left",
      leftCount: 1,
      rightCount: 0,
      leftSec: 0,
      rightSec: 0,
      sideSince: STARTED_5MIN_AGO,
      startSide: "breast_left",
    })
  }

  describe("1 分以上計測したタイマー（閉じても計測は端末に残り、チップから戻れる）", () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] })
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it("Escape で閉じるが、localStorage と計測は残り、取り消しのトーストは出ない", () => {
      seedRunningFiveMinutes()
      const onOpenChange = vi.fn()
      const onRunningChange = vi.fn()
      renderTimer({ onOpenChange, onRunningChange })

      pressEscape()

      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(savedTimerState()?.startedAt).toBe(STARTED_5MIN_AGO)
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining("計測は続いています"),
      )
      expect(toast.success).not.toHaveBeenCalledWith("授乳の計測を取り消しました")
      // 親へは「計測中」のまま（null で上書きしない）
      expect(onRunningChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ startedAt: STARTED_5MIN_AGO, stale: false }),
      )
      expect(recordFeeding).not.toHaveBeenCalled()
    })

    it("暗幕（シート外）でも閉じるが、localStorage と計測は残る", () => {
      seedRunningFiveMinutes()
      const onOpenChange = vi.fn()
      renderTimer({ onOpenChange })

      pressOutside()

      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(savedTimerState()?.startedAt).toBe(STARTED_5MIN_AGO)
    })

    it("× ボタンは常に出て、押しても計測は捨てられない", () => {
      seedRunningFiveMinutes()
      const onOpenChange = vi.fn()
      renderTimer({ onOpenChange })

      fireEvent.click(screen.getByRole("button", { name: "閉じる" }))

      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(savedTimerState()?.startedAt).toBe(STARTED_5MIN_AGO)
      expect(toast.success).not.toHaveBeenCalledWith("授乳の計測を取り消しました")
    })

    it("開いてからちょうど 60 秒の Escape は取り消さず、計測を残して閉じる（1 分未満だけが誤操作扱い）", () => {
      const onOpenChange = vi.fn()
      renderTimer({ onOpenChange })
      const before = savedTimerState()
      vi.setSystemTime(new Date(FIXED_NOW.getTime() + 60_000))

      pressEscape()

      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(savedTimerState()?.startedAt).toBe(before.startedAt)
      expect(toast.success).not.toHaveBeenCalledWith("授乳の計測を取り消しました")
    })
  })

  describe("開いて 1 分未満（誤って開いた）のタイマー", () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] })
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it("Escape で計測を取り消して閉じ、localStorage を消してトーストで知らせる", () => {
      const onOpenChange = vi.fn()
      renderTimer({ onOpenChange })
      expect(savedTimerState()?.startedAt).toBe(FIXED_NOW_ISO)
      vi.setSystemTime(new Date(FIXED_NOW.getTime() + 59_000))

      pressEscape()

      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(savedTimerState()).toBeNull()
      expect(toast.success).toHaveBeenCalledWith("授乳の計測を取り消しました")
      expect(recordFeeding).not.toHaveBeenCalled()
    })

    it("暗幕（シート外）でも取り消して閉じる", () => {
      const onOpenChange = vi.fn()
      renderTimer({ onOpenChange })

      pressOutside()

      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(savedTimerState()).toBeNull()
      expect(toast.success).toHaveBeenCalledWith("授乳の計測を取り消しました")
    })

    it("× ボタンを出し、押すと取り消して閉じる", () => {
      const onOpenChange = vi.fn()
      renderTimer({ onOpenChange })

      fireEvent.click(screen.getByRole("button", { name: "閉じる" }))

      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(savedTimerState()).toBeNull()
      expect(toast.success).toHaveBeenCalledWith("授乳の計測を取り消しました")
    })

    it("手動入力へ切り替えても、閉じる操作で取り消せる（裏のタイマーも 1 分未満）", () => {
      const onOpenChange = vi.fn()
      renderTimer({ onOpenChange })
      fireEvent.click(screen.getByRole("button", { name: "手動入力" }))

      pressEscape()

      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(savedTimerState()).toBeNull()
    })

    it("1 分未満でも左右を切り替えた計測は、閉じる操作では捨てず計測を残して閉じる（触った計測は確認を経る）", () => {
      const onOpenChange = vi.fn()
      renderTimer({ onOpenChange })
      fireEvent.click(screen.getByRole("button", { name: "右" }))
      vi.setSystemTime(new Date(FIXED_NOW.getTime() + 30_000))

      pressEscape()

      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(savedTimerState()?.startedAt).toBe(FIXED_NOW_ISO)
      expect(toast.success).not.toHaveBeenCalledWith("授乳の計測を取り消しました")
    })

    it("時計が戻って開始時刻が未来になっても、積んだ計測を閉じる操作では捨てない（経過が負なら猶予外）", () => {
      // 開始時刻が「今」より 20 分先 = 端末の時計が開始後に戻った状態。左右の回数・秒数も積んである。
      const futureStart = new Date(FIXED_NOW.getTime() + 20 * 60_000).toISOString()
      seedTimerState({
        startedAt: futureStart,
        feedingType: "breast_right",
        leftCount: 2,
        rightCount: 1,
        leftSec: 600,
        rightSec: 300,
        sideSince: futureStart,
        startSide: "breast_left",
      })
      const onOpenChange = vi.fn()
      renderTimer({ onOpenChange })

      pressEscape()

      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(savedTimerState()?.startedAt).toBe(futureStart)
      expect(toast.success).not.toHaveBeenCalledWith("授乳の計測を取り消しました")
    })

    // 上の fixture は操作済みゆえ seed の判定だけで猶予外になり、経過が負の門まで届かぬ
    // （門を消しても緑のままじゃった）。未操作の seed のまま時計だけが戻った形で門を固定する。
    /** seed のまま（片側・回数は seed どおり・秒の積算なし）のタイマーを開始時刻だけ変えて仕込む。 */
    function seedUntouchedAt(startedAt: string) {
      seedTimerState({
        startedAt,
        feedingType: "breast_left",
        leftCount: 1,
        rightCount: 0,
        leftSec: 0,
        rightSec: 0,
        sideSince: startedAt,
        startSide: "breast_left",
      })
    }

    it("未操作の seed でも、時計が戻って開始時刻が未来なら閉じる操作で捨てない（片側だけの長い計測でありうる）", () => {
      const futureStart = new Date(FIXED_NOW.getTime() + 20 * 60_000).toISOString()
      seedUntouchedAt(futureStart)
      const onOpenChange = vi.fn()
      renderTimer({ onOpenChange })

      pressEscape()

      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(savedTimerState()?.startedAt).toBe(futureStart)
      expect(toast.success).not.toHaveBeenCalledWith("授乳の計測を取り消しました")
    })

    it("対照: 同じ seed で開始が 30 秒前なら、閉じる操作で取り消す（上の fixture が未操作の seed であることの確かめ）", () => {
      const recentStart = new Date(FIXED_NOW.getTime() - 30_000).toISOString()
      seedUntouchedAt(recentStart)
      const onOpenChange = vi.fn()
      renderTimer({ onOpenChange })

      pressEscape()

      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(savedTimerState()).toBeNull()
      expect(toast.success).toHaveBeenCalledWith("授乳の計測を取り消しました")
    })
  })

  it("1 分を過ぎても × は出続け、押すと計測を残したまま閉じる（手動入力中も時計を進める）", () => {
    vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date", "setInterval", "clearInterval"] })
    try {
      const onOpenChange = vi.fn()
      renderTimer({ onOpenChange })
      fireEvent.click(screen.getByRole("button", { name: "手動入力" }))
      expect(screen.getByRole("button", { name: "閉じる" })).toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(61_000)
      })

      const close = screen.getByRole("button", { name: "閉じる" })
      fireEvent.click(close)
      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(savedTimerState()?.startedAt).toBe(FIXED_NOW_ISO)
    } finally {
      vi.useRealTimers()
    }
  })

  it("閉じる操作の後も計測は続き、記録すると logged_at は最初の開始時刻のまま", async () => {
    vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] })
    try {
      seedTimerState({
        startedAt: STARTED_5MIN_AGO,
        feedingType: "breast_left",
        leftCount: 1,
        rightCount: 0,
        leftSec: 0,
        rightSec: 0,
        sideSince: STARTED_5MIN_AGO,
        startSide: "breast_left",
      })
      recordFeeding.mockResolvedValueOnce({ error: null, id: "kept-1" })
      renderTimer()

      pressEscape()
      pressOutside()
      fireEvent.click(stopButton())

      await waitFor(() => expect(recordFeeding).toHaveBeenCalledTimes(1))
      expect(recordFeeding.mock.calls[0][0].loggedAt).toBe(STARTED_5MIN_AGO)
    } finally {
      vi.useRealTimers()
    }
  })

  it("「キャンセル（記録しない）」は 1 回目では破棄せず、確認を挟む", () => {
    const onOpenChange = vi.fn()
    renderTimer({ onOpenChange })
    const before = savedTimerState()

    fireEvent.click(screen.getByRole("button", { name: "キャンセル（記録しない）" }))

    expect(savedTimerState()?.startedAt).toBe(before.startedAt)
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.getByRole("button", { name: "破棄する" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "計測を続ける" })).toBeInTheDocument()
  })

  it("確認段の「計測を続ける」「破棄する」はどちらも 44px 以上（Button 基底の min-h-11）", () => {
    // size="sm" の h-7（28px）は高さの既定にすぎず、Button 基底の min-h-11 が下限として
    // 勝つ（min-height は height より優先）。className で潰していないことを固定する。
    renderTimer()
    fireEvent.click(screen.getByRole("button", { name: "キャンセル（記録しない）" }))

    for (const name of ["計測を続ける", "破棄する"]) {
      const button = screen.getByRole("button", { name })
      expect(button.className).toMatch(/(^|\s)min-h-11(\s|$)/)
      expect(button.className).toMatch(/(^|\s)min-w-11(\s|$)/)
    }
  })

  it("確認で「計測を続ける」を選ぶと破棄せず元の表示へ戻る", () => {
    renderTimer()
    const before = savedTimerState()

    fireEvent.click(screen.getByRole("button", { name: "キャンセル（記録しない）" }))
    fireEvent.click(screen.getByRole("button", { name: "計測を続ける" }))

    expect(savedTimerState()?.startedAt).toBe(before.startedAt)
    expect(screen.queryByRole("button", { name: "破棄する" })).toBeNull()
    expect(
      screen.getByRole("button", { name: "キャンセル（記録しない）" }),
    ).toBeInTheDocument()
  })

  it("確認で「破棄する」を選んだ時だけ localStorage を消し、トーストで知らせて閉じる", () => {
    const onOpenChange = vi.fn()
    renderTimer({ onOpenChange })

    fireEvent.click(screen.getByRole("button", { name: "キャンセル（記録しない）" }))
    fireEvent.click(screen.getByRole("button", { name: "破棄する" }))

    expect(savedTimerState()).toBeNull()
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining("破棄しました"),
    )
    expect(recordFeeding).not.toHaveBeenCalled()
  })

  it("計測していない時（破棄後）は Escape で通常どおり閉じられる（対照）", () => {
    // onOpenChange の mock は open を変えぬため、破棄後もシートは開いたまま残る。
    const onOpenChange = vi.fn()
    renderTimer({ onOpenChange })
    fireEvent.click(screen.getByRole("button", { name: "キャンセル（記録しない）" }))
    fireEvent.click(screen.getByRole("button", { name: "破棄する" }))
    onOpenChange.mockClear()

    pressEscape()

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("1 分未満でも「キャンセル（記録しない）」は従来どおり確認を挟む（明示の破棄の経路は変えない）", () => {
    const onOpenChange = vi.fn()
    renderTimer({ onOpenChange })

    fireEvent.click(screen.getByRole("button", { name: "キャンセル（記録しない）" }))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(savedTimerState()).not.toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "破棄する" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(savedTimerState()).toBeNull()
  })

  it("記録成功の後（計測していない）は Escape で通常どおり閉じられる（対照）", async () => {
    const onOpenChange = vi.fn()
    recordFeeding.mockResolvedValueOnce({ error: null, id: "done-1" })
    renderTimer({ onOpenChange })
    fireEvent.click(stopButton())
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    onOpenChange.mockClear()

    pressEscape()

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe("FeedingTimer の持ち主と冪等 id（P3-08 / P2-08）", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("端末保存には持ち主（userId）と冪等 id（clientId）が入る", () => {
    renderTimer({ userId: "u1" })
    const saved = savedTimerState()
    expect(saved.userId).toBe("u1")
    expect(saved.clientId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("別の利用者の計測は復元せず捨てて始め直す（他人の授乳を自分の名義で記録しない）", () => {
    seedTimerState({
      startedAt: STARTED_5MIN_AGO,
      feedingType: "breast_right",
      leftCount: 2,
      rightCount: 1,
      userId: "someone-else",
    })
    renderTimer({ initialFeedingType: "breast_left", userId: "u1" })

    expect(screen.getByText("00:00")).toBeInTheDocument()
    expect(screen.getByText(/左1回 00:00・右0回 00:00/)).toBeInTheDocument()
    expect(savedTimerState()).toMatchObject({ startedAt: FIXED_NOW_ISO, userId: "u1" })
  })

  it("持ち主を持たぬ旧形式の保存は受理し、持ち主を書き足す（更新直後に計測を消さない）", () => {
    seedTimerState({
      startedAt: STARTED_5MIN_AGO,
      feedingType: "breast_left",
      leftCount: 2,
      rightCount: 1,
    })
    renderTimer({ userId: "u1" })
    expect(screen.getByText("左2・右1")).toBeInTheDocument()
    expect(savedTimerState()).toMatchObject({ startedAt: STARTED_5MIN_AGO, userId: "u1" })
  })

  it("通信断で停止が失敗した後の再停止は同じ冪等 id を送る（二重記録を作らない）", async () => {
    renderTimer()
    const clientId = savedTimerState().clientId as string

    recordFeeding.mockRejectedValueOnce(new Error("network down"))
    fireEvent.click(stopButton())
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    // 計測と id は端末に残っている
    expect(savedTimerState().clientId).toBe(clientId)

    recordFeeding.mockResolvedValueOnce({ error: null, id: clientId })
    fireEvent.click(stopButton())
    await waitFor(() => expect(recordFeeding).toHaveBeenCalledTimes(2))
    expect(recordFeeding.mock.calls[0][0].clientId).toBe(clientId)
    expect(recordFeeding.mock.calls[1][0].clientId).toBe(clientId)
    expect(savedTimerState()).toBeNull()
  })

  it("保存された冪等 id は復元後も同じものを送る（リロードを挟んだ再試行）", async () => {
    seedTimerState({
      startedAt: STARTED_5MIN_AGO,
      feedingType: "breast_left",
      leftCount: 1,
      rightCount: 0,
      userId: "u1",
      clientId: "6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
    })
    recordFeeding.mockResolvedValueOnce({ error: null, id: "6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f" })
    renderTimer()
    fireEvent.click(stopButton())
    await waitFor(() => expect(recordFeeding).toHaveBeenCalled())
    expect(recordFeeding.mock.calls[0][0].clientId).toBe("6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f")
  })
})

describe("FeedingTimer の停め忘れの停止時判定と、端末保存が効かぬ環境（レビュー P3-6 / P3-7）", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("開いたまま 2 時間を超えた計測は「停止して記録」で膨らんだ時間を記録せず、手動入力へ回す", async () => {
    seedTimerState({
      startedAt: STARTED_5MIN_AGO,
      feedingType: "breast_left",
      leftCount: 1,
      rightCount: 0,
      userId: "u1",
    })
    renderTimer()
    // 開いた時点では停め忘れではない（対照）
    expect(screen.queryByLabelText("右の分")).toBeNull()

    // 画面を点けたまま（wake lock）2 時間 10 分が過ぎた
    vi.setSystemTime(new Date(FIXED_NOW.getTime() + (2 * 60 + 10) * 60_000))
    fireEvent.click(stopButton())

    expect(recordFeeding).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("2 時間を超えています"))
    // 手動入力になり、開始時刻は保たれておる（記録すれば logged_at は STARTED_5MIN_AGO）
    expect(screen.getByLabelText("右の分")).toBeInTheDocument()
    expect(savedTimerState().startedAt).toBe(STARTED_5MIN_AGO)
    recordFeeding.mockResolvedValueOnce({ error: null, id: "late-1" })
    fireEvent.change(screen.getByLabelText("右の分"), { target: { value: "10" } })
    fireEvent.click(screen.getByRole("button", { name: /記録する/ }))
    await waitFor(() => expect(recordFeeding).toHaveBeenCalled())
    expect(recordFeeding).toHaveBeenCalledWith(
      expect.objectContaining({ loggedAt: STARTED_5MIN_AGO, breastRightSec: 600 }),
    )
  })

  it("端末保存に失敗する環境では、閉じて開き直しても手元の計測を新しいタイマーで上書きせぬ", () => {
    // 容量不足・プライベートモード: writePersistedTimer は false（1 回だけ知らせる）
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError")
      })
    try {
      const onRunningChange = vi.fn()
      const onOpenChange = vi.fn()
      const view = render(
        <FeedingTimer
          open
          onOpenChange={onOpenChange}
          initialFeedingType="breast_left"
          userId="u1"
          onRunningChange={onRunningChange}
        />,
      )
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("保存できませんでした"))
      expect(onRunningChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ startedAt: FIXED_NOW_ISO }),
      )

      // 閉じて 5 分後に開き直す（保存は無い）
      view.rerender(
        <FeedingTimer
          open={false}
          onOpenChange={onOpenChange}
          initialFeedingType="breast_left"
          userId="u1"
          onRunningChange={onRunningChange}
        />,
      )
      vi.setSystemTime(new Date(FIXED_NOW.getTime() + 5 * 60_000))
      view.rerender(
        <FeedingTimer
          open
          onOpenChange={onOpenChange}
          initialFeedingType="breast_left"
          userId="u1"
          onRunningChange={onRunningChange}
        />,
      )

      // 手元の計測（開始 FIXED_NOW）がそのまま続いておる。新しい開始時刻にはならぬ
      expect(onRunningChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ startedAt: FIXED_NOW_ISO, stale: false }),
      )
      expect(screen.getByText("05:00")).toBeInTheDocument()
    } finally {
      setItem.mockRestore()
    }
  })

  it("対照: 端末保存が効く環境で保存が無ければ（別タブで記録済み等）従来どおり新しく始める", () => {
    const onRunningChange = vi.fn()
    const onOpenChange = vi.fn()
    const view = render(
      <FeedingTimer
        open
        onOpenChange={onOpenChange}
        initialFeedingType="breast_left"
        userId="u1"
        onRunningChange={onRunningChange}
      />,
    )
    view.rerender(
      <FeedingTimer
        open={false}
        onOpenChange={onOpenChange}
        initialFeedingType="breast_left"
        userId="u1"
        onRunningChange={onRunningChange}
      />,
    )
    localStorage.clear()
    const later = new Date(FIXED_NOW.getTime() + 5 * 60_000)
    vi.setSystemTime(later)
    view.rerender(
      <FeedingTimer
        open
        onOpenChange={onOpenChange}
        initialFeedingType="breast_left"
        userId="u1"
        onRunningChange={onRunningChange}
      />,
    )
    expect(onRunningChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ startedAt: later.toISOString() }),
    )
  })
})

describe("FeedingTimer のシート本文はスクロールできる（小型画面で出口が切れない）", () => {
  // SheetContent は max-h-[85dvh] overflow-hidden。本文が縦に収まらぬ端末（iPhone SE の
  // standalone 等）で、記録・キャンセル・破棄の確認が下で切れて押せなくならぬよう、
  // 見出しの下の本文だけを縦スクロールにする（記録シート・日記シートと同じ型）。
  function scrollBodyOf(element: HTMLElement) {
    return element.closest(".overflow-y-auto") as HTMLElement | null
  }

  it("タイマーの本文: 停止・キャンセル・破棄の確認がスクロール領域の中にあり、見出しは外にある", () => {
    renderTimer()
    const body = scrollBodyOf(stopButton())
    expect(body).not.toBeNull()

    const cancel = screen.getByRole("button", { name: "キャンセル（記録しない）" })
    expect(body).toContainElement(cancel)
    fireEvent.click(cancel)
    expect(body).toContainElement(screen.getByRole("button", { name: "破棄する" }))

    // 見出しはスクロールで流れない
    expect(body).not.toContainElement(screen.getByText("授乳を記録"))
  })

  it("手動入力の本文: 記録・キャンセルが同じスクロール領域の中にある", () => {
    renderTimer()
    fireEvent.click(screen.getByRole("button", { name: "手動入力" }))
    const body = scrollBodyOf(screen.getByRole("button", { name: /記録する/ }))
    expect(body).not.toBeNull()
    expect(body).toContainElement(
      screen.getByRole("button", { name: "キャンセル（記録しない）" }),
    )
  })
})

describe("FeedingTimer の「閉じる」釦（押す前に結果を文言で示す）", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("開いたばかり（1 分未満・未操作）は「取り消し」と書き、押すと計測を捨てて閉じる", () => {
    const onOpenChange = vi.fn()
    renderTimer({ onOpenChange })
    const close = screen.getByRole("button", { name: /^閉じる（/ })
    expect(close).toHaveTextContent("閉じる（開いたばかりの計測は取り消し）")

    fireEvent.click(close)

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(savedTimerState()).toBeNull()
    expect(toast.success).toHaveBeenCalledWith("授乳の計測を取り消しました")
  })

  it("1 分以上の計測は「計測は続きます」と書き、押しても端末の計測は残る（チップから戻れる）", () => {
    seedTimerState({
      startedAt: STARTED_5MIN_AGO,
      feedingType: "breast_left",
      leftCount: 1,
      rightCount: 0,
      leftSec: 0,
      rightSec: 0,
      sideSince: STARTED_5MIN_AGO,
      startSide: "breast_left",
      userId: "u1",
    })
    const onOpenChange = vi.fn()
    renderTimer({ onOpenChange })
    const close = screen.getByRole("button", { name: /^閉じる（/ })
    expect(close).toHaveTextContent("閉じる（計測は続きます）")

    fireEvent.click(close)

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(savedTimerState()?.startedAt).toBe(STARTED_5MIN_AGO)
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("計測は続いています"))
    expect(toast.success).not.toHaveBeenCalledWith("授乳の計測を取り消しました")
    expect(recordFeeding).not.toHaveBeenCalled()
  })

  it("1 分未満でも左右を切り替えた計測は「続きます」（触った計測は確認なしに捨てぬ）", () => {
    const onOpenChange = vi.fn()
    renderTimer({ onOpenChange })
    fireEvent.click(screen.getByRole("button", { name: "右" }))
    const close = screen.getByRole("button", { name: /^閉じる（/ })
    expect(close).toHaveTextContent("閉じる（計測は続きます）")
    fireEvent.click(close)
    expect(savedTimerState()).not.toBeNull()
  })

  it("左右の大きな釦は名前が「左」「右」で、吸わせ中の側を aria-pressed と語の両方で示す", () => {
    renderTimer({ initialFeedingType: "breast_left" })
    const left = screen.getByRole("button", { name: "左" })
    const right = screen.getByRole("button", { name: "右" })
    expect(left).toHaveAttribute("aria-pressed", "true")
    expect(right).toHaveAttribute("aria-pressed", "false")
    expect(left).toHaveTextContent("吸わせ中")
    expect(right).not.toHaveTextContent("吸わせ中")
    fireEvent.click(right)
    expect(left).toHaveAttribute("aria-pressed", "false")
    expect(right).toHaveAttribute("aria-pressed", "true")
    expect(right).toHaveTextContent("1回 00:00")
  })

  it("入力方法（タイマー / 手動入力）は左右とは別の群で、選択中を aria-pressed で示す", () => {
    renderTimer()
    const group = screen.getByRole("group", { name: "入力方法" })
    expect(group).toContainElement(screen.getByRole("button", { name: "タイマー" }))
    expect(group).not.toContainElement(screen.getByRole("button", { name: "左" }))
    expect(screen.getByRole("button", { name: "タイマー" })).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(screen.getByRole("button", { name: "手動入力" }))
    expect(screen.getByRole("button", { name: "手動入力" })).toHaveAttribute("aria-pressed", "true")
  })
})
