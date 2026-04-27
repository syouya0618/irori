export { rankSuggestions } from "./ranking"
export { matchStockToTemplate, type MatchResult } from "./matching"
export { normalizeIngredientName, ingredientsMatch } from "./normalize"
export {
  calculateExpiryBonus,
  calculateReactionScore,
  daysUntilExpiry,
} from "./scoring"
export {
  DEFAULT_SCORING_CONFIG,
  type RecipeSuggestion,
  type ScoringConfig,
  type StockItemInput,
  type TemplateInput,
  type TemplateIngredient,
} from "./types"
export {
  calculateDailyRate,
  calculateMilkDailyMl,
  estimateRemainingDays,
  DEFAULT_RATE_CONFIG,
  type ConsumptionLogInput,
  type ConsumptionRateConfig,
} from "./consumption-rate"
export {
  aggregateFeedings,
  aggregateSleep,
  aggregateDiapers,
  extractTemperatures,
  extractGrowth,
  calculateAge,
  type AggregationLogInput,
  type DailyFeedingSummary,
  type DailySleepSummary,
  type DailyDiaperSummary,
  type TemperatureRecord,
  type GrowthRecord,
} from "./baby-log-aggregation"
export {
  buildBabyWeeklySummary,
  totalBabyWeeklySummary,
  type BabyWeeklySummaryLogInput,
  type BabyWeeklySummaryDay,
} from "./baby-weekly-summary"
