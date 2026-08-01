/**
 * 一括操作（チェック済み削除 / 献立から生成）の **Realtime 非依存な反映** を固定する。
 *
 * 単発の追加・削除は shopping-optimistic-add.test.tsx / shopping-list.test.tsx が
 * 見ておるが、この 2 つの一括経路は同じ欠陥を残していた:
 *   - `clearChecked` は成功トーストを出すだけで state から行を落とさなかった
 *   - `generateFromMeals` は件数しか返さず、親は何も挿せなかった
 * `revalidatePath` はサーバキャッシュを消すのみでマウント済みの useState には届かず、
 * Realtime の DELETE はフィルタ付き購読では構造的に配信されぬ（Supabase 公式 docs）。
 * ゆえにサーバが「実際に消した id / 挿した行」を返し、親がそれを適用する経路だけが
 * 担保になる。ここでは Realtime を一切 emit せずにその一本道を検証する。
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react"
import type { ShoppingItemData } from "../shopping-item"
import type { ViFn } from "@/test-utils/supabase-realtime-mock"
import { resetInlineReducerMockState } from "@/test-utils/supabase-realtime-mock"

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

// 追加フォームは本ファイルの対象外（単発追加は別ファイルが見ておる）
vi.mock("../add-item-form", () => ({ AddItemForm: () => null }))

vi.mock("@/app/(main)/shopping/actions", async () => {
  const { vi: viMod } = await import("vitest")
  return {
    addItem: viMod.fn(),
    getSuggestions: viMod.fn().mockResolvedValue({ suggestions: [] }),
    toggleItem: viMod.fn().mockResolvedValue({ autoStocked: false }),
    deleteItem: viMod.fn().mockResolvedValue({ error: null }),
    clearChecked: viMod.fn(),
    generateFromMeals: viMod.fn(),
    previewMealIngredients: viMod.fn().mockResolvedValue({ count: 2 }),
  }
})

import { ShoppingList } from "../shopping-list"
import {
  clearChecked,
  generateFromMeals,
} from "@/app/(main)/shopping/actions"

const clearCheckedMock = vi.mocked(clearChecked)
const generateFromMealsMock = vi.mocked(generateFromMeals)

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

beforeEach(() => {
  cleanup()
  resetInlineReducerMockState(mockState)
  clearCheckedMock.mockReset()
  generateFromMealsMock.mockReset()
})

describe("チェック済み一括削除の反映", () => {
  async function openDialogAndConfirm() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /チェック済みを削除/ }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "削除する" }))
    })
  }

  it("サーバが返した removedIds の行だけが一覧から消える", async () => {
    renderList([
      makeItem({ id: "a", name: "牛乳", is_checked: true, checked_at: "2026-07-31T00:00:00Z" }),
      makeItem({ id: "b", name: "卵", is_checked: true, checked_at: "2026-07-31T01:00:00Z" }),
      makeItem({ id: "c", name: "パン" }),
    ])
    clearCheckedMock.mockResolvedValue({
      success: true,
      count: 2,
      removedIds: ["a", "b"],
    })

    expect(screen.getByText("残り 1 / 3 件")).toBeInTheDocument()

    await openDialogAndConfirm()

    // Realtime payload は一切 emit していない
    expect(screen.getByText("残り 1 / 1 件")).toBeInTheDocument()
    expect(screen.getByText("パン")).toBeInTheDocument()
  })

  it("removedIds に無い行は消さない（サーバが実際に消した分だけを落とす）", async () => {
    renderList([
      makeItem({ id: "a", name: "牛乳", is_checked: true, checked_at: "2026-07-31T00:00:00Z" }),
      makeItem({ id: "b", name: "卵", is_checked: true, checked_at: "2026-07-31T01:00:00Z" }),
    ])
    // 何らかの理由で 1 行しか消えなかった場合、もう 1 行は残らねばならぬ
    clearCheckedMock.mockResolvedValue({
      success: true,
      count: 1,
      removedIds: ["a"],
    })

    await openDialogAndConfirm()

    expect(screen.getByText("残り 0 / 1 件")).toBeInTheDocument()
  })

  it("失敗時は行を消さない", async () => {
    renderList([
      makeItem({ id: "a", name: "牛乳", is_checked: true, checked_at: "2026-07-31T00:00:00Z" }),
    ])
    clearCheckedMock.mockResolvedValue({ error: "削除に失敗しました" })

    await openDialogAndConfirm()

    expect(screen.getByText("残り 0 / 1 件")).toBeInTheDocument()
  })
})

describe("献立から生成の楽観挿入", () => {
  async function openDialogAndGenerate() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /献立から追加/ }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "追加する" }))
    })
  }

  it("サーバが返した行が Realtime を待たずに一覧へ出る", async () => {
    renderList()
    generateFromMealsMock.mockResolvedValue({
      success: true,
      count: 2,
      items: [
        makeItem({ id: "g1", name: "人参", sort_order: 1 }),
        makeItem({ id: "g2", name: "玉ねぎ", sort_order: 2 }),
      ],
    })

    await openDialogAndGenerate()

    expect(screen.getByText("人参")).toBeInTheDocument()
    expect(screen.getByText("玉ねぎ")).toBeInTheDocument()
    expect(screen.getByText("残り 2 / 2 件")).toBeInTheDocument()
  })

  it("既に在る行は二重に出ない（id で dedupe）", async () => {
    renderList([makeItem({ id: "g1", name: "人参", sort_order: 1 })])
    generateFromMealsMock.mockResolvedValue({
      success: true,
      count: 2,
      items: [
        makeItem({ id: "g1", name: "人参", sort_order: 1 }),
        makeItem({ id: "g2", name: "玉ねぎ", sort_order: 2 }),
      ],
    })

    await openDialogAndGenerate()

    expect(screen.getAllByText("人参")).toHaveLength(1)
    expect(screen.getByText("残り 2 / 2 件")).toBeInTheDocument()
  })

  it("失敗時は行を出さない", async () => {
    renderList()
    generateFromMealsMock.mockResolvedValue({
      error: "今週の献立が登録されていません",
      count: 0,
    })

    await openDialogAndGenerate()

    expect(screen.getByText("アイテムがありません")).toBeInTheDocument()
  })
})
