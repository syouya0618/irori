/**
 * 好み（明示の設定と食後の評価）による採点と、その理由。
 *
 * 規則（旧 Irori の欠陥 (c)「評価者を失う集約」を直したもの）:
 * - 評価は**本人ごと**に扱う。全員ぶんを平坦に足し合わせない。理由には実記録の `profileId` と記録 ID を残す
 *   （「◯◯さんが前回『おいしい』」は、実在する評価からしか作らない）。
 * - 味・手間・また食べたいは別々の軸。軸ごとに、本人の**最新の記録**だけを使う。
 * - 「苦手」は「おいしい」より重く数える（片方の好評でもう片方の不評を打ち消さない）。
 * - `excludeFromLearning`（その日の気分など）は反映しない。「作らなかった」は評価ではないので入力に無い。
 * - 入力に無い好み・評価は影響しない（モジュール内にキャッシュや状態を持たない）。
 * - ここは**採点だけ**。必須除外（アレルギー・苦手の設定）は `exclusions.ts` が別に判定する。
 */

import { isSameOrDerivedFrom } from "./lookup"
import type { IngredientIndex } from "./normalize"
import type { DishFeedback, FoodPreference, RecipeDef } from "./types"

export const PREFERENCE_WEIGHTS = {
  explicit: {
    recipe: { like: 4, dislike: -5 },
    ingredient: { like: 2, dislike: -3 },
    tag: { like: 2, dislike: -3 },
  },
  taste: { 1: -4, 2: 0, 3: 3 },
  effort: { 1: -1, 2: 0, 3: 1 },
  again: { yes: 2, no: -3 },
} as const

export const TASTE_LABELS: Readonly<Record<1 | 2 | 3, string>> = { 1: "苦手", 2: "ふつう", 3: "おいしい" }
export const EFFORT_LABELS: Readonly<Record<1 | 2 | 3, string>> = { 1: "大変", 2: "ふつう", 3: "楽" }

export type PreferenceReason =
  | {
      kind: "explicit"
      preferenceId: string
      scope: FoodPreference["scope"]
      /** 家族共通の設定は null。 */
      profileId: string | null
      sentiment: FoodPreference["sentiment"]
      target: FoodPreference["target"]
      points: number
    }
  | { kind: "taste"; feedbackId: string; profileId: string; eatenOn: string; value: 1 | 2 | 3; points: number }
  | { kind: "effort"; feedbackId: string; profileId: string; eatenOn: string; value: 1 | 2 | 3; points: number }
  | { kind: "again"; feedbackId: string; profileId: string; eatenOn: string; value: boolean; points: number }

export interface PreferenceScore {
  total: number
  /** 明示の好み（家族共通・個人）。 */
  explicit: number
  taste: number
  effort: number
  again: number
  reasons: PreferenceReason[]
  /** この料理を「苦手」「また食べたくない」と記録・設定している本人（相殺せずに別軸で返す）。 */
  dislikedBy: string[]
}

export interface PreferenceInput {
  preferences: readonly FoodPreference[]
  feedback: readonly DishFeedback[]
}

type FeedbackAxis = "taste" | "effort" | "again"

function isNewer(a: DishFeedback, b: DishFeedback): boolean {
  return a.eatenOn > b.eatenOn || (a.eatenOn === b.eatenOn && a.id > b.id)
}

/**
 * レシピ 1 件について、本人ごと・軸ごとの最新の評価を返す。
 * `excludeFromLearning` の記録と、その軸が未入力（null）の記録は使わない。
 */
export function latestFeedbackByProfile(
  feedback: readonly DishFeedback[],
  recipeId: string,
  axis: FeedbackAxis,
): DishFeedback[] {
  const latest = new Map<string, DishFeedback>()
  for (const row of feedback) {
    if (row.recipeId !== recipeId || row.excludeFromLearning || row[axis] === null) continue
    const current = latest.get(row.profileId)
    if (!current || isNewer(row, current)) latest.set(row.profileId, row)
  }
  return [...latest.values()].sort((a, b) => a.profileId.localeCompare(b.profileId))
}

function matchesPreference(
  recipe: RecipeDef,
  preference: FoodPreference,
  index: IngredientIndex | undefined,
): boolean {
  const { kind, id } = preference.target
  if (kind === "recipe") return recipe.id === id
  if (kind === "tag") return recipe.tags.includes(id)
  if (kind !== "ingredient") return false
  return recipe.ingredients.some((ingredient) =>
    index
      ? isSameOrDerivedFrom(ingredient.ingredientId, id, index) !== null
      : ingredient.ingredientId === id,
  )
}

