import {
  normalizeIngredientName,
  normalizedIngredientsMatch,
} from "./normalize"
import type {
  StockItemInput,
  TemplateIngredient,
  TemplateInput,
} from "./types"

export interface MatchResult {
  /** マッチした食材と、対応する在庫アイテム */
  matched: Array<{
    ingredient: TemplateIngredient
    stockItem: StockItemInput
  }>
  /** マッチしなかった食材 */
  missing: TemplateIngredient[]
  /** マッチ率（matched / total、total=0の場合は0） */
  matchRate: number
}

/**
 * 1つのテンプレートに対して在庫リストをマッチングする純関数。
 *
 * 各テンプレート食材について、**未使用の** 在庫アイテムから最初にマッチしたものを紐付ける。
 * 同じ在庫アイテムは1つのテンプレート食材にのみ使われる（重複使用防止）。
 *
 * 例: 在庫に「玉ねぎ」が1つしかない場合、テンプレートに「玉ねぎA」「玉ねぎB」があっても、
 * 片方だけがマッチしてもう片方は不足扱いになる。
 */
export function matchStockToTemplate(
  template: TemplateInput,
  stockItems: StockItemInput[],
  minMatchLength: number,
): MatchResult {
  const total = template.ingredients.length
  if (total === 0) {
    return { matched: [], missing: [], matchRate: 0 }
  }

  // 在庫名を先に正規化しておき、内部ループで重複正規化を避ける。
  const normalizedStock = stockItems.map((item) => ({
    item,
    normalized: normalizeIngredientName(item.name),
  }))

  const matched: MatchResult["matched"] = []
  const missing: TemplateIngredient[] = []
  const usedStockIds = new Set<string>()

  for (const ingredient of template.ingredients) {
    const normalizedIngredient = normalizeIngredientName(ingredient.name)
    const found = normalizedStock.find(
      ({ item, normalized }) =>
        !usedStockIds.has(item.id) &&
        normalizedIngredientsMatch(
          normalized,
          normalizedIngredient,
          minMatchLength,
        ),
    )
    if (found) {
      usedStockIds.add(found.item.id)
      matched.push({ ingredient, stockItem: found.item })
    } else {
      missing.push(ingredient)
    }
  }

  return {
    matched,
    missing,
    matchRate: matched.length / total,
  }
}
