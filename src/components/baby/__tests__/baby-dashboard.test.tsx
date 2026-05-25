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
 * - INSERT/UPDATE/DELETE payload 受信時の weeklyLogs state 整合 → 1, 2, 3, 8, 9
 * - ID のみ payload で来る DELETE ブランチ → 3
 * - isRelevantToCurrentWeek の sleep cross-week 分岐 → 6
 * - 真夜中跨ぎ時の today ref 更新と週ウィンドウシフト → 10
 *
 * 検証対象:
 * 1. 当日 feeding INSERT → 週間サマリー授乳が 0回 → 1回
 * 2. 当日 feeding UPDATE (branch a: belongsToWeek && exists) → 件数不変
 * 3. 当日 diaper DELETE → 件数 -1（payload.old が { id } のみ）
 * 4. 別日付（週内）の sleep INSERT → 週間サマリー反映
 * 5. 週外の feeding INSERT → 無変化
 * 6. sleep cross-week INSERT → isRelevantToCurrentWeek の越境分岐で weeklyLogs に取り込み
 * 7. unmount で supabase.removeChannel が呼ばれる
 * 8. UPDATE branch b (belongsToWeek && !exists) → 週外→週内移動で weeklyLogs に追加
 * 9. UPDATE branch c (!belongsToWeek && exists) → 週内→週外移動で weeklyLogs から除外
 * 10. 真夜中跨ぎで useNow setInterval が発火 → today/weeklyStart の ref が前進し
 *     chart labels が ["4/10",..,"4/16"] → ["4/11",..,"4/17"] へシフト
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { act } from "react"
import type { BabyLogData } from "@/lib/types/baby"

// ---------------------------------------------------------------------------
// Mock state (vi.hoisted で factory と test body で共有)
// ---------------------------------------------------------------------------

type RealtimePayload = {
  eventType: "INSERT" | "UPDATE" | "DELETE"
  schema: string
  table: string
  commit_timestamp: string
  errors: string[]
  new: BabyLogData | Record<string, never>
  old: { id: string } | Record<string, never>
}

const mockState = vi.hoisted(() => ({
  listeners: [] as Array<(payload: unknown) => void>,
  removeChannelMock: undefined as unknown as ReturnType<typeof import("vitest").vi.fn>,
  fromMock: undefined as unknown as ReturnType<typeof import("vitest").vi.fn>,
}))

