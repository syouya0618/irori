import type { ItemCategory, MealReaction } from "@/lib/types/database"

/** meal_templates.ingredients JSONBの各要素 */
export interface TemplateIngredient {
  name: string
  quantity: string
  category: ItemCategory
}

/** Domain層が扱う在庫アイテムの最小限の型 */
export interface StockItemInput {
  id: string
  name: string
  category: ItemCategory
  expires_at: string | null
}

/** Domain層が扱うテンプレート + 過去リアクション */
export interface TemplateInput {
  id: string
  title: string
  ingredients: TemplateIngredient[]
  /** このテンプレートを使って作った献立の全リアクション */
  reactionHistory: MealReaction[]
}

/** 1件のマッチング結果 */
export interface RecipeSuggestion {
  templateId: string
  title: string
  /** 総合スコア（0.0〜1.0+にクランプ） */
  score: number
  /** スコア内訳（デバッグ用・UIのマッチ率表示用） */
  scoreBreakdown: {
    /** 食材のマッチ率 0.0〜1.0 */
    matchRate: number
    /** 期限切れ間近食材ボーナス 0.0〜0.3 */
    expiryBonus: number
    /** リアクション補正 -0.1〜0.2 */
    reactionScore: number
  }
  /** マッチした食材の情報 */
  matchedIngredients: Array<{
    name: string
    isExpiring: boolean
  }>
  /** 不足している食材 */
  missingIngredients: TemplateIngredient[]
  /** 期限切れ間近の食材が含まれるか（UIバッジ用） */
  hasExpiringStock: boolean
}

/** スコアリング設定 */
export interface ScoringConfig {
  /** 賞味期限ボーナスの閾値（日数） */
  expiryBonusThresholdDays: number
  /** 期限間近食材1件あたりのボーナス */
  expiryBonusPerItem: number
  /** 賞味期限ボーナスの上限 */
  expiryBonusMax: number
  /** goodリアクション1件あたりのボーナス */
  goodReactionBonus: number
  /** badリアクション1件あたりのペナルティ */
  badReactionPenalty: number
  /** リアクションスコアの上限 */
  reactionScoreMax: number
  /** リアクションスコアの下限 */
  reactionScoreMin: number
  /** 上位何件まで返すか */
  topN: number
  /** 最小マッチ長（これ未満の食材名は完全一致のみ） */
  minMatchLength: number
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  expiryBonusThresholdDays: 3,
  expiryBonusPerItem: 0.1,
  expiryBonusMax: 0.3,
  goodReactionBonus: 0.05,
  badReactionPenalty: 0.05,
  reactionScoreMax: 0.2,
  reactionScoreMin: -0.1,
  topN: 10,
  minMatchLength: 2,
}
