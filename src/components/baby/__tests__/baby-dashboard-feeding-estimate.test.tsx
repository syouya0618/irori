/**
 * 「次の授乳の目安」の起点配線に対する回帰テスト（BabyDashboard 統合）。
 *
 * 直された欠陥（主の訴え「搾乳ではなく授乳の目安が欲しい・時間がおかしい・変化がない」）:
 * - 起点が搾乳（feeding_type='pumped'）限定だったため、母乳/ミルクを記録しても
 *   目安が動かず、古い搾乳に張り付いていた
 * - 起点が「その日の logs」限定だったため、深夜を跨ぐと目安ごと消えていた
 *
 * ゆえにここで固定するのは 3 点（受け入れ条件）:
 * 1. 母乳/ミルクを 1 件記録すると目安時刻が動く
 * 2. 前日 23:00 の授乳を起点に、翌 01:00 でも目安カードが出る
 * 3. 搾乳のみの日は目安が出ない（搾乳は赤子に与えていないため起点にしない）
 *
 * 時刻は vi.useFakeTimers({ now }) で固定する（todayJstString() / useNow(60_000) の
 * 双方が Date に依存するため）。Supabase client は Realtime mock へ差し替え、
 * INSERT payload を emit して「記録された」状態を作る。
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
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
import { formatTimeJst } from "@/lib/utils/date-jst"

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
      "supabase.from() should not be called in feeding-estimate tests " +
      "(selectedDate must not change)",
  })
})

import { BabyDashboard } from "../baby-dashboard"

// JST 2026-04-16 12:00:00 = UTC 2026-04-16 03:00:00
const FIXED_NOW = new Date("2026-04-16T03:00:00Z")
const TODAY = "2026-04-16"

const baseLog = {
  logged_by: "user-1",
  feeding_type: null,
  amount_ml: null,
  breast_left_count: null,
  breast_right_count: null,
  breast_left_sec: null,
  breast_right_sec: null,
  diaper_type: null,
  temperature: null,
  weight_g: null,
  height_cm: null,
  duration_min: null,
  duration_sec: null,
  memo: null,
  created_at: "2026-04-16T00:00:00+09:00",
} satisfies Omit<BabyLogData, "id" | "log_type" | "logged_at">

function makeLog(
  overrides: Partial<BabyLogData> &
    Pick<BabyLogData, "id" | "log_type" | "logged_at">,
): BabyLogData {
  return { ...baseLog, ...overrides }
}

const makePayload = makePayloadFor<BabyLogData>("baby_logs")
const emit = (payload: RealtimePayload<BabyLogData>) =>
  emitPayload(mockState, payload)

function defaultProps(
  overrides: Partial<Parameters<typeof BabyDashboard>[0]> = {},
): Parameters<typeof BabyDashboard>[0] {
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
    ...overrides,
  }
}

/** 目安カードの時刻表示（HH:MM）。カードが無ければ null。 */
function estimateTime(): string | null {
  const label = screen.queryByText("次の授乳の目安")
  if (!label) return null
  const card = label.parentElement
  return card?.querySelector("span.font-mono")?.textContent ?? null
}

beforeAll(() => {
  vi.useFakeTimers({ now: FIXED_NOW })
})

afterAll(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  cleanup()
  vi.setSystemTime(FIXED_NOW)
  resetInlineReducerMockState(mockState)
})

