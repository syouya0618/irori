import type { MealReaction } from "@/lib/types/database"
import type { StockItemInput, TemplateInput } from "../types"
import type { MatchResult } from "../matching"

/** テスト用の StockItemInput を作成するファクトリ */
export function mkStock(
  name: string,
  overrides: Partial<StockItemInput> = {},
): StockItemInput {
  return {
    id: `s-${name}`,
    name,
    category: "other_food",
    expires_at: null,
    ...overrides,
  }
}

/** テスト用の TemplateInput を作成するファクトリ */
export function mkTemplate(
  id: string,
  ingredientNames: Array<string | { name: string; quantity?: string }>,
  reactionHistory: MealReaction[] = [],
): TemplateInput {
  return {
    id,
    title: `テンプレ${id}`,
    ingredients: ingredientNames.map((i) => {
      if (typeof i === "string") {
        return { name: i, quantity: "1個", category: "other_food" as const }
      }
      return {
        name: i.name,
        quantity: i.quantity ?? "1個",
        category: "other_food" as const,
      }
    }),
    reactionHistory,
  }
}

/** MatchResult["matched"] 形式を StockItemInput から構築 */
export function mkMatched(
  stockItems: StockItemInput[],
): MatchResult["matched"] {
  return stockItems.map((stockItem) => ({
    ingredient: {
      name: stockItem.name,
      quantity: "1個",
      category: stockItem.category,
    },
    stockItem,
  }))
}
