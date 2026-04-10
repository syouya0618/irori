import type { MealReaction } from "@/lib/types/database"
import { daysFromTodayJst } from "@/lib/utils/date-jst"
import type { MatchResult } from "./matching"
import type { ScoringConfig } from "./types"

/**
 * 指定された expires_at（YYYY-MM-DD）から、今日(JST)までの日数差を返す。
 * 期限切れは負の値、当日は0、未来は正の値。
 * expires_at が null または不正な場合は null を返す。
 *
 * タイムゾーン非依存: サーバー(UTC)とクライアント(JST)で同じ結果になる。
 */
export function daysUntilExpiry(
  expiresAt: string | null,
  today: Date,
): number | null {
  if (!expiresAt) return null
  return daysFromTodayJst(expiresAt, today)
}

/**
 * 賞味期限ボーナスを計算する。
 * マッチした食材の中で、thresholdDays以内の期限切れ間近食材が
 * 含まれていればボーナスを付与する（1件ごとに加算、上限あり）。
 * 期限切れ（負の日数）も「使い切りたい」としてボーナス対象。
 */
export function calculateExpiryBonus(
  matched: MatchResult["matched"],
  config: Pick<
    ScoringConfig,
    "expiryBonusThresholdDays" | "expiryBonusPerItem" | "expiryBonusMax"
  >,
  today: Date,
): number {
  if (matched.length === 0) return 0

  let bonus = 0
  for (const { stockItem } of matched) {
    const days = daysUntilExpiry(stockItem.expires_at, today)
    if (days === null) continue
    if (days <= config.expiryBonusThresholdDays) {
      bonus += config.expiryBonusPerItem
    }
  }

  return Math.min(bonus, config.expiryBonusMax)
}

/**
 * 過去リアクション履歴からスコア補正を計算する。
 * good → 加点、bad → 減点、ok → 無視。
 */
export function calculateReactionScore(
  reactionHistory: MealReaction[],
  config: Pick<
    ScoringConfig,
    | "goodReactionBonus"
    | "badReactionPenalty"
    | "reactionScoreMax"
    | "reactionScoreMin"
  >,
): number {
  if (reactionHistory.length === 0) return 0

  let score = 0
  for (const reaction of reactionHistory) {
    if (reaction === "good") score += config.goodReactionBonus
    else if (reaction === "bad") score -= config.badReactionPenalty
  }

  return Math.max(
    config.reactionScoreMin,
    Math.min(config.reactionScoreMax, score),
  )
}

