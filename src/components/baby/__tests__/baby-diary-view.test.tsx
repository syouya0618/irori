import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react"
import type { BabyLogData } from "@/lib/types/baby"

// ---------------------------------------------------------------------------
// Mocks（vi.hoisted で factory と test body で共有）
// ---------------------------------------------------------------------------

type FetchResult = { data: BabyLogData[] | null; error: unknown }

const mockState = vi.hoisted(() => ({
  results: [] as FetchResult[],
  rangeCalls: [] as Array<[number, number]>,
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// BabyLogFormSheet は自身のテストで網羅済みのため stub 化し、ここでは
// 「日記を書く」導線の開閉と onLogRecorded の prepend 配線だけを検証する。
const sheetState = vi.hoisted(() => ({
  props: null as null | {
    open: boolean
    createLogType?: string | null
    onLogRecorded?: (log: BabyLogData) => void
  },
}))

vi.mock("../baby-log-form-sheet", () => ({
  BabyLogFormSheet: (props: {
    open: boolean
    createLogType?: string | null
    onLogRecorded?: (log: BabyLogData) => void
  }) => {
    sheetState.props = props
    return props.open ? <div data-testid="compose-sheet" /> : null
  },
}))

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        order: () => q,
        range: (from: number, to: number) => {
          mockState.rangeCalls.push([from, to])
          return q
        },
        abortSignal: () => q,
        then: (
          onF: (value: FetchResult) => unknown,
          onR?: (reason: unknown) => unknown,
        ) => {
          const result = mockState.results.shift() ?? { data: [], error: null }
          return Promise.resolve(result).then(onF, onR)
        },
      }
      return q
    },
  }),
}))

import { BabyDiaryView } from "../baby-diary-view"
import { toast } from "sonner"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function memoLog(
  overrides: Partial<BabyLogData> & Pick<BabyLogData, "id" | "logged_at">,
): BabyLogData {
  return {
    log_type: "memo",
    logged_by: "user-1",
    feeding_type: null,
    amount_ml: null,
    diaper_type: null,
    ended_at: null,
    temperature: null,
    weight_g: null,
    height_cm: null,
    duration_min: null,
    duration_sec: null,
    memo: "メモ本文",
    created_at: "2026-07-18T00:00:00+09:00",
    ...overrides,
  }
}

beforeEach(() => {
  mockState.results.length = 0
  mockState.rangeCalls.length = 0
  sheetState.props = null
  vi.mocked(toast.error).mockClear()
})
afterEach(cleanup)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BabyDiaryView の表示（グルーピング・全文・改行）", () => {
  it("メモを JST 日付でグルーピングし日付見出しを出す", () => {
    render(
      <BabyDiaryView
        householdId="h1"
        userId="user-1"
        initialLogs={[
          memoLog({ id: "a", logged_at: "2026-07-22T15:00:00+09:00", memo: "きょうのメモ" }),
          memoLog({ id: "b", logged_at: "2026-07-21T09:00:00+09:00", memo: "きのうのメモ" }),
        ]}
      />,
    )
    expect(screen.getByText(/7月22日/)).toBeInTheDocument()
    expect(screen.getByText(/7月21日/)).toBeInTheDocument()
    expect(screen.getByText("きょうのメモ")).toBeInTheDocument()
    expect(screen.getByText("きのうのメモ")).toBeInTheDocument()
  })

  it("メモ全文を whitespace-pre-wrap で表示し改行を保持する", () => {
    render(
      <BabyDiaryView
        householdId="h1"
        userId="user-1"
        initialLogs={[
          memoLog({
            id: "a",
            logged_at: "2026-07-22T10:00:00+09:00",
            memo: "1行目\n2行目\n3行目",
          }),
        ]}
      />,
    )
    const el = screen.getByText(/1行目/)
    expect(el).toHaveClass("whitespace-pre-wrap")
    // textContent は正規化されないため生の改行が保持されている
    expect(el.textContent).toContain("\n")
    expect(el.textContent).toBe("1行目\n2行目\n3行目")
  })

  it("メモが空なら空状態を出す", () => {
    render(<BabyDiaryView householdId="h1"
        userId="user-1" initialLogs={[]} />)
    expect(screen.getByText("まだ日記がありません")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "もっと見る" }),
    ).not.toBeInTheDocument()
  })
})

