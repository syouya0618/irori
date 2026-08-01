/**
 * issue #155: 育児日記（baby_diaries）の Realtime 購読の回帰テスト。
 *
 * baby-dashboard.tsx は baby_logs とは別 channel で baby_diaries を購読し、
 * INSERT/UPDATE のうち **選択日（selectedDate）と一致する日記だけ** を setDiary で
 * 反映する（household filter は Supabase 側、日付一致はクライアント側 selectedDateRef）。
 * DELETE は household filter 付き購読では配信されない（migration 20260723000001）ため
 * 購読側では扱わず、date-nav / visibilitychange refetch で回収する（別テスト・実機）。
 *
 * 実 postgres_changes は table 単位で配信されるため、baby_diaries payload が
 * baby_logs の callback を発火してはならない。emit は per-table にルーティングする
 * mock を本ファイルに構築して production の分離を再現する。
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { act } from "react"
import type { BabyDiaryData } from "@/lib/types/baby"
import type { RealtimePayload, ViFn } from "@/test-utils/supabase-realtime-mock"
import { makePayloadFor } from "@/test-utils/supabase-realtime-mock"

// ---------------------------------------------------------------------------
// Mock state（vi.hoisted で factory と test body で共有）
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => ({
  /** 購読 table 名 → その callback 群。per-table 配信を再現する */
  listenersByTable: new Map<string, Array<(payload: unknown) => void>>(),
  removeChannelMock: undefined as unknown as ViFn,
  /** visibilitychange refetch の `.from(baby_diaries)...maybeSingle()` が返す結果。
   *  テスト側が仕込んでから visibilitychange を発火させる。 */
  diaryFetchResult: { data: null as unknown, error: null as unknown },
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock("@/lib/supabase/client", async () => {
  const { vi: viMod } = await import("vitest")
  mockState.removeChannelMock = viMod.fn().mockResolvedValue("ok")
  return {
    createClient: () => {
      const channel: {
        on: (
          event: string,
          filter: { table?: string } | undefined,
          cb: (p: unknown) => void,
        ) => typeof channel
        subscribe: () => typeof channel
      } = {
        on: (_event, filter, cb) => {
          const table = filter?.table ?? "__unknown__"
          const list = mockState.listenersByTable.get(table) ?? []
          list.push(cb)
          mockState.listenersByTable.set(table, list)
          return channel
        },
        subscribe: () => channel,
      }
      // visibilitychange refetch の `.from("baby_diaries").select().eq().eq()
      // .maybeSingle().then()` chain。mockState.diaryFetchResult を resolve する。
      const makeQuery = (): Record<string, unknown> => {
        const q: Record<string, unknown> = {
          select: () => q,
          eq: () => q,
          maybeSingle: () => q,
          then: (onF: (v: { data: unknown; error: unknown }) => unknown) =>
            Promise.resolve(mockState.diaryFetchResult).then(onF),
        }
        return q
      }
      return {
        channel: () => channel,
        removeChannel: mockState.removeChannelMock,
        from: () => makeQuery(),
      }
    },
  }
})

// ---------------------------------------------------------------------------
// Imports after vi.mock
// ---------------------------------------------------------------------------
import { BabyDashboard } from "../baby-dashboard"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// JST 2026-07-18 12:00:00 = UTC 03:00:00
const FIXED_NOW = new Date("2026-07-18T03:00:00Z")
const TODAY = "2026-07-18"
const YESTERDAY = "2026-07-17"

const makeDiaryPayload = makePayloadFor<BabyDiaryData>("baby_diaries")

function makeDiary(overrides: Partial<BabyDiaryData> = {}): BabyDiaryData {
  return {
    id: "d1",
    diary_date: TODAY,
    content: "初期本文",
    updated_at: "2026-07-18T00:00:00+09:00",
    ...overrides,
  }
}

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

/** baby_diaries の callback にのみ payload を流す（per-table 配信） */
function emitDiary(payload: RealtimePayload<BabyDiaryData>) {
  for (const cb of mockState.listenersByTable.get("baby_diaries") ?? []) {
    cb(payload)
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(() => {
  vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] })
})

