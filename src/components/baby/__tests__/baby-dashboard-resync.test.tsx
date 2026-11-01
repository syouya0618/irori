/**
 * P1-04: 育児ログ（baby_logs）の復帰時・再接続時の再取得（自己回復）の回帰テスト。
 *
 * 背景: household フィルタ付きの postgres_changes は DELETE を配信せず、本番では
 * 購読自体も間欠的に届かない（#92）。復帰や再接続で取り直さないと、配偶者の
 * 記録・削除・編集が画面に出ず、「最終授乳」「次の授乳の目安」が嘘のまま残る。
 *
 * このファイルは専用の mock を持つ（既存の builder は即時解決で、購読の status も
 * 流せないため）:
 * - from(table) の鎖を記録し、test が種類（選択日 / 週窓 / 成長 / fallback 2 本 /
 *   日記）を見分けて任意の順で解決できる（in-flight と世代の再現）
 * - channel.subscribe(cb) の cb を捕まえ、SUBSCRIBED / CLOSED を流せる（再接続の再現）
 * - postgres_changes は table ごとに配信する（本番の channel 分離の再現）
 * - auth.getSession の結果を test が差し替えられる（失効 + refresh 失敗で session が
 *   null になり、PostgREST が anon キーで 0 行を error なしで返す状態の再現）
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
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react"
import { act } from "react"
import { toast } from "sonner"
import type { BabyDiaryData, BabyLogData } from "@/lib/types/baby"
import type { RealtimePayload } from "@/test-utils/supabase-realtime-mock"
import { makePayloadFor } from "@/test-utils/supabase-realtime-mock"
import { logSupabaseError } from "@/lib/supabase/log-error"
import {
  deleteLog,
  recordDiaper,
  upsertBabyDiary,
} from "@/app/(main)/baby/actions"

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

type Result = { data: unknown; error: unknown }

interface QueryRecord {
  table: string
  calls: Array<[string, unknown[]]>
  signal: AbortSignal | undefined
  maybeSingle: boolean
  settled: boolean
  resolve: (r: Result) => void
}

type SessionResult = {
  data: { session: { access_token: string } | null }
  error: unknown
}

const SIGNED_IN: SessionResult = {
  data: { session: { access_token: "user-jwt" } },
  error: null,
}

const mockState = vi.hoisted(() => ({
  listenersByTable: new Map<string, Array<(payload: unknown) => void>>(),
  subscribeCallbacks: new Map<string, (status: string, err?: Error) => void>(),
  queries: [] as QueryRecord[],
  /** auth.getSession() が返す結果。既定はサインイン済み（beforeEach で戻す）。 */
  session: null as unknown as SessionResult,
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))
vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))
// 予定カードは自前の visibility refetch（calendar_events）を持つ。本テストの対象外ゆえ stub。
vi.mock("@/components/calendar/upcoming-events-card", () => ({
  UpcomingEventsCard: () => null,
}))
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

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    const makeChannel = (name: string) => {
      const channel: {
        on: (
          event: string,
          filter: { table?: string } | undefined,
          cb: (p: unknown) => void,
        ) => typeof channel
        subscribe: (cb?: (status: string, err?: Error) => void) => typeof channel
      } = {
        on: (_event, filter, cb) => {
          const table = filter?.table ?? "__unknown__"
          const list = mockState.listenersByTable.get(table) ?? []
          list.push(cb)
          mockState.listenersByTable.set(table, list)
          return channel
        },
        subscribe: (cb) => {
          if (cb) mockState.subscribeCallbacks.set(name, cb)
          return channel
        },
      }
      return channel
    }
    const makeQuery = (table: string) => {
      let resolveFn!: (r: Result) => void
      const promise = new Promise<Result>((res) => {
        resolveFn = res
      })
      const record: QueryRecord = {
        table,
        calls: [],
        signal: undefined,
        maybeSingle: false,
        settled: false,
        resolve: (r) => {
          record.settled = true
          resolveFn(r)
        },
      }
      mockState.queries.push(record)
      const q: Record<string, unknown> = {}
      for (const method of ["select", "eq", "gte", "lt", "lte", "order", "limit", "or"]) {
        q[method] = (...args: unknown[]) => {
          record.calls.push([method, args])
          return q
        }
      }
      q.abortSignal = (sig: AbortSignal) => {
        record.signal = sig
        return q
      }
      q.maybeSingle = () => {
        record.maybeSingle = true
        return q
      }
      q.then = (
        onF: (v: Result) => unknown,
        onR?: (e: unknown) => unknown,
      ) => promise.then(onF, onR)
      return q
    }
    return {
      channel: (name: string) => makeChannel(name),
      removeChannel: vi.fn().mockResolvedValue("ok"),
      from: (table: string) => makeQuery(table),
      auth: { getSession: async () => mockState.session },
    }
  },
}))

