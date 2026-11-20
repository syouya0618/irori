/**
 * ごはんの下位 route の綴り（正本）。
 *
 * 境界指令を持たない中立モジュール（Server Component・Server Action の `revalidatePath`・
 * Client Component のどこからでも値 import できる）。`"use client"` のファイルへ置くと、
 * Server 側からの値 import が実行時に壊れる。
 */

export const MEALS_BASE_HREF = "/chores/meals"
export const MEALS_NOW_HREF = "/chores/meals/now"
export const MEALS_PLAN_HREF = "/chores/meals/plan"
export const MEALS_SHOPPING_HREF = "/chores/meals/shopping"
export const MEALS_PANTRY_HREF = "/chores/meals/pantry"
export const MEALS_MEMO_HREF = "/chores/meals/memo"
export const MEALS_SETTINGS_HREF = "/chores/meals/settings"
export const MEALS_RECIPES_HREF = "/chores/meals/recipes"

/** 設定画面の区画の id（別の画面からその区画へ送るときの行き先）。 */
export const MEAL_SETTINGS_CHILD_STAGES_ID = "meal-child-stages"
export const MEAL_SETTINGS_FEEDBACK_ID = "meal-feedback"
/** 設定の「子どもの食事」（食事の段階）への href。 */
export const MEAL_CHILD_STAGES_HREF = `${MEALS_SETTINGS_HREF}#${MEAL_SETTINGS_CHILD_STAGES_ID}`

export interface MealSegment {
  href: string
  label: string
}

/** 日常の入口は 3 画面。従来の詳細機能は route を残し、ここには並べない。 */
export const MEAL_SEGMENTS: readonly MealSegment[] = [
  { href: MEALS_BASE_HREF, label: "スケジュール" },
  { href: MEALS_PANTRY_HREF, label: "冷蔵庫の在庫" },
  { href: MEALS_MEMO_HREF, label: "メモ" },
]

/**
 * 切替には並べないが、ごはんの下位に在る route。現在地の判定に含める
 * （含めないと、設定やレシピの画面で「今夜」が現在地に見える）。
 */
export const MEAL_HIDDEN_SEGMENTS: readonly MealSegment[] = [
  { href: MEALS_PLAN_HREF, label: "献立の詳細" },
  { href: MEALS_NOW_HREF, label: "料理の候補" },
  { href: MEALS_SHOPPING_HREF, label: "買い物の詳細" },
  { href: MEALS_SETTINGS_HREF, label: "設定" },
  { href: MEALS_RECIPES_HREF, label: "レシピ" },
]

/** レシピ詳細の href。ID は path の 1 区切りとして符号化する。 */
export function mealRecipeHref(recipeId: string): string {
  return `${MEALS_RECIPES_HREF}/${encodeURIComponent(recipeId)}`
}

/** ごはんの全画面を再検証するときの path（`revalidatePath(MEALS_BASE_HREF, "layout")`）。 */
export const MEALS_REVALIDATE_PATH = MEALS_BASE_HREF