afterAll(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  cleanup()
  mockState.listenersByTable.clear()
  mockState.removeChannelMock?.mockClear()
  mockState.diaryFetchResult = { data: null, error: null }
  // jsdom の可視状態を "visible" に固定（visibilitychange ハンドラの guard 用）。
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BabyDashboard / baby_diaries Realtime 購読 (issue #155)", () => {
  it("選択日と一致する日記の INSERT を反映する（null → 本文表示）", () => {
    render(<BabyDashboard {...defaultProps({ initialDiary: null })} />)
    // 初期は日記なし
    expect(screen.getByText("日記を書く")).toBeInTheDocument()

    act(() => {
      emitDiary(
        makeDiaryPayload(
          "INSERT",
          makeDiary({ diary_date: TODAY, content: "配偶者が書いた日記" }),
        ),
      )
    })

    expect(screen.getByText("配偶者が書いた日記")).toBeInTheDocument()
    expect(screen.queryByText("日記を書く")).not.toBeInTheDocument()
  })

  it("選択日と一致する日記の UPDATE で本文が差し替わる", () => {
    render(
      <BabyDashboard
        {...defaultProps({
          initialDiary: makeDiary({ diary_date: TODAY, content: "旧本文" }),
        })}
      />,
    )
    expect(screen.getByText("旧本文")).toBeInTheDocument()

    act(() => {
      emitDiary(
        makeDiaryPayload(
          "UPDATE",
          makeDiary({ diary_date: TODAY, content: "配偶者が編集した本文" }),
        ),
      )
    })

    expect(screen.getByText("配偶者が編集した本文")).toBeInTheDocument()
    expect(screen.queryByText("旧本文")).not.toBeInTheDocument()
  })

  it("選択日と異なる日付の日記イベントは反映しない（selectedDate 不一致）", () => {
    render(
      <BabyDashboard
        {...defaultProps({
          initialDiary: makeDiary({ diary_date: TODAY, content: "今日の本文" }),
        })}
      />,
    )
    expect(screen.getByText("今日の本文")).toBeInTheDocument()

    act(() => {
      emitDiary(
        makeDiaryPayload(
          "UPDATE",
          makeDiary({
            id: "d-yesterday",
            diary_date: YESTERDAY,
            content: "昨日の本文",
          }),
        ),
      )
    })

    // 昨日の日記イベントは選択日（今日）に反映されない
    expect(screen.getByText("今日の本文")).toBeInTheDocument()
    expect(screen.queryByText("昨日の本文")).not.toBeInTheDocument()
  })

  it("diary_date が時刻付き（保険境界）でも先頭10文字で選択日一致と判定する", () => {
    // 実 Realtime は DATE 列を "YYYY-MM-DD" で配信するが、万一 "...T00:00:00" 形で
    // 来ても guard が silent 全滅しないことを固定する（.slice(0,10) の回帰防止）。
    render(<BabyDashboard {...defaultProps({ initialDiary: null })} />)
    expect(screen.getByText("日記を書く")).toBeInTheDocument()

    act(() => {
      emitDiary(
        makeDiaryPayload(
          "INSERT",
          makeDiary({
            diary_date: `${TODAY}T00:00:00`,
            content: "時刻付き日付でも反映",
          }),
        ),
      )
    })

    expect(screen.getByText("時刻付き日付でも反映")).toBeInTheDocument()
  })

  it("diary_date を持たない payload が届いても throw せず no-op（防御・?.slice）", () => {
    // 本番は channel 分離で baby_diaries イベントのみ届くが、共有 listener 経路
    // （他ダッシュボードテストの mock）で非 diary payload が来ても crash しないこと。
    render(
      <BabyDashboard
        {...defaultProps({
          initialDiary: makeDiary({ diary_date: TODAY, content: "壊れない本文" }),
        })}
      />,
    )
    expect(screen.getByText("壊れない本文")).toBeInTheDocument()

    act(() => {
      for (const cb of mockState.listenersByTable.get("baby_diaries") ?? []) {
        // diary_date を欠く INSERT payload（例: baby_logs 由来の混入）。
        cb({
          eventType: "INSERT",
          schema: "public",
          table: "baby_diaries",
          commit_timestamp: "2026-07-18T00:00:00Z",
          errors: [],
          new: { id: "x", logged_at: `${TODAY}T01:00:00+09:00` },
          old: {},
        })
      }
    })

    // throw せず、本文も変わらない。
    expect(screen.getByText("壊れない本文")).toBeInTheDocument()
  })

  it("DELETE は購読側で扱わない（本文は保持され、refetch 経路に委ねる）", () => {
    render(
      <BabyDashboard
        {...defaultProps({
          initialDiary: makeDiary({ diary_date: TODAY, content: "残る本文" }),
        })}
      />,
    )
    expect(screen.getByText("残る本文")).toBeInTheDocument()

    act(() => {
      emitDiary(makeDiaryPayload("DELETE", "d1"))
    })

    // DELETE は household filter 付き購読では配信されない前提。仮に届いても
    // 購読側は無視し（本文保持）、実際の削除反映は date-nav / visibility refetch が担う。
    expect(screen.getByText("残る本文")).toBeInTheDocument()
  })
})

describe("BabyDashboard / 日記の visibilitychange refetch (DELETE 回収・#155)", () => {
  /** visibilitychange を発火し、refetch の microtask を flush する */
  async function fireVisibilityRefetch() {
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      // .from()...maybeSingle().then(setDiary) の microtask を流し切る
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it("タブ復帰で選択日の日記を取り直し、配偶者の空保存(DELETE)を回収する", async () => {
    // 配偶者が日記を空にして保存 = 行 DELETE（購読では届かない）→ refetch は null。
    mockState.diaryFetchResult = { data: null, error: null }
    render(
      <BabyDashboard
        {...defaultProps({
          initialDiary: makeDiary({ diary_date: TODAY, content: "消える本文" }),
        })}
      />,
    )
    expect(screen.getByText("消える本文")).toBeInTheDocument()

    await fireVisibilityRefetch()

    expect(screen.queryByText("消える本文")).not.toBeInTheDocument()
    expect(screen.getByText("日記を書く")).toBeInTheDocument()
  })

  it("タブ復帰で新規/更新された日記を取り直して表示する", async () => {
    mockState.diaryFetchResult = {
      data: makeDiary({ diary_date: TODAY, content: "復帰後に取得した本文" }),
      error: null,
    }
    render(<BabyDashboard {...defaultProps({ initialDiary: null })} />)
    expect(screen.getByText("日記を書く")).toBeInTheDocument()

    await fireVisibilityRefetch()

    expect(screen.getByText("復帰後に取得した本文")).toBeInTheDocument()
  })

  it("refetch が error のときは現在の本文を保持する（同一日ゆえ fail-to-empty しない）", async () => {
    mockState.diaryFetchResult = {
      data: null,
      error: { message: "boom", code: "500" },
    }
    render(
      <BabyDashboard
        {...defaultProps({
          initialDiary: makeDiary({ diary_date: TODAY, content: "保持される本文" }),
        })}
      />,
    )
    expect(screen.getByText("保持される本文")).toBeInTheDocument()

    await fireVisibilityRefetch()

    // date-nav の cross-date fail-to-empty と違い、同一日の取り直し失敗では
    // 現在の本文を消さない。
    expect(screen.getByText("保持される本文")).toBeInTheDocument()
  })
})
