/**
 * AddItemForm のカテゴリ/購入先 Select trigger 表示に対する回帰テスト (issue #24)。
 *
 * issue #24 の主現場: オプション展開時のカテゴリ/購入先 Select が初期値を常に持つため
 * placeholder 経路に到達せず、Root に items が無いと Base UI の SelectValue が
 * enum 生値 ("other_food" / "supermarket") をそのまま trigger に描画していた。
 * Select.Root への items={allCategories} / items={allStores} 追加で
 * 日本語ラベルが解決されることを検証する。
 *
 * - AddItemForm は @/app/(main)/shopping/actions から addItem / getSuggestions を
 *   import するため、モジュール単位で vi.mock し実 fetch を防止する
 *   (stock-list.test.tsx と同じ idiom)
 * - mount 時の suggestion debounce (300ms) は name="" のため fetchSuggestions が
 *   early return し getSuggestions は呼ばれない
 * - SelectPortal は closed 時 null のため popup 側 SelectItem との getByText 衝突はない
 *
 * 検証ケース:
 * 1. オプション展開後、カテゴリ trigger に「その他食品」/ 購入先 trigger に「スーパー」
 * 2. enum 生値 "other_food" / "supermarket" が DOM に出ない (回帰ガード本体)
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"

// AddItemForm が import する server actions を mock 化（実 fetch 防止）。
// 他の action が呼ばれるようになれば "is not a function" で即落ちる
// defensive failure mode を保持する (meal-week-view.test.tsx と同方針)
vi.mock("@/app/(main)/shopping/actions", async () => {
  const { vi: viMod } = await import("vitest")
  return {
    addItem: viMod.fn().mockResolvedValue({ error: null }),
    getSuggestions: viMod.fn().mockResolvedValue({ suggestions: [] }),
  }
})

import { AddItemForm } from "../add-item-form"

beforeEach(() => {
  cleanup()
})

describe("AddItemForm オプション展開時の Select trigger 表示 (issue #24)", () => {
  it("カテゴリ/購入先の trigger に日本語ラベルを表示し、enum 生値を露出しない", () => {
    render(<AddItemForm />)

    fireEvent.click(screen.getByRole("button", { name: "オプションを開く" }))

    expect(screen.getByText("その他食品")).toBeInTheDocument()
    expect(screen.getByText("スーパー")).toBeInTheDocument()
    // 回帰ガード本体: enum 生値が DOM に出ない
    expect(screen.queryByText("other_food")).not.toBeInTheDocument()
    expect(screen.queryByText("supermarket")).not.toBeInTheDocument()
  })
})
