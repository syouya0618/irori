/**
 * B-08: 日付ナビ client refetch の error 握り潰し & インターリーブ上書きの回帰テスト。
 *
 * baby-dashboard.tsx の日付ナビ fetch（selectedDate 変更時の refetch）は従来:
 *   .then(({ data }) => { if (!aborted && data) setLogs(data) })
 * だったため 2 欠陥があった:
 *   (1) 解決値の `error` を捨てる（AUDIT-012） → DB エラー時に無言で失敗
 *   (2) `setLogs(data)` の無条件全置換（H3-02） → fetch in-flight 中に Realtime で
 *       先着した選択日の行が解決時に上書きで消える
 *
 * このテストは inline reducer mock（from() を throw）では検証不能なため、
 * 「Realtime channel + 遅延解決の日付ナビ fetch チェーン」を両立する専用 mock を
 * 本ファイル内に構築する（既存 builder は即時解決で .lte を使うため流用不可）。
 * fetch は test から `resolvePendingFetch(...)` で明示解決し、in-flight タイミングで
 * Realtime INSERT を挟める。
 *
 * 検証:
 * 1. fetch が error を返す → toast.error「読み込みに失敗しました」+ 既存 logs 不変
 * 2. fetch in-flight 中に選択日の Realtime INSERT → fetch 解決後もその行が残る
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
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { act } from "react"
import { toast } from "sonner"
import type { BabyLogData } from "@/lib/types/baby"
import type {
  RealtimePayload,
  ViFn,
} from "@/test-utils/supabase-realtime-mock"
import { makePayloadFor } from "@/test-utils/supabase-realtime-mock"

// ---------------------------------------------------------------------------
// Mock state（vi.hoisted で factory と test body で共有）
// ---------------------------------------------------------------------------

type FetchResult = { data: BabyLogData[] | null; error: unknown }

const mockState = vi.hoisted(() => ({
  listeners: [] as Array<(payload: unknown) => void>,
  removeChannelMock: undefined as unknown as ViFn,
  /** 解決待ちの日付ナビ fetch。test 側が resolve を呼んで in-flight を終える */
  pendingFetches: [] as Array<{
    resolve: (value: FetchResult) => void
    signal: AbortSignal | undefined
  }>,
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
          filter: unknown,
          cb: (p: unknown) => void,
        ) => typeof channel
        subscribe: () => typeof channel
      } = {
        on: (_event, _filter, cb) => {
          mockState.listeners.push(cb)
          return channel
        },
        subscribe: () => channel,
      }
      // 遅延解決の PostgREST クエリビルダ mock。
      // 日付ナビの chain: select→eq→gte→lt→order→abortSignal→then
      const makeQuery = () => {
        let resolveFn!: (value: FetchResult) => void
        const promise = new Promise<FetchResult>((res) => {
          resolveFn = res
        })
        const record: {
          resolve: (value: FetchResult) => void
          signal: AbortSignal | undefined
        } = { resolve: resolveFn, signal: undefined }
        mockState.pendingFetches.push(record)
        const q: Record<string, unknown> = {
          select: () => q,
          eq: () => q,
          gte: () => q,
          lt: () => q,
          order: () => q,
          abortSignal: (sig: AbortSignal) => {
            record.signal = sig
            return q
          },
          then: (
            onF: (value: FetchResult) => unknown,
            onR?: (reason: unknown) => unknown,
          ) => promise.then(onF, onR),
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

const makePayload = makePayloadFor<BabyLogData>("baby_logs")

function makeLog(
  overrides: Partial<BabyLogData> &
    Pick<BabyLogData, "id" | "log_type" | "logged_at">,
): BabyLogData {
  return {
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
    created_at: "2026-07-18T00:00:00+09:00",
    ...overrides,
  }
}

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
    lastSleepEndedAt: null,
    activeSleepFallback: null,
    babyName: null,
    babyBirthDate: null,
    pumpingIntervalMin: 180,
    ...overrides,
  }
}

