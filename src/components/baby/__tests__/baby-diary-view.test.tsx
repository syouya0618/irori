import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react"
import { todayJstString } from "@/lib/utils/date-jst"
import type { BabyDiaryData } from "@/lib/types/baby"

// ---------------------------------------------------------------------------
// Mocks（vi.hoisted で factory と test body で共有）
// ---------------------------------------------------------------------------

type FetchResult = { data: BabyDiaryData[] | null; error: unknown }

const mockState = vi.hoisted(() => ({
  results: [] as FetchResult[],
  rangeCalls: [] as Array<[number, number]>,
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// BabyDiaryEditSheet は自身のテストで網羅する前提の stub。ここでは
// 「開閉・対象日・初期本文の受け渡し」と「onSaved の一覧反映」だけを検証する。
const sheetState = vi.hoisted(() => ({
  props: null as null | {
    open: boolean
    diaryDate: string
    initialContent: string
    onSaved: (diary: BabyDiaryData | null) => void
  },
}))

vi.mock("../baby-diary-edit-sheet", () => ({
  BabyDiaryEditSheet: (props: {
    open: boolean
    diaryDate: string
    initialContent: string
    onSaved: (diary: BabyDiaryData | null) => void
  }) => {
    sheetState.props = props
    return props.open ? <div data-testid="diary-edit-sheet" /> : null
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

function diaryRow(
  overrides: Partial<BabyDiaryData> & Pick<BabyDiaryData, "id" | "diary_date">,
): BabyDiaryData {
  return {
    content: "日記本文",
    updated_at: "2026-07-22T12:00:00+09:00",
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

describe("BabyDiaryView の表示（1日1本・日付降順・全文）", () => {
  it("日付見出しと全文（改行保持）を降順で表示する", () => {
    render(
      <BabyDiaryView
        householdId="h1"
        initialDiaries={[
          diaryRow({
            id: "a",
            diary_date: "2026-07-22",
            content: "1行目\n2行目",
          }),
          diaryRow({ id: "b", diary_date: "2026-07-21", content: "きのうの日記" }),
        ]}
      />,
    )
    expect(screen.getByText(/7月22日/)).toBeInTheDocument()
    expect(screen.getByText(/7月21日/)).toBeInTheDocument()
    const body = screen.getByText(/1行目/)
    expect(body).toHaveClass("whitespace-pre-wrap")
    expect(body.textContent).toBe("1行目\n2行目")
    // 降順: 22日の見出しが 21日より先に出る
    const headings = screen.getAllByRole("heading", { level: 2 })
    expect(headings[0].textContent).toContain("7月22日")
  })

  it("日記が空なら空状態と「今日の日記を書く」を出す", () => {
    render(<BabyDiaryView householdId="h1" initialDiaries={[]} />)
    expect(screen.getByText("まだ日記がありません")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /今日の日記を書く/ }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "もっと見る" }),
    ).not.toBeInTheDocument()
  })
})

describe("BabyDiaryView の編集導線", () => {
  it("エントリのタップでその日の編集シートが本文 seed 付きで開く", () => {
    render(
      <BabyDiaryView
        householdId="h1"
        initialDiaries={[
          diaryRow({ id: "a", diary_date: "2026-07-20", content: "過去の日記" }),
        ]}
      />,
    )
    fireEvent.click(
      screen.getByRole("button", { name: "2026-07-20 の日記を編集" }),
    )
    expect(screen.getByTestId("diary-edit-sheet")).toBeInTheDocument()
    expect(sheetState.props?.diaryDate).toBe("2026-07-20")
    expect(sheetState.props?.initialContent).toBe("過去の日記")
  })

  it("「今日の日記を書く」は当日を対象に開き、既存の今日分があれば本文を seed する", () => {
    const today = todayJstString()
    render(
      <BabyDiaryView
        householdId="h1"
        initialDiaries={[
          diaryRow({ id: "t", diary_date: today, content: "今日のぶん" }),
        ]}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /今日の日記を書く/ }))
    expect(sheetState.props?.diaryDate).toBe(today)
    expect(sheetState.props?.initialContent).toBe("今日のぶん")
  })

  it("onSaved の保存で該当日を置換して降順を保ち、null で一覧から除く", () => {
    render(
      <BabyDiaryView
        householdId="h1"
        initialDiaries={[
          diaryRow({ id: "a", diary_date: "2026-07-22", content: "before" }),
          diaryRow({ id: "b", diary_date: "2026-07-20", content: "古い日記" }),
        ]}
      />,
    )
    // 22日を開いて置換保存
    fireEvent.click(
      screen.getByRole("button", { name: "2026-07-22 の日記を編集" }),
    )
    act(() => {
      sheetState.props?.onSaved(
        diaryRow({ id: "a", diary_date: "2026-07-22", content: "after" }),
      )
    })
    expect(screen.getByText("after")).toBeInTheDocument()
    expect(screen.queryByText("before")).not.toBeInTheDocument()

    // 20日を開いて空保存（削除）
    fireEvent.click(
      screen.getByRole("button", { name: "2026-07-20 の日記を編集" }),
    )
    act(() => {
      sheetState.props?.onSaved(null)
    })
    expect(screen.queryByText("古い日記")).not.toBeInTheDocument()
    expect(screen.getByText("after")).toBeInTheDocument()
  })
})

describe("BabyDiaryView のページネーション", () => {
  it("「もっと見る」で受領件数をオフセットに次ページを追記する", async () => {
    render(
      <BabyDiaryView
        householdId="h1"
        initialDiaries={[
          diaryRow({ id: "a", diary_date: "2026-07-22", content: "1件目" }),
          diaryRow({ id: "b", diary_date: "2026-07-21", content: "2件目" }),
        ]}
      />,
    )
    mockState.results.push({
      data: [diaryRow({ id: "c", diary_date: "2026-07-20", content: "3件目" })],
      error: null,
    })

    fireEvent.click(screen.getByRole("button", { name: "もっと見る" }))

    expect(await screen.findByText("3件目")).toBeInTheDocument()
    // オフセット = 受領済み件数（2）。to = 2 + 50 - 1 = 51
    expect(mockState.rangeCalls[0]).toEqual([2, 51])
    expect(screen.getByText("1件目")).toBeInTheDocument()
    expect(screen.getByText("2件目")).toBeInTheDocument()
  })

  it("返却0件で終端 → 「もっと見る」が消える", async () => {
    render(
      <BabyDiaryView
        householdId="h1"
        initialDiaries={[
          diaryRow({ id: "a", diary_date: "2026-07-22", content: "唯一" }),
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
    expect(screen.getByText("唯一")).toBeInTheDocument()
  })

  it("fetch が error を返すと toast.error を出し、ボタンは残る", async () => {
    render(
      <BabyDiaryView
        householdId="h1"
        initialDiaries={[
          diaryRow({ id: "a", diary_date: "2026-07-22", content: "既存" }),
        ]}
      />,
    )
    mockState.results.push({
      data: null,
      error: { message: "boom", code: "500" },
    })
    fireEvent.click(screen.getByRole("button", { name: "もっと見る" }))

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "読み込みに失敗しました",
      ),
    )
    expect(
      screen.getByRole("button", { name: "もっと見る" }),
    ).toBeInTheDocument()
    expect(screen.getByText("既存")).toBeInTheDocument()
  })
})