// vi.mock 後 import
import { BabyDashboard } from "../baby-dashboard"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// JST 2026-07-18 12:00:00 = UTC 03:00:00
const FIXED_NOW = new Date("2026-07-18T03:00:00Z")
const TODAY = "2026-07-18"
const YESTERDAY = "2026-07-17"
// 取得窓 8 日（WEEKLY_FETCH_DAYS）の起点
const WEEK_START = "2026-07-11"

const makePayload = makePayloadFor<BabyLogData>("baby_logs")

function makeLog(
  overrides: Partial<BabyLogData> &
    Pick<BabyLogData, "id" | "log_type" | "logged_at">,
): BabyLogData {
  return {
    logged_by: "user-1",
    feeding_type: null,
    amount_ml: null,
    breast_left_count: null,
    breast_right_count: null,
    breast_left_sec: null,
    breast_right_sec: null,
    breast_start_side: null,
    diaper_type: null,
    poop_amount: null,
    temperature: null,
    weight_g: null,
    height_cm: null,
    duration_min: null,
    duration_sec: null,
    memo: null,
    created_at: `${TODAY}T00:00:00+09:00`,
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
    initialBottleDefault: { status: "set" as const, amountMl: 120 },
    ...overrides,
  }
}

const feedingA = makeLog({
  id: "a",
  log_type: "feeding",
  feeding_type: "bottle",
  amount_ml: 100,
  logged_at: `${TODAY}T08:00:00+09:00`,
  memo: "ROW_A",
})
const diaperB = makeLog({
  id: "b",
  log_type: "diaper",
  diaper_type: "pee",
  logged_at: `${TODAY}T09:00:00+09:00`,
  memo: "ROW_B",
})

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

type Kind =
  | "diary"
  | "growth"
  | "lastFeeding"
  | "lastNursing"
  | "weekly"
  | `day:${string}`

function call(q: QueryRecord, method: string): unknown[] | undefined {
  return q.calls.find(([m]) => m === method)?.[1]
}

function kindOf(q: QueryRecord): Kind {
  if (q.table === "baby_diaries") return "diary"
  if (q.calls.some(([m, args]) => m === "eq" && args[0] === "log_type" && args[1] === "growth")) {
    return "growth"
  }
  if (call(q, "or")) return "lastNursing"
  if (call(q, "limit")) return "lastFeeding"
  const gte = call(q, "gte")
  if (gte?.[1] === `${WEEK_START}T00:00:00+09:00`) return "weekly"
  return `day:${String(gte?.[1]).slice(0, 10)}`
}

function pendingOf(kind: Kind): QueryRecord[] {
  return mockState.queries.filter((q) => !q.settled && kindOf(q) === kind)
}

const RESYNC_KINDS: Kind[] = ["weekly", "growth", "lastFeeding", "lastNursing"]

/**
 * 直近の再取得（選択日 / 週窓 / 成長 / fallback 2 本）の各クエリを 1 本ずつ解決する。
 * 渡さなかった種類は空（配列は []・maybeSingle は null）で解決する。
 */
async function resolveLatestResync(
  results: Partial<Record<Kind, Result>> & { day: Result; date?: string },
) {
  const date = results.date ?? TODAY
  const kinds: Kind[] = [`day:${date}`, ...RESYNC_KINDS]
  const targets = kinds.map((kind) => {
    const list = pendingOf(kind)
    if (list.length === 0) throw new Error(`解決待ちの ${kind} クエリが無い（再取得が走っていない）`)
    return { kind, q: list[list.length - 1] }
  })
  await act(async () => {
    for (const { kind, q } of targets) {
      const r =
        kind === `day:${date}`
          ? results.day
          : (results[kind] ?? { data: q.maybeSingle ? null : [], error: null })
      q.resolve(r)
    }
    await new Promise((r) => setTimeout(r, 0))
  })
}

/**
 * 再取得は auth.getSession() を await してからクエリを発行するため、microtask 1 回では
 * クエリがまだ出ていない。macrotask 1 回ぶん流して「発行済み・解決待ち」にする。
 */
async function flushResyncStart() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function fireVisible() {
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await flushResyncStart()
}

/**
 * render してマウント時の再取得を「SSR と同じ内容」で解決する（＝表示は変わらない）。
 * マウント時の再取得そのものを検証しない test が、後続の再取得だけを扱えるようにする。
 */
async function renderDashboard(
  overrides: Partial<Parameters<typeof BabyDashboard>[0]> = {},
) {
  const props = defaultProps(overrides)
  const utils = render(<BabyDashboard {...props} />)
  await flushResyncStart()
  await resolveLatestResync({
    day: { data: props.initialLogs, error: null },
    weekly: { data: props.initialWeeklyLogs, error: null },
    growth: { data: props.initialGrowthLogs, error: null },
    lastFeeding: { data: props.lastFeedingFallback, error: null },
    lastNursing: { data: props.lastNursingFallback, error: null },
  })
  return utils
}

