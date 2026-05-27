/**
 * ShoppingList の Realtime inline reducer に対する統合テスト。
 *
 * - PR #36 (BabyDashboard) と同じ idiom: vi.hoisted + vi.mock("@/lib/supabase/client", ...)
 *   で Supabase channel API を差し替え、テスト本体から payload を emit
 * - 子コンポーネント (AddItemForm / GenerateFromMeals) は server action を呼ぶため
 *   無効化 stub に置き換える（テスト対象は親の inline reducer のみ）
 * - shopping/actions の clearChecked は本テストでは未使用だが、ShoppingItem 経由で
 *   toggleItem / deleteItem が走る可能性があるためモジュール単位で mock 化
 *
 * shopping-list.tsx (line 108-145) の Realtime 流路:
 * - INSERT: 既存 id と衝突したら no-op、それ以外は push
 * - UPDATE: id 一致行を payload.new で置換
 * - DELETE: payload.old.id で filter
 *
 * 検証ケース:
 * 1. INSERT 重複防止: 同一 id を 2 度 emit しても 1 件のまま
 * 2. UPDATE で既存 item の name 等が置換される
 * 3. DELETE で件数 -1 / 残り N / 全 N の表示が更新される
 * 4. unmount で supabase.removeChannel が呼ばれる
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { act } from "react"
import type { ShoppingItemData } from "../shopping-item"
import type {
  RealtimePayload,
  ViFn,
} from "@/test-utils/supabase-realtime-mock"
import {
  emitPayload,
  makePayloadFor,
  resetInlineReducerMockState,
} from "@/test-utils/supabase-realtime-mock"

// ---------------------------------------------------------------------------
// Mock state (vi.hoisted で factory と test body で共有)
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => ({
  listeners: [] as Array<(payload: unknown) => void>,
  removeChannelMock: undefined as unknown as ViFn,
  fromMock: undefined as unknown as ViFn,
}))

vi.mock("@/lib/supabase/client", async () => {
  const { vi: viMod } = await import("vitest")
  const { buildInlineReducerSupabaseMock } = await import(
    "@/test-utils/supabase-realtime-mock"
  )
  return buildInlineReducerSupabaseMock(viMod, mockState, {
    throwMessage:
      "supabase.from() should not be called in ShoppingList Realtime callback tests",
  })
})

// 子フォームは server action を呼ぶので無効化
vi.mock("../add-item-form", () => ({
  AddItemForm: () => null,
}))
vi.mock("../generate-from-meals", () => ({
  GenerateFromMeals: () => null,
}))

// ShoppingItem は inline reducer の DOM 反映 anchor として描画させる必要があるので
// 残すが、内部から呼ぶ server actions はモジュール単位で mock 化する
vi.mock("@/app/(main)/shopping/actions", () => ({
  toggleItem: vi.fn().mockResolvedValue({ autoStocked: false }),
  deleteItem: vi.fn().mockResolvedValue({ error: null }),
  clearChecked: vi.fn().mockResolvedValue({ success: true, count: 0 }),
  addItem: vi.fn().mockResolvedValue({ error: null }),
  getSuggestions: vi.fn().mockResolvedValue({ data: [] }),
}))

// ---------------------------------------------------------------------------
// Imports after vi.mock
// ---------------------------------------------------------------------------
import { ShoppingList } from "../shopping-list"

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

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

const makePayload = makePayloadFor<ShoppingItemData>("shopping_items")

function defaultProps(
  overrides: Partial<Parameters<typeof ShoppingList>[0]> = {},
): Parameters<typeof ShoppingList>[0] {
  return {
    initialItems: [],
    householdId: "h1",
    members: [{ id: "u1", display_name: "テスト" }],
    ...overrides,
  }
}

const emit = (payload: RealtimePayload<ShoppingItemData>) =>
  emitPayload(mockState, payload)

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  // cleanup() → resetInlineReducerMockState() の順序が load-bearing:
  // cleanup() で前テストの unmount が走り removeChannel カウントが +1 されるので、
  // その後で reset() (内部で mockClear) を呼ぶことでカウントを境界跨ぎさせない。
  cleanup()
  resetInlineReducerMockState(mockState)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ShoppingList / Realtime inline reducer", () => {
  it("INSERT 重複防止: 同一 id を 2 度 emit しても 1 件のまま", () => {
    render(<ShoppingList {...defaultProps()} />)

    // 初期表示は空
    expect(screen.getByText("アイテムがありません")).toBeInTheDocument()
    expect(screen.getByText("残り 0 / 0 件")).toBeInTheDocument()

    const newItem = makeItem({ id: "item-1", name: "牛乳" })

    act(() => {
      emit(makePayload("INSERT", newItem))
    })

    expect(screen.getByText("牛乳")).toBeInTheDocument()
    expect(screen.getByText("残り 1 / 1 件")).toBeInTheDocument()

    // 同一 id を再 emit しても重複しない
    act(() => {
      emit(makePayload("INSERT", newItem))
    })

    expect(screen.getAllByText("牛乳")).toHaveLength(1)
    expect(screen.getByText("残り 1 / 1 件")).toBeInTheDocument()
  })

  it("UPDATE で既存 item の name が payload.new に置換される", () => {
    const existing = makeItem({ id: "item-1", name: "牛乳" })

    render(<ShoppingList {...defaultProps({ initialItems: [existing] })} />)

    expect(screen.getByText("牛乳")).toBeInTheDocument()
    expect(screen.getByText("残り 1 / 1 件")).toBeInTheDocument()

    act(() => {
      emit(makePayload("UPDATE", { ...existing, name: "豆乳" }))
    })

    expect(screen.queryByText("牛乳")).not.toBeInTheDocument()
    expect(screen.getByText("豆乳")).toBeInTheDocument()
    expect(screen.getByText("残り 1 / 1 件")).toBeInTheDocument()
  })

  it("DELETE で件数 -1 / 残り N / 全 N の表示が更新される", () => {
    const item1 = makeItem({ id: "item-1", name: "牛乳" })
    const item2 = makeItem({ id: "item-2", name: "パン" })

    render(
      <ShoppingList {...defaultProps({ initialItems: [item1, item2] })} />,
    )

    expect(screen.getByText("牛乳")).toBeInTheDocument()
    expect(screen.getByText("パン")).toBeInTheDocument()
    expect(screen.getByText("残り 2 / 2 件")).toBeInTheDocument()

    act(() => {
      emit(makePayload("DELETE", item1.id))
    })

    expect(screen.queryByText("牛乳")).not.toBeInTheDocument()
    expect(screen.getByText("パン")).toBeInTheDocument()
    expect(screen.getByText("残り 1 / 1 件")).toBeInTheDocument()
  })

  it("unmount で supabase.removeChannel が呼ばれる", () => {
    const { unmount } = render(<ShoppingList {...defaultProps()} />)

    expect(mockState.removeChannelMock).not.toHaveBeenCalled()

    unmount()

    expect(mockState.removeChannelMock).toHaveBeenCalledTimes(1)
  })
})
