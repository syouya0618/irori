/**
 * StockList の復帰時 refetch（useVisibilityRefetch の配線）を固定する。
 *
 * shopping 側（shopping-visibility-refetch.test.tsx）と同じ契約: Realtime の
 * フィルタ付き購読では DELETE が構造的に配信されぬため、「配偶者が消した在庫が
 * 自分の画面に残る」の回収経路は復帰時 refetch のみ。table / 列 / 世帯を
 * 取り違えてもフックのテストは緑のままゆえ、クエリの中身までここで固定する。
 *
 * stock-list.test.tsx は `supabase.from()` を throw mock にして「Realtime 経路では
 * from を呼ばぬ」契約を守らせているため、本ファイルを分けている。
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, cleanup, act } from "@testing-library/react"
import type { StockItemData } from "../stock-item"
import type { ViFn } from "@/test-utils/supabase-realtime-mock"

const mockState = vi.hoisted(() => ({
  fromMock: undefined as unknown as ViFn,
  selectMock: undefined as unknown as ViFn,
  eqMock: undefined as unknown as ViFn,
  orderMock: undefined as unknown as ViFn,
  abortSignalMock: undefined as unknown as ViFn,
  result: { data: null as unknown, error: null as unknown },
}))

vi.mock("@/lib/supabase/client", async () => {
  const { vi: viMod } = await import("vitest")
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

vi.mock("../stock-suggestions", () => ({ StockSuggestions: () => null }))
vi.mock("../stock-form-sheet", () => ({ StockFormSheet: () => null }))
vi.mock("@/app/(main)/stock/actions", async () => {
  const { vi: viMod } = await import("vitest")
  return {
    checkAndAutoAddLowStock: viMod
      .fn()
      .mockResolvedValue({ error: null, addedItems: [] }),
    deleteStockItem: viMod.fn().mockResolvedValue({ success: true }),
    addToShoppingList: viMod.fn().mockResolvedValue({ error: null }),
    addStockItem: viMod.fn().mockResolvedValue({ error: null }),
    updateStockItem: viMod.fn().mockResolvedValue({ error: null }),
    getStockSuggestions: viMod.fn().mockResolvedValue({ data: [] }),
    getRecipeSuggestions: viMod.fn().mockResolvedValue({ data: [] }),
    getConsumptionRates: viMod.fn().mockResolvedValue({ data: {} }),
  }
})

import { StockList } from "../stock-list"
import { STOCK_ITEM_COLUMNS } from "@/lib/domain/stock-item-columns"

function makeItem(
  overrides: Partial<StockItemData> & Pick<StockItemData, "id" | "name">,
): StockItemData {
  return {
    category: "other_food",
    quantity: 1,
    unit: null,
    expires_at: null,
    created_by: "u1",
    created_at: "2026-04-16T00:00:00+09:00",
    updated_at: "2026-04-16T00:00:00+09:00",
    ...overrides,
  }
}

function renderList(initialItems: StockItemData[]) {
  return render(
    <StockList
      initialItems={initialItems}
      initialSuggestions={[]}
      consumptionRates={{}}
      householdId="h1"
    />,
  )
}

/** visibilitychange を発火し、refetch の microtask を flush する。 */
async function fireVisible(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"))
  })
}

beforeEach(() => {
  cleanup()
  // checkAndAutoAddLowStock の 30 分 throttle をテスト間で絶縁
  sessionStorage.clear()
  mockState.result = { data: null, error: null }
  mockState.fromMock?.mockClear()
  mockState.selectMock?.mockClear()
  mockState.eqMock?.mockClear()
  mockState.orderMock?.mockClear()
  mockState.abortSignalMock?.mockClear()
})

describe("StockList / 復帰時 refetch（DELETE 非配信の回収）", () => {
  const onion = makeItem({ id: "stock-1", name: "玉ねぎ" })
  const carrot = makeItem({ id: "stock-2", name: "人参" })

  it("配偶者が消した在庫が復帰で画面から消える", async () => {
    mockState.result = { data: [onion], error: null }

    renderList([onion, carrot])
    expect(screen.getByText("人参")).toBeInTheDocument()

    await fireVisible()

    expect(screen.queryByText("人参")).not.toBeInTheDocument()
    expect(screen.getByText("玉ねぎ")).toBeInTheDocument()
    expect(screen.getByText("1件")).toBeInTheDocument()
  })

  it("クエリはテーブル / 列 / 世帯 / 並び / abort signal を正しく指定する", async () => {
    mockState.result = { data: [onion], error: null }

    renderList([onion])
    await fireVisible()

    expect(mockState.fromMock).toHaveBeenCalledWith("stock_items")
    expect(mockState.selectMock).toHaveBeenCalledWith(STOCK_ITEM_COLUMNS)
    expect(mockState.eqMock).toHaveBeenCalledWith("household_id", "h1")
    expect(mockState.orderMock).toHaveBeenCalledWith("name")
    expect(mockState.abortSignalMock).toHaveBeenCalledWith(
      expect.any(AbortSignal),
    )
  })

  it("refetch 失敗では既存表示を壊さず、error を握り潰さない", async () => {
    mockState.result = {
      data: null,
      error: { message: "boom", code: "XX000", details: "d", hint: "h" },
    }
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    renderList([onion, carrot])
    await fireVisible()

    expect(screen.getByText("玉ねぎ")).toBeInTheDocument()
    expect(screen.getByText("人参")).toBeInTheDocument()
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[stock]"),
      expect.objectContaining({ message: "boom", code: "XX000" }),
    )
    consoleSpy.mockRestore()
  })
})
