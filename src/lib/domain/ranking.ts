import { matchStockToTemplate } from "./matching"
import {
  calculateExpiryBonus,
  calculateReactionScore,
  daysUntilExpiry,
} from "./scoring"
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
 *
 * マッチ率が0のテンプレートは結果から除外する。
 * テンプレート数やカスタム設定は config で上書き可能。
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

    // マッチ率0のテンプレートは除外
    if (matchResult.matchRate === 0) continue

    const expiryBonus = calculateExpiryBonus(
      matchResult.matched,
      mergedConfig,
      today,
    )
    const reactionScore = calculateReactionScore(
      template.reactionHistory,
      mergedConfig,
    )

    const score = matchResult.matchRate + expiryBonus + reactionScore

    // マッチ食材と isExpiring を1ループで構築
    // （hasExpiringStock も matchedIngredients から導出して冗長計算を避ける）
    const matchedIngredients = matchResult.matched.map(
      ({ ingredient, stockItem }) => {
        const days = daysUntilExpiry(stockItem.expires_at, today)
        return {
          name: ingredient.name,
          isExpiring:
            days !== null && days <= mergedConfig.expiryBonusThresholdDays,
        }
      },
    )

    results.push({
      templateId: template.id,
      title: template.title,
      score,
      scoreBreakdown: {
        matchRate: matchResult.matchRate,
        expiryBonus,
        reactionScore,
      },
      matchedIngredients,
      missingIngredients: matchResult.missing,
      hasExpiringStock: matchedIngredients.some((m) => m.isExpiring),
    })
  }

  // スコア降順でソート、上位N件を返す
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, mergedConfig.topN)
}
