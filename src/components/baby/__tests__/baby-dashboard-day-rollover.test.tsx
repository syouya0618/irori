/**
 * 画面を開いたまま JST 0:00 を跨いだ時の BabyDashboard。
 *
 * 「今日」は useNow の時計から導く（React Compiler の凍結を避けるため）。ゆえに日を
 * 跨ぐと today が進む。その時に守るべき不変条件:
 *
 * 1. 「今日」を見ておったなら選択日も新しい今日へ進む（見出し「今日」・クイック記録が
 *    残る）。過去日を見ておった時、または記録シート・日記シートを開いておる最中は
 *    選択日を動かさぬ（開いたシートは開いた日の記録を書いておる）。
 * 2. 最終授乳・次の授乳の目安の起点（「今日より前の最後の授乳」フォールバック）が前へ
 *    進む。進めねば、新しい今日にまだ授乳が無い間、前夜の授乳を飛ばしてページ読込
 *    時点の値（2 日前など）を出す — 夜間授乳の判断を誤る。
 *    - 手元の記録（logs / weeklyLogs）で進む（取り直しが失敗＝圏外でも効く）
 *    - DB から取り直した値は真値として扱う（別端末の記録で進み、手元に残った
 *      削除済みの行は正される）
 * 3. 「今日・明日の予定」カードが新しい今日の予定へ入れ替わる（読込日の予定を
 *    「今日」と出し続けぬ）。二晩目以降も同じ。
 *
 * fake timers で 23:55 から 6 分進め、useNow(60_000) の interval で日を跨がせる。
 * Supabase は呼び出し列を記録する汎用チェーンで模し、テーブルと条件で応答を返す。
 *
 * 二段目の取り直しは復帰時と同じ resyncLogs（P1-04）で、auth.getSession() で session を
 * 確かめてから 5 本（選択日・週窓・成長・最終授乳 2 本）を発行する。マウント時にも同じ
 * 取り直しが走るが、こちらは session を解決させず保留のまま止める（`sessionReady`）:
 * 通すと既定の応答「新しい日のログは空」が initialLogs を上書きし、「手元の記録だけで
 * 進む」経路が検証できぬうえ、クエリ本数の assert が曖昧になる。日を跨ぐ前に解決を
 * 許し、日跨ぎの取り直しだけが問い合わせを出す。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react"
import { act } from "react"
import type { BabyLogData } from "@/lib/types/baby"
import type { CalendarEventRecord } from "@/components/calendar/use-month-events"
import { formatElapsedMinutes } from "@/lib/utils/baby-log-labels"
import { recordFeeding, upsertBabyDiary } from "@/app/(main)/baby/actions"

type Call = [method: string, args: unknown[]]
type Responder = (table: string, calls: Call[]) => { data: unknown; error: unknown }

const mockState = vi.hoisted(() => ({
  responder: (() => ({ data: null, error: null })) as Responder,
  queries: [] as Array<{ table: string; calls: Call[] }>,
  /**
   * auth.getSession() を解決させるか。false の間に呼ばれた取り直しは session 待ちで
   * 止まったまま（マウント時の分）。crossMidnight が true にして日跨ぎの分だけ通す。
   */
  sessionReady: false,
}))

