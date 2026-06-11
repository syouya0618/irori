/**
 * MealFormSheet のプリフィル動作に対する統合テスト (issue #22 回帰固定)。
 *
 * meal-week-view.test.tsx と同じ idiom (vi.hoisted + buildRefetchSupabaseMock)
 * じゃが、意図的な差分として MealFormSheet を null モックせず実レンダーする。
 * 「スロットタップ → シートが選択スロットの値で開く」という親 (MealWeekView)
 * の key リマウント配線まで含めて固定するため、render 対象は MealWeekView。
 *
 * 検証ケース:
 * 1. 空スロットタップでタップした日付がプリフィルされる
 * 2. 保存時に createMeal がタップしたスロットの date/mealType で呼ばれる
 *    (date="" のまま insert に行き「献立の作成に失敗しました」になる退行の直接固定)
 * 3. 2 回目の open で前回タップ時の値が残らない (off-by-one stale 再発防止)
 * 4. 既存 meal タップ (編集) で initialData がプリフィルされる
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  render,
  screen,
  cleanup,
  waitFor,
  within,
  fireEvent,
} from "@testing-library/react"

import type { MealReaction } from "@/lib/types/database"
import type { ViFn } from "@/test-utils/supabase-realtime-mock"
import { resetRefetchMockState } from "@/test-utils/supabase-realtime-mock"

// ---------------------------------------------------------------------------
// 型: テストで扱う MealWithDetails の row shape は meal-week-view.tsx の
//     SELECT 結果に合わせる (meal-week-view.test.tsx と同一)
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

// ---------------------------------------------------------------------------
// Mock state (vi.hoisted で factory と test body で共有)
// ---------------------------------------------------------------------------

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
  currentResolveData: [] as MealRow[],
}))

vi.mock("@/lib/supabase/client", async () => {
  const { vi: viMod } = await import("vitest")
  const { buildRefetchSupabaseMock } = await import(
    "@/test-utils/supabase-realtime-mock"
  )
  return buildRefetchSupabaseMock<MealRow>(viMod, mockState)
})

// next/navigation: useSearchParams は空、useRouter は no-op
// （templateIdFromUrl が null になりテンプレート URL 経路は不活性化）
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

// meals/actions: MealFormSheet を実レンダーするため、render tree が import する
// action を全て stub する。
// - MealWeekView: loadTemplate
// - MealFormSheet: createMeal / updateMeal / deleteMeal / saveAsTemplate
// - TemplateSelector: getTemplates / loadTemplate / deleteTemplate
// - MealReactions: upsertReaction
vi.mock("@/app/(main)/meals/actions", async () => {
  const { vi: viMod } = await import("vitest")
  return {
    loadTemplate: viMod.fn().mockResolvedValue({ data: null, error: null }),
    getTemplates: viMod.fn().mockResolvedValue({ data: [], error: null }),
    deleteTemplate: viMod.fn().mockResolvedValue({ error: null }),
    createMeal: viMod.fn().mockResolvedValue({ error: null, mealId: "m-new" }),
    updateMeal: viMod.fn().mockResolvedValue({ error: null }),
    deleteMeal: viMod.fn().mockResolvedValue({ error: null }),
    saveAsTemplate: viMod.fn().mockResolvedValue({ error: null }),
    upsertReaction: viMod.fn().mockResolvedValue({ error: null }),
  }
})

// ---------------------------------------------------------------------------
// Imports after vi.mock
// ---------------------------------------------------------------------------
import { MealWeekView } from "../meal-week-view"
import { createMeal } from "@/app/(main)/meals/actions"

const createMealMock = vi.mocked(createMeal)

// ---------------------------------------------------------------------------
// Test fixtures (meal-week-view.test.tsx と同じ月曜固定週)
// ---------------------------------------------------------------------------

// 月曜固定の週: 2026-04-13 (Mon) 〜 2026-04-19 (Sun)
const WEEK_START = "2026-04-13"

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

/** dateKey の day row 内にある空スロット (mealType) をタップする */
function tapEmptySlot(dateKey: string, mealType: string) {
  fireEvent.click(
    within(screen.getByTestId(`meal-day-${dateKey}`)).getByTestId(
      `empty-meal-slot-${mealType}`,
    ),
  )
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  // cleanup() → resetRefetchMockState() の順序が load-bearing
  // (meal-week-view.test.tsx の beforeEach コメント参照)
  cleanup()
  resetRefetchMockState(mockState)
  createMealMock.mockClear()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MealFormSheet プリフィル (issue #22)", () => {
  it("空スロットタップでタップした日付がプリフィルされる", async () => {
    render(<MealWeekView {...defaultProps()} />)

    tapEmptySlot("2026-04-15", "breakfast")

    expect(await screen.findByLabelText("日付")).toHaveValue("2026-04-15")
  })

  it("保存時に createMeal がタップしたスロットの date/mealType で呼ばれる", async () => {
    render(<MealWeekView {...defaultProps()} />)

    tapEmptySlot("2026-04-15", "breakfast")

    fireEvent.change(await screen.findByLabelText("メニュー名"), {
      target: { value: "トースト" },
    })
    fireEvent.click(screen.getByRole("button", { name: "追加する" }))

    await waitFor(() => {
      expect(createMealMock).toHaveBeenCalledWith(
        expect.objectContaining({
          date: "2026-04-15",
          mealType: "breakfast",
          title: "トースト",
        }),
      )
    })
  })

  it("2 回目の open で前回タップ時の値が残らない (off-by-one stale 再発防止)", async () => {
    render(<MealWeekView {...defaultProps()} />)

    // スロット A (2026-04-15 朝食) を開いて閉じる
    tapEmptySlot("2026-04-15", "breakfast")
    await screen.findByLabelText("日付")
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    await waitFor(() => {
      expect(screen.queryByLabelText("日付")).not.toBeInTheDocument()
    })

    // スロット B (2026-04-16 昼食) を開く → B の日付が表示される
    tapEmptySlot("2026-04-16", "lunch")
    expect(await screen.findByLabelText("日付")).toHaveValue("2026-04-16")
  })

  it("既存 meal タップ (編集) で initialData がプリフィルされる", async () => {
    const existing = makeMeal({
      id: "meal-1",
      date: "2026-04-14",
      meal_type: "dinner",
      title: "カレーライス",
    })

    render(<MealWeekView {...defaultProps({ initialMeals: [existing] })} />)

    fireEvent.click(screen.getByText("カレーライス"))

    expect(await screen.findByLabelText("メニュー名")).toHaveValue(
      "カレーライス",
    )
    expect(screen.getByLabelText("日付")).toHaveValue("2026-04-14")
  })
})