vi.mock("@/lib/supabase/client", async () => {
  const { vi: viMod } = await import("vitest")
  mockState.removeChannelMock = viMod.fn().mockResolvedValue("ok")
  mockState.fromMock = viMod.fn().mockImplementation(() => {
    throw new Error(
      "supabase.from() should not be called in BabyDashboard tests " +
        "(selectedDate must not change to trigger the date-change useEffect)",
    )
  })
  return {
    createClient: () => {
      const channel: {
        on: (event: string, filter: unknown, cb: (p: unknown) => void) => typeof channel
        subscribe: () => typeof channel
      } = {
        on: (_event, _filter, cb) => {
          mockState.listeners.push(cb)
          return channel
        },
        subscribe: () => channel,
      }
      return {
        channel: () => channel,
        removeChannel: mockState.removeChannelMock,
        from: mockState.fromMock,
      }
    },
  }
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
  diaper_type: null,
  ended_at: null,
  temperature: null,
  weight_g: null,
  height_cm: null,
  duration_min: null,
  memo: null,
  created_at: "2026-04-16T00:00:00+09:00",
} satisfies Omit<BabyLogData, "id" | "log_type" | "logged_at">

function makeLog(
  overrides: Partial<BabyLogData> &
    Pick<BabyLogData, "id" | "log_type" | "logged_at">,
): BabyLogData {
  return { ...baseLog, ...overrides }
}

function makePayload(
  eventType: "INSERT" | "UPDATE",
  log: BabyLogData,
): RealtimePayload
function makePayload(eventType: "DELETE", logId: string): RealtimePayload
function makePayload(
  eventType: "INSERT" | "UPDATE" | "DELETE",
  logOrId: BabyLogData | string,
): RealtimePayload {
  const base = {
    schema: "public",
    table: "baby_logs",
    commit_timestamp: "2026-04-16T03:30:00Z",
    errors: [],
  }
  if (eventType === "DELETE") {
    return {
      ...base,
      eventType,
      new: {},
      old: { id: logOrId as string },
    }
  }
  return {
    ...base,
    eventType,
    new: logOrId as BabyLogData,
    old: {},
  }
}

function defaultProps(
  overrides: Partial<Parameters<typeof BabyDashboard>[0]> = {},
): Parameters<typeof BabyDashboard>[0] {
  return {
    initialLogs: [],
    initialWeeklyLogs: [],
    householdId: "h1",
    userId: "u1",
    initialDate: TODAY,
    lastSleepEndedAt: null,
    ...overrides,
  }
}

function emit(payload: RealtimePayload) {
  for (const cb of mockState.listeners) cb(payload)
}

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
  // cleanup() で前テストの DOM/effect を片付け → removeChannel の呼び出しが
  // 1 increment 増える可能性があるので、その後に mock state をリセットする。
  cleanup()
  // case 10 (真夜中跨ぎ) が時刻を進めるため、毎テスト先頭で FIXED_NOW に戻す。
  vi.setSystemTime(FIXED_NOW)
  mockState.listeners.length = 0
  mockState.removeChannelMock.mockClear()
  mockState.fromMock.mockClear()
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

  it("別日付（週内・selectedDate 範囲外）の sleep INSERT は週間サマリーに反映", () => {
    render(<BabyDashboard {...defaultProps()} />)

    expect(chartTitles("直近7日の睡眠時間")).toContain(`4/15: 0分`)

    act(() => {
      emit(
        makePayload(
          "INSERT",
          makeLog({
            id: "log-sleep-1",
            log_type: "sleep",
            // 昨日 22:00 開始、23:30 終了 = 90 分
            logged_at: "2026-04-15T22:00:00+09:00",
            ended_at: "2026-04-15T23:30:00+09:00",
            duration_min: 90,
          }),
        ),
      )
    })

    // 昨日の睡眠が 1時間30分 に反映される
    expect(chartTitles("直近7日の睡眠時間")).toContain(`4/15: 1時間30分`)
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

  it("sleep cross-week INSERT（週前日に開始・週初日に終了）は isRelevantToCurrentWeek の越境分岐で weeklyLogs に取り込まれる", () => {
    render(<BabyDashboard {...defaultProps()} />)

    // 4/8 18:00 開始 → 4/10 06:00 終了 = 36 時間 = 2160 分。
    // logged_at の日付（4/8）は週外。
    // 但し sleep + ended_at あり、かつ sleepEndMs(4/10 06:00) > weekStartMs(4/10 00:00)、
    // sleepStartMs(4/8 18:00) < weekEndMs(4/17 00:00) なので isRelevantToCurrentWeek=true
    act(() => {
      emit(
        makePayload(
          "INSERT",
          makeLog({
            id: "log-sleep-cross",
            log_type: "sleep",
            logged_at: "2026-04-08T18:00:00+09:00",
            ended_at: "2026-04-10T06:00:00+09:00",
            duration_min: 2160,
          }),
        ),
      )
    })

    // 週内に取り込まれたことの実証として、睡眠の totals が >0 になる。
    // buildBabyWeeklySummary は cross-week ログを「週内重複時間のみ」に切る
    // 挙動なので、4/10 の睡眠時間が >0 で現れることを確認する。
    const sleepTitles = chartTitles("直近7日の睡眠時間")
    const dayTen = sleepTitles.find((t) => t.startsWith("4/10:"))
    expect(dayTen).toBeDefined()
    expect(dayTen).not.toBe("4/10: 0分")
  })

  it("unmount で supabase.removeChannel が呼ばれる", () => {
    const { unmount } = render(<BabyDashboard {...defaultProps()} />)

    expect(mockState.removeChannelMock).not.toHaveBeenCalled()

    unmount()

    expect(mockState.removeChannelMock).toHaveBeenCalledTimes(1)
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
          logged_at: "2026-04-08T10:00:00+09:00", // 週外（cross-week 救済対象外: feeding は ended_at を持たない）
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
