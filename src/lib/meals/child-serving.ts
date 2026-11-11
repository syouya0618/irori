/**
 * 子どもの取り分け案内と年齢制約。
 *
 * 規則:
 * - 取り分け案内は `childServing` を持つレシピだけに出す。一般ガイドがあるだけで全料理を対応扱いにしない。
 * - 案内は、保護者が食事段階を「幼児食」と設定した子にだけ出す。月齢だけで段階を決めつけない
 *   （段階が未設定なら、2 歳以上でも出さず「未設定」と返す。C-61 / C-64）。
 * - 離乳開始前・離乳期（初期〜完了期）・未設定・対象月齢外では「そのまま食べられる」と表示しない。
 * - 年齢制約（`ageRule`。1 歳未満のはちみつ等）は辞書の一次資料つきデータだけで判定し、
 *   加熱の有無では緩めない。派生食材（`derivedFrom`）と任意材料も対象。
 * - 新しい食材の開始・アレルギーの診断・治療上の食事判断は提案しない。
 */

import { ageMonthsAt } from "@/lib/domain/child-age"

import { ingredientNameOf, lineageOf } from "./lookup"
import type { IngredientIndex } from "./normalize"
import type { ChildServingGuide, RecipeDef, RecipeIngredient } from "./types"

/** 保護者が設定する食事段階。 */
export const GUARDIAN_MEAL_STAGES = [
  "not_started",
  "weaning_early",
  "weaning_mid",
  "weaning_late",
  "weaning_complete",
  "toddler",
] as const
export type GuardianMealStage = (typeof GUARDIAN_MEAL_STAGES)[number]

export const GUARDIAN_MEAL_STAGE_LABELS: Readonly<Record<GuardianMealStage, string>> = {
  not_started: "離乳開始前",
  weaning_early: "離乳初期",
  weaning_mid: "離乳中期",
  weaning_late: "離乳後期",
  weaning_complete: "離乳完了期",
  toddler: "幼児食",
}

export interface MealChild {
  id: string
  /** YYYY-MM-DD。未登録は null。 */
  birthDate: string | null
  /** 保護者の設定。未設定は null。未知の値は「設定を読めない」として案内を出さない。 */
  mealStage: string | null
}

export type ChildServingReason = "未対応" | "未設定" | "離乳開始前" | "対象月齢外"

export type ChildServingResult =
  | {
      show: ChildServingGuide
      /** 保護者の設定に基づく（月齢だけからは出さない）。 */
      basis: "guardian_stage"
      /** 表示用の見出し（保護者が設定した段階の名前）。 */
      label: string
    }
  | { show: null; reason: ChildServingReason }

function isGuardianMealStage(value: string): value is GuardianMealStage {
  return (GUARDIAN_MEAL_STAGES as readonly string[]).includes(value)
}

/** 基準日時点の月齢（暦月。生年月日が無い・不正・基準日より後なら null）。 */
export function childAgeMonths(birthDate: string | null, onDate: string): number | null {
  return ageMonthsAt(birthDate, onDate)
}

export interface AgeRuleWarning {
  childId: string
  ingredientId: string
  ingredientName: string
  /** 制約を持つ食材（材料そのもの、または由来する食材）。 */
  ruleIngredientId: string
  minAgeMonths: number
  sourceId: string
  /** true = 生年月日が無く判定できない（確認を促す）。false = 月齢が制約未満。 */
  ageUnknown: boolean
}

interface AgeRuleHit {
  ingredientId: string
  ruleIngredientId: string
  minAgeMonths: number
  sourceId: string
}

