/**
 * BabyDashboard の Realtime → 週間サマリー反映パスに対する統合テスト。
 *
 * - Supabase channel API を vi.mock + vi.hoisted で差し替え、テストから payload を emit
 * - JST 系の今日判定は vi.useFakeTimers({ now }) で固定し、todayJstString() の戻りを制御
 * - useNow(60_000) の setInterval も vi.advanceTimersByTime で進められるので、
 *   真夜中跨ぎの「today ref 更新と週ウィンドウシフト」を実時間操作なしで検証可能
 * - BabyWeeklySummary の BarChart は SVG <title>"4/16: 1回"</title> を吐くため
 *   これを anchor に DOM クエリして反映を検証
 *
 * issue #16 の検証要件カバレッジ:
 * - INSERT/UPDATE/DELETE payload 受信時の weeklyLogs state 整合 → 1, 2, 3, 4, 7, 8
 * - ID のみ payload で来る DELETE ブランチ → 3
 * - 真夜中跨ぎ時の today ref 更新と週ウィンドウシフト → 9
 *
 * 検証対象:
 * 1. 当日 feeding INSERT → 週間サマリー授乳が 0回 → 1回
 * 2. 当日 feeding UPDATE (branch a: belongsToWeek && exists) → 件数不変
 * 3. 当日 diaper DELETE → 件数 -1（payload.old が { id } のみ）
 * 4. 別日付（週内・selectedDate 範囲外）の feeding INSERT → 週間サマリーに反映
 * 5. 週外の feeding INSERT → 無変化
 * 6. unmount で supabase.removeChannel が呼ばれる
 * 7. UPDATE branch b (belongsToWeek && !exists) → 週外→週内移動で weeklyLogs に追加
 * 8. UPDATE branch c (!belongsToWeek && exists) → 週内→週外移動で weeklyLogs から除外
 * 9. 真夜中跨ぎで useNow setInterval が発火 → today/weeklyStart の ref が前進し
 *     chart labels が ["4/10",..,"4/16"] → ["4/11",..,"4/17"] へシフト
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

// ---------------------------------------------------------------------------
// Mock state (vi.hoisted で factory と test body で共有)
// ---------------------------------------------------------------------------

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
      "supabase.from() should not be called in BabyDashboard tests " +
      "(selectedDate must not change to trigger the date-change useEffect)",
  })
})

// ---------------------------------------------------------------------------
// Imports after vi.mock
// ---------------------------------------------------------------------------
import { BabyDashboard } from "../baby-dashboard"

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

// JST 2026-04-16 12:00:00 = UTC 2026-04-16 03:00:00
const FIXED_NOW = new Date("2026-04-16T03:00:00Z")
const TODAY = "2026-04-16"
// WEEK_START = TODAY - 6 = 2026-04-10
const BEFORE_WEEK_DATE = "2026-04-08" // week start - 2

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

const emit = (payload: RealtimePayload<BabyLogData>) =>
  emitPayload(mockState, payload)

/**
 * 指定 ariaLabel の BarChart の SVG <title> テキスト一覧を返す。
 * BarChart は各日について `<title>${label}: ${formatted}</title>` を出力する
 * （bar-chart.test.ts で実証済み）。
 */
