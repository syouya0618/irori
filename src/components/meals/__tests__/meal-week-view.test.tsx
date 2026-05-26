/**
 * MealWeekView の Realtime → refetch 反映パスに対する統合テスト。
 *
 * - PR #36 (BabyDashboard) / PR #40 (ShoppingList, StockList) と同じ idiom で
 *   vi.hoisted + vi.mock("@/lib/supabase/client", ...) を使う
 * - 違いは「Realtime callback 内で supabase.from(...).select(...).eq().gte().lte().order()
 *   を chainable に呼ぶ refetch スタイル」である点。
 *   そのため from は throw mock ではなく chainable query builder mock を返す。
 * - 最終 .order() は thenable: Promise.resolve({ data: mockState.currentMeals, error: null })
 *   を返し、テスト本体から `setMockMeals(rows)` で「次に refetch されたら返るデータ」を制御する。
 *
 * meal-week-view.tsx (line 216-238) の Realtime 流路:
 * - INSERT/UPDATE/DELETE のいずれでも payload を見ずに weekStartRef.current で
 *   fetchMeals を再走させ、SELECT 結果で setMeals を上書きする refetch スタイル
 * - 週切替時は ref が更新されるため、後続の Realtime event は新 weekStart で再 fetch
 *
 * 検証ケース:
 * 1. INSERT payload → fetchMeals 走行 → 新 meal が DOM に出現
 * 2. UPDATE payload → fetchMeals 走行 → 更新後 title が反映
 * 3. DELETE payload → fetchMeals 走行 → 対象 meal が消え EmptyMealSlot 表示
 * 4. 週切替（次の週）後の Realtime event は新しい weekStart で fetch される
 *    （gteMock の last call が新 weekStart の YYYY-MM-DD を含む）
 * 5. unmount で supabase.removeChannel が呼ばれる
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react"
import { act } from "react"

import type { MealReaction } from "@/lib/types/database"

// ---------------------------------------------------------------------------
// 型: テストで扱う MealWithDetails の row shape は meal-week-view.tsx の
//     SELECT 結果に合わせる
// ---------------------------------------------------------------------------

type MealRow = {
  id: string
  date: string
  meal_type: "breakfast" | "lunch" | "dinner" | "snack"
  title: string
  is_eating_out: boolean
  template_id: string | null
  meal_reactions: { user_id: string; reaction: MealReaction }[]
  meal_ingredients: { name: string; quantity: string | null; category: string }[]
}

type RealtimePayload = {
  eventType: "INSERT" | "UPDATE" | "DELETE"
  schema: string
  table: string
  commit_timestamp: string
  errors: string[]
  new: MealRow | Record<string, never>
  old: { id: string } | Record<string, never>
}

// ---------------------------------------------------------------------------
// Mock state (vi.hoisted で factory と test body で共有)
// ---------------------------------------------------------------------------

// vi.fn() のデフォルト generic は callable な型を返さないため、明示的に
// (...args) => unknown シグネチャを指定して invoke 可能にする
type ViFn = ReturnType<typeof import("vitest").vi.fn<(...args: unknown[]) => unknown>>

const mockState = vi.hoisted(() => ({
  listeners: [] as Array<(payload: unknown) => void>,
  removeChannelMock: undefined as unknown as ViFn,
  channelNameMock: undefined as unknown as ViFn,
  fromMock: undefined as unknown as ViFn,
  selectMock: undefined as unknown as ViFn,
  eqMock: undefined as unknown as ViFn,
  gteMock: undefined as unknown as ViFn,
  lteMock: undefined as unknown as ViFn,
  orderMock: undefined as unknown as ViFn,
  // 次に fetchMeals が呼ばれた時に返す data。テスト側で setMockMeals() で更新する。
  currentMeals: [] as Array<Record<string, unknown>>,
}))

vi.mock("@/lib/supabase/client", async () => {
  const { vi: viMod } = await import("vitest")
  mockState.removeChannelMock = viMod.fn().mockResolvedValue("ok")
  mockState.channelNameMock = viMod.fn()

  // chainable query builder:
  // .from("meals").select(...).eq("household_id", ...).gte("date", start).lte("date", end).order("date")
  // 最後の .order() が thenable (Promise) として { data, error } を resolve する。
  mockState.orderMock = viMod
    .fn()
    .mockImplementation(() =>
      Promise.resolve({ data: mockState.currentMeals, error: null }),
    )
  mockState.lteMock = viMod.fn(() => ({ order: mockState.orderMock }))
  mockState.gteMock = viMod.fn(() => ({ lte: mockState.lteMock }))
  mockState.eqMock = viMod.fn(() => ({ gte: mockState.gteMock }))
  mockState.selectMock = viMod.fn(() => ({ eq: mockState.eqMock }))
  mockState.fromMock = viMod.fn(() => ({ select: mockState.selectMock }))

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
        channel: (name: string) => {
          mockState.channelNameMock(name)
          return channel
        },
        removeChannel: mockState.removeChannelMock,
        from: mockState.fromMock,
      }
    },
  }
})

// next/navigation: useSearchParams は空、useRouter は no-op
// （templateIdFromUrl が null になるよう一貫した空 URLSearchParams 参照を返す）
vi.mock("next/navigation", async () => {
  const { vi: viMod } = await import("vitest")
  const emptyParams = new URLSearchParams()
  return {
    useSearchParams: viMod.fn(() => emptyParams),
    useRouter: viMod.fn(() => ({
      replace: viMod.fn(),
      push: viMod.fn(),
      back: viMod.fn(),
      forward: viMod.fn(),
      refresh: viMod.fn(),
      prefetch: viMod.fn(),
    })),
  }
})

// 子フォーム: server action / Sheet portal の副作用を避けるため null 化
vi.mock("../meal-form-sheet", () => ({
  MealFormSheet: () => null,
}))

// meals/actions: URL template 経路 (useEffect → loadTemplate) のみ stub。
// MealFormSheet は () => null で隔離済みなので createMeal/updateMeal/deleteMeal/
// upsertReaction 等は本テストの render tree から呼ばれない。
// 将来別 action が呼ばれるようになれば test が "is not a function" で即落ちて
// 明示的な追加判断を促す失敗モードを保持する（defensive failure mode）。
vi.mock("@/app/(main)/meals/actions", async () => {
  const { vi: viMod } = await import("vitest")
  return {
    loadTemplate: viMod.fn().mockResolvedValue({ data: null, error: null }),
  }
})

// ---------------------------------------------------------------------------
// Imports after vi.mock
// ---------------------------------------------------------------------------
import { MealWeekView } from "../meal-week-view"

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

// 月曜固定の週: 2026-04-13 (Mon) 〜 2026-04-19 (Sun)
const WEEK_START = "2026-04-13"
const NEXT_WEEK_START = "2026-04-20"
const NEXT_WEEK_END = "2026-04-26"

function makeMeal(
  overrides: Partial<MealRow> & Pick<MealRow, "id" | "date" | "meal_type" | "title">,
): MealRow {
  return {
    is_eating_out: false,
    template_id: null,
    meal_reactions: [],
    meal_ingredients: [],
    ...overrides,
  }
}

function makePayload(
  eventType: "INSERT" | "UPDATE",
  meal: MealRow,
): RealtimePayload
function makePayload(eventType: "DELETE", mealId: string): RealtimePayload
function makePayload(
  eventType: "INSERT" | "UPDATE" | "DELETE",
  mealOrId: MealRow | string,
): RealtimePayload {
  const base = {
    schema: "public",
    table: "meals",
    commit_timestamp: "2026-04-13T03:30:00Z",
    errors: [],
  }
  if (eventType === "DELETE") {
    return {
      ...base,
      eventType,
      new: {},
      old: { id: mealOrId as string },
    }
  }
  return {
    ...base,
    eventType,
    new: mealOrId as MealRow,
    old: {},
  }
}

function defaultProps(
  overrides: Partial<Parameters<typeof MealWeekView>[0]> = {},
): Parameters<typeof MealWeekView>[0] {
  return {
    initialMeals: [],
    householdId: "h1",
    userId: "u1",
    initialWeekStart: WEEK_START,
    ...overrides,
  }
}

function emit(payload: RealtimePayload) {
  for (const cb of mockState.listeners) cb(payload)
}

/**
 * 次に fetchMeals が呼ばれた時に SELECT 結果として返すデータをセットする。
 * Realtime emit より前に呼ぶ契約。
 */
