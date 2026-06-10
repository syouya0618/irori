/**
 * MealIngredientFields のカテゴリ Select trigger 表示に対する回帰テスト (issue #24)。
 *
 * Base UI の Select.Value は Root に items が無く children/placeholder も無い場合、
 * resolveSelectedLabel が fallback して string value をそのまま描画する
 * (= enum 生値 "other_food" 等が UI に露出する)。
 * Select.Root への items={FOOD_CATEGORIES} 追加で日本語ラベルが解決されることを検証する。
 *
 * - MealIngredientFields は server action / supabase import を持たぬ純 props component
 *   のため mock 不要で render できる
 * - Base UI の SelectPortal は closed 時 null を返すため、popup を開かない限り
 *   SelectItem 側のラベルは DOM に mount されず、trigger 表示のみを衝突なく検証できる
 *
 * 検証ケース:
 * 1. category=other_food → trigger に「その他食品」、生値 "other_food" は DOM に出ない
 * 2. category=vegetable → trigger に「野菜」、生値 "vegetable" は DOM に出ない
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { MealIngredientFields } from "../meal-ingredient-fields"
import type { IngredientInput } from "../meal-ingredient-fields"

beforeEach(() => {
  cleanup()
})

function renderFields(ingredients: IngredientInput[]) {
  return render(
    <MealIngredientFields
      ingredients={ingredients}
      setIngredients={vi.fn()}
      isPending={false}
    />,
  )
}

describe("MealIngredientFields カテゴリ Select の trigger 表示 (issue #24)", () => {
  it("category=other_food で trigger に日本語ラベル「その他食品」を表示する", () => {
    renderFields([{ name: "", quantity: "", category: "other_food" }])

    expect(screen.getByText("その他食品")).toBeInTheDocument()
    // 回帰ガード本体: enum 生値が DOM に出ない
    expect(screen.queryByText("other_food")).not.toBeInTheDocument()
  })

  it("category=vegetable で trigger に日本語ラベル「野菜」を表示する", () => {
    renderFields([{ name: "にんじん", quantity: "1本", category: "vegetable" }])

    expect(screen.getByText("野菜")).toBeInTheDocument()
    expect(screen.queryByText("vegetable")).not.toBeInTheDocument()
  })
})