/** 解決待ちの baby_logs クエリを全て「anon の RLS 結果」（0 行・error なし）で解決する。 */
async function resolvePendingLogsAsAnon() {
  await act(async () => {
    for (const q of mockState.queries) {
      if (q.settled || q.table !== "baby_logs") continue
      q.resolve({ data: q.maybeSingle ? null : [], error: null })
    }
    await new Promise((r) => setTimeout(r, 0))
  })
}

function subscribeStatus(channel: string, status: string) {
  const cb = mockState.subscribeCallbacks.get(channel)
  if (!cb) throw new Error(`${channel} の subscribe callback が無い`)
  act(() => {
    cb(status)
  })
}

function emitLogs(payload: RealtimePayload<BabyLogData>) {
  for (const cb of mockState.listenersByTable.get("baby_logs") ?? []) cb(payload)
}

function chartTitles(ariaLabel: string): string[] {
  const svg = screen.getByLabelText(ariaLabel)
  return Array.from(svg.querySelectorAll("title")).map((t) => t.textContent ?? "")
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
  mockState.subscribeCallbacks.clear()
  mockState.queries.length = 0
  mockState.session = SIGNED_IN
  vi.mocked(toast.error).mockClear()
  vi.mocked(toast.success).mockClear()
  vi.mocked(logSupabaseError).mockClear()
  vi.mocked(recordDiaper).mockReset()
  vi.mocked(deleteLog).mockReset()
  vi.mocked(upsertBabyDiary).mockReset()
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BabyDashboard / baby_logs の復帰時再取得（P1-04）", () => {
  it("タブ復帰で選択日・週窓（8日）・成長・fallback 2 本を page.tsx と同じ形で取り直す", async () => {
    await renderDashboard()

    await fireVisible()

    const day = pendingOf(`day:${TODAY}`)
    expect(day).toHaveLength(1)
    expect(call(day[0], "eq")).toEqual(["household_id", "h1"])
    expect(call(day[0], "gte")).toEqual(["logged_at", `${TODAY}T00:00:00+09:00`])
    expect(call(day[0], "lt")).toEqual(["logged_at", "2026-07-19T00:00:00+09:00"])
    expect(day[0].signal).toBeInstanceOf(AbortSignal)

    const weekly = pendingOf("weekly")
    expect(weekly).toHaveLength(1)
    expect(call(weekly[0], "lt")).toEqual(["logged_at", "2026-07-19T00:00:00+09:00"])

    expect(pendingOf("growth")).toHaveLength(1)
    expect(call(pendingOf("growth")[0], "order")).toEqual([
      "logged_at",
      { ascending: true },
    ])

    const nursing = pendingOf("lastNursing")[0]
    expect(call(nursing, "or")).toEqual(["feeding_type.is.null,feeding_type.neq.pumped"])
    expect(call(nursing, "lt")).toEqual(["logged_at", `${TODAY}T00:00:00+09:00`])
    expect(nursing.maybeSingle).toBe(true)
    expect(pendingOf("lastFeeding")[0].maybeSingle).toBe(true)
  })

  it("window の focus でも取り直す", async () => {
    await renderDashboard()
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
    })
    await flushResyncStart()
    expect(pendingOf(`day:${TODAY}`)).toHaveLength(1)
  })

  it("配偶者が消した行（DELETE は配信されない）は復帰後の再取得で消える", async () => {
    await renderDashboard({
      initialLogs: [feedingA, diaperB],
      initialWeeklyLogs: [feedingA, diaperB],
    })
    expect(screen.getByText("ROW_B")).toBeInTheDocument()
    expect(chartTitles("直近7日の授乳回数")).toContain("7/18: 1回")

    await fireVisible()
    await resolveLatestResync({
      day: { data: [diaperB], error: null },
      weekly: { data: [diaperB], error: null },
    })

    expect(screen.queryByText("ROW_A")).not.toBeInTheDocument()
    expect(screen.getByText("ROW_B")).toBeInTheDocument()
    // 週窓も置き換わる（今日の授乳 1 → 0）
    expect(chartTitles("直近7日の授乳回数")).toContain("7/18: 0回")
  })

  it("配偶者の記録・編集（Realtime 不達）も復帰後の再取得で出る", async () => {
    await renderDashboard({ initialLogs: [diaperB] })

    await fireVisible()
    await resolveLatestResync({
      day: {
        data: [feedingA, { ...diaperB, memo: "ROW_B_EDITED" }],
        error: null,
      },
    })

    expect(screen.getByText("ROW_A")).toBeInTheDocument()
    expect(screen.getByText("ROW_B_EDITED")).toBeInTheDocument()
    expect(screen.queryByText("ROW_B")).not.toBeInTheDocument()
  })

  it("成長ログも置き換わる（消された成長記録が曲線から消える）", async () => {
    const growth = makeLog({
      id: "g1",
      log_type: "growth",
      weight_g: 5200,
      logged_at: "2026-07-01T10:00:00+09:00",
    })
    await renderDashboard({ initialGrowthLogs: [growth] })
    // Open the lazy chart before checking its actual values and subsequent deletion.
    fireEvent.click(screen.getByRole("button",{name:/成長の記録/}))
    expect((await screen.findAllByText("5.2kg")).length).toBeGreaterThan(0)

    await fireVisible()
    await resolveLatestResync({
      day: { data: [], error: null },
      growth: { data: [], error: null },
    })

    expect(screen.queryByText("5.2kg")).not.toBeInTheDocument()
    expect(
      screen.getByText("成長記録を追加すると、体重・身長の曲線が表示されます"),
    ).toBeInTheDocument()
  })

  it("「次の授乳の目安」の起点（今日より前の最後の授乳）も取り直し、配偶者の削除で古い起点へ戻る", async () => {
    const deletedLate = makeLog({
      id: "late",
      log_type: "feeding",
      feeding_type: "breast",
      breast_left_count: 1,
      breast_right_count: 0,
      logged_at: `${YESTERDAY}T23:00:00+09:00`,
    })
    const earlier = makeLog({
      id: "earlier",
      log_type: "feeding",
      feeding_type: "breast",
      breast_left_count: 1,
      breast_right_count: 0,
      logged_at: `${YESTERDAY}T20:00:00+09:00`,
    })
    await renderDashboard({
      lastFeedingFallback: deletedLate,
      lastNursingFallback: deletedLate,
    })
    // 23:00 + 180 分 = 02:00
    expect(screen.getByText("02:00")).toBeInTheDocument()

    await fireVisible()
    await resolveLatestResync({
      day: { data: [], error: null },
      lastFeeding: { data: earlier, error: null },
      lastNursing: { data: earlier, error: null },
    })

    // 20:00 + 180 分 = 23:00
    expect(screen.queryByText("02:00")).not.toBeInTheDocument()
    expect(screen.getByText("23:00")).toBeInTheDocument()
  })

  it("取得中に Realtime で届いた行は、取得結果に無くても消えない", async () => {
    await renderDashboard({ initialLogs: [feedingA] })

    await fireVisible()
    act(() => {
      emitLogs(
        makePayload(
          "INSERT",
          makeLog({
            id: "rt-1",
            log_type: "diaper",
            diaper_type: "poop",
            logged_at: `${TODAY}T11:30:00+09:00`,
            memo: "REALTIME_ROW",
          }),
        ),
      )
    })
    expect(screen.getByText("REALTIME_ROW")).toBeInTheDocument()

    // 取得はその INSERT より前の snapshot で解決する
    await resolveLatestResync({ day: { data: [feedingA], error: null } })

    expect(screen.getByText("ROW_A")).toBeInTheDocument()
    expect(screen.getByText("REALTIME_ROW")).toBeInTheDocument()
  })

  it("取得中に手元で記録した行（楽観 append）は、取得結果に無くても消えない", async () => {
    vi.mocked(recordDiaper).mockResolvedValue({ error: null, id: "local-1" })
    await renderDashboard()
    const summary = () => screen.getByLabelText("今日のまとめ")

    await fireVisible()
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() =>
      expect(within(summary()).getByText("おしっこ1・うんち0")).toBeInTheDocument(),
    )

    await resolveLatestResync({ day: { data: [], error: null } })

    expect(within(summary()).getByText("おしっこ1・うんち0")).toBeInTheDocument()
  })

  it("古い世代の応答は捨てる（後から届いても新しい結果を上書きしない）", async () => {
    await renderDashboard({ initialLogs: [feedingA, diaperB] })

    await fireVisible()
    const firstGen = pendingOf(`day:${TODAY}`)[0]
    const firstGenAll = mockState.queries.filter((q) => !q.settled && q.table === "baby_logs")
    await fireVisible()

    // 新しい世代が起動した時点で古い世代は abort されている
    expect(firstGen.signal?.aborted).toBe(true)

    // 新しい世代: B は配偶者が消した
    await resolveLatestResync({ day: { data: [feedingA], error: null } })
    expect(screen.queryByText("ROW_B")).not.toBeInTheDocument()

    // 古い世代が遅れて（B を含む古い snapshot で）届いても反映しない
    await act(async () => {
      for (const q of firstGenAll) {
        q.resolve({ data: q.maybeSingle ? null : [feedingA, diaperB], error: null })
      }
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.queryByText("ROW_B")).not.toBeInTheDocument()
    expect(screen.getByText("ROW_A")).toBeInTheDocument()
  })

  it("取得が error なら現在の表示を保ち、構造化ログだけ残す（トーストは出さない）", async () => {
    await renderDashboard({ initialLogs: [feedingA, diaperB] })

    await fireVisible()
    await resolveLatestResync({
      day: { data: null, error: { message: "boom", code: "PGRST500" } },
    })

    expect(screen.getByText("ROW_A")).toBeInTheDocument()
    expect(screen.getByText("ROW_B")).toBeInTheDocument()
    expect(vi.mocked(logSupabaseError)).toHaveBeenCalledWith(
      "baby",
      expect.any(String),
      expect.objectContaining({ message: "boom" }),
      expect.objectContaining({ householdId: "h1" }),
    )
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })

  it("取得中に選択日が変わったら、旧選択日の結果を logs へ反映しない", async () => {
    await renderDashboard({ initialLogs: [feedingA] })

    await fireVisible()
    act(() => {
      fireEvent.click(screen.getByLabelText("前の日"))
    })

    // 今日の取得結果（今日の行を含む）が遅れて届く
    await resolveLatestResync({
      day: { data: [feedingA, diaperB], error: null },
    })

    // 昨日を表示中ゆえ今日の行は出さない
    expect(screen.queryByText("ROW_B")).not.toBeInTheDocument()
  })

  // 旧版は「初回の SUBSCRIBED は SSR 直後ゆえ取り直さない」を固定していたが、その前提は
  // 偽だった: 戻る/進む（history traversal）では Next 16 が古さを問わずキャッシュ済みの
  // RSC payload を再利用し（router の bfcache・staleTimes の対象外）、BabyDashboard は
  // 何分も前の initialLogs で再マウントされる。マウント時にも初回の SUBSCRIBED でも
  // 取らないと、配偶者の記録・削除と「最終授乳」「次の授乳の目安」が次の visible / focus
  // まで嘘のまま残る（アプリは前面のままゆえ発火しない）。
  it("マウント時に取り直す（戻る操作で古い RSC payload から再マウントされても自己回復する）", async () => {
    // 古い payload: B は配偶者が離れている間に消した行
    render(<BabyDashboard {...defaultProps({ initialLogs: [feedingA, diaperB] })} />)
    expect(screen.getByText("ROW_B")).toBeInTheDocument()

    // visible / focus も SUBSCRIBED も起こさない
    await flushResyncStart()
    expect(pendingOf(`day:${TODAY}`)).toHaveLength(1)

    await resolveLatestResync({ day: { data: [feedingA], error: null } })
    expect(screen.queryByText("ROW_B")).not.toBeInTheDocument()
    expect(screen.getByText("ROW_A")).toBeInTheDocument()
  })

  it("初回を含むすべての SUBSCRIBED で取り直す（マウント時の取得から購読開始までの隙間も回収する）", async () => {
    render(<BabyDashboard {...defaultProps({ initialLogs: [feedingA, diaperB] })} />)
    await flushResyncStart()
    const mountGen = pendingOf(`day:${TODAY}`)
    expect(mountGen).toHaveLength(1)

    subscribeStatus("baby_logs", "SUBSCRIBED")
    await flushResyncStart()
    // マウント時の取得は新しい世代に置き換わる（重複取得は世代ガードが吸収する）
    expect(mountGen[0].signal?.aborted).toBe(true)
    const firstSubscribed = pendingOf(`day:${TODAY}`).filter((q) => !q.signal?.aborted)
    expect(firstSubscribed).toHaveLength(1)

    subscribeStatus("baby_logs", "CLOSED")
    await flushResyncStart()
    expect(pendingOf(`day:${TODAY}`).filter((q) => !q.signal?.aborted)).toHaveLength(1)

    subscribeStatus("baby_logs", "SUBSCRIBED")
    await flushResyncStart()
    expect(firstSubscribed[0].signal?.aborted).toBe(true)
    expect(pendingOf(`day:${TODAY}`).filter((q) => !q.signal?.aborted)).toHaveLength(1)

    await resolveLatestResync({ day: { data: [feedingA], error: null } })
    expect(screen.queryByText("ROW_B")).not.toBeInTheDocument()
  })

  it("session が無い（失効 + refresh 失敗）なら anon の 0 行を真値として描かず、表示を保って構造化ログを残す", async () => {
    // auth-js は失効後の refresh 失敗で session: null を返し、supabase-js は anon キーで
    // PostgREST を叩く。RLS は error ではなく 0 行を返すため、そのまま反映すると記録・
    // 最終授乳・目安が無音で消える。
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const fallback = makeLog({
        id: "prev",
        log_type: "feeding",
        feeding_type: "breast",
        breast_left_count: 1,
        breast_right_count: 0,
        logged_at: `${YESTERDAY}T23:00:00+09:00`,
      })
      await renderDashboard({
        initialLogs: [feedingA],
        initialWeeklyLogs: [feedingA],
        lastFeedingFallback: fallback,
        lastNursingFallback: fallback,
      })
      expect(screen.getByText("ROW_A")).toBeInTheDocument()

      mockState.session = { data: { session: null }, error: null }
      await fireVisible()
      await resolvePendingLogsAsAnon()

      expect(screen.getByText("ROW_A")).toBeInTheDocument()
      expect(chartTitles("直近7日の授乳回数")).toContain("7/18: 1回")
      // 次の授乳の目安（今日の授乳 08:00 + 180 分 = 11:00）も保たれる
      expect(screen.getByText("11:00")).toBeInTheDocument()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("[baby] logs resync"),
        expect.objectContaining({ householdId: "h1", date: TODAY }),
      )
      expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("session の取得が error を返しても反映せず、logSupabaseError で残す", async () => {
    await renderDashboard({ initialLogs: [feedingA] })

    mockState.session = {
      data: { session: null },
      error: { message: "refresh failed", status: 400 },
    }
    await fireVisible()
    await resolvePendingLogsAsAnon()

    expect(screen.getByText("ROW_A")).toBeInTheDocument()
    expect(vi.mocked(logSupabaseError)).toHaveBeenCalledWith(
      "baby",
      expect.stringContaining("logs resync"),
      expect.objectContaining({ message: "refresh failed" }),
      expect.objectContaining({ householdId: "h1" }),
    )
  })

  it("session があれば同じ 0 行の結果を真値として反映する（上の対照）", async () => {
    await renderDashboard({ initialLogs: [feedingA], initialWeeklyLogs: [feedingA] })

    await fireVisible()
    await resolvePendingLogsAsAnon()

    expect(screen.queryByText("ROW_A")).not.toBeInTheDocument()
    expect(chartTitles("直近7日の授乳回数")).toContain("7/18: 0回")
  })

  it("取得中に取り消した行は、削除前の snapshot が届いても蘇らない", async () => {
    // 取り消しは作成に成功した時の版でしか消せぬ（版の無い応答には「取り消す」を出さぬ）
    vi.mocked(recordDiaper).mockResolvedValue({
      error: null,
      id: "undo-1",
      updatedAt: "2026-07-18T02:59:00.123456+00:00",
      loggedAt: "2026-07-18T02:59:00.123456+00:00",
    })
    vi.mocked(deleteLog).mockResolvedValue({ error: null })
    await renderDashboard()
    const summary = () => screen.getByLabelText("今日のまとめ")

    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() =>
      expect(within(summary()).getByText("おしっこ1・うんち0")).toBeInTheDocument(),
    )
    const recorded = vi.mocked(toast.success).mock.calls.at(-1)?.[1] as
      | { action?: { onClick: () => void } }
      | undefined

    await fireVisible()
    act(() => {
      recorded?.action?.onClick()
    })
    await waitFor(() =>
      expect(within(summary()).getByText("おしっこ0・うんち0")).toBeInTheDocument(),
    )

    // 取得は取り消し前の snapshot（行がまだ在る）で解決する
    await resolveLatestResync({
      day: {
        data: [
          makeLog({
            id: "undo-1",
            log_type: "diaper",
            diaper_type: "pee",
            logged_at: `${TODAY}T11:59:00+09:00`,
          }),
        ],
        error: null,
      },
    })

    expect(within(summary()).getByText("おしっこ0・うんち0")).toBeInTheDocument()
  })

  it("unmount で in-flight の再取得を abort する", async () => {
    const { unmount } = await renderDashboard()
    await fireVisible()
    const day = pendingOf(`day:${TODAY}`)[0]
    unmount()
    expect(day.signal?.aborted).toBe(true)
  })
})

