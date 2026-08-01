/**
 * ShoppingList の復帰時 refetch（useVisibilityRefetch の配線）を固定する。
 *
 * Realtime のフィルタ付き購読では DELETE が構造的に配信されない
 * （Supabase docs: "You can't filter Delete events when tracking Postgres Changes"）。
 * ゆえに「配偶者が消した行が自分の画面から消えない」は復帰時 refetch でしか
 * 回収できぬ。ここでは **その回収が実際に起きること**と、クエリが正しい
 * テーブル / 列 / 世帯で飛ぶことを固定する（table 名や eq を落としても
 * フックのテストだけでは緑のまま通ってしまうため）。
 *
 * 他の ShoppingList テスト（shopping-list.test.tsx / shopping-optimistic-add.test.tsx）は
 * `supabase.from()` を throw mock にして「Realtime 経路では from を呼ばぬ」契約を
 * 守らせているため、from を実際に使う本ファイルは別ファイルに分ける。
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, cleanup, act } from "@testing-library/react"
import type { ShoppingItemData } from "../shopping-item"
import type { ViFn } from "@/test-utils/supabase-realtime-mock"

const mockState = vi.hoisted(() => ({
  fromMock: undefined as unknown as ViFn,
  selectMock: undefined as unknown as ViFn,
  eqMock: undefined as unknown as ViFn,
  orderMock: undefined as unknown as ViFn,
  abortSignalMock: undefined as unknown as ViFn,
  /** 次の refetch が resolve する内容（テスト側で差し替える） */
  result: { data: null as unknown, error: null as unknown },
}))

vi.mock("@/lib/supabase/client", async () => {
  const { vi: viMod } = await import("vitest")
  // 実 PostgrestFilterBuilder と同じく「thenable かつ .abortSignal() を持つ」形
  const thenable: {
    abortSignal: (...args: unknown[]) => unknown
    then: (
      onFulfilled?: ((value: unknown) => unknown) | null,
      onRejected?: ((reason: unknown) => unknown) | null,
    ) => Promise<unknown>
  } = {
    abortSignal: (...args: unknown[]) => {
      mockState.abortSignalMock(...args)
      return thenable
    },
    then: (onFulfilled, onRejected) =>
      Promise.resolve(mockState.result).then(onFulfilled, onRejected),
  }
  mockState.abortSignalMock = viMod.fn()
  mockState.orderMock = viMod.fn(() => thenable)
  mockState.eqMock = viMod.fn(() => ({ order: mockState.orderMock }))
  mockState.selectMock = viMod.fn(() => ({ eq: mockState.eqMock }))
  mockState.fromMock = viMod.fn(() => ({ select: mockState.selectMock }))

  const channel: { on: () => typeof channel; subscribe: () => typeof channel } =
    {
      on: () => channel,
      subscribe: () => channel,
    }
  return {
    createClient: () => ({
      channel: () => channel,
      removeChannel: viMod.fn().mockResolvedValue("ok"),
      from: mockState.fromMock,
    }),
  }
})

vi.mock("../add-item-form", () => ({ AddItemForm: () => null }))
vi.mock("../generate-from-meals", () => ({ GenerateFromMeals: () => null }))
vi.mock("@/app/(main)/shopping/actions", async () => {
  const { vi: viMod } = await import("vitest")
  return {
    addItem: viMod.fn().mockResolvedValue({ error: null }),
    getSuggestions: viMod.fn().mockResolvedValue({ suggestions: [] }),
    toggleItem: viMod.fn().mockResolvedValue({ autoStocked: false }),
    deleteItem: viMod.fn().mockResolvedValue({ success: true }),
    clearChecked: viMod.fn().mockResolvedValue({ success: true, count: 0 }),
  }
})

import { ShoppingList } from "../shopping-list"
import { SHOPPING_ITEM_COLUMNS } from "@/lib/domain/shopping-item-columns"

function makeItem(
  overrides: Partial<ShoppingItemData> & Pick<ShoppingItemData, "id" | "name">,
): ShoppingItemData {
  return {
    quantity: null,
    category: "other_food",
    store_type: "supermarket",
    is_checked: false,
    checked_by: null,
    checked_at: null,
    sort_order: 0,
    ...overrides,
  }
}

/** visibilitychange を発火し、refetch の microtask を flush する。 */
async function fireVisible(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"))
  })
}

beforeEach(() => {
  cleanup()
  mockState.result = { data: null, error: null }
  mockState.fromMock?.mockClear()
  mockState.selectMock?.mockClear()
  mockState.eqMock?.mockClear()
  mockState.orderMock?.mockClear()
  mockState.abortSignalMock?.mockClear()
})

describe("ShoppingList / 復帰時 refetch（DELETE 非配信の回収）", () => {
  const milk = makeItem({ id: "item-1", name: "牛乳", sort_order: 1 })
  const bread = makeItem({ id: "item-2", name: "パン", sort_order: 2 })

  it("配偶者が消した行が復帰で画面から消える（Realtime DELETE は届かぬ前提）", async () => {
    mockState.result = { data: [milk], error: null }

    render(
      <ShoppingList
        initialItems={[milk, bread]}
        householdId="h1"
        members={[]}
      />,
    )
    expect(screen.getByText("パン")).toBeInTheDocument()

    await fireVisible()

    expect(screen.queryByText("パン")).not.toBeInTheDocument()
    expect(screen.getByText("牛乳")).toBeInTheDocument()
    expect(screen.getByText("残り 1 / 1 件")).toBeInTheDocument()
  })

  it("クエリはテーブル / 列 / 世帯 / 並び / abort signal を正しく指定する", async () => {
    mockState.result = { data: [milk], error: null }

    render(<ShoppingList initialItems={[milk]} householdId="h1" members={[]} />)
    await fireVisible()

    expect(mockState.fromMock).toHaveBeenCalledWith("shopping_items")
    expect(mockState.selectMock).toHaveBeenCalledWith(SHOPPING_ITEM_COLUMNS)
    expect(mockState.eqMock).toHaveBeenCalledWith("household_id", "h1")
    expect(mockState.orderMock).toHaveBeenCalledWith("sort_order", {
      ascending: true,
    })
    expect(mockState.abortSignalMock).toHaveBeenCalledWith(
      expect.any(AbortSignal),
    )
  })

  it("refetch 失敗では既存表示を壊さず、error を握り潰さない", async () => {
    const error = {
      message: "boom",
      code: "XX000",
      details: "d",
      hint: "h",
    }
    mockState.result = { data: null, error }
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    render(
      <ShoppingList
        initialItems={[milk, bread]}
        householdId="h1"
        members={[]}
      />,
    )
    await fireVisible()

    // 既存表示は保持（真値が取れない時に画面を空にしない）
    expect(screen.getByText("牛乳")).toBeInTheDocument()
    expect(screen.getByText("パン")).toBeInTheDocument()
    // Supabase error は plain object ゆえフィールドを構造化ログする
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[shopping]"),
      expect.objectContaining({ message: "boom", code: "XX000" }),
    )
    consoleSpy.mockRestore()
  })

  it("mount しただけでは refetch しない（初期行は SSR 由来で足りている）", () => {
    render(<ShoppingList initialItems={[milk]} householdId="h1" members={[]} />)

    expect(mockState.fromMock).not.toHaveBeenCalled()
  })
})
