/**
 * 「今あるもので」: 在庫から今日作れる料理を提案する。
 *
 * 規則:
 * - 必須除外で落とした後の候補だけを使う（採点の前と、結果を返す直前の 2 回検証する）。
 * - 結果は 3 つの枠に分ける。混ぜない。
 *   - `ready`: 必要な食材と量が揃う（基本 3 案）
 *   - `check`: 食材はあるが分量などの確認が必要
 *   - `buy`  : 買い足しが必要（不足は `match.missing` に明示）
 * - `ready` が 0 件でも黙って緩めない。0 件であることと、別枠の候補・入力見直しのヒントを返す。
 * - 順位は「早く使いたい・期限が近い食材の利用」「好み」「時間」。
 *   **期限超過への加点はしない**（期限を過ぎた在庫は突き合わせの時点で材料に数えない）。
 * - 「原材料の確認が必要」な料理（アレルギーの除外があり成分を確かめられない）は別枠で返す。
 */

import {
  buildExclusionSet,
  evaluateRecipe,
  type ExclusionSet,
  partitionRecipes,
  type Unverifiable,
} from "./exclusions"
import { type CatalogInput, toCatalogView } from "./lookup"
import {
  expiryStateOn,
  isStale,
  matchDishToPantry,
  type PantryMatch,
  type Sufficiency,
} from "./pantry-match"
import { type PreferenceReason, scoreRecipePreference } from "./preferences"
import type {
  DishFeedback,
  DishRole,
  FoodExclusion,
  FoodPreference,
  PantryItem,
  RecipeDef,
} from "./types"

export const NOW_SUGGESTION_LIMIT = 3
const DEFAULT_ROLES: readonly DishRole[] = ["main", "side", "soup"]

export const NOW_WEIGHTS = {
  useSoonPerItem: 6,
  useSoonMax: 12,
  expiringPerItem: 5,
  expiringMax: 10,
  preferenceClamp: 10,
  overMaxMinutes: -10,
  mainRole: 1,
} as const

export interface SuggestNowInput {
  /** 今日（YYYY-MM-DD, JST）。食べる日でもある。 */
  today: string
  servings: number
  pantry: readonly PantryItem[]
  exclusions: readonly FoodExclusion[]
  preferences?: readonly FoodPreference[]
  feedback?: readonly DishFeedback[]
  /** 世帯が設定した常備品。 */
  stapleIngredientIds?: readonly string[]
  catalog: CatalogInput
  /** 対象にする料理区分（既定: 主菜・副菜・汁物）。 */
  roles?: readonly DishRole[]
  /** 調理時間の希望（分）。超える料理は順位を下げる。 */
  maxMinutes?: number | null
  /** 各枠の件数（既定 3）。 */
  limit?: number
}

export interface NowScore {
  total: number
  useSoon: number
  expiring: number
  preference: number
  time: number
  role: number
}

export interface NowSuggestion {
  recipe: RecipeDef
  level: Sufficiency
  match: PantryMatch
  score: NowScore
  /** 実記録・明示設定に基づく理由だけ。 */
  preferenceReasons: PreferenceReason[]
}

export type SuggestHint =
  /** 使える在庫が 1 件も登録されていない。 */
  | "pantry_empty"
  /** 辞書に解決できていない在庫名がある（名前の見直しで候補が増える可能性）。 */
  | "unresolved_items"
  /** 数量が未登録の在庫がある（数量を入れると「揃う」と判定できる）。 */
  | "quantity_unknown"
  /** 最終確認が古い在庫がある。 */
  | "stale_items"
  /** 期限を過ぎた在庫がある（材料に数えていない）。 */
  | "expired_items"
  /** 使い切った在庫がある（材料に数えていない）。 */
  | "used_up_items"
  /** 必須除外で全ての候補が対象外になった。 */
  | "all_excluded"
  /** 対象の料理区分にレシピが無い。 */
  | "no_recipes"

export interface SuggestNowResult {
  ready: NowSuggestion[]
  /** `ready` の全件数（`ready` は上位だけ）。0 なら「揃う候補は 0 件」。 */
  readyTotal: number
  check: NowSuggestion[]
  checkTotal: number
  buy: NowSuggestion[]
  buyTotal: number
  /** 原材料の確認が必要な料理（自動の候補にしない）。 */
  labelCheck: { recipe: RecipeDef; unverifiable: Unverifiable[] }[]
  /** 必須除外に当たって外した件数。 */
  excludedCount: number
  /** `ready` が 0 件のときだけ入る、入力見直しのヒント。 */
  hints: SuggestHint[]
  /**
   * 総称（「豚肉」「鶏肉」「牛肉」「きのこ」）で登録された、使える在庫。
   * 部位・種類とは同一視しないため「揃う」には数えていない（その材料は「確認が必要」になる）。
   * 画面で「部位（豚こま・豚バラ など）で登録すると候補に数えます」と知らせるために返す。
   */
  genericItems: { pantryItemId: string; ingredientId: string; name: string }[]
}