vi.mock("@/lib/supabase/client", () => {
  function makeQuery(table: string) {
    const calls: Call[] = []
    mockState.queries.push({ table, calls })
    const query: Record<string, unknown> = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            return (
              onFulfilled?: (v: unknown) => unknown,
              onRejected?: (r: unknown) => unknown,
            ) =>
              Promise.resolve(mockState.responder(table, calls)).then(
                onFulfilled,
                onRejected,
              )
          }
          return (...args: unknown[]) => {
            calls.push([String(prop), args])
            return query
          }
        },
      },
    )
    return query
  }
  const channel: Record<string, unknown> = {}
  channel.on = () => channel
  channel.subscribe = () => channel
  return {
    createClient: () => ({
      from: (table: string) => makeQuery(table),
      channel: () => channel,
      removeChannel: () => Promise.resolve("ok"),
      auth: {
        getSession: () =>
          mockState.sessionReady
            ? Promise.resolve({
                data: { session: { user: { id: "u1" } } },
                error: null,
              })
            : new Promise(() => {}),
      },
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

import { BabyDashboard } from "../baby-dashboard"

const mockedRecordFeeding = vi.mocked(recordFeeding)

const D = "2026-04-16"
const NEXT = "2026-04-17"
const NEXT2 = "2026-04-18"
const PREV = "2026-04-15"
// JST 2026-04-16 23:55
const START = new Date("2026-04-16T14:55:00Z")
// JST 2026-04-17 23:55（二晩目の手前）
const START_NEXT = new Date("2026-04-17T14:55:00Z")

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
    created_at: `${D}T00:00:00+09:00`,
    ...overrides,
  }
}

// ページ読込時のフォールバック =「D の 0 時より前の最後の授乳」= 前日 21:00
const STALE_FALLBACK = makeLog({
  id: "stale",
  log_type: "feeding",
  feeding_type: "bottle",
  logged_at: `${PREV}T21:00:00+09:00`,
})
// D の 22:30 の授乳（DB にも手元にもある）
const LAST_NIGHT = makeLog({
  id: "last-night",
  log_type: "feeding",
  feeding_type: "breast",
  breast_left_count: 1,
  breast_right_count: 0,
  logged_at: `${D}T22:30:00+09:00`,
})

function hasCall(calls: Call[], method: string): boolean {
  return calls.some(([m]) => m === method)
}

const OFFLINE = { code: "", message: "TypeError: Failed to fetch" }

/**
 * 既定の応答: 新しい日のログは空・日記なし・予定なし。フォールバックの取り直しは
 * 現実の DB と同じく「新しい今日より前の最新授乳」= 前夜 22:30 を返す。
 * `fallback: "offline"` で取り直しを失敗させ、手元の記録だけで進む経路を表す。
 */
function defaultResponder(overrides: {
  fallback?: BabyLogData | null | "offline"
  events?: CalendarEventRecord[]
} = {}): Responder {
  return (table, calls) => {
    if (table === "calendar_events") {
      return { data: overrides.events ?? [], error: null }
    }
    if (table === "baby_diaries") return { data: null, error: null }
    if (table === "baby_logs") {
      if (hasCall(calls, "maybeSingle")) {
        const fb = overrides.fallback === undefined ? LAST_NIGHT : overrides.fallback
        if (fb === "offline") return { data: null, error: OFFLINE }
        return { data: fb, error: null }
      }
      return { data: [], error: null }
    }
    return { data: null, error: null }
  }
}

function dayLogQueriesFor(ymd: string) {
  return mockState.queries.filter(
    (q) =>
      q.table === "baby_logs" &&
      q.calls.some(
        ([m, a]) => m === "gte" && a[0] === "logged_at" && String(a[1]).startsWith(ymd),
      ),
  )
}

function defaultProps(
  overrides: Partial<Parameters<typeof BabyDashboard>[0]> = {},
): Parameters<typeof BabyDashboard>[0] {
  return {
    initialLogs: [LAST_NIGHT],
    initialWeeklyLogs: [LAST_NIGHT],
    initialGrowthLogs: [],
    householdId: "h1",
    userId: "u1",
    initialDate: D,
    initialDiary: null,
    lastFeedingFallback: STALE_FALLBACK,
    lastNursingFallback: STALE_FALLBACK,
    babyName: null,
    babyBirthDate: null,
    feedingIntervalMin: 180,
    initialBottleDefault: { status: "set" as const, amountMl: 120 },
    ...overrides,
  }
}

/** 6 分進めて JST 00:01 へ。interval と、その後の fetch の解決まで流す */
async function crossMidnight() {
  // ここから先に始まる取り直し（日跨ぎの二段目）だけ session を解決させる
  mockState.sessionReady = true
  await act(async () => {
    await vi.advanceTimersByTimeAsync(360_000)
  })
  await act(async () => {
    await Promise.resolve()
  })
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

function lastFeedingText(): string {
  // 今日は「最終授乳（開始から）」、過去日は「最終授乳」（授乳の logged_at は開始時刻）
  const label = screen.getByText(/^最終授乳/)
  return label.nextElementSibling?.textContent ?? ""
}

/** シートが開いておる間は背面が aria-hidden になるゆえ hidden も含めて引く */
function pageHeading(): HTMLElement {
  return screen.getByRole("heading", { level: 1, hidden: true })
}

beforeEach(() => {
  cleanup()
  vi.useFakeTimers({ now: START, toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] })
  mockState.queries.length = 0
  mockState.responder = defaultResponder()
  mockState.sessionReady = false
  mockedRecordFeeding.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("BabyDashboard / 開いたまま日を跨ぐ — 選択日の追従", () => {
  // baby-dashboard.test.tsx から移設（日跨ぎで fetch が走るようになったため）
  it("真夜中跨ぎ: useNow の interval が発火し today/weeklyStart が前進、chart labels がシフトする", async () => {
    render(<BabyDashboard {...defaultProps()} />)
    const labels = () =>
      Array.from(
        screen.getByLabelText("直近7日の授乳回数").querySelectorAll("title"),
      ).map((t) => (t.textContent ?? "").split(":")[0])

    // 初期: 週ウィンドウは 4/10 〜 4/16
    expect(labels()).toEqual(["4/10", "4/11", "4/12", "4/13", "4/14", "4/15", "4/16"])

    // 6 分進めて JST 00:01 に到達 → useNow(60_000) の setInterval が 6 回発火
    await crossMidnight()

    // 真夜中越え: 週ウィンドウは 4/11 〜 4/17 にシフトする
    expect(labels()).toEqual(["4/11", "4/12", "4/13", "4/14", "4/15", "4/16", "4/17"])
  })

  it("「今日」を見ておれば選択日も新しい今日へ進み、クイック記録が残る", async () => {
    render(<BabyDashboard {...defaultProps()} />)
    expect(pageHeading()).toHaveTextContent("今日")

    await crossMidnight()

    expect(pageHeading()).toHaveTextContent("今日")
    expect(screen.getByRole("group", { name: "今日のまとめ" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "おしっこ" })).toBeInTheDocument()
    // 新しい今日の行は、日付ナビの取得（選択日が動いた）と日跨ぎの取り直し（resyncLogs の
    // 選択日窓）の 2 本で引く。どちらも id 合流ゆえ二重に出ない
    expect(dayLogQueriesFor(NEXT)).toHaveLength(2)
  })

  it("過去日を見ておれば選択日は動かさぬ", async () => {
    render(<BabyDashboard {...defaultProps()} />)
    fireEvent.click(screen.getByRole("button", { name: "前の日" }))
    await flush()
    expect(pageHeading()).toHaveTextContent("昨日")

    await crossMidnight()

    // 選択日は D-1 のまま（日を跨いだので「昨日」ではなく日付表記になる）
    expect(pageHeading()).not.toHaveTextContent(/^(今日|昨日)$/)
    expect(dayLogQueriesFor(NEXT)).toHaveLength(0)
  })

  // 開いたシートは開いた日の記録を書いておる。選択日が動くと、日記は前日の本文を
  // 翌日として upsert し、記録シートは前日の行を新しい日のタイムラインへ前置きする。
  it("記録シートを開いておる最中は選択日を動かさぬ", async () => {
    render(<BabyDashboard {...defaultProps()} />)
    fireEvent.click(screen.getByRole("button", { name: "搾乳" }))
    await flush()
    // fake timers 下では findBy の待機が進まぬゆえ、描画を流してから同期で引く
    expect(screen.getByRole("dialog")).toBeInTheDocument()

    await crossMidnight()

    // 選択日は D のまま → 日を跨いだので見出しは「昨日」
    expect(pageHeading()).toHaveTextContent("昨日")
    expect(dayLogQueriesFor(NEXT)).toHaveLength(0)
  })

  it("日記シートを開いておる最中は選択日を動かさぬ", async () => {
    render(<BabyDashboard {...defaultProps()} />)
    // 日記が無い日の入口は「日記を書く」
    fireEvent.click(screen.getByRole("button", { name: /日記を書く/ }))
    await flush()
    expect(screen.getByRole("dialog")).toBeInTheDocument()

    await crossMidnight()

    expect(pageHeading()).toHaveTextContent("昨日")
    expect(dayLogQueriesFor(NEXT)).toHaveLength(0)
  })
})

describe("BabyDashboard / 開いたまま日を跨ぐ — 最終授乳のフォールバック", () => {
  it("DB の取り直しが失敗（圏外）でも、logs にしか無い前夜の授乳で進む", async () => {
    // 楽観 append の行は logs にしか入らぬ（weeklyLogs は Realtime 頼み）
    mockState.responder = defaultResponder({ fallback: "offline" })
    render(
      <BabyDashboard
        {...defaultProps({ initialLogs: [LAST_NIGHT], initialWeeklyLogs: [] })}
      />,
    )

    await crossMidnight()

    // 00:01 - 22:30 = 1時間31分。前日 21:00 起点の「27時間1分前」ではない
    expect(lastFeedingText()).toBe(`${formatElapsedMinutes(91)}前`)
  })

  it("DB の取り直しが失敗（圏外）でも、weeklyLogs にしか無い前夜の授乳で進む（過去日から「今日」へ戻る）", async () => {
    mockState.responder = defaultResponder({ fallback: "offline" })
    render(<BabyDashboard {...defaultProps()} />)
    // 23:55 に前日へ移る（logs は前日の行へ入れ替わり、前夜の授乳は weeklyLogs にだけ残る）
    fireEvent.click(screen.getByRole("button", { name: "前の日" }))
    await flush()

    await crossMidnight()
    fireEvent.click(screen.getByRole("button", { name: "今日に戻る" }))
    await flush()

    expect(lastFeedingText()).toBe(`${formatElapsedMinutes(91)}前`)
  })

  it("DB から取り直した別端末の記録（手元に無い）でも前へ進む", async () => {
    const otherDevice = makeLog({
      id: "other-device",
      log_type: "feeding",
      feeding_type: "bottle",
      logged_at: `${D}T23:40:00+09:00`,
    })
    mockState.responder = defaultResponder({ fallback: otherDevice })
    render(<BabyDashboard {...defaultProps()} />)

    await crossMidnight()

    // 00:01 - 23:40 = 21分
    expect(lastFeedingText()).toBe(`${formatElapsedMinutes(21)}前`)
    // 取り直しは「新しい今日の 0 時より前」で引く
    const fallbackQueries = mockState.queries.filter(
      (q) => q.table === "baby_logs" && hasCall(q.calls, "maybeSingle"),
    )
    expect(fallbackQueries).toHaveLength(2)
    for (const q of fallbackQueries) {
      expect(q.calls).toContainEqual(["lt", ["logged_at", `${NEXT}T00:00:00+09:00`]])
    }
    // 目安用は搾乳だけを外す denylist（page.tsx と同じ条件）
    expect(
      fallbackQueries.some((q) =>
        q.calls.some(
          ([m, a]) => m === "or" && a[0] === "feeding_type.is.null,feeding_type.neq.pumped",
        ),
      ),
    ).toBe(true)
  })

  // 取り消し・削除した行は household フィルタ付き購読では DELETE が届かず weeklyLogs に
  // 残りうる（別端末の削除も同じ）。一段目がそれを拾っても、DB の応答で正す。
  it("手元に残った削除済みの行より、DB の応答（真値）を採る", async () => {
    const ghost = makeLog({
      id: "ghost",
      log_type: "feeding",
      feeding_type: "bottle",
      logged_at: `${D}T23:40:00+09:00`,
    })
    render(
      <BabyDashboard
        {...defaultProps({ initialWeeklyLogs: [LAST_NIGHT, ghost] })}
      />,
    )

    await crossMidnight()

    // DB は 22:30 を返す → 幽霊の 23:40（21分前）ではなく 1時間31分前
    expect(lastFeedingText()).toBe(`${formatElapsedMinutes(91)}前`)
  })

  it("DB が「前の授乳は無い」と答えたら、手元の削除済みの行も出さぬ", async () => {
    const ghost = makeLog({
      id: "ghost",
      log_type: "feeding",
      feeding_type: "bottle",
      logged_at: `${D}T23:40:00+09:00`,
    })
    mockState.responder = defaultResponder({ fallback: null })
    render(
      <BabyDashboard
        {...defaultProps({
          initialLogs: [],
          initialWeeklyLogs: [ghost],
          lastFeedingFallback: null,
          lastNursingFallback: null,
        })}
      />,
    )

    await crossMidnight()

    expect(lastFeedingText()).toBe("---")
  })

  // 日跨ぎで開いたままのシートから前日として保存した授乳は、選択日（D）の logs へ入る。
  // 一段目の前進はその前に済んでおるゆえ、appendLog でもフォールバックを前へ進める。
  it("開いたシートから前日として保存した授乳でも、「今日」へ戻った時に前へ進んでおる", async () => {
    mockedRecordFeeding.mockResolvedValue({ error: null, id: "pumped-2355" })
    render(<BabyDashboard {...defaultProps()} />)
    fireEvent.click(screen.getByRole("button", { name: "搾乳" }))
    await flush()
    expect(screen.getByRole("dialog")).toBeInTheDocument()

    await crossMidnight()

    // 開いた時点（D 23:55）の時刻のまま保存する
    fireEvent.click(screen.getByRole("button", { name: "記録する" }))
    await flush()
    await flush()
    expect(mockedRecordFeeding).toHaveBeenCalledWith(
      expect.objectContaining({
        feedingType: "pumped",
        loggedAt: new Date(`${D}T23:55:00+09:00`).toISOString(),
      }),
    )

    fireEvent.click(screen.getByRole("button", { name: "今日に戻る" }))
    await flush()
    // 00:01 - 23:55 = 6分（搾乳も「最終授乳」には含む契約）
    expect(lastFeedingText()).toBe(`${formatElapsedMinutes(6)}前`)
  })
})

describe("BabyDashboard / 日跨ぎと保存の競合", () => {
  // 保存の通信中にシートを閉じると、開閉フラグによる追従の抑止は外れる。その間に日を
  // 跨ぐと選択日が新しい今日へ進み、後から戻った保存結果（前日の行・前日の日記）が
  // 新しい日の画面へ入りうる。受け側で日付を確かめて防ぐ（Realtime の入場条件と同じ）。
  it("前日として保存した行が、選択日が進んだ後に戻っても新しい日のタイムラインへ入らぬ", async () => {
    let resolveRecord: (v: Awaited<ReturnType<typeof recordFeeding>>) => void = () => {}
    mockedRecordFeeding.mockReturnValue(
      new Promise((resolve) => {
        resolveRecord = resolve
      }),
    )
    render(<BabyDashboard {...defaultProps({ initialLogs: [], initialWeeklyLogs: [] })} />)
    fireEvent.click(screen.getByRole("button", { name: "搾乳" }))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "記録する" }))
    await flush()
    // 通信中に閉じる → 追従の抑止が外れる
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    await flush()

    await crossMidnight()
    expect(pageHeading()).toHaveTextContent("今日")

    // 前日 23:55 の行として保存が戻る
    await act(async () => {
      resolveRecord({ error: null, id: "late-pumped" })
    })
    await flush()

    // 新しい日のタイムラインには出ぬ（前日の行ゆえ）
    expect(screen.getByText("まだ記録がありません")).toBeInTheDocument()
    // ただし「今日より前の最後の授乳」としては前へ進む（00:01 - 23:55 = 6分）
    expect(lastFeedingText()).toBe(`${formatElapsedMinutes(6)}前`)
  })

  it("前日の日記の保存が、選択日が進んだ後に戻っても新しい日の日記として表示されぬ", async () => {
    let resolveDiary: (v: Awaited<ReturnType<typeof upsertBabyDiary>>) => void = () => {}
    vi.mocked(upsertBabyDiary).mockReturnValue(
      new Promise((resolve) => {
        resolveDiary = resolve
      }),
    )
    render(<BabyDashboard {...defaultProps()} />)
    fireEvent.click(screen.getByRole("button", { name: /日記を書く/ }))
    await flush()
    fireEvent.change(screen.getByLabelText("日記本文"), {
      target: { value: "前日の日記" },
    })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))
    await flush()
    // 通信中に閉じる → 追従の抑止が外れる
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    await flush()

    await crossMidnight()
    expect(pageHeading()).toHaveTextContent("今日")

    await act(async () => {
      resolveDiary({
        error: null,
        diary: { id: "d1", diary_date: D, content: "前日の日記", updated_at: "" },
      })
    })
    await flush()

    // 新しい日の日記欄は空のまま（前日の本文を出せば、次の編集で新しい日へ upsert される）
    expect(screen.queryByText("前日の日記")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /日記を書く/ })).toBeInTheDocument()
  })
})

