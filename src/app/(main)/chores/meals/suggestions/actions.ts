"use server"

/**
 * 1日の主菜・副菜・主食・汁物の任意提案。読み取り専用で、ボタンを押すまで候補を作らない。
 * 候補の受領は一切保存せず、採用は既存 add_recipe の世帯/版ガードへ渡す。
 * レシピと除外情報はサーバーにだけ置き、クライアントへは表示用の値だけを返す。
 */

import { findAgeRuleWarnings } from "@/lib/meals/child-serving"
import { GROCERY_HORIZON_DAYS } from "@/lib/meals/server/plan-requests"
import { loadMealContext } from "@/lib/meals/server/context"
import { mealToday } from "@/lib/meals/server/today"
import { suggestNow } from "@/lib/meals/suggest-now"
import type { DishRole } from "@/lib/meals/types"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { isValidYmd, shiftYmd } from "@/lib/utils/date-jst"

const ROLES: readonly DishRole[] = ["main", "side", "staple", "soup"]
const CUISINES = new Set(["japanese", "western", "chinese"])
const STOCK_ORDER = { ready: 0, check: 1, buy: 2 } as const
const MAX_SHOWN = 3

export interface MealRoleCandidate {
  recipeId: string
  title: string
  role: DishRole
  minutes: number
  stock: "ready" | "check" | "buy"
  missingNames: string[]
  checkNames: string[]
}

export type SuggestMealRoleResult =
  | { ok: true; date: string; role: DishRole; revision: number; choices: MealRoleCandidate[] }
  | { ok: false; reason: "invalid" | "unavailable" | "conflict"; message: string }

/** 日付と区分はクライアントの入力。世帯IDは決して受け取らない。 */
export async function suggestMealRole(
  request: { date: string; role: DishRole; expectedRevision: number },
): Promise<SuggestMealRoleResult> {
  if (
    !request || typeof request !== "object" ||
    !isValidYmd(request.date) || !ROLES.includes(request.role) ||
    !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
    Object.keys(request).some((key) => !["date", "role", "expectedRevision"].includes(key))
  ) {
    return { ok: false, reason: "invalid", message: "対象の日付と料理の種類を確認してください。" }
  }
  const today = mealToday()
  if (request.date < today || request.date > shiftYmd(today, GROCERY_HORIZON_DAYS - 1)) {
    return { ok: false, reason: "invalid", message: "今日以降の対象日だけ料理を提案できます。" }
  }

  const auth = await getAuthContext()
  if (auth.error !== null || !auth.context) {
    return { ok: false, reason: "unavailable", message: "ログインと世帯の設定を確認してください。" }
  }
  const { supabase, householdId } = auth.context
  try {
    const loaded = await loadMealContext(supabase, householdId, {
      include: ["settings", "pantry", "exclusions", "preferences", "feedback", "plan", "children"] as const,
      today,
      planRange: { from: today, to: shiftYmd(today, GROCERY_HORIZON_DAYS - 1) },
    })
    if (!loaded.ok) {
      return { ok: false, reason: "unavailable", message: "献立・在庫・除外設定をすべて確認できませんでした。読み直してください。" }
    }
    const context = loaded.context
    if ((context.unreadable.plan ?? 0) > 0 || (context.unreadable.pantry ?? 0) > 0 || (context.unreadable.children ?? 0) > 0) {
      return { ok: false, reason: "unavailable", message: "読めない献立か食材があるため、安全に提案できません。" }
    }
    if (context.plan.revision !== request.expectedRevision) {
      return { ok: false, reason: "conflict", message: "別の端末で献立が変更されました。最新の献立を読み直してください。" }
    }
    const active = context.plan.entries.filter((entry) => entry.date === request.date && entry.status !== "skipped")
    if (active.some((entry) => entry.role === request.role)) {
      return { ok: false, reason: "conflict", message: "この種類の料理は既に決まっています。既存の料理は変更しません。" }
    }

    const hasRiceInMain = active.some((entry) =>
      entry.role === "main" && context.lookup.recipeById.get(entry.recipeId ?? "")?.includesStaple === true,
    )
    if (request.role === "staple" && hasRiceInMain) {
      return { ok: false, reason: "invalid", message: "丼・カレーなど主食を含む主菜があるため、主食を重ねません。" }
    }

    const existingRecipeIds = new Set(active.map((entry) => entry.recipeId).filter((id): id is string => id !== null))
    const genre = new Set(
      active.flatMap((entry) => context.lookup.recipeById.get(entry.recipeId ?? "")?.tags ?? [])
        .filter((tag) => CUISINES.has(tag)),
    )
    const children = context.children.map((child) => ({ id: child.id, birthDate: child.birthDate, mealStage: null }))
    // 既に料理がある日はその料理の人数で採用される。候補の在庫判定も同じ人数に揃える。
    const servings = active.find((entry) => entry.status === "proposed" || entry.status === "confirmed")?.servings ?? context.settings.servings
    const suggestions = suggestNow({
      today,
      eatOn: request.date,
      servings,
      pantry: context.pantry,
      exclusions: context.exclusions,
      preferences: context.preferences,
      feedback: context.feedback,
      stapleIngredientIds: context.settings.stapleIngredientIds,
      maxMinutes: context.settings.maxCookMinutes,
      catalog: context.lookup,
      roles: [request.role],
      limit: 50,
    })
    const safe = [...suggestions.ready, ...suggestions.check, ...suggestions.buy].filter(({ recipe }) => {
      if (existingRecipeIds.has(recipe.id)) return false
      if (request.role === "main" && recipe.includesStaple === true &&
        active.some((entry) => entry.role === "staple")) return false
      return findAgeRuleWarnings(recipe.ingredients, children, request.date, context.lookup.index).length === 0
    })
    safe.sort((a, b) =>
      STOCK_ORDER[a.level] - STOCK_ORDER[b.level] ||
      Number(b.recipe.tags.some((tag) => genre.has(tag))) - Number(a.recipe.tags.some((tag) => genre.has(tag))) ||
      b.score.total - a.score.total || a.recipe.id.localeCompare(b.recipe.id),
    )
    return {
      ok: true,
      date: request.date,
      role: request.role,
      revision: context.plan.revision,
      choices: safe.slice(0, MAX_SHOWN).map(({ recipe, level, match }) => ({
        recipeId: recipe.id,
        title: recipe.title,
        role: recipe.role,
        minutes: recipe.minutes,
        stock: level,
        missingNames: match.missing.map((item) => item.name).slice(0,5),
        checkNames: match.toCheck.map((item) => item.name).slice(0,5),
      })),
    }
  } catch {
    return { ok: false, reason: "unavailable", message: "提案を読み込めませんでした。再度お試しください。" }
  }
}