function setMockMeals(rows: MealRow[]) {
  mockState.currentMeals = rows as unknown as Array<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  // cleanup() で前テストの unmount を発火させ removeChannel カウントが
  // テスト境界を跨がぬよう、その後で mock state をリセットする
  cleanup()
  mockState.listeners.length = 0
  mockState.currentMeals = []
  mockState.removeChannelMock.mockClear()
  mockState.channelNameMock.mockClear()
  mockState.fromMock.mockClear()
  mockState.selectMock.mockClear()
  mockState.eqMock.mockClear()
  mockState.gteMock.mockClear()
  mockState.lteMock.mockClear()
  mockState.orderMock.mockClear()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MealWeekView / Realtime → refetch 反映", () => {
  it("初期 render では fetchMeals は呼ばれず、initialMeals が seed として表示される", () => {
    const existing = makeMeal({
      id: "meal-seed",
      date: WEEK_START,
      meal_type: "dinner",
      title: "カレーライス",
    })

    render(<MealWeekView {...defaultProps({ initialMeals: [existing] })} />)

    // seed の title が表示される
    expect(screen.getByText("カレーライス")).toBeInTheDocument()
    // mount 時に refetch は走らない（初期 SSR 経路を尊重する契約）
    expect(mockState.fromMock).not.toHaveBeenCalled()
  })

  it("INSERT payload → fetchMeals が走行し新規 meal が DOM に出現する", async () => {
    render(<MealWeekView {...defaultProps()} />)

    // 初期は空: dinner スロットは EmptyMealSlot（"夕食" ラベル）
    expect(screen.queryByText("唐揚げ")).not.toBeInTheDocument()

    const inserted = makeMeal({
      id: "meal-new",
      date: WEEK_START,
      meal_type: "dinner",
      title: "唐揚げ",
    })

    // 次回 refetch で返す data を仕込んでから emit
    setMockMeals([inserted])

    await act(async () => {
      emit(makePayload("INSERT", inserted))
    })

    await waitFor(() => {
      expect(mockState.fromMock).toHaveBeenCalledWith("meals")
    })
    expect(await screen.findByText("唐揚げ")).toBeInTheDocument()
  })

  it("UPDATE payload → fetchMeals が再走行し更新後 title が反映される", async () => {
    const existing = makeMeal({
      id: "meal-1",
      date: WEEK_START,
      meal_type: "lunch",
      title: "うどん",
    })

    render(<MealWeekView {...defaultProps({ initialMeals: [existing] })} />)

    expect(screen.getByText("うどん")).toBeInTheDocument()

    const updated = { ...existing, title: "そば" }
    setMockMeals([updated])

    await act(async () => {
      emit(makePayload("UPDATE", updated))
    })

    expect(await screen.findByText("そば")).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByText("うどん")).not.toBeInTheDocument()
    })
  })

  it("DELETE payload → fetchMeals が再走行し対象 meal が消える", async () => {
    const existing = makeMeal({
      id: "meal-1",
      date: WEEK_START,
      meal_type: "breakfast",
      title: "トースト",
    })

    render(<MealWeekView {...defaultProps({ initialMeals: [existing] })} />)

    expect(screen.getByText("トースト")).toBeInTheDocument()

    // 削除後は空 → fetchMeals は空配列を返す
    setMockMeals([])

    await act(async () => {
      emit(makePayload("DELETE", existing.id))
    })

    await waitFor(() => {
      expect(screen.queryByText("トースト")).not.toBeInTheDocument()
    })
  })

  it("週切替後の Realtime event は新しい weekStart (weekStartRef) で fetch される", async () => {
    render(<MealWeekView {...defaultProps()} />)

    // 「次の週」ボタンクリック → fetchMeals(newStart) が即時走る
    const nextWeekBtn = screen.getByRole("button", { name: "次の週" })

    await act(async () => {
      fireEvent.click(nextWeekBtn)
    })

    // クリックで fetch が 1 度走り、gte は新週開始日で呼ばれる
    await waitFor(() => {
      expect(mockState.gteMock).toHaveBeenCalled()
    })
    expect(mockState.gteMock).toHaveBeenLastCalledWith("date", NEXT_WEEK_START)
    expect(mockState.lteMock).toHaveBeenLastCalledWith("date", NEXT_WEEK_END)

    const fromCallsAfterNav = mockState.fromMock.mock.calls.length

    // 続けて Realtime INSERT が来た時、weekStartRef.current は新週なので
    // fetchMeals は新週で呼ばれる
    const insertedInNextWeek = makeMeal({
      id: "meal-next",
      date: NEXT_WEEK_START,
      meal_type: "dinner",
      title: "肉じゃが",
    })
    setMockMeals([insertedInNextWeek])

    await act(async () => {
      emit(makePayload("INSERT", insertedInNextWeek))
    })

    // 2 回目の fetch が走った
    await waitFor(() => {
      expect(mockState.fromMock.mock.calls.length).toBeGreaterThan(
        fromCallsAfterNav,
      )
    })

    // emit 起因の fetch も新 weekStart で動いたことを last call で検証
    expect(mockState.gteMock).toHaveBeenLastCalledWith("date", NEXT_WEEK_START)
    expect(mockState.lteMock).toHaveBeenLastCalledWith("date", NEXT_WEEK_END)

    // 新週の DOM にも追加 meal が反映される
    expect(await screen.findByText("肉じゃが")).toBeInTheDocument()
  })

  it("unmount で supabase.removeChannel が呼ばれる", () => {
    const { unmount } = render(<MealWeekView {...defaultProps()} />)

    // mount 時に Realtime channel 名が "meals-${householdId}" 形式で
    // 確実に houshold スコープで購読されることを pin する
    expect(mockState.channelNameMock).toHaveBeenCalledWith("meals-h1")
    expect(mockState.removeChannelMock).not.toHaveBeenCalled()

    unmount()

    expect(mockState.removeChannelMock).toHaveBeenCalledTimes(1)
  })
})
