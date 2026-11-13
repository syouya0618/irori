/**
 * /chores/cleaning の Server Component: 読んだものを世帯で絞り、読めなかったものを
 * 「項目なし」「未記録」と偽らぬこと。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen, within } from "@testing-library/react"

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }))
vi.mock("@/lib/supabase/auth-context", () => ({ getAuthContext }))
vi.mock("@/app/(main)/chores/cleaning/actions", () => ({ saveCleaning: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), usePathname: () => "/chores/cleaning" }))

import CleaningPage from "../page"

const USER = "c1000000-0000-4000-8000-000000000001"
const HOUSE = "c1000000-0000-4000-8000-0000000000a1"
const DRAIN = "c2000000-0000-4000-8000-000000000001"
const V = "2026-11-01T00:00:00.123456+00:00"

type Reply = { data: unknown; error: { code?: string; message: string } | null }

function routineRow(over: Record<string, unknown> = {}) {
  return {
    id: DRAIN,
    name: "浴室の排水口",
    location: "浴室",
    cadence_unit: "week",
    cadence_interval: 1,
    schedule_mode: "fixed",
    anchor_date: "2026-11-07",
    postponed_occurrence: null,
    postponed_until: null,
    paused_at: null,
    resume_floor: null,
    archived: false,
    updated_at: V,
    created_at: V,
    ...over,
  }
}

function signIn(replies: { routines: Reply; marks: Reply; logs: Reply }) {
  const queries: { table: string; filters: Record<string, unknown>; limit: number | null }[] = []
  const supabase = {
    from(table: string) {
      const query = { table, filters: {} as Record<string, unknown>, limit: null as number | null }
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          query.filters[column] = value
          return builder
        },
        is: (column: string, value: unknown) => {
          query.filters[column] = value
          return builder
        },
        order: () => builder,
        limit: (count: number) => {
          query.limit = count
          queries.push(query)
          return Promise.resolve(table === "cleaning_routines" ? replies.routines : replies.logs)
        },
      }
      return builder
    },
    rpc: async () => replies.marks,
  }
  getAuthContext.mockResolvedValue({ error: null, reason: null, context: { supabase, userId: USER, householdId: HOUSE } })
  return queries
}

const ok = (data: unknown): Reply => ({ data, error: null })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-11T03:00:00.000Z"))
  getAuthContext.mockReset()
  localStorage.clear()
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("/chores/cleaning", () => {
  it("定義と履歴を世帯で絞って読み、h1 と「今日・今週やること」を描く", async () => {
    const queries = signIn({
      routines: ok([routineRow()]),
      marks: ok([{ routine_id: DRAIN, last_done_on: "2026-11-01", max_occurrence: "2026-10-31", max_skip_occurrence: null }]),
      logs: ok([]),
    })
    render(await CleaningPage())
    expect(screen.getByRole("heading", { level: 1, name: "掃除" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "家事" })).toHaveAttribute("href", "/chores")
    const due = screen.getByRole("region", { name: "今日・今週やること" })
    expect(within(due).getByText("浴室の排水口")).toBeInTheDocument()
    // 前回実施日は履歴の要約から（定義の基準日からではない）
    expect(within(due).getByText("11月1日（日）（10日前）")).toBeInTheDocument()
    expect(queries.map((query) => [query.table, query.filters.household_id])).toEqual([
      ["cleaning_routines", HOUSE],
      ["cleaning_logs", HOUSE],
    ])
    // 取り消した履歴は読まぬ
    expect(queries[1].filters).toMatchObject({ voided_at: null })
  })

  it("要約に行が無い項目は「未記録」", async () => {
    signIn({ routines: ok([routineRow()]), marks: ok([]), logs: ok([]) })
    render(await CleaningPage())
    expect(screen.getByText("未記録")).toBeInTheDocument()
  })

  // R34: page 自身は throw せず、失敗を KeepLastGood へ渡す。初回の表示（直前に読めた内容が無い）では
  // KeepLastGood が同じ文言で throw して error boundary へ渡す = 描画が失敗する
  it("定義を読めなんだ時は throw する（「項目がまだありません」と描かぬ）", async () => {
    signIn({ routines: { data: null, error: { code: "57014", message: "timeout" } }, marks: ok([]), logs: ok([]) })
    const tree = await CleaningPage()
    expect(() => render(tree)).toThrow("掃除の項目を取得できませんでした")
    expect(screen.queryByText(/項目がまだありません/)).not.toBeInTheDocument()
  })

  it("履歴の要約を読めなんだ・壊れておった時も throw する（実施済みを「未記録」と描かぬ）", async () => {
    signIn({ routines: ok([routineRow()]), marks: { data: null, error: { message: "fetch failed" } }, logs: ok([]) })
    const failed = await CleaningPage()
    expect(() => render(failed)).toThrow("履歴の要約を取得できませんでした")
    signIn({ routines: ok([routineRow()]), marks: ok([{ routine_id: DRAIN, last_done_on: "broken" }]), logs: ok([]) })
    const broken = await CleaningPage()
    expect(() => render(broken)).toThrow("履歴の要約を読み取れませんでした")
    expect(screen.queryByText("未記録")).not.toBeInTheDocument()
  })

  it("表示済みの画面の取り直しが失敗しても画面を倒さず、直前の内容を保って理由を出す（R34）", async () => {
    signIn({
      routines: ok([routineRow()]),
      marks: ok([{ routine_id: DRAIN, last_done_on: "2026-11-01", max_occurrence: "2026-10-31", max_skip_occurrence: null }]),
      logs: ok([]),
    })
    const view = render(await CleaningPage())
    const due = screen.getByRole("region", { name: "今日・今週やること" })
    // 定期の再取得（router.refresh）で page が再実行され、読み取りが一時的に失敗した
    signIn({ routines: { data: null, error: { code: "57014", message: "timeout" } }, marks: ok([]), logs: ok([]) })
    view.rerender(await CleaningPage())
    // 同じ DOM のまま（Client の画面は unmount されておらぬ）
    expect(screen.getByRole("region", { name: "今日・今週やること" })).toBe(due)
    expect(within(due).getByText("浴室の排水口")).toBeInTheDocument()
    expect(screen.getByTestId("stale-content-notice")).toHaveTextContent(
      "最新の内容に更新できませんでした（掃除の項目を取得できませんでした）",
    )
    // 次に読めたら知らせを消す
    signIn({ routines: ok([routineRow({ name: "浴室の排水口と鏡" })]), marks: ok([]), logs: ok([]) })
    view.rerender(await CleaningPage())
    expect(screen.queryByTestId("stale-content-notice")).not.toBeInTheDocument()
    expect(screen.getByText("浴室の排水口と鏡")).toBeInTheDocument()
  })

  it("対照: 履歴の一覧だけ読めなんだ時は画面を倒さず、期限は要約から出す", async () => {
    signIn({
      routines: ok([routineRow()]),
      marks: ok([{ routine_id: DRAIN, last_done_on: "2026-11-01", max_occurrence: "2026-10-31", max_skip_occurrence: null }]),
      logs: { data: null, error: { message: "fetch failed" } },
    })
    render(await CleaningPage())
    expect(screen.getByText("11月1日（日）（10日前）")).toBeInTheDocument()
    expect(screen.getByText("期限を4日過ぎています")).toBeInTheDocument()
  })

  it("この版が知らぬ周期の行は、その行だけを読めぬ項目として数える（画面は倒さぬ）", async () => {
    signIn({
      routines: ok([routineRow(), routineRow({ id: "c2000000-0000-4000-8000-000000000009", cadence_unit: "season" })]),
      marks: ok([]),
      logs: ok([]),
    })
    render(await CleaningPage())
    expect(screen.getByText("浴室の排水口")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent("表示できない項目が 1 件あります")
  })

  it("認証の文脈が無ければ何も描かぬ（遷移は (main)/layout が受ける）", async () => {
    getAuthContext.mockResolvedValue({ error: "認証されていません", reason: "unauthenticated", context: null })
    expect(await CleaningPage()).toBeNull()
  })
})