function explicitReasons(
  recipe: RecipeDef,
  preferences: readonly FoodPreference[],
  index: IngredientIndex | undefined,
): PreferenceReason[] {
  const reasons: PreferenceReason[] = []
  const sorted = [...preferences].sort((a, b) => a.id.localeCompare(b.id))
  for (const preference of sorted) {
    // 未知の種類・未知の sentiment は採点に使わない（落とさず無視する）
    const table: Record<string, Record<string, number> | undefined> = PREFERENCE_WEIGHTS.explicit
    const points = table[preference.target.kind]?.[preference.sentiment]
    if (points === undefined || !matchesPreference(recipe, preference, index)) continue
    reasons.push({
      kind: "explicit",
      preferenceId: preference.id,
      scope: preference.scope,
      profileId: preference.scope === "personal" ? preference.profileId : null,
      sentiment: preference.sentiment,
      target: preference.target,
      points,
    })
  }
  return reasons
}

function feedbackReasons(recipe: RecipeDef, feedback: readonly DishFeedback[]): PreferenceReason[] {
  const reasons: PreferenceReason[] = []
  for (const row of latestFeedbackByProfile(feedback, recipe.id, "taste")) {
    const value = row.taste as 1 | 2 | 3
    const points = PREFERENCE_WEIGHTS.taste[value] ?? 0
    reasons.push({ kind: "taste", feedbackId: row.id, profileId: row.profileId, eatenOn: row.eatenOn, value, points })
  }
  for (const row of latestFeedbackByProfile(feedback, recipe.id, "effort")) {
    const value = row.effort as 1 | 2 | 3
    const points = PREFERENCE_WEIGHTS.effort[value] ?? 0
    reasons.push({ kind: "effort", feedbackId: row.id, profileId: row.profileId, eatenOn: row.eatenOn, value, points })
  }
  for (const row of latestFeedbackByProfile(feedback, recipe.id, "again")) {
    const value = row.again === true
    const points = value ? PREFERENCE_WEIGHTS.again.yes : PREFERENCE_WEIGHTS.again.no
    reasons.push({ kind: "again", feedbackId: row.id, profileId: row.profileId, eatenOn: row.eatenOn, value, points })
  }
  return reasons
}

function sumOf(reasons: readonly PreferenceReason[], kind: PreferenceReason["kind"]): number {
  return reasons.filter((reason) => reason.kind === kind).reduce((sum, reason) => sum + reason.points, 0)
}

function dislikers(reasons: readonly PreferenceReason[]): string[] {
  const ids = new Set<string>()
  for (const reason of reasons) {
    if (reason.kind === "explicit") {
      if (reason.sentiment === "dislike" && reason.profileId !== null) ids.add(reason.profileId)
    } else if (reason.kind === "taste") {
      if (reason.value === 1) ids.add(reason.profileId)
    } else if (reason.kind === "again") {
      if (!reason.value) ids.add(reason.profileId)
    }
  }
  return [...ids].sort()
}

/**
 * レシピ 1 件の好みの点数と理由。`index` を渡すと、食材の好みを派生食材にも当てる。
 * 同じ入力からは必ず同じ結果を返す。
 */
export function scoreRecipePreference(
  recipe: RecipeDef,
  input: PreferenceInput,
  index?: IngredientIndex,
): PreferenceScore {
  const reasons = [
    ...explicitReasons(recipe, input.preferences, index),
    ...feedbackReasons(recipe, input.feedback),
  ]
  const explicit = sumOf(reasons, "explicit")
  const taste = sumOf(reasons, "taste")
  const effort = sumOf(reasons, "effort")
  const again = sumOf(reasons, "again")
  return {
    total: explicit + taste + effort + again,
    explicit,
    taste,
    effort,
    again,
    reasons,
    dislikedBy: dislikers(reasons),
  }
}

/**
 * 理由を日本語にする。名前は呼び出し側が `profileId` から引く（引けなければ null を返してよい）。
 * 記録に基づく理由だけを文にする。点数が 0 の「ふつう」は文にしない（null）。
 */
export function describePreferenceReason(
  reason: PreferenceReason,
  nameOf: (profileId: string) => string | null,
): string | null {
  const who = (profileId: string | null) => {
    const name = profileId === null ? null : nameOf(profileId)
    return name ? `${name}さん` : "家族"
  }
  if (reason.kind === "explicit") {
    const subject = reason.scope === "household" ? "家族共通の設定" : `${who(reason.profileId)}の設定`
    return `${subject}で「${reason.sentiment === "like" ? "好き" : "苦手"}」`
  }
  if (reason.points === 0) return null
  if (reason.kind === "taste") return `${who(reason.profileId)}が前回「${TASTE_LABELS[reason.value]}」`
  if (reason.kind === "effort") return `${who(reason.profileId)}が前回「${EFFORT_LABELS[reason.value]}」`
  return `${who(reason.profileId)}が前回「${reason.value ? "また食べたい" : "しばらくいい"}」`
}
