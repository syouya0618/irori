import { ingredientsMatch } from "./normalize"
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

  const matched: MatchResult["matched"] = []
  const missing: TemplateIngredient[] = []
  const usedStockIds = new Set<string>()

  for (const ingredient of template.ingredients) {
    const stockItem = stockItems.find(
      (s) =>
        !usedStockIds.has(s.id) &&
        ingredientsMatch(s.name, ingredient.name, minMatchLength),
    )
    if (stockItem) {
      usedStockIds.add(stockItem.id)
      matched.push({ ingredient, stockItem })
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
