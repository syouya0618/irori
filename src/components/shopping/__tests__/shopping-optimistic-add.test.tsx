/**
 * 買い物アイテム追加の **楽観挿入** を固定する（Realtime 非依存の反映）。
 *
 * 本番の postgres_changes は間欠不達（issue #92）ゆえ、Realtime INSERT が
 * 唯一の反映経路だと「押しても何も出ない回」が出る。ここでは Realtime を
 * 一切 emit せずに、フォーム → server action → onAdded → 親 state の一本道だけで
 * 行が出ることを検証する（e2e は同じ契約を実ブラウザ + WS 遮断で固定する）。
 *
 * shopping-list.test.tsx は AddItemForm を stub 化して親の Realtime reducer のみを
 * 見るが、本ファイルは **実 AddItemForm を親にぶら下げる**（欠陥は「フォームが親へ
 * 何も渡していない」ことだったため、境界を跨いで検証せねば意味がない）。
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react"
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
      "supabase.from() should not be called without a visibility/focus event",
  })
})

// 献立からの生成は本ファイルの対象外（server action + dialog）
vi.mock("../generate-from-meals", () => ({
  GenerateFromMeals: () => null,
}))

vi.mock("@/app/(main)/shopping/actions", async () => {
  const { vi: viMod } = await import("vitest")
  return {
    addItem: viMod.fn(),
    getSuggestions: viMod.fn().mockResolvedValue({ suggestions: [] }),
    toggleItem: viMod.fn().mockResolvedValue({ autoStocked: false }),
    deleteItem: viMod.fn().mockResolvedValue({ error: null }),
    clearChecked: viMod.fn().mockResolvedValue({ success: true, count: 0 }),
  }
})

import { ShoppingList } from "../shopping-list"
import { addItem } from "@/app/(main)/shopping/actions"

const addItemMock = vi.mocked(addItem)
const makePayload = makePayloadFor<ShoppingItemData>("shopping_items")

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

function renderList(initialItems: ShoppingItemData[] = []) {
  return render(
    <ShoppingList
      initialItems={initialItems}
      householdId="h1"
      members={[{ id: "u1", display_name: "テスト" }]}
    />,
  )
}

/** 名前を入力して「追加」を押し、server action の往復を flush する。 */
async function submitItem(name: string): Promise<void> {
  fireEvent.change(screen.getByPlaceholderText("アイテムを追加..."), {
    target: { value: name },
  })
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "追加" }))
  })
}

beforeEach(() => {
  cleanup()
  resetInlineReducerMockState(mockState)
  addItemMock.mockReset()
})

describe("買い物アイテムの楽観挿入（Realtime 非依存）", () => {
  it("追加成功でサーバが返した行が Realtime を待たずに一覧へ出る", async () => {
    const inserted = makeItem({ id: "item-1", name: "ヨーグルト", sort_order: 3 })
    addItemMock.mockResolvedValue({ success: true, item: inserted })

    renderList()
    expect(screen.getByText("アイテムがありません")).toBeInTheDocument()

    await submitItem("ヨーグルト")

    // Realtime payload は一切 emit していない
    expect(screen.getByText("ヨーグルト")).toBeInTheDocument()
    expect(screen.getByText("残り 1 / 1 件")).toBeInTheDocument()
  })

  it("同じ行が後から Realtime INSERT で届いても二重表示にならない（id で dedupe）", async () => {
    const inserted = makeItem({ id: "item-1", name: "ヨーグルト" })
    addItemMock.mockResolvedValue({ success: true, item: inserted })

    renderList()
    await submitItem("ヨーグルト")

    act(() => {
      emitPayload(mockState, makePayload("INSERT", inserted) as RealtimePayload<
        ShoppingItemData
      >)
    })

    expect(screen.getAllByText("ヨーグルト")).toHaveLength(1)
    expect(screen.getByText("残り 1 / 1 件")).toBeInTheDocument()
  })

  it("追加失敗（error）では行を出さない", async () => {
    addItemMock.mockResolvedValue({ error: "アイテムの追加に失敗しました" })

    renderList()
    await submitItem("ヨーグルト")

    expect(screen.queryByText("ヨーグルト")).not.toBeInTheDocument()
    expect(screen.getByText("アイテムがありません")).toBeInTheDocument()
    // 失敗時は入力を消さない（打ち直しを強いない）
    expect(screen.getByPlaceholderText("アイテムを追加...")).toHaveValue(
      "ヨーグルト",
    )
  })

  it("行を返さない成功応答でも落ちない（undefined を親へ流さない防御）", async () => {
    // 型の上では到達不能（addItem は成功時に必ず item を返す）が、mock 差し替えや
    // 将来の戻り値変更では起こりうる形。undefined を親の dedupe
    // (`prev.some(i => i.id === item.id)`) へ流すと throw するため、
    // AddItemForm 側の存在確認ガードをここで固定する。
    addItemMock.mockResolvedValue({ success: true } as unknown as Awaited<
      ReturnType<typeof addItem>
    >)

    renderList()
    await submitItem("ヨーグルト")

    expect(screen.getByText("アイテムがありません")).toBeInTheDocument()
    // 成功扱いなので入力欄はクリアされる
    expect(screen.getByPlaceholderText("アイテムを追加...")).toHaveValue("")
  })
})
