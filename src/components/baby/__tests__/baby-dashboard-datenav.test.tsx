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

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))

// クイック記録・取り消しの Server Action（日付をまたぐ取り消しの帯の検証で使う）
vi.mock("@/app/(main)/baby/actions", () => ({
  recordFeeding: vi.fn(),
  recordDiaper: vi.fn(),
  deleteLog: vi.fn(),
  updateLog: vi.fn(),
}))

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
          // 育児日記の選択日 refetch（maybeSingle 終端）。このテスト群では日記
          // クエリは解決せず放置する（logs のアサーションに影響しない）。
          maybeSingle: () => q,
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
        // マウント時の再取得（P1-04）は session を確かめてから問い合わせる。本ファイルは
        // 日付ナビの検証ゆえ、getSession を解決させずに再取得を保留のまま止め、
        // pendingFetches に日付ナビ以外の鎖を混ぜない。
        auth: { getSession: () => new Promise(() => {}) },
      }
    },
  }
})

// ---------------------------------------------------------------------------
// Imports after vi.mock
// ---------------------------------------------------------------------------
import { BabyDashboard } from "../baby-dashboard"
import { recordDiaper, deleteLog } from "@/app/(main)/baby/actions"

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
    created_at: "2026-07-18T00:00:00+09:00",
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

const emit = (payload: RealtimePayload<BabyLogData>) => {
  for (const cb of mockState.listeners) cb(payload)
}

/** 「前の日」ボタンを押して selectedDate を 1 日戻し、日付ナビ fetch を発火させる */
function goPrevDay() {
  fireEvent.click(screen.getByLabelText("前の日"))
}