/**
 * 取り直しの応答が保留中に、手元で新しい授乳が書かれた場合と、Server Action の
 * revalidatePath で initialDate が先に今日へ追いついた場合。どちらも応答の扱い
 * （真値として置換するか合流するか）と発火条件（マウント時の日付）を固定する。
 */
describe("BabyDashboard / 日跨ぎのフォールバック取り直し — 保留中の競合", () => {
  function holdFallback() {
    const pending: Array<(v: { data: unknown; error: unknown }) => void> = []
    const base = defaultResponder()
    mockState.responder = (table, calls) => {
      if (table === "baby_logs" && hasCall(calls, "maybeSingle")) {
        // Proxy の then は Promise.resolve(responder()) ゆえ、Promise を返せば保留できる
        return new Promise((resolve) => pending.push(resolve)) as unknown as {
          data: unknown
          error: unknown
        }
      }
      return base(table, calls)
    }
    return pending
  }

  it("保留中に手元で前日の授乳が書かれたら、古い DB 応答で巻き戻さず新しい方を残す", async () => {
    const pending = holdFallback()
    mockedRecordFeeding.mockResolvedValue({ error: null, id: "pumped-2355" })
    render(<BabyDashboard {...defaultProps()} />)
    fireEvent.click(screen.getByRole("button", { name: "搾乳" }))
    await flush()

    await crossMidnight()
    expect(pending).toHaveLength(2)

    // 取り直しが保留のまま、開いたシートから前日 23:55 として保存する
    fireEvent.click(screen.getByRole("button", { name: "記録する" }))
    await flush()
    await flush()

    // その後に DB の古い応答（22:30）が着く
    await act(async () => {
      for (const resolve of pending) resolve({ data: LAST_NIGHT, error: null })
    })
    await flush()

    fireEvent.click(screen.getByRole("button", { name: "今日に戻る" }))
    await flush()
    // 23:55（6分前）が残る。22:30（1時間31分前）へ巻き戻さぬ
    expect(lastFeedingText()).toBe(`${formatElapsedMinutes(6)}前`)
  })

  it("日跨ぎの直前に initialDate が今日へ追いついても（revalidatePath）、取り直しは走る", async () => {
    const otherDevice = makeLog({
      id: "other-device",
      log_type: "feeding",
      feeding_type: "bottle",
      logged_at: `${D}T23:40:00+09:00`,
    })
    mockState.responder = defaultResponder({ fallback: otherDevice })
    const { rerender } = render(<BabyDashboard {...defaultProps()} />)

    // 実時計は 0 時を過ぎたが useNow はまだ刻んでおらぬ（最大 60 秒の遅れ）。その間に
    // Server Action の revalidatePath でサーバの新しい今日が initialDate として届く
    act(() => {
      vi.setSystemTime(new Date(`${NEXT}T00:00:10+09:00`))
    })
    rerender(<BabyDashboard {...defaultProps({ initialDate: NEXT })} />)

    // useNow が刻んで today が追いつく（crossMidnight を使わぬゆえ session を手で解決させる）
    mockState.sessionReady = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    await flush()

    // initialDate ではなくマウント時の日付で判定するゆえ、取り直しは走って別端末の記録を拾う
    expect(
      mockState.queries.filter(
        (q) => q.table === "baby_logs" && hasCall(q.calls, "maybeSingle"),
      ),
    ).toHaveLength(2)
    // 00:01:10 - 23:40 ≒ 21分
    expect(lastFeedingText()).toBe(`${formatElapsedMinutes(21)}前`)
  })
})