describe("BabyDashboard / 日記の編集シートへ保持中の版を渡す（P1-06）", () => {
  it("Realtime で届いた日記の更新後に開くと、その updated_at を版として保存する", async () => {
    vi.mocked(upsertBabyDiary).mockResolvedValue({ error: null, diary: null })
    render(
      <BabyDashboard
        {...defaultProps({
          initialDiary: {
            id: "d1",
            diary_date: TODAY,
            content: "SSR の本文",
            updated_at: "2026-07-18T01:00:00.000001+00:00",
          },
        })}
      />,
    )
    act(() => {
      for (const cb of mockState.listenersByTable.get("baby_diaries") ?? []) {
        cb(
          makePayloadFor<BabyDiaryData>("baby_diaries")("UPDATE", {
            id: "d1",
            diary_date: TODAY,
            content: "配偶者の新しい本文",
            updated_at: "2026-07-18T02:00:00.000002+00:00",
          }),
        )
      }
    })

    fireEvent.click(screen.getByRole("button", { name: "日記を編集" }))
    fireEvent.change(await screen.findByLabelText("日記本文"), {
      target: { value: "書き足し" },
    })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))

    await waitFor(() =>
      expect(vi.mocked(upsertBabyDiary)).toHaveBeenCalledWith(
        TODAY,
        "書き足し",
        "2026-07-18T02:00:00.000002+00:00",
      ),
    )
  })

  it("日記が無い日（取得失敗の空表示を含む）から書くと版 null で保存する", async () => {
    vi.mocked(upsertBabyDiary).mockResolvedValue({ error: null, diary: null })
    render(<BabyDashboard {...defaultProps({ initialDiary: null })} />)

    fireEvent.click(screen.getByRole("button", { name: /日記を書く/ }))
    fireEvent.change(await screen.findByLabelText("日記本文"), {
      target: { value: "空欄から" },
    })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))

    await waitFor(() =>
      expect(vi.mocked(upsertBabyDiary)).toHaveBeenCalledWith(TODAY, "空欄から", null),
    )
  })
})

