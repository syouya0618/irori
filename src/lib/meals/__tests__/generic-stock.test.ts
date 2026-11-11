/**
 * 独立レビュー R24 の回帰テスト（**実カタログ**）。
 *
 * 在庫に総称（「豚肉」「鶏肉」「牛肉」「きのこ」）で入れた食材は、部位・種類と同一視はしない（C-22）。
 * ただし「在庫に無い」とも言わず、その総称に由来する材料は「確認が必要」へ回し、
 * どの在庫が総称なのかを結果で返す。
 */

import { describe, expect, it } from "vitest"

import { ALLERGENS, INGREDIENTS, RECIPES } from "@/lib/meals/catalog"
import { toCatalogView } from "@/lib/meals/lookup"
import { resolveIngredientId } from "@/lib/meals/normalize"
import { matchDishToPantry, type MatchOptions } from "@/lib/meals/pantry-match"
import { suggestNow } from "@/lib/meals/suggest-now"
import type { PantryItem, Quantity, RecipeDef } from "@/lib/meals/types"

const CATALOG = toCatalogView({ ingredients: INGREDIENTS, recipes: RECIPES, allergens: ALLERGENS })
const TODAY = "2026-11-16"
const OPTIONS: MatchOptions = { eatOn: TODAY, today: TODAY, index: CATALOG.index }
const SEASONINGS = ["soy_sauce", "mirin", "sake", "sugar", "salt", "salad_oil", "pepper", "katsuobushi", "rice_oil", "katakuriko"]

function stockByName(name: string, quantity: Quantity | null, overrides: Partial<PantryItem> = {}): PantryItem {
  return {
    id: `p-${name}`,
    ingredientId: resolveIngredientId(name, CATALOG.index),
    name,
    quantity,
    status: "have",
    useSoon: false,
    storage: "fridge",
    expiresOn: null,
    confirmedOn: TODAY,
    ...overrides,
  }
}

function stockById(ingredientId: string, quantity: Quantity | null): PantryItem {
  return { ...stockByName(ingredientId, quantity), id: `p-${ingredientId}`, ingredientId }
}

function recipeByTitle(title: string): RecipeDef {
  const found = RECIPES.find((r) => r.title === title)
  if (!found) throw new Error(`recipe not in catalog: ${title}`)
  return found
}

/** レシピの必須材料のうち、`exceptId` 以外を十分な量で持つ在庫。 */
function everythingBut(recipe: RecipeDef, exceptId: string): PantryItem[] {
  return recipe.ingredients
    .filter((i) => i.optional !== true && i.ingredientId !== exceptId)
    .map((i) => stockById(i.ingredientId, i.quantity.amount === null ? null : { amount: 9999, unit: i.quantity.unit }))
}