describe("BabyDashboard / 開いたまま日を跨ぐ — 今日・明日の予定", () => {
  const onD = {
    id: "ev-d",
    title: "読込日の予定",
    memo: null,
    is_all_day: true,
    start_date: D,
    end_date: D,
    start_at: null,
    end_at: null,
    source: "native",
    series_id: null,
  } as unknown as CalendarEventRecord
  const onNext = {
    ...onD,
    id: "ev-next",
    title: "新しい今日の予定",
    start_date: NEXT,
    end_date: NEXT,
  } as unknown as CalendarEventRecord
  const onNext2 = {
    ...onD,
    id: "ev-next2",
    title: "二晩目の予定",
    start_date: NEXT2,
    end_date: NEXT2,
  } as unknown as CalendarEventRecord
  const card = () => screen.getByRole("link", { name: /今日・明日の予定/ })

  it("新しい今日の予定へ取り直す（読込日の予定を「今日」と出し続けぬ）", async () => {
    mockState.responder = defaultResponder({ events: [onNext] })
    render(<BabyDashboard {...defaultProps({ initialUpcomingEvents: [onD] })} />)
    expect(within(card()).getByText("読込日の予定")).toBeInTheDocument()

    await crossMidnight()

    expect(within(card()).getByText("新しい今日の予定")).toBeInTheDocument()
    expect(within(card()).queryByText("読込日の予定")).not.toBeInTheDocument()
  })

  it("二晩目も取り直す（一晩目だけで止まらぬ）", async () => {
    mockState.responder = defaultResponder({ events: [onNext] })
    render(<BabyDashboard {...defaultProps({ initialUpcomingEvents: [onD] })} />)
    await crossMidnight()
    expect(within(card()).getByText("新しい今日の予定")).toBeInTheDocument()

    mockState.responder = defaultResponder({ events: [onNext2] })
    act(() => {
      vi.setSystemTime(START_NEXT)
    })
    await crossMidnight()

    expect(within(card()).getByText("二晩目の予定")).toBeInTheDocument()
    expect(within(card()).queryByText("新しい今日の予定")).not.toBeInTheDocument()
  })
})