// ---------------------------------------------------------------------------
// 2026-10-27 C1 / C3 / C4: 範囲ごとの最新の確認・初回の取得失敗・折り畳み・引き継ぎ
// ---------------------------------------------------------------------------

describe("BabyDashboard / 最新を確認できぬ範囲（C1 鮮度・AC15）", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("日次の取り直しだけが失敗したら、記録を消さず「この日の記録」の最終確認と再試行を出す（週は最新扱いのまま）", async () => {
    await renderDashboard({ initialLogs: [feedingA], initialWeeklyLogs: [feedingA] })
    expect(screen.queryByText(/最新を確認できません/)).not.toBeInTheDocument()

    await fireVisible()
    await resolveLatestResync({
      day: { data: null, error: { message: "upstream 503", code: "" } },
      weekly: { data: [feedingA], error: null },
    })

    const notice = screen.getByText(/最新を確認できません/)
    expect(notice.textContent).toBe("最新を確認できません: この日の記録（最終確認 12:00）")
    expect(notice.textContent).not.toMatch(/週間/)
    // 「記録なし」「0 件」と偽らぬ: 直前に取れた記録は出したまま
    expect(screen.getByText("ROW_A")).toBeInTheDocument()
    expect(screen.queryByText("まだ記録がありません")).not.toBeInTheDocument()

    // 再試行で取り直し、成功すれば消える
    fireEvent.click(screen.getByRole("button", { name: "最新をもう一度読み込む" }))
    await flushResyncStart()
    await resolveLatestResync({
      day: { data: [feedingA], error: null },
      weekly: { data: [feedingA], error: null },
    })
    expect(screen.queryByText(/最新を確認できません/)).not.toBeInTheDocument()
  })

  it("session が無く取り直せなんだ時も、最新を確認できぬと出す（anon の 0 行を真値にせぬ）", async () => {
    await renderDashboard({ initialLogs: [feedingA] })
    mockState.session = { data: { session: null }, error: null }
    await fireVisible()
    expect(screen.getByText(/最新を確認できません/)).toBeInTheDocument()
    expect(screen.getByText("ROW_A")).toBeInTheDocument()
  })

  it("初回描画の記録の取得失敗を「まだ記録がありません」と描かず、失敗と再読み込みを出す", async () => {
    render(<BabyDashboard {...defaultProps({ initialLoadErrors: { logs: true } })} />)
    expect(screen.queryByText("まだ記録がありません")).not.toBeInTheDocument()
    expect(screen.getByText("この日の記録を読み込めませんでした")).toBeInTheDocument()
    // 今日のまとめの数字も 0 と言わぬ（週の内訳は別の窓で、取れておる）
    const todaySummary = screen.getByRole("group", { name: "今日のまとめ" })
    expect(within(todaySummary).queryByText("おしっこ0・うんち0")).not.toBeInTheDocument()

    // マウント時の取り直しが通れば癒える（対照: 取れた空は「まだ記録がありません」）
    await flushResyncStart()
    await resolveLatestResync({ day: { data: [], error: null } })
    expect(screen.getByText("まだ記録がありません")).toBeInTheDocument()
  })

  it("初回描画の日記の取得失敗を「日記を書く」と描かず、失敗と再読み込みを出す", async () => {
    render(<BabyDashboard {...defaultProps({ initialLoadErrors: { diary: true } })} />)
    expect(screen.getByText(/この日の日記を読み込めませんでした/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /日記を書く|日記を編集/ })).toBeNull()
    expect(screen.getByRole("button", { name: "日記をもう一度読み込む" })).toBeInTheDocument()
  })
})

