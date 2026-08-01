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
  aggregateDiapers,
  extractTemperatures,
  extractGrowth,
  calculateAge,
  type AggregationLogInput,
  type DailyFeedingSummary,
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
export { parseStockFormData, type ParsedStockFields } from "./stock-form"
export {
  clampFeedingDuration,
  clampFeedingDurationSec,
  deriveDurationMinFromSec,
  FEEDING_DURATION_MIN,
  FEEDING_DURATION_MAX,
  FEEDING_DURATION_SEC_MIN,
  FEEDING_DURATION_SEC_MAX,
} from "./feeding"
