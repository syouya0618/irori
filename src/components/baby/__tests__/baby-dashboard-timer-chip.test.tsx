/**
 * ダッシュボードの「授乳を計測中」チップ（UX-04a）と、端末保存の持ち主判定（P3-08）。
 *
 * タイマーのシートを閉じても計測は端末（localStorage）に残る。予定を見た後・別の記録を
 * 付けた後・再読み込みの後に、ダッシュボードのチップから計測へ戻れることを固定する。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"
import { act } from "react"
import { recordFeeding } from "@/app/(main)/baby/actions"
import { FEEDING_TIMER_STORAGE_KEY } from "@/lib/domain/feeding-timer-storage"

vi.mock("@/lib/supabase/client", () => {
  const channel: Record<string, unknown> = {}
  channel.on = () => channel
  channel.subscribe = () => channel
  // 問い合わせは起きぬ前提（マウント時の再取得は session 待ちで止める）。万一呼ばれても
  // 解決せぬ thenable を返し、テストを壊さず放置する
  const query: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return () => new Promise(() => {})
        return () => query
      },
    },
  )
  return {
    createClient: () => ({
      from: () => query,
      channel: () => channel,
      removeChannel: () => Promise.resolve("ok"),
      auth: { getSession: () => new Promise(() => {}) },
    }),
  }
})
vi.mock("@/app/(main)/baby/actions", () => ({
  recordFeeding: vi.fn(),
  recordDiaper: vi.fn(),
  deleteLog: vi.fn(),
  recordTemperature: vi.fn(),
  recordGrowth: vi.fn(),
  recordMemo: vi.fn(),
  updateLog: vi.fn(),
  upsertBabyDiary: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))
vi.mock("@/components/calendar/upcoming-events-card", () => ({
  UpcomingEventsCard: () => null,
}))

import { BabyDashboard } from "../baby-dashboard"

// JST 2026-07-19 13:00
const FIXED_NOW = new Date("2026-07-19T04:00:00.000Z")
const TODAY = "2026-07-19"
const STARTED_5MIN_AGO = "2026-07-19T03:55:00.000Z"
const STARTED_3H_AGO = "2026-07-19T01:00:00.000Z"

function defaultProps(): Parameters<typeof BabyDashboard>[0] {
  return {
    initialLogs: [],
    initialWeeklyLogs: [],
    initialGrowthLogs: [],
    householdId: "h1",
    userId: "u1",
    initialDate: TODAY,
    initialDiary: null,
    lastFeedingFallback: null,
    lastNursingFallback: null,
    babyName: null,
    babyBirthDate: null,
    feedingIntervalMin: 180,
  }
}

function seedTimer(state: Record<string, unknown>) {
  localStorage.setItem(FEEDING_TIMER_STORAGE_KEY, JSON.stringify(state))
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  cleanup()
  localStorage.clear()
  vi.clearAllMocks()
  vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("BabyDashboard / 授乳を計測中のチップ（UX-04a）", () => {
  it("端末に計測が残っておればマウント直後にチップを出し、タップでタイマーへ戻れる", async () => {
    seedTimer({
      startedAt: STARTED_5MIN_AGO,
      feedingType: "breast_right",
      leftCount: 1,
      rightCount: 1,
      leftSec: 60,
      rightSec: 0,
      sideSince: STARTED_5MIN_AGO,
      startSide: "breast_left",
      userId: "u1",
    })
    render(<BabyDashboard {...defaultProps()} />)
    await flush()

    const chip = screen.getByRole("button", { name: /授乳を計測中 05:00（右）/ })
    expect(chip).toBeInTheDocument()

    fireEvent.click(chip)
    await flush()
    // タイマーが開き、保存されていた計測（左1回・右1回）がそのまま続いている
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByText(/左1回 .+・右1回 /)).toBeInTheDocument()
    expect(screen.getByText("05:00")).toBeInTheDocument()
    // シートが開いている間はチップを重ねて出さぬ
    expect(screen.queryByRole("button", { name: /授乳を計測中/ })).toBeNull()
  })

  it("計測が無ければチップは出ない（対照）", async () => {
    render(<BabyDashboard {...defaultProps()} />)
    await flush()
    expect(screen.queryByRole("button", { name: /授乳を計測中|授乳の計測が残っています/ })).toBeNull()
  })

  it("別の利用者の計測はチップに出さない（P3-08）", async () => {
    seedTimer({
      startedAt: STARTED_5MIN_AGO,
      feedingType: "breast_left",
      leftCount: 1,
      rightCount: 0,
      userId: "someone-else",
    })
    render(<BabyDashboard {...defaultProps()} />)
    await flush()
    expect(screen.queryByRole("button", { name: /授乳を計測中/ })).toBeNull()
  })

  it("停め忘れ（2 時間超）は経過を刻まず、記録か破棄を促すチップにする", async () => {
    seedTimer({
      startedAt: STARTED_3H_AGO,
      feedingType: "breast_left",
      leftCount: 2,
      rightCount: 1,
      userId: "u1",
    })
    render(<BabyDashboard {...defaultProps()} />)
    await flush()
    expect(
      screen.getByRole("button", { name: /授乳の計測が残っています（10:00 開始）/ }),
    ).toBeInTheDocument()
  })

  it("タイマーで記録を終えるとチップが消え、端末保存も消える", async () => {
    seedTimer({
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
    vi.mocked(recordFeeding).mockResolvedValue({ error: null, id: "f-1" })
    render(<BabyDashboard {...defaultProps()} />)
    await flush()

    fireEvent.click(screen.getByRole("button", { name: /授乳を計測中/ }))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: /停止して記録/ }))
    await waitFor(() => expect(recordFeeding).toHaveBeenCalledTimes(1))
    await flush()

    expect(screen.queryByRole("button", { name: /授乳を計測中/ })).toBeNull()
    expect(localStorage.getItem(FEEDING_TIMER_STORAGE_KEY)).toBeNull()
    // 記録した行はタイムラインへ楽観 append される（左1回・5 分）
    // （「今」カードも同じ要約を最終授乳として出すゆえ、タイムラインの行 = button に絞る）
    expect(
      screen.getByRole("button", { name: /母乳（左から） 左1回5分/ }),
    ).toBeInTheDocument()
  })

  it("シートを閉じても計測は残り、チップが再び出る", async () => {
    render(<BabyDashboard {...defaultProps()} />)
    await flush()
    // 新しく計測を始める（左）
    fireEvent.click(screen.getByRole("button", { name: "左" }))
    await flush()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    // 1 分以上計測してから閉じる（1 分未満は誤って開いた扱いで取り消される）
    act(() => {
      vi.setSystemTime(new Date(FIXED_NOW.getTime() + 90_000))
    })
    fireEvent.click(screen.getByRole("button", { name: "右" }))
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" })
    await flush()

    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.getByRole("button", { name: /授乳を計測中 .*（右）/ })).toBeInTheDocument()
    expect(localStorage.getItem(FEEDING_TIMER_STORAGE_KEY)).not.toBeNull()
  })
})
