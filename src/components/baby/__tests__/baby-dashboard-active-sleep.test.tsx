/**
 * B-01（日跨ぎアクティブ睡眠の袋小路）の component テスト。
 *
 * 検証対象（state 遷移は純関数で表現できないため RTL で固定 — 計画書 §3 B-01）:
 * 1. 前夜開始・未終了の睡眠が選択日 logs に無くても activeSleepFallback で
 *    トグルが「睡眠中（経過時間表示）」になる
 * 2. トグルタップで endSleep(fallback.id) が呼ばれ、成功後はフォールバックが
 *    明示クリアされてトグルが「ねんね」へ戻る（Realtime 不達 #92 でも
 *    睡眠中表示へ戻らない）
 * 3. Realtime UPDATE で fallback 睡眠の ended_at が設定されたら（配偶者端末で
 *    終了された場合）フォールバックが同期クリアされる
 *
 * 時刻は実タイマー + todayJstString() の実時刻から相対で組む
 * （前夜 21:00 JST 開始 = 常に日跨ぎ条件が成立し、選択日 logs に現れない）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react"
import { act } from "react"
import type { BabyLogData } from "@/lib/types/baby"
import type {
  RealtimePayload,
  ViFn,
} from "@/test-utils/supabase-realtime-mock"
import {
  emitPayload,
  makePayloadFor,
  resetInlineReducerMockState,
} from "@/test-utils/supabase-realtime-mock"
import { todayJstString, shiftYmd } from "@/lib/utils/date-jst"
import { endSleep, startSleep } from "@/app/(main)/baby/actions"

const mockState = vi.hoisted(() => ({
  listeners: [] as Array<(payload: unknown) => void>,
  removeChannelMock: undefined as unknown as ViFn,
  fromMock: undefined as unknown as ViFn,
}))

vi.mock("@/lib/supabase/client", async () => {
  const { vi: viMod } = await import("vitest")
  const { buildInlineReducerSupabaseMock } = await import(
    "@/test-utils/supabase-realtime-mock"
  )
  return buildInlineReducerSupabaseMock(viMod, mockState, {
    throwMessage:
      "supabase.from() should not be called in this test " +
      "(selectedDate must not change to trigger the date-change useEffect)",
  })
})

vi.mock("@/app/(main)/baby/actions", () => ({
  recordFeeding: vi.fn(),
  recordDiaper: vi.fn(),
  startSleep: vi.fn(),
  endSleep: vi.fn(),
  deleteLog: vi.fn(),
  recordTemperature: vi.fn(),
  recordGrowth: vi.fn(),
  recordMemo: vi.fn(),
  updateLog: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// vi.mock 後 import
import { BabyDashboard } from "../baby-dashboard"

const mockedEndSleep = vi.mocked(endSleep)
const mockedStartSleep = vi.mocked(startSleep)

// 実時刻ベースの相対日付（前夜 21:00 JST 開始 → 実行時刻によらず日跨ぎ成立）
const TODAY = todayJstString()
const YESTERDAY = shiftYmd(TODAY, -1)

const crossMidnightSleep: BabyLogData = {
  id: "sleep-cross-midnight",
  log_type: "sleep",
  logged_at: `${YESTERDAY}T21:00:00+09:00`,
  logged_by: "user-1",
  feeding_type: null,
  amount_ml: null,
  breast_left_count: null,
  breast_right_count: null,
  diaper_type: null,
  ended_at: null,
  temperature: null,
  weight_g: null,
  height_cm: null,
  duration_min: null,
  duration_sec: null,
  memo: null,
  created_at: `${YESTERDAY}T21:00:00+09:00`,
}

const makePayload = makePayloadFor<BabyLogData>("baby_logs")
const emit = (payload: RealtimePayload<BabyLogData>) =>
  emitPayload(mockState, payload)

function defaultProps(
  overrides: Partial<Parameters<typeof BabyDashboard>[0]> = {},
): Parameters<typeof BabyDashboard>[0] {
  return {
    initialLogs: [],
    initialOverlapLogs: [],
    initialWeeklyLogs: [],
    initialGrowthLogs: [],
    householdId: "h1",
    userId: "u1",
    initialDate: TODAY,
    initialDiary: null,
    lastSleepEndedAt: null,
    activeSleepFallback: null,
    lastFeedingFallback: null,
    babyName: null,
    babyBirthDate: null,
    pumpingIntervalMin: 180,
    ...overrides,
  }
}

/** 睡眠トグルボタン（睡眠中: 経過時間表示 / 起床中: 「ねんね」）を取得する */
function sleepToggle(): HTMLElement {
  // 睡眠中は font-mono の経過時間（例: "12時間30分"）、起床中は「ねんね」
  const nenne = screen.queryByRole("button", { name: "ねんね" })
  if (nenne) return nenne
  const elapsed = screen.getByRole("button", { name: /(時間|分)/ })
  return elapsed
}