describe("BabyDiaryView のページネーション", () => {
  it("「もっと見る」で受領件数をオフセットに次ページを追記する", async () => {
    render(
      <BabyDiaryView
        householdId="h1"
        userId="user-1"
        initialLogs={[
          memoLog({ id: "a", logged_at: "2026-07-22T15:00:00+09:00", memo: "1件目" }),
          memoLog({ id: "b", logged_at: "2026-07-22T09:00:00+09:00", memo: "2件目" }),
        ]}
      />,
    )
    // 次ページに古い日付の 1 件
    mockState.results.push({
      data: [
        memoLog({ id: "c", logged_at: "2026-07-20T12:00:00+09:00", memo: "3件目" }),
      ],
      error: null,
    })

    fireEvent.click(screen.getByRole("button", { name: "もっと見る" }))

    // 追記された行が表示される
    expect(await screen.findByText("3件目")).toBeInTheDocument()
    // オフセット = 受領済み件数（2）。to = 2 + 50 - 1 = 51
    expect(mockState.rangeCalls[0]).toEqual([2, 51])
    // 既存行は保持
    expect(screen.getByText("1件目")).toBeInTheDocument()
    expect(screen.getByText("2件目")).toBeInTheDocument()
  })

  it("2ページ目のオフセットは1ページ目受領後の総件数になる（短いページでも飛ばさない）", async () => {
    render(
      <BabyDiaryView
        householdId="h1"
        userId="user-1"
        initialLogs={[
          memoLog({ id: "a", logged_at: "2026-07-22T15:00:00+09:00", memo: "初回" }),
        ]}
      />,
    )
    // 1ページ目は 50 未満（短いページ）でも終端扱いしない
    mockState.results.push({
      data: [
        memoLog({ id: "b", logged_at: "2026-07-21T12:00:00+09:00", memo: "2回目" }),
      ],
      error: null,
    })
    fireEvent.click(screen.getByRole("button", { name: "もっと見る" }))
    expect(await screen.findByText("2回目")).toBeInTheDocument()
    expect(mockState.rangeCalls[0]).toEqual([1, 50])

    // 2ページ目: 受領済み総件数 = 2 がオフセット
    mockState.results.push({
      data: [
        memoLog({ id: "c", logged_at: "2026-07-20T12:00:00+09:00", memo: "3回目" }),
      ],
      error: null,
    })
    fireEvent.click(screen.getByRole("button", { name: "もっと見る" }))
    expect(await screen.findByText("3回目")).toBeInTheDocument()
    expect(mockState.rangeCalls[1]).toEqual([2, 51])
  })

  it("返却0件で終端 → 「もっと見る」が消える", async () => {
    render(
      <BabyDiaryView
        householdId="h1"
        userId="user-1"
        initialLogs={[
          memoLog({ id: "a", logged_at: "2026-07-22T15:00:00+09:00", memo: "唯一" }),
        ]}
      />,
    )
    mockState.results.push({ data: [], error: null })
    fireEvent.click(screen.getByRole("button", { name: "もっと見る" }))

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "もっと見る" }),
      ).not.toBeInTheDocument(),
    )
    // 既存行は残る
    expect(screen.getByText("唯一")).toBeInTheDocument()
  })

  it("fetch が error を返すと toast.error を出し、ボタンは残る", async () => {
    render(
      <BabyDiaryView
        householdId="h1"
        userId="user-1"
        initialLogs={[
          memoLog({ id: "a", logged_at: "2026-07-22T15:00:00+09:00", memo: "唯一" }),
        ]}
      />,
    )
    mockState.results.push({
      data: null,
      error: { message: "boom", code: "PGRST500", details: null, hint: null },
    })
    fireEvent.click(screen.getByRole("button", { name: "もっと見る" }))

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith("読み込みに失敗しました"),
    )
    // 終端ではないのでボタンは残る
    expect(
      screen.getByRole("button", { name: "もっと見る" }),
    ).toBeInTheDocument()
  })
})

describe("BabyDiaryView の日記を書く（作成導線）", () => {
  it("空状態でも「日記を書く」ボタンがあり、押すと memo 作成モードのシートが開く", () => {
    render(
      <BabyDiaryView householdId="h1" userId="user-1" initialLogs={[]} />,
    )
    expect(screen.queryByTestId("compose-sheet")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /日記を書く/ }))
    expect(screen.getByTestId("compose-sheet")).toBeInTheDocument()
    expect(sheetState.props?.createLogType).toBe("memo")
  })

  it("作成成功（onLogRecorded）で新しい日記が先頭グループに即時表示され、同一 id の重複 prepend はしない", () => {
    render(
      <BabyDiaryView
        householdId="h1"
        userId="user-1"
        initialLogs={[
          memoLog({
            id: "old",
            logged_at: "2026-07-20T12:00:00+09:00",
            memo: "以前の日記",
          }),
        ]}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /日記を書く/ }))
    const newLog = memoLog({
      id: "new",
      logged_at: "2026-07-22T20:00:00+09:00",
      memo: "今日の日記",
    })
    act(() => {
      sheetState.props?.onLogRecorded?.(newLog)
    })
    // 新規日記は最新（降順の先頭）グループとして表示される
    const headings = screen.getAllByRole("heading", { level: 2 })
    expect(headings[0].textContent).toContain("7月22日")
    expect(screen.getByText("今日の日記")).toBeInTheDocument()
    expect(screen.getByText("以前の日記")).toBeInTheDocument()
    // Realtime echo 等で同じ行が再度届いても重複表示しない（id dedupe）
    act(() => {
      sheetState.props?.onLogRecorded?.(newLog)
    })
    expect(screen.getAllByText("今日の日記")).toHaveLength(1)
  })
})