/**
 * in-flight の fetch を全て解決する（microtask を flush）。
 * 日付ナビ refetch は logs + 育児日記の 2 本ゆえ、同一結果で両方を解決する
 * （logs 側の error/merge 検証はそのまま成立する）。
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

describe("BabyDashboard / 日付ナビ fetch の error 握り潰し (B-08) と取得状態の表示 (P2-10)", () => {
  // 旧テストは「error 後も既存 logs（前の日の行）が画面に残る」を固定していた。それは
  // B-08 の主眼（error を捨てぬ）の副産物で、見出しが「昨日」なのに今日の行が並ぶ
  // （P2-10: 表示データの日付と見出しが食い違う）を容認していた。新しい受入条件:
  // error は toast に加えて画面に残る失敗表示と再読み込みの導線で伝え、前の日の行は
  // 見せぬ。state の logs は捨てぬ（先着した Realtime 行の合流は下のテストが固定する）。
  it("fetch が error を返すと toast と失敗表示を出し、前の日の行を新しい見出しの下に出さぬ。再読み込みで回復する", async () => {
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
    // 見出しは「昨日」。今日の行をその下に出さぬ
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("昨日")
    expect(screen.queryByText("TODAYROW")).not.toBeInTheDocument()
    // トーストが消えた後も画面に失敗が残り、再読み込みの導線がある
    expect(screen.getByRole("alert")).toHaveTextContent(
      "この日の記録を読み込めませんでした",
    )
    const retry = screen.getByRole("button", { name: "もう一度読み込む" })

    // 再読み込み → 同じ日を取り直し、その日の行だけが並ぶ
    act(() => {
      fireEvent.click(retry)
    })
    await resolvePendingFetch({
      data: [
        makeLog({
          id: "yesterday-1",
          log_type: "diaper",
          logged_at: `${YESTERDAY}T09:00:00+09:00`,
          diaper_type: "pee",
          memo: "YESTERDAYROW",
        }),
      ],
      error: null,
    })
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByText("YESTERDAYROW")).toBeInTheDocument()
    expect(screen.queryByText("TODAYROW")).not.toBeInTheDocument()
  })

  it("取得中は前の日の行を隠し、読み込み中の骨組みを出す（解決後は空状態へ）", async () => {
    const todayRow = makeLog({
      id: "today-1",
      log_type: "feeding",
      logged_at: "2026-07-18T08:00:00+09:00",
      feeding_type: "bottle",
      memo: "TODAYROW",
    })
    render(<BabyDashboard {...defaultProps({ initialLogs: [todayRow] })} />)
    // 今日のまとめにも今日の行が数えられておる（対照）
    expect(
      screen.getByRole("group", { name: "今日のまとめ" }),
    ).toHaveTextContent("ミルク1")

    act(() => {
      goPrevDay()
    })

    // in-flight: 見出しは「昨日」、今日の行もその集計も出さぬ。まとめと体温カードは
    // 空配列を「0回」「未測定」と偽らず、取得中を示す（レビュー P3-5）
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("昨日")
    expect(screen.queryByText("TODAYROW")).not.toBeInTheDocument()
    expect(screen.getByRole("status", { name: "記録を読み込み中" })).toBeInTheDocument()
    const summary = screen.getByRole("group", { name: "7/17 のまとめ" })
    expect(summary).toHaveAttribute("aria-busy", "true")
    expect(summary).not.toHaveTextContent("0回")
    expect(screen.getByRole("status", { name: "体温を読み込み中" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /体温を記録/ })).toBeNull()

    await resolvePendingFetch({ data: [], error: null })
    expect(screen.queryByRole("status", { name: "記録を読み込み中" })).not.toBeInTheDocument()
    expect(screen.getByText("まだ記録がありません")).toBeInTheDocument()
    expect(screen.getByRole("group", { name: "7/17 のまとめ" })).toHaveTextContent("0回")
    expect(screen.getByRole("button", { name: "朝の体温を記録" })).toBeInTheDocument()
  })

  it("fetch in-flight 中に Realtime で先着した選択日の行が、fetch 解決後も残る", async () => {
    render(<BabyDashboard {...defaultProps({ initialLogs: [] })} />)

    // 昨日へ移動 → fetch 発火（in-flight、まだ解決しない）
    act(() => {
      goPrevDay()
    })

    // in-flight の間に選択日（昨日）の Realtime INSERT が先着 → logs に前置きされる
    // （取得中は骨組みを出しておるゆえ、この時点ではまだ画面には出ぬ。P2-10）
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
    expect(screen.getByRole("status", { name: "記録を読み込み中" })).toBeInTheDocument()

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

describe("BabyDashboard / 日付ナビの育児日記 refetch（W-1: fail-to-empty）", () => {
  it("日記 fetch が error のとき前の日の日記を残さない（誤日付上書き経路の遮断）", async () => {
    render(
      <BabyDashboard
        {...defaultProps({
          initialDiary: {
            id: "d1",
            diary_date: TODAY,
            content: "今日の日記本文",
            updated_at: "2026-07-18T00:00:00+09:00",
          },
        })}
      />,
    )
    expect(screen.getByText("今日の日記本文")).toBeInTheDocument()

    goPrevDay()
    // logs / diary の2クエリを同一 error で解決する。
    // logs 側の toast は既存テストで検証済み。本テストの本命は日記の挙動。
    await resolvePendingFetch({
      data: null,
      error: { message: "boom", code: "500" },
    })

    // 日記は error 時 null へ倒す（logs の stale 保持と違い、本文の残留は
    // 「前日の本文を別日として上書き保存」する事故経路になるため）。
    expect(screen.queryByText("今日の日記本文")).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /日記を書く/ }),
    ).toBeInTheDocument()
  })

  it("日付を切り替えた直後の取得中は前の日の本文を見せず、編集も開けぬ（取得後に空状態へ）", async () => {
    // 旧実装は取得が済むまで前の日の diary を新しい見出しの下に描いており、その間に編集を
    // 開いて 2 回保存すると前の日の本文が新しい日の日記として入った（レビュー P2-4）
    render(
      <BabyDashboard
        {...defaultProps({
          initialDiary: {
            id: "d1",
            diary_date: TODAY,
            content: "今日の日記本文",
            updated_at: "2026-07-18T00:00:00+09:00",
          },
        })}
      />,
    )
    expect(screen.getByText("今日の日記本文")).toBeInTheDocument()

    act(() => {
      goPrevDay()
    })

    // in-flight: 本文は出さず、書く/編集の導線も出さぬ
    expect(screen.queryByText("今日の日記本文")).not.toBeInTheDocument()
    expect(screen.getByRole("status", { name: "日記を読み込み中" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /日記を書く|日記を編集/ })).toBeNull()

    await resolvePendingFetch({ data: null, error: null })
    expect(screen.queryByRole("status", { name: "日記を読み込み中" })).toBeNull()
    expect(screen.getByRole("button", { name: /日記を書く/ })).toBeInTheDocument()
    expect(screen.queryByText("今日の日記本文")).not.toBeInTheDocument()
  })
})

describe("BabyDashboard / 日付をまたぐ間の「直前の記録」の取り消し", () => {
  const VERSION = "2026-07-18T03:00:00.123456+00:00"
  const INLINE_UNDO = /^直前の記録（\d\d:\d\d）を取り消す$/

  it("過去日へ移ると帯は消え（今の記録の口は過去日に出さぬ）、今日へ戻っても古い帯は戻らぬ。残ったトーストの取り消しは 1 回だけ届いて行を外す", async () => {
    const mockedToast = vi.mocked(toast)
    mockedToast.success.mockReset()
    // 実物の sonner と同じく、出したトーストは自動で閉じる（帯へ引き継ぐ）
    mockedToast.success.mockImplementation(((
      _m: unknown,
      opts?: { onAutoClose?: () => void },
    ) => {
      setTimeout(() => act(() => opts?.onAutoClose?.()), 0)
      return 1
    }) as never)
    vi.mocked(recordDiaper).mockReset()
    vi.mocked(recordDiaper).mockResolvedValue({ error: null, id: "pee-nav", updatedAt: VERSION })
    vi.mocked(deleteLog).mockReset()
    vi.mocked(deleteLog).mockResolvedValue({ error: null })

    render(<BabyDashboard {...defaultProps()} />)
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await screen.findByRole("button", { name: INLINE_UNDO })
    const toastUndo = (mockedToast.success.mock.calls.at(-1)?.[1] as {
      action?: { onClick: () => void }
    }).action

    // 過去日へ: クイック記録ごと帯が消える
    goPrevDay()
    expect(screen.queryByRole("button", { name: INLINE_UNDO })).toBeNull()
    expect(screen.queryByRole("button", { name: "おしっこ" })).toBeNull()
    await resolvePendingFetch({ data: [], error: null })

    // 今日へ戻る: 記録の行は在るが、帯は作り直された部品には残らぬ
    fireEvent.click(screen.getByRole("button", { name: "今日に戻る" }))
    await resolvePendingFetch({
      data: [makeLog({ id: "pee-nav", log_type: "diaper", logged_at: "2026-07-18T11:30:00+09:00", diaper_type: "pee", updated_at: VERSION })],
      error: null,
    })
    expect(screen.getByRole("group", { name: "今日のまとめ" })).toHaveTextContent("おしっこ1")
    expect(screen.queryByRole("button", { name: INLINE_UNDO })).toBeNull()

    // 移動の前に出ておったトーストの取り消しは、作成時の版で 1 回だけ届き、行を外す
    await act(async () => {
      toastUndo?.onClick()
      await Promise.resolve()
    })
    expect(vi.mocked(deleteLog)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(deleteLog)).toHaveBeenCalledWith("pee-nav", VERSION)
    await vi.waitFor(() =>
      expect(screen.getByRole("group", { name: "今日のまとめ" })).toHaveTextContent("おしっこ0"),
    )
    mockedToast.success.mockReset()
  })
})