function timePoints(minutes: number, maxMinutes: number | null): number {
  if (maxMinutes !== null && minutes > maxMinutes) return NOW_WEIGHTS.overMaxMinutes
  if (minutes <= 15) return 3
  if (minutes <= 30) return 2
  if (minutes <= 45) return 0
  return -2
}

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value))
}

function scoreOf(recipe: RecipeDef, match: PantryMatch, preference: number, maxMinutes: number | null): NowScore {
  const useSoon = Math.min(match.useSoonCount * NOW_WEIGHTS.useSoonPerItem, NOW_WEIGHTS.useSoonMax)
  const expiring = Math.min(match.expiringSoonCount * NOW_WEIGHTS.expiringPerItem, NOW_WEIGHTS.expiringMax)
  const time = timePoints(recipe.minutes, maxMinutes)
  const role = recipe.role === "main" ? NOW_WEIGHTS.mainRole : 0
  const pref = clamp(preference, NOW_WEIGHTS.preferenceClamp)
  return { total: useSoon + expiring + pref + time + role, useSoon, expiring, preference: pref, time, role }
}

function compareSuggestions(a: NowSuggestion, b: NowSuggestion): number {
  const aGap = a.match.missing.length * 10 + a.match.toCheck.length
  const bGap = b.match.missing.length * 10 + b.match.toCheck.length
  return aGap - bGap || b.score.total - a.score.total || a.recipe.id.localeCompare(b.recipe.id)
}

function buildHints(input: SuggestNowInput, roleRecipes: number, allowed: number): SuggestHint[] {
  const hints: SuggestHint[] = []
  const usable = input.pantry.filter(
    (item) => item.status !== "out" && expiryStateOn(item.expiresOn, input.today) !== "expired",
  )
  if (roleRecipes === 0) hints.push("no_recipes")
  else if (allowed === 0) hints.push("all_excluded")
  if (usable.length === 0) hints.push("pantry_empty")
  if (usable.some((item) => item.ingredientId === null)) hints.push("unresolved_items")
  if (usable.some((item) => item.ingredientId !== null && item.quantity === null)) hints.push("quantity_unknown")
  if (usable.some((item) => isStale(item, input.today))) hints.push("stale_items")
  if (input.pantry.some((item) => item.status !== "out" && expiryStateOn(item.expiresOn, input.today) === "expired")) {
    hints.push("expired_items")
  }
  if (input.pantry.some((item) => item.status === "out")) hints.push("used_up_items")
  return hints
}

function stillAllowed(suggestions: NowSuggestion[], set: ExclusionSet): NowSuggestion[] {
  return suggestions.filter((suggestion) => evaluateRecipe(suggestion.recipe, set).allowed)
}

/** 今日作れる候補を 3 つの枠で返す。同じ入力からは同じ結果。 */
export function suggestNow(input: SuggestNowInput): SuggestNowResult {
  const view = toCatalogView(input.catalog)
  const set = buildExclusionSet(input.exclusions, view)
  const roles = input.roles ?? DEFAULT_ROLES
  const limit = Math.max(1, Math.floor(input.limit ?? NOW_SUGGESTION_LIMIT))
  const roleRecipes = view.recipes.filter((recipe) => roles.includes(recipe.role))
  const partition = partitionRecipes(roleRecipes, set)
  const preferenceInput = { preferences: input.preferences ?? [], feedback: input.feedback ?? [] }

  const suggestions: NowSuggestion[] = partition.allowed.map((recipe) => {
    const match = matchDishToPantry(recipe, input.servings, input.pantry, {
      eatOn: input.today,
      today: input.today,
      stapleIngredientIds: input.stapleIngredientIds,
      index: view.index,
    })
    const preference = scoreRecipePreference(recipe, preferenceInput, view.index)
    return {
      recipe,
      level: match.level,
      match,
      score: scoreOf(recipe, match, preference.total, input.maxMinutes ?? null),
      preferenceReasons: preference.reasons,
    }
  })

  const byLevel = (level: Sufficiency) =>
    stillAllowed(suggestions.filter((s) => s.level === level), set).sort(compareSuggestions)
  const ready = byLevel("ready")
  const check = byLevel("check")
  const buy = byLevel("buy")
  return {
    ready: ready.slice(0, limit),
    readyTotal: ready.length,
    check: check.slice(0, limit),
    checkTotal: check.length,
    buy: buy.slice(0, limit),
    buyTotal: buy.length,
    labelCheck: partition.labelCheck.map((recipe) => ({
      recipe,
      unverifiable: evaluateRecipe(recipe, set).unverifiable,
    })),
    excludedCount: partition.blocked.length,
    hints: ready.length === 0 ? buildHints(input, roleRecipes.length, partition.allowed.length) : [],
    genericItems: input.pantry.flatMap((item) => {
      const usable = item.status !== "out" && expiryStateOn(item.expiresOn, input.today) !== "expired"
      if (!usable || item.ingredientId === null) return []
      if (view.index.byId.get(item.ingredientId)?.generic !== true) return []
      return [{ pantryItemId: item.id, ingredientId: item.ingredientId, name: item.name }]
    }),
  }
}