describe("BabyDashboard / 前回この端末で見てから（C4 引き継ぎ・AC16）", () => {
  const SEEN = "2026-07-18T02:00:00.000000+00:00" // JST 11:00
  const seenKey = "irori:handoff-seen:v1:u1:h1"

  beforeEach(() => {
    localStorage.clear()
  })

  const otherNew = makeLog({
    id: "n1",
    log_type: "diaper",
    diaper_type: "pee",
    logged_by: "spouse",
    logged_at: `${TODAY}T11:30:00+09:00`,
    created_at: "2026-07-18T02:30:00.000000+00:00",
    updated_at: "2026-07-18T02:30:00.000000+00:00",
  })
  const mineNew = makeLog({
    id: "n2",
    log_type: "diaper",
    diaper_type: "poop",
    logged_by: "u1",
    logged_at: `${TODAY}T11:40:00+09:00`,
    created_at: "2026-07-18T02:40:00.000000+00:00",
    updated_at: "2026-07-18T02:40:00.000000+00:00",
  })
  const edited = makeLog({
    id: "e1",
    log_type: "diaper",
    diaper_type: "pee",
    logged_by: "spouse",
    logged_at: `${TODAY}T08:00:00+09:00`,
    created_at: "2026-07-17T23:00:00.000000+00:00",
    updated_at: "2026-07-18T02:50:00.000000+00:00",
  })

  it("新規（ほかの方が作成）と更新を分けて数え、範囲を添え、変更者・既読・削除の有無を断定せぬ", async () => {
    localStorage.setItem(seenKey, SEEN)
    await renderDashboard({ initialWeeklyLogs: [otherNew, mineNew, edited] })
    const card = screen.getByRole("region", { name: "前回この端末で見てから" })
    expect(card.textContent).toMatch(/新しい記録 1件（ほかの方が記録）/)
    expect(card.textContent).toMatch(/更新のある記録 1件/)
    expect(card.textContent).toMatch(/直近8日の範囲で数えています/)
    expect(card.textContent).toMatch(/ご自身の記録 1件は含めていません/)
    expect(card.textContent).toMatch(/更新した人は記録されていません/)
    expect(card.textContent).not.toMatch(/全部で|読んだ|既読|削除なし|が変更/)
  })

  it("初回（この端末に前回の確認が無い）は件数を出さず、離れる時に今見えておる最新の版を残す", async () => {
    const view = await renderDashboard({ initialWeeklyLogs: [otherNew, edited] })
    expect(screen.queryByRole("region", { name: "前回この端末で見てから" })).not.toBeInTheDocument()
    view.unmount()
    expect(localStorage.getItem(seenKey)).toBe("2026-07-18T02:50:00.000000+00:00")
  })

  it("週の窓を読めなんだ時は数えず（0 件と言わず）、前回の確認の印も進めぬ", async () => {
    localStorage.setItem(seenKey, SEEN)
    const view = render(
      <BabyDashboard
        {...defaultProps({ initialWeeklyLogs: [], initialLoadErrors: { weekly: true } })}
      />,
    )
    expect(screen.getByText(/読み込めなかったため数えられません/)).toBeInTheDocument()
    view.unmount()
    expect(localStorage.getItem(seenKey)).toBe(SEEN)
  })

  it("「確認した」はこの端末の印だけを進めて閉じる", async () => {
    localStorage.setItem(seenKey, SEEN)
    await renderDashboard({ initialWeeklyLogs: [otherNew] })
    fireEvent.click(screen.getByRole("button", { name: "確認した" }))
    expect(
      screen.queryByRole("region", { name: "前回この端末で見てから" }),
    ).not.toBeInTheDocument()
    expect(localStorage.getItem(seenKey)).toBe("2026-07-18T02:30:00.000000+00:00")
  })
})