describe("BabyDashboard 次の授乳の目安", () => {
  it("ミルクを1件記録すると目安時刻が動く（母乳/ミルクで目安が変化しなかった欠陥の回帰）", () => {
    // 09:30 に母乳 → 目安 12:30（間隔180分）
    const breast = makeLog({
      id: "breast-1",
      log_type: "feeding",
      logged_at: "2026-04-16T09:30:00+09:00",
      feeding_type: "breast",
      breast_left_count: 2,
      breast_right_count: 1,
    })
    render(
      <BabyDashboard
        {...defaultProps({ initialLogs: [breast], initialWeeklyLogs: [breast] })}
      />,
    )
    expect(estimateTime()).toBe(formatTimeJst("2026-04-16T12:30:00+09:00"))

    // 11:00 にミルクを記録 → 目安は 14:00 へ前進する
    act(() => {
      emit(
        makePayload(
          "INSERT",
          makeLog({
            id: "bottle-1",
            log_type: "feeding",
            logged_at: "2026-04-16T11:00:00+09:00",
            feeding_type: "bottle",
            amount_ml: 120,
          }),
        ),
      )
    })
    expect(estimateTime()).toBe(formatTimeJst("2026-04-16T14:00:00+09:00"))
  })

  it("母乳サイクルを1件記録しても目安時刻が動く", () => {
    const bottle = makeLog({
      id: "bottle-0",
      log_type: "feeding",
      logged_at: "2026-04-16T08:00:00+09:00",
      feeding_type: "bottle",
      amount_ml: 100,
    })
    render(
      <BabyDashboard
        {...defaultProps({ initialLogs: [bottle], initialWeeklyLogs: [bottle] })}
      />,
    )
    expect(estimateTime()).toBe(formatTimeJst("2026-04-16T11:00:00+09:00"))

    act(() => {
      emit(
        makePayload(
          "INSERT",
          makeLog({
            id: "breast-2",
            log_type: "feeding",
            logged_at: "2026-04-16T10:30:00+09:00",
            feeding_type: "breast",
            breast_left_count: 1,
            breast_right_count: 1,
          }),
        ),
      )
    })
    expect(estimateTime()).toBe(formatTimeJst("2026-04-16T13:30:00+09:00"))
  })

  it("前日 23:00 の授乳を起点に、翌 01:00 でも目安カードが出る（深夜跨ぎ）", () => {
    // JST 2026-04-16 01:00 に閲覧。今日の logs は空で、起点は前日 23:00 の授乳。
    vi.setSystemTime(new Date("2026-04-15T16:00:00Z"))
    render(
      <BabyDashboard
        {...defaultProps({
          initialLogs: [],
          initialWeeklyLogs: [],
          lastNursingFallback: makeLog({
            id: "breast-prev-day",
            log_type: "feeding",
            logged_at: "2026-04-15T23:00:00+09:00",
            feeding_type: "breast",
            breast_left_count: 2,
            breast_right_count: 2,
          }),
        })}
      />,
    )
    expect(screen.getByText("次の授乳の目安")).toBeInTheDocument()
    expect(estimateTime()).toBe(formatTimeJst("2026-04-16T02:00:00+09:00"))
    expect(screen.getByText(/あと1時間/)).toBeInTheDocument()
  })

  it("搾乳のみの日は目安が出ない（搾乳は起点にしない）", () => {
    const pumped = makeLog({
      id: "pumped-1",
      log_type: "feeding",
      logged_at: "2026-04-16T08:00:00+09:00",
      feeding_type: "pumped",
      amount_ml: 80,
    })
    render(
      <BabyDashboard
        {...defaultProps({ initialLogs: [pumped], initialWeeklyLogs: [pumped] })}
      />,
    )
    expect(screen.queryByText("次の授乳の目安")).not.toBeInTheDocument()
    // 旧カード（搾乳起点）も出ない＝置き換えであって並記ではない
    expect(screen.queryByText("次の搾乳の目安")).not.toBeInTheDocument()
  })

  it("搾乳を記録しても目安の起点は動かない（授乳のみが起点）", () => {
    const breast = makeLog({
      id: "breast-3",
      log_type: "feeding",
      logged_at: "2026-04-16T09:00:00+09:00",
      feeding_type: "breast",
      breast_left_count: 1,
      breast_right_count: 1,
    })
    render(
      <BabyDashboard
        {...defaultProps({ initialLogs: [breast], initialWeeklyLogs: [breast] })}
      />,
    )
    expect(estimateTime()).toBe(formatTimeJst("2026-04-16T12:00:00+09:00"))

    act(() => {
      emit(
        makePayload(
          "INSERT",
          makeLog({
            id: "pumped-2",
            log_type: "feeding",
            logged_at: "2026-04-16T11:30:00+09:00",
            feeding_type: "pumped",
            amount_ml: 60,
          }),
        ),
      )
    })
    // 搾乳で 14:30 へ飛ばない
    expect(estimateTime()).toBe(formatTimeJst("2026-04-16T12:00:00+09:00"))
  })

  it("目安を過ぎたら経過時間を表示する（「そろそろです」で張り付かない）", () => {
    // 08:30 授乳 + 180分 → 11:30 目安。NOW 12:00 は 30 分超過
    const breast = makeLog({
      id: "breast-4",
      log_type: "feeding",
      logged_at: "2026-04-16T08:30:00+09:00",
      feeding_type: "breast",
      breast_left_count: 1,
      breast_right_count: 1,
    })
    render(
      <BabyDashboard
        {...defaultProps({ initialLogs: [breast], initialWeeklyLogs: [breast] })}
      />,
    )
    expect(screen.getByText("30分 経過")).toBeInTheDocument()
    expect(screen.queryByText("そろそろです")).not.toBeInTheDocument()
  })
})