describe("R24 総称で登録した在庫（豚肉・鶏肉・牛肉・きのこ）", () => {
  it("名前は総称の食材へ解決している（部位の ID ではない）", () => {
    expect(resolveIngredientId("豚肉", CATALOG.index)).toBe("pork")
    expect(resolveIngredientId("鶏肉", CATALOG.index)).toBe("chicken")
    expect(resolveIngredientId("牛肉", CATALOG.index)).toBe("beef")
    expect(resolveIngredientId("きのこ", CATALOG.index)).toBe("mushroom")
    for (const id of ["pork", "chicken", "beef", "mushroom"]) expect(CATALOG.index.byId.get(id)?.generic, id).toBe(true)
  })

  const cases: readonly (readonly [string, string, string])[] = [
    ["豚肉", "pork", "肉じゃが"],
    ["鶏肉", "chicken", "鶏肉と大根の煮物"],
    ["牛肉", "beef", "牛丼"],
  ]

  it.each(cases)("「%s」300g: その部位を使う料理を「買い足し」にせず「確認が必要」へ回す", (name, genericId, title) => {
    const recipe = recipeByTitle(title)
    const cut = recipe.ingredients.find(
      (i) => i.optional !== true && (CATALOG.index.byId.get(i.ingredientId)?.derivedFrom ?? []).includes(genericId),
    )
    if (!cut) throw new Error(`${title} does not use a cut of ${genericId}`)
    const others = everythingBut(recipe, cut.ingredientId)
    const generic = stockByName(name, { amount: 300, unit: "g" })

    const match = matchDishToPantry(recipe, 2, [...others, generic], OPTIONS)
    expect(match.level).toBe("check")
    expect(match.missing).toEqual([])
    const line = match.lines.find((l) => l.ingredientId === cut.ingredientId)
    expect(line).toMatchObject({ state: "uncertain", reasons: [], genericStock: { pantryItemIds: [generic.id] } })
    // 同一視はしない: 総称の在庫を数量で引き当てない（買い物でも差し引かない）
    expect(match.consumption.filter((c) => c.pantryItemId === generic.id)).toEqual([])
    expect(line?.stockCertain).toBe(0)
    expect(line?.shortBy?.amount).toBeGreaterThan(0)

    // 対照: 総称の在庫も無ければ「買い足し」
    const without = matchDishToPantry(recipe, 2, others, OPTIONS)
    expect(without.level).toBe("buy")
    expect(without.missing.map((l) => l.ingredientId)).toEqual([cut.ingredientId])
    expect(without.lines.find((l) => l.ingredientId === cut.ingredientId)?.genericStock).toBeUndefined()

    // 対照: 部位そのものが十分にあれば「揃う」（総称の在庫が併存していても）
    const exact = stockById(cut.ingredientId, { amount: 9999, unit: cut.quantity.unit })
    const ready = matchDishToPantry(recipe, 2, [...others, exact, generic], OPTIONS)
    expect(ready.level).toBe("ready")
    expect(ready.lines.find((l) => l.ingredientId === cut.ingredientId)?.genericStock).toBeUndefined()
  })

  it("使い切った・期限を過ぎた総称の在庫は数えない", () => {
    const recipe = recipeByTitle("肉じゃが")
    const cut = recipe.ingredients.find((i) => (CATALOG.index.byId.get(i.ingredientId)?.derivedFrom ?? []).includes("pork"))
    if (!cut) throw new Error("unreachable")
    const others = everythingBut(recipe, cut.ingredientId)
    for (const overrides of [{ status: "out" as const }, { expiresOn: "2026-11-15" }]) {
      const match = matchDishToPantry(recipe, 2, [...others, stockByName("豚肉", { amount: 300, unit: "g" }, overrides)], OPTIONS)
      expect(match.level, JSON.stringify(overrides)).toBe("buy")
    }
  })

  it("対照: 総称ではない由来元（牛乳 → バター、大豆 → 豆腐）は、在庫として数えない", () => {
    for (const [stockName, ingredientId] of [["牛乳", "butter"], ["大豆", "tofu_momen"], ["トマト", "tomato_can"]] as const) {
      const dish = { ingredients: [{ ingredientId, quantity: { amount: 1, unit: "piece" as const } }], servings: 2 }
      const match = matchDishToPantry(dish, 2, [stockByName(stockName, null)], OPTIONS)
      expect(match.level, stockName).toBe("buy")
      expect(match.lines[0], stockName).toMatchObject({ state: "missing", reasons: ["not_in_pantry"] })
    }
  })

  it("対照: 総称の在庫は、由来の違う材料には数えない（豚肉で鶏もも肉は確認にならない）", () => {
    const dish = { ingredients: [{ ingredientId: "chicken_thigh", quantity: { amount: 200, unit: "g" as const } }], servings: 2 }
    expect(matchDishToPantry(dish, 2, [stockByName("豚肉", { amount: 300, unit: "g" })], OPTIONS).level).toBe("buy")
  })

  it("レビューの再現: 総称の肉と野菜を登録した世帯で、肉じゃが・鶏肉と大根の煮物・牛丼が「確認が必要」に出て、総称の在庫を知らせる", () => {
    const pantry = [
      stockByName("豚肉", { amount: 300, unit: "g" }),
      stockByName("鶏肉", { amount: 600, unit: "g" }),
      stockByName("牛肉", { amount: 300, unit: "g" }),
      stockByName("じゃがいも", { amount: 6, unit: "piece" }),
      stockByName("玉ねぎ", { amount: 6, unit: "piece" }),
      stockByName("にんじん", { amount: 6, unit: "stalk" }),
      stockByName("大根", { amount: 2, unit: "stalk" }),
      stockByName("しょうが", { amount: 6, unit: "clove" }),
      stockByName("米", { amount: 2, unit: "kg" }),
    ]
    const result = suggestNow({
      today: TODAY,
      servings: 2,
      pantry,
      exclusions: [],
      stapleIngredientIds: SEASONINGS,
      catalog: CATALOG,
      limit: 1000,
    })
    const levelOf = (title: string) =>
      (["ready", "check", "buy"] as const).find((level) => result[level].some((s) => s.recipe.title === title))
    for (const title of ["肉じゃが", "鶏肉と大根の煮物", "牛丼"]) {
      const suggestion = [...result.check, ...result.buy].find((s) => s.recipe.title === title)
      const meatLines = suggestion?.match.lines.filter((line) => line.genericStock !== undefined) ?? []
      expect(meatLines.length, title).toBe(1)
      expect(meatLines[0].state, title).toBe("uncertain")
      // 肉以外が揃っていれば「確認が必要」。肉を「買い足し」には数えない
      expect(suggestion?.match.missing.some((line) => line.genericStock !== undefined), title).toBe(false)
    }
    expect(levelOf("牛丼")).toBe("check")
    expect(result.genericItems.map((item) => [item.name, item.ingredientId]).sort()).toEqual([
      ["牛肉", "beef"],
      ["豚肉", "pork"],
      ["鶏肉", "chicken"],
    ])
    // 総称の在庫だけでは「揃う」にしない（C-22: 部位を同一視しない）
    for (const suggestion of result.ready) {
      expect(suggestion.match.lines.some((line) => line.genericStock !== undefined), suggestion.recipe.title).toBe(false)
    }
  })

  it("対照: 総称の在庫が無ければ、知らせる在庫も無い", () => {
    const result = suggestNow({
      today: TODAY,
      servings: 2,
      pantry: [stockByName("豚こま", { amount: 400, unit: "g" }), stockByName("しめじ", { amount: 1, unit: "pack" })],
      exclusions: [],
      catalog: CATALOG,
    })
    expect(result.genericItems).toEqual([])
  })

  it("カタログのレシピは、総称の食材を材料に使わない（総称の在庫が完全一致で引き当たることは無い）", () => {
    const generic = new Set(INGREDIENTS.filter((i) => i.generic === true).map((i) => i.id))
    expect([...generic].sort()).toEqual(["beef", "chicken", "mushroom", "pork"])
    const users = RECIPES.filter((recipe) => recipe.ingredients.some((i) => generic.has(i.ingredientId)))
    expect(users.map((r) => r.id)).toEqual([])
  })
})
