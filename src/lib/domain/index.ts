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