const emit = (payload: RealtimePayload<BabyLogData>) => {
  for (const cb of mockState.listeners) cb(payload)
}

/** 「前の日」ボタンを押して selectedDate を 1 日戻し、日付ナビ fetch を発火させる */
function goPrevDay() {
  fireEvent.click(screen.getByLabelText("前の日"))
}

/**
 * in-flight の fetch を全て解決する（microtask を flush）。
 * B-02 で日付ナビ refetch が logs + overlap 睡眠の 2 本になったため、同一結果で
 * 両方を解決する（logs 側の error/merge 検証はそのまま成立。overlap 側は同結果を
 * 受けても本テストの assert には無害）。
 */
async function resolvePendingFetch(result: FetchResult) {
  const pendings = mockState.pendingFetches.splice(0)
  if (pendings.length === 0) throw new Error("解決待ちの fetch が無い")
  await act(async () => {
    for (const pending of pendings) pending.resolve(result)
    // onFulfilled（setState を含む）を microtask で流し切る
    await Promise.resolve()
  })
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(() => {
  // Date のみ固定（todayJstString() を決定化）。setInterval は実タイマーのまま
  // にして promise/microtask を実挙動で flush できるようにする。
  vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] })
})

afterAll(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  cleanup()
  mockState.listeners.length = 0
  mockState.pendingFetches.length = 0
  mockState.removeChannelMock?.mockClear()
  vi.mocked(toast.error).mockClear()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BabyDashboard / 日付ナビ fetch の error 握り潰し (B-08)", () => {
  it("fetch が error を返すと toast.error を出し、既存 logs は保持される", async () => {
    const todayRow = makeLog({
      id: "today-1",
      log_type: "feeding",
      logged_at: "2026-07-18T08:00:00+09:00",
      feeding_type: "bottle",
      memo: "TODAYROW",
    })
    render(<BabyDashboard {...defaultProps({ initialLogs: [todayRow] })} />)

    expect(screen.getByText("TODAYROW")).toBeInTheDocument()

    // 昨日へ移動 → fetch 発火（in-flight）
    act(() => {
      goPrevDay()
    })

    // fetch が error 解決（Supabase は DB エラーを reject でなく { error } で resolve）
    await resolvePendingFetch({
      data: null,
      error: {
        message: "boom",
        code: "PGRST500",
        details: null,
        hint: null,
      },
    })

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("読み込みに失敗しました")
    // logs 不変: 前状態の行が消えていない
    expect(screen.getByText("TODAYROW")).toBeInTheDocument()
  })

  it("fetch in-flight 中に Realtime で先着した選択日の行が、fetch 解決後も残る", async () => {
    render(<BabyDashboard {...defaultProps({ initialLogs: [] })} />)

    // 昨日へ移動 → fetch 発火（in-flight、まだ解決しない）
    act(() => {
      goPrevDay()
    })

    // in-flight の間に選択日（昨日）の Realtime INSERT が先着 → logs に前置きされる
    act(() => {
      emit(
        makePayload(
          "INSERT",
          makeLog({
            id: "realtime-1",
            log_type: "diaper",
            logged_at: `${YESTERDAY}T22:00:00+09:00`,
            diaper_type: "poop",
            memo: "REALTIMEROW",
          }),
        ),
      )
    })
    expect(screen.getByText("REALTIMEROW")).toBeInTheDocument()

    // fetch が REALTIMEROW を含まない結果で解決（クエリ発行はその INSERT より前）
    await resolvePendingFetch({
      data: [
        makeLog({
          id: "server-1",
          log_type: "feeding",
          logged_at: `${YESTERDAY}T08:00:00+09:00`,
          feeding_type: "bottle",
          memo: "SERVERROW",
        }),
      ],
      error: null,
    })

    // 無条件全置換なら REALTIMEROW は消える（現状赤）。dedupe マージなら残る。
    expect(screen.getByText("SERVERROW")).toBeInTheDocument()
    expect(screen.getByText("REALTIMEROW")).toBeInTheDocument()
  })
})