function ageRuleHits(
  ingredients: readonly RecipeIngredient[],
  index: IngredientIndex,
): AgeRuleHit[] {
  const hits: AgeRuleHit[] = []
  for (const ingredient of ingredients) {
    const ids = [ingredient.ingredientId, ...lineageOf(ingredient.ingredientId, index).ancestors]
    for (const id of ids) {
      const rule = index.byId.get(id)?.ageRule
      if (!rule) continue
      const duplicate = hits.some(
        (h) => h.ingredientId === ingredient.ingredientId && h.ruleIngredientId === id,
      )
      if (duplicate) continue
      hits.push({
        ingredientId: ingredient.ingredientId,
        ruleIngredientId: id,
        minAgeMonths: rule.minAgeMonths,
        sourceId: rule.sourceId,
      })
    }
  }
  return hits
}

/**
 * 年齢制約に触れる材料（任意材料・派生食材を含む）と、該当する子の組を返す。
 * 月齢が制約以上の子には何も返さない（1 歳以上のはちみつに警告は出さない）。
 * 生年月日が無い子は判定できないため、`ageUnknown` として返す。
 */
export function findAgeRuleWarnings(
  ingredients: readonly RecipeIngredient[],
  children: readonly MealChild[],
  onDate: string,
  index: IngredientIndex,
): AgeRuleWarning[] {
  const hits = ageRuleHits(ingredients, index)
  const warnings: AgeRuleWarning[] = []
  for (const child of children) {
    const age = childAgeMonths(child.birthDate, onDate)
    for (const hit of hits) {
      if (age !== null && age >= hit.minAgeMonths) continue
      warnings.push({
        childId: child.id,
        ingredientId: hit.ingredientId,
        ingredientName: ingredientNameOf(hit.ingredientId, index),
        ruleIngredientId: hit.ruleIngredientId,
        minAgeMonths: hit.minAgeMonths,
        sourceId: hit.sourceId,
        ageUnknown: age === null,
      })
    }
  }
  return warnings
}

const HIDDEN = (reason: ChildServingReason): ChildServingResult => ({ show: null, reason })

/**
 * レシピ 1 件 × 子ども 1 人の取り分け案内。
 * `index` を渡すと、年齢制約に触れる材料があるときは案内を出さない。
 */
export function resolveChildServing(
  recipe: Pick<RecipeDef, "childServing" | "ingredients">,
  child: MealChild,
  onDate: string,
  index?: IngredientIndex,
): ChildServingResult {
  const guide = recipe.childServing
  if (!guide) return HIDDEN("未対応")

  const stage = child.mealStage
  if (stage !== null && !isGuardianMealStage(stage)) return HIDDEN("未設定")
  if (stage === "not_started") return HIDDEN("離乳開始前")
  // 離乳期（初期〜完了期）の個別レシピ対応は持たない。保護者の設定を月齢より優先する
  if (stage !== null && stage !== "toddler") return HIDDEN("対象月齢外")

  const age = childAgeMonths(child.birthDate, onDate)
  if (age === null) return HIDDEN("未設定")
  if (age < guide.minAgeMonths) return HIDDEN("対象月齢外")
  // 段階が未設定の子には、2 歳以上でも月齢だけからは出さない（離乳完了期の食事の子もいる）
  if (stage === null) return HIDDEN("未設定")
  if (index && findAgeRuleWarnings(recipe.ingredients, [child], onDate, index).length > 0) {
    return HIDDEN("対象月齢外")
  }
  return { show: guide, basis: "guardian_stage", label: GUARDIAN_MEAL_STAGE_LABELS.toddler }
}

export interface RecipeChildSummary {
  perChild: { childId: string; result: ChildServingResult }[]
  warnings: AgeRuleWarning[]
}

/** レシピ 1 件について、世帯の子ども全員ぶんの案内と年齢制約の警告をまとめる。 */
export function summarizeChildServing(
  recipe: Pick<RecipeDef, "childServing" | "ingredients">,
  children: readonly MealChild[],
  onDate: string,
  index: IngredientIndex,
): RecipeChildSummary {
  return {
    perChild: children.map((child) => ({
      childId: child.id,
      result: resolveChildServing(recipe, child, onDate, index),
    })),
    warnings: findAgeRuleWarnings(recipe.ingredients, children, onDate, index),
  }
}
