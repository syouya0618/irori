/**
 * StockFormSheet のカテゴリ/単位 Select trigger 表示に対する回帰テスト (issue #24)。
 *
 * issue 未記載の第 4 露出サイト: 在庫カテゴリ Select も初期値 "other_food" を常に持ち、
 * Root に items が無いと enum 生値が trigger に露出していた。
 * また単位 Select は placeholder='選択' で生値露出はないが、value≠label の
 * '切' (label '切れ') だけ items 未指定だと value がそのまま表示されていた。
 * Select.Root への items={allCategories} / items={STOCK_UNITS} 追加で
 * いずれも日本語ラベルが解決されることを検証する。
 *
 * - StockFormSheet は @/app/(main)/stock/actions から addStockItem / updateStockItem を
 *   import するため、モジュール単位で vi.mock し実 fetch を防止する
 *   (stock-list.test.tsx と同じ idiom)
 * - Sheet (Base UI Dialog) を open={true} で portal mount する本リポジトリ初のテスト。
 *   SelectPortal は closed 時 null のため Select popup 側との getByText 衝突はない
 *
 * 検証ケース:
 * 1. 新規 (editingItem=null): カテゴリ trigger に「その他食品」、生値が DOM に出ない。
 *    単位は未選択 (unit="") なので placeholder「選択」表示 (items 追加後も placeholder
 *    動作が壊れないことの回帰ガード)
 * 2. 編集 (unit="切"): 単位 trigger に label「切れ」が表示される (items 効果)
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

// StockFormSheet が import する server actions を mock 化（実 fetch 防止）
vi.mock("@/app/(main)/stock/actions", async () => {
  const { vi: viMod } = await import("vitest")
  return {
    addStockItem: viMod.fn().mockResolvedValue({ success: true }),
    updateStockItem: viMod.fn().mockResolvedValue({ success: true }),
  }
})

import { StockFormSheet } from "../stock-form-sheet"
import type { StockItemData } from "../stock-item"

beforeEach(() => {
  cleanup()
})

function makeItem(
  overrides: Partial<StockItemData> & Pick<StockItemData, "id" | "name">,
): StockItemData {
  return {
    category: "other_food",
    quantity: 1,
    unit: null,
    expires_at: null,
    created_by: "u1",
    created_at: "2026-06-10T00:00:00+09:00",
    updated_at: "2026-06-10T00:00:00+09:00",
    ...overrides,
  }
}

describe("StockFormSheet の Select trigger 表示 (issue #24)", () => {
  it("新規追加時、カテゴリ trigger に「その他食品」を表示し enum 生値を露出しない", () => {
    render(
      <StockFormSheet open={true} onOpenChange={vi.fn()} editingItem={null} />,
    )

    expect(screen.getByText("その他食品")).toBeInTheDocument()
    // 回帰ガード本体: enum 生値が DOM に出ない
    expect(screen.queryByText("other_food")).not.toBeInTheDocument()
    // unit="" は未選択扱いのため placeholder「選択」が出る (items 追加後も維持)
    expect(screen.getByText("選択")).toBeInTheDocument()
  })

  it("unit='切' の編集時、単位 trigger に label「切れ」を表示する", () => {
    render(
      <StockFormSheet
        open={true}
        onOpenChange={vi.fn()}
        editingItem={makeItem({ id: "s1", name: "鮭", category: "fish", unit: "切" })}
      />,
    )

    expect(screen.getByText("切れ")).toBeInTheDocument()
    expect(screen.getByText("魚介")).toBeInTheDocument()
  })
})
