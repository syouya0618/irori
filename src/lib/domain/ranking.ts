import { matchStockToTemplate } from "./matching"
import { calculateReactionScore, daysUntilExpiry } from "./scoring"
import {
  DEFAULT_SCORING_CONFIG,
  type RecipeSuggestion,
  type ScoringConfig,
  type StockItemInput,
  type TemplateInput,
} from "./types"

/**
 * テンプレートリストと在庫リストを受け取り、スコア降順で上位N件を返す。
 * Domain層の唯一の公開エントリポイント。
 * マッチ率が0のテンプレートは結果から除外する。
 */
export function rankSuggestions(
  templates: TemplateInput[],
  stockItems: StockItemInput[],
  config: Partial<ScoringConfig> = {},
  today: Date = new Date(),
): RecipeSuggestion[] {
  const mergedConfig: ScoringConfig = { ...DEFAULT_SCORING_CONFIG, ...config }

  const results: RecipeSuggestion[] = []

  for (const template of templates) {
    const matchResult = matchStockToTemplate(
      template,
      stockItems,
      mergedConfig.minMatchLength,
    )

    if (matchResult.matchRate === 0) continue

    // daysUntilExpiry を1回だけ計算し、matchedIngredients と expiryBonus の両方で共有する。
    let expiringCount = 0
    const matchedIngredients = matchResult.matched.map(
      ({ ingredient, stockItem }) => {
        const days = daysUntilExpiry(stockItem.expires_at, today)
        const isExpiring =
          days !== null && days <= mergedConfig.expiryBonusThresholdDays
        if (isExpiring) expiringCount++
        return { name: ingredient.name, isExpiring }
      },
    )

    const expiryBonus = Math.min(
      expiringCount * mergedConfig.expiryBonusPerItem,
      mergedConfig.expiryBonusMax,
    )
    const reactionScore = calculateReactionScore(
      template.reactionHistory,
      mergedConfig,
    )

    results.push({
      templateId: template.id,
      title: template.title,
      score: matchResult.matchRate + expiryBonus + reactionScore,
      scoreBreakdown: {
        matchRate: matchResult.matchRate,
        expiryBonus,
        reactionScore,
      },
      matchedIngredients,
      missingIngredients: matchResult.missing,
      hasExpiringStock: expiringCount > 0,
    })
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, mergedConfig.topN)
}