describe("BabyDashboard / 低頻度の面を任意で畳める（C3）", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("体温・日記を畳むとこの端末（持ち主ごと）に覚え、作り直しても畳んだまま。記録の釦は畳まれぬ", async () => {
    const view = await renderDashboard()
    fireEvent.click(screen.getByRole("button", { name: "体温を畳む" }))
    fireEvent.click(screen.getByRole("button", { name: "育児日記を畳む" }))
    expect(screen.queryByRole("button", { name: /日記を書く/ })).toBeNull()
    expect(JSON.parse(localStorage.getItem("irori:home-folds:v1:u1:h1")!)).toMatchObject({
      temperature: false,
      diary: false,
    })
    view.unmount()

    await renderDashboard()
    expect(screen.getByRole("button", { name: /体温/, expanded: false })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /日記を書く/ })).toBeNull()
    // 主要操作は畳まぬ
    expect(screen.getByRole("button", { name: "おしっこ" })).toBeInTheDocument()

    // 別の利用者には持ち込まぬ
    cleanup()
    await renderDashboard({ userId: "u2" })
    expect(screen.getByRole("button", { name: /日記を書く/ })).toBeInTheDocument()
  })

  it("この日の日記の下書きが端末に残っておれば、日記は畳まずその旨を出す", async () => {
    localStorage.setItem("irori:home-folds:v1:u1:h1", JSON.stringify({ diary: false }))
    localStorage.setItem(
      `irori:draft:v1:u1:h1:diary:${TODAY}`,
      JSON.stringify({
        schemaVersion: 1,
        owner: { userId: "u1", householdId: "h1" },
        target: { kind: "diary", date: TODAY },
        baseVersion: null,
        content: { text: "下書き" },
        createdAt: FIXED_NOW.toISOString(),
        updatedAt: FIXED_NOW.toISOString(),
      }),
    )
    await renderDashboard()
    expect(screen.getByText(/保存していない下書きがあります/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /日記を書く/ })).toBeInTheDocument()
  })
})