function chartTitles(ariaLabel: string): string[] {
  const svg = screen.getByLabelText(ariaLabel)
  return Array.from(svg.querySelectorAll("title")).map(
    (t) => t.textContent ?? "",
  )
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(() => {
  // useNow(60_000) の setInterval を制御するため fakeTimers を有効化。
  // Date も同時に fake され、todayJstString() が FIXED_NOW を基に動作する。
  vi.useFakeTimers({ now: FIXED_NOW })
})

afterAll(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  // cleanup() → resetInlineReducerMockState() の順序が load-bearing:
  // cleanup() で前テストの unmount が走り removeChannel カウントが +1 されるので、
  // その後で reset() (内部で mockClear) を呼ぶことでカウントを境界跨ぎさせない。
  cleanup()
  // case 10 (真夜中跨ぎ) が時刻を進めるため、毎テスト先頭で FIXED_NOW に戻す。
  vi.setSystemTime(FIXED_NOW)
  resetInlineReducerMockState(mockState)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BabyDashboard / Realtime → 週間サマリー反映", () => {
  it("当日 feeding INSERT で授乳チャートの今日分が 0回 → 1回 になる", () => {
    render(<BabyDashboard {...defaultProps()} />)

    expect(chartTitles("直近7日の授乳回数")).toContain(`4/16: 0回`)

    act(() => {
      emit(
        makePayload(
          "INSERT",
          makeLog({
            id: "log-1",
            log_type: "feeding",
            logged_at: "2026-04-16T03:30:00+09:00",
            feeding_type: "breast_left",
            amount_ml: 60,
          }),
        ),
      )
    })

    expect(chartTitles("直近7日の授乳回数")).toContain(`4/16: 1回`)
    // 他日は影響を受けない
    expect(chartTitles("直近7日の授乳回数")).toContain(`4/15: 0回`)
  })

  it("当日 feeding UPDATE で同件の amount_ml を変えても feedingCount は据え置き", () => {
    const existing = makeLog({
      id: "log-feed-1",
      log_type: "feeding",
      logged_at: "2026-04-16T01:00:00+09:00",
      feeding_type: "breast_left",
      amount_ml: 40,
    })

    render(
      <BabyDashboard
        {...defaultProps({
          initialLogs: [existing],
          initialWeeklyLogs: [existing],
        })}
      />,
    )

    expect(chartTitles("直近7日の授乳回数")).toContain(`4/16: 1回`)

    act(() => {
      emit(makePayload("UPDATE", { ...existing, amount_ml: 80 }))
    })

    // 件数は不変。本テストは件数だけを assert（amount_ml 値の UI 表示は
    // BabyTimeline 側で別途検証する性質のものでスコープ外）
    expect(chartTitles("直近7日の授乳回数")).toContain(`4/16: 1回`)
    expect(chartTitles("直近7日の授乳回数")).not.toContain(`4/16: 2回`)
  })

  it("当日 diaper DELETE で diaperCount が 1 減る（payload.old が { id } のみ）", () => {
    const existing = makeLog({
      id: "log-diaper-1",
      log_type: "diaper",
      logged_at: "2026-04-16T02:00:00+09:00",
      diaper_type: "pee",
    })

    render(
      <BabyDashboard
        {...defaultProps({
          initialLogs: [existing],
          initialWeeklyLogs: [existing],
        })}
      />,
    )

    expect(chartTitles("直近7日のおむつ交換回数")).toContain(`4/16: 1回`)

    act(() => {
      emit(makePayload("DELETE", existing.id))
    })

    expect(chartTitles("直近7日のおむつ交換回数")).toContain(`4/16: 0回`)
  })

  it("別日付（週内・selectedDate 範囲外）の feeding INSERT は週間サマリーに反映", () => {
    render(<BabyDashboard {...defaultProps()} />)

    expect(chartTitles("直近7日の授乳回数")).toContain(`4/15: 0回`)

    act(() => {
      emit(
        makePayload(
          "INSERT",
          makeLog({
            id: "log-feed-yesterday",
            log_type: "feeding",
            feeding_type: "bottle",
            // 昨日（週内だが selectedDate=4/16 の窓外）
            logged_at: "2026-04-15T22:00:00+09:00",
            amount_ml: 100,
          }),
        ),
      )
    })

    // weeklyLogs（週窓）へは入るが logs（選択日窓）へは入らない分岐の回帰。
    // isRelevantToCurrentWeek は selectedDate ではなく週窓で判定するため、
    // 選択日の外でも週間サマリーには載る。
    expect(chartTitles("直近7日の授乳回数")).toContain(`4/15: 1回`)
  })

  it("週外の feeding INSERT は週間サマリーに影響しない", () => {
    render(<BabyDashboard {...defaultProps()} />)

    const beforeTitles = chartTitles("直近7日の授乳回数")
    // 週外（4/8）は週間サマリーには登場せず、4/10〜4/16 のみ 7 件
    expect(beforeTitles).toHaveLength(7)
    expect(beforeTitles.every((t) => t.endsWith(": 0回"))).toBe(true)

    act(() => {
      emit(
        makePayload(
          "INSERT",
          makeLog({
            id: "log-out-of-week",
            log_type: "feeding",
            logged_at: `${BEFORE_WEEK_DATE}T08:00:00+09:00`,
            feeding_type: "breast_left",
          }),
        ),
      )
    })

    const afterTitles = chartTitles("直近7日の授乳回数")
    // 7 件のまま、全て 0回 のまま
    expect(afterTitles).toEqual(beforeTitles)
    expect(afterTitles.every((t) => t.endsWith(": 0回"))).toBe(true)
  })

  it("unmount で全 Realtime channel の supabase.removeChannel が呼ばれる", () => {
    const { unmount } = render(<BabyDashboard {...defaultProps()} />)

    expect(mockState.removeChannelMock).not.toHaveBeenCalled()

    unmount()

    // dashboard は baby_logs と baby_diaries の 2 channel を購読する（issue #155）。
    // どちらも cleanup で removeChannel されること。
    expect(mockState.removeChannelMock).toHaveBeenCalledTimes(2)
  })

  it("UPDATE branch b (週外→週内へ logged_at 移動) で weeklyLogs に取り込まれる", () => {
    // 元 logged_at が週外（4/8）だった想定で、初期 weeklyLogs は空。
    // 編集後 logged_at が週内（4/15）に変わった UPDATE payload を流す。
    render(<BabyDashboard {...defaultProps()} />)

    expect(chartTitles("直近7日の授乳回数")).toContain("4/15: 0回")

    act(() => {
      emit(
        makePayload(
          "UPDATE",
          makeLog({
            id: "log-moved-into-week",
            log_type: "feeding",
            logged_at: "2026-04-15T10:00:00+09:00",
            feeding_type: "breast_left",
          }),
        ),
      )
    })

    // 週外時点では weeklyLogs に居なかったが、belongsToWeek=true で追加される
    expect(chartTitles("直近7日の授乳回数")).toContain("4/15: 1回")
  })

  it("UPDATE branch c (週内→週外へ logged_at 移動) で weeklyLogs から除外される", () => {
    // 初期 weeklyLogs に週内ログ。UPDATE で logged_at を週外（4/8）に変える。
    const original = makeLog({
      id: "log-moved-out-of-week",
      log_type: "feeding",
      logged_at: "2026-04-15T10:00:00+09:00",
      feeding_type: "breast_left",
    })
    render(
      <BabyDashboard
        {...defaultProps({ initialWeeklyLogs: [original] })}
      />,
    )

    expect(chartTitles("直近7日の授乳回数")).toContain("4/15: 1回")

    act(() => {
      emit(
        makePayload("UPDATE", {
          ...original,
          logged_at: "2026-04-08T10:00:00+09:00", // 週外
        }),
      )
    })

    // 週外移動で belongsToWeek=false かつ exists=true → 除外
    expect(chartTitles("直近7日の授乳回数")).toContain("4/15: 0回")
  })

  it("真夜中跨ぎ: useNow の interval が発火し today/weeklyStart の ref が前進、chart labels がシフトする", () => {
    // JST 2026-04-16 23:55:00 = UTC 14:55:00 から開始
    vi.setSystemTime(new Date("2026-04-16T14:55:00Z"))

    render(<BabyDashboard {...defaultProps()} />)

    // 初期: 週ウィンドウは 4/10 〜 4/16
    const labelsBefore = chartTitles("直近7日の授乳回数").map((t) =>
      t.split(":")[0],
    )
    expect(labelsBefore).toEqual([
      "4/10",
      "4/11",
      "4/12",
      "4/13",
      "4/14",
      "4/15",
      "4/16",
    ])

    // 6 分進めて JST 00:01 に到達 → useNow(60_000) の setInterval が 6 回発火
    act(() => {
      vi.advanceTimersByTime(360_000)
    })

    // 真夜中越え: 週ウィンドウは 4/11 〜 4/17 にシフトする
    const labelsAfter = chartTitles("直近7日の授乳回数").map((t) =>
      t.split(":")[0],
    )
    expect(labelsAfter).toEqual([
      "4/11",
      "4/12",
      "4/13",
      "4/14",
      "4/15",
      "4/16",
      "4/17",
    ])
  })
})
