/**
 * BabyDashboard の過去日（機能 C）: クイック記録の代わりに「この日の記録を追加」を出し、
 * 追記した行はその日のタイムラインと週窓へ即時に載る。今日の行が過去日へ混入せぬことも
 * 同時に固定する（かつて F-03 として見送った懸念の答え）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react"
import { act } from "react"
import { recordMemo } from "@/app/(main)/baby/actions"

vi.mock("@/lib/supabase/client", () => {
  const channel: Record<string, unknown> = {}
  channel.on = () => channel
  channel.subscribe = () => channel
  // 日付ナビの取得は呼ばれぬ（initialDate が選択日）。再取得は session 待ちで止める
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
const YESTERDAY = "2026-07-18"

function defaultProps(): Parameters<typeof BabyDashboard>[0] {
  return {
    initialLogs: [],
    initialWeeklyLogs: [],
    initialGrowthLogs: [],
    householdId: "h1",
    userId: "u1",
    initialDate: YESTERDAY,
    initialDiary: null,
    lastFeedingFallback: null,
    lastNursingFallback: null,
    babyName: null,
    babyBirthDate: null,
    feedingIntervalMin: 180,
    initialBottleDefault: { status: "set" as const, amountMl: 120 },
  }
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

describe("BabyDashboard / 過去日の追記（機能 C）", () => {
  it("過去日を開くとクイック記録は出ず「この日の記録を追加」が出る", async () => {
    render(<BabyDashboard {...defaultProps()} />)
    await flush()
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("昨日")
    expect(screen.queryByRole("button", { name: "おしっこ" })).toBeNull()
    expect(screen.getByRole("region", { name: "この日の記録を追加" })).toBeInTheDocument()
  })

  it("「メモ」から開いたフォームは昨日の日付を持ち、記録した行は昨日のタイムラインと週窓へ即時に載る", async () => {
    vi.mocked(recordMemo).mockResolvedValue({ error: null, id: "memo-past" })
    render(<BabyDashboard {...defaultProps()} />)
    await flush()

    fireEvent.click(
      within(screen.getByRole("region", { name: "この日の記録を追加" })).getByRole("button", {
        name: "メモ",
      }),
    )
    await flush()
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText(/2026年7月18日\(土\) の記録として保存します/)).toBeInTheDocument()
    expect((within(dialog).getByLabelText("日付") as HTMLInputElement).value).toBe(YESTERDAY)

    fireEvent.change(within(dialog).getByLabelText("時刻"), { target: { value: "15:00" } })
    fireEvent.change(within(dialog).getByLabelText("メモ"), { target: { value: "昨日のメモ" } })
    fireEvent.click(within(dialog).getByRole("button", { name: "記録する" }))

    await waitFor(() => expect(recordMemo).toHaveBeenCalledTimes(1))
    expect(recordMemo).toHaveBeenCalledWith(
      expect.objectContaining({ loggedAt: "2026-07-18T06:00:00.000Z" }),
    )
    await flush()
    // 昨日のタイムラインへ出る（今日の行として混入しない）
    expect(screen.getByText("昨日のメモ")).toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("昨日")
  })
})