beforeEach(() => {
  vi.clearAllMocks()
  cleanup()
  resetInlineReducerMockState(mockState)
})
afterEach(cleanup)

describe("BabyDashboard / 日跨ぎアクティブ睡眠フォールバック (B-01)", () => {
  it("前夜開始・未終了の睡眠が logs に無くても activeSleepFallback でトグルが睡眠中表示になる", () => {
    render(
      <BabyDashboard
        {...defaultProps({ activeSleepFallback: crossMidnightSleep })}
      />,
    )

    // 袋小路の再現条件: 「ねんね」（睡眠開始）トグルが出てはならない。
    // 経過時間付きの「起こす」トグル（例: "12時間30分"）が出る。
    expect(
      screen.queryByRole("button", { name: "ねんね" }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /時間/ }),
    ).toBeInTheDocument()
    // まとめバーも「睡眠中」表示
    expect(screen.getByText("睡眠中")).toBeInTheDocument()
  })

  it("トグルタップで endSleep(fallback.id) が呼ばれ、成功後トグルが「ねんね」へ戻る（明示クリア）", async () => {
    mockedEndSleep.mockResolvedValue({ error: null })
    render(
      <BabyDashboard
        {...defaultProps({ activeSleepFallback: crossMidnightSleep })}
      />,
    )

    fireEvent.click(sleepToggle())

    await waitFor(() =>
      expect(mockedEndSleep).toHaveBeenCalledWith("sleep-cross-midnight"),
    )
    // 袋小路の対偶: startSleep（23505 経路）は呼ばれない
    expect(mockedStartSleep).not.toHaveBeenCalled()

    // Realtime echo なしでもフォールバックが明示クリアされ「ねんね」へ戻る
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "ねんね" }),
      ).toBeInTheDocument(),
    )
    expect(screen.getByText("起きてる")).toBeInTheDocument()
  })

  it("endSleep が失敗した場合はフォールバックを保持し睡眠中表示のまま", async () => {
    mockedEndSleep.mockResolvedValue({ error: "終了に失敗しました。" })
    render(
      <BabyDashboard
        {...defaultProps({ activeSleepFallback: crossMidnightSleep })}
      />,
    )

    fireEvent.click(sleepToggle())

    await waitFor(() => expect(mockedEndSleep).toHaveBeenCalled())
    // 失敗時はクリアしない（リトライ可能な状態を保つ）
    expect(
      screen.queryByRole("button", { name: "ねんね" }),
    ).not.toBeInTheDocument()
    expect(screen.getByText("睡眠中")).toBeInTheDocument()
  })

  it("Realtime UPDATE で fallback 睡眠の ended_at が設定されたら同期クリアされる（別端末での終了）", () => {
    render(
      <BabyDashboard
        {...defaultProps({ activeSleepFallback: crossMidnightSleep })}
      />,
    )

    expect(screen.getByText("睡眠中")).toBeInTheDocument()

    act(() => {
      emit(
        makePayload("UPDATE", {
          ...crossMidnightSleep,
          ended_at: `${TODAY}T07:30:00+09:00`,
        }),
      )
    })

    expect(
      screen.getByRole("button", { name: "ねんね" }),
    ).toBeInTheDocument()
    expect(screen.queryByText("睡眠中")).not.toBeInTheDocument()
  })

  it("Realtime DELETE で fallback 睡眠が削除されたら同期クリアされる", () => {
    render(
      <BabyDashboard
        {...defaultProps({ activeSleepFallback: crossMidnightSleep })}
      />,
    )

    expect(screen.getByText("睡眠中")).toBeInTheDocument()

    act(() => {
      emit(makePayload("DELETE", crossMidnightSleep.id))
    })

    expect(
      screen.getByRole("button", { name: "ねんね" }),
    ).toBeInTheDocument()
  })

  it("fallback が null なら従来どおり「ねんね」トグル（回帰）", () => {
    render(<BabyDashboard {...defaultProps()} />)

    expect(
      screen.getByRole("button", { name: "ねんね" }),
    ).toBeInTheDocument()
    expect(screen.getByText("起きてる")).toBeInTheDocument()
  })
})
