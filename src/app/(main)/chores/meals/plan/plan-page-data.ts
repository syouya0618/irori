/**
 * 献立の画面（/chores/meals/plan）が 1 回で読むデータの組み立て。
 *
 * **サーバー専用**（食材辞書・レシピのカタログを使う `context.ts` を import する。Client Component から
 * 値 import しない）。献立の表示（`buildDinnerPlanView`）と同じ 1 回の読み込みから、画面の操作に要る
 * 補助の値を作る:
 *
 * - 料理の後に状態を更新できる食材（その料理の材料に当たる、登録済みの食材）。**候補を出すだけで、
 *   在庫は何も変えない**（更新は利用者が選んだ食材だけ）。
 * - この料理・この日の、**自分の**食後評価（家族の評価は載せない。評価は本人だけが変えられる）。
 * - 手動料理の材料（編集フォームの初期値）。
 *
 * 取得の失敗を「空」として返さない（`{ ok: false }`。page が error boundary へ渡す）。
 */

import type {
  CookedPantryOption,
  CustomIngredientView,
  EntryFeedbackView,
  PlanPageExtras,
} from "@/components/chores/meals/plan/plan-types"
import { PLAN_VIEW_DAYS } from "@/components/chores/meals/plan/plan-query"
import { ingredientNameOf } from "@/lib/meals/lookup"
import {
  type MealContext,
  type MealLoadFailure,
  type MealSupabase,
  loadMealContext,
} from "@/lib/meals/server/context"
import { PANTRY_STATUS_LABELS, formatQuantityJa } from "@/lib/meals/server/format"
import { type DinnerPlanView, buildDinnerPlanView } from "@/lib/meals/server/plan-views"
import type { StoredPlanEntry } from "@/lib/meals/server/rows"
import { mealDateRange, mealToday } from "@/lib/meals/server/today"
import type { RecipeIngredient } from "@/lib/meals/types"

/**
 * `children` は、年齢の制約の注意（1 歳未満のはちみつ等。`DinnerEntryView.ageWarnings`）に要る。
 * 外すと注意は出ず、`ageRulesChecked` が false になる（「注意なし」とは言えなくなる）。
 */
export const PLAN_PAGE_PARTS = ["settings", "pantry", "exclusions", "plan", "feedback", "children"] as const
/** 子どもを読めなかったときの読み直しに使う部分（年齢の注意だけを諦める）。 */
const PLAN_PAGE_PARTS_WITHOUT_CHILDREN = ["settings", "pantry", "exclusions", "plan", "feedback"] as const
/** 画面の操作に要る補助の値の組み立てが読む部分（子どもは使わない）。 */
export type PlanPageContext = MealContext<(typeof PLAN_PAGE_PARTS_WITHOUT_CHILDREN)[number]>

function ingredientsOf(entry: StoredPlanEntry, context: PlanPageContext): readonly RecipeIngredient[] {
  if (entry.recipeId === null) return entry.customIngredients ?? []
  return context.lookup.recipeById.get(entry.recipeId)?.ingredients ?? []
}

/** 画面の操作に要る補助の値（純粋。同じ入力からは同じ結果）。 */
export function buildPlanPageExtras(context: PlanPageContext, view: DinnerPlanView, userId: string): PlanPageExtras {
  const { today, lookup } = context
  const shown = new Set(view.days.flatMap((day) => day.entries.map((entry) => entry.id)))
  const pantryByEntry: Record<string, CookedPantryOption[]> = {}
  const feedbackByEntry: Record<string, EntryFeedbackView> = {}
  const customByEntry: Record<string, CustomIngredientView[]> = {}

  for (const entry of context.plan.entries) {
    if (!shown.has(entry.id)) continue

    if (entry.recipeId === null) {
      customByEntry[entry.id] = (entry.customIngredients ?? []).map((ingredient) => ({
        name: ingredientNameOf(ingredient.ingredientId, lookup.index),
        amount: ingredient.quantity.amount,
        unit: ingredient.quantity.unit,
        optional: ingredient.optional === true,
      }))
    }

    // 料理の後の操作（食材の更新・評価）は、今日までの日だけ
    if (entry.date > today) continue

    if (entry.status !== "skipped") {
      const used = new Set(ingredientsOf(entry, context).map((ingredient) => ingredient.ingredientId))
      const options = context.pantry
        // 使い切った食材は「使った食材」の候補に出さない（減らす対象が無い）
        .filter((item) => item.ingredientId !== null && used.has(item.ingredientId) && item.status !== "out")
        .map((item) => ({
          id: item.id,
          version: item.version,
          name: item.name,
          quantityText: formatQuantityJa(item.quantity),
          status: item.status,
          statusLabel: PANTRY_STATUS_LABELS[item.status] ?? "",
        }))
        .sort((a, b) => a.name.localeCompare(b.name, "ja") || a.id.localeCompare(b.id))
      if (options.length > 0) pantryByEntry[entry.id] = options
    }

    const title = view.days.flatMap((day) => day.entries).find((item) => item.id === entry.id)?.title ?? ""
    const mine = context.feedback.find(
      (feedback) =>
        feedback.profileId === userId &&
        feedback.eatenOn === entry.date &&
        (entry.recipeId !== null
          ? feedback.recipeId === entry.recipeId
          : feedback.recipeId === null && feedback.dishTitle === title),
    )
    if (mine) {
      feedbackByEntry[entry.id] = {
        id: mine.id,
        version: mine.version,
        taste: mine.taste,
        effort: mine.effort,
        again: mine.again,
        excludeFromLearning: mine.excludeFromLearning,
      }
    }
  }
  return { pantryByEntry, feedbackByEntry, customByEntry }
}

export type PlanPageData =
  | { ok: true; view: DinnerPlanView; extras: PlanPageExtras }
  | { ok: false; failures: MealLoadFailure[] }

/**
 * 献立の画面のデータを 1 回で読む。`startDate` から 7 日ぶん。
 * 「買い物リストが古いか」は今日以降の確定の有無でも決まるので、今日も範囲へ含めて読む
 * （`loadDinnerPlanView` と同じ範囲）。
 */
export async function loadPlanPageData(
  supabase: MealSupabase,
  householdId: string,
  userId: string,
  options: { startDate: string; today?: string },
): Promise<PlanPageData> {
  const today = options.today ?? mealToday()
  const range = mealDateRange(options.startDate, PLAN_VIEW_DAYS)
  if (range === null) return { ok: false, failures: [{ part: "plan", kind: "query" }] }
  const from = range.from < today ? range.from : today
  const to = range.to > today ? range.to : today
  const loaded = await loadMealContext(supabase, householdId, {
    include: PLAN_PAGE_PARTS,
    planRange: { from, to },
    today,
  })
  if (loaded.ok) {
    const view = buildDinnerPlanView(loaded.context, { startDate: range.from, days: PLAN_VIEW_DAYS })
    if (view === null) return { ok: false, failures: [{ part: "plan", kind: "query" }] }
    return { ok: true, view, extras: buildPlanPageExtras(loaded.context, view, userId) }
  }
  // 子どもだけを読めなかったときは、献立まで倒さない。子ども抜きで読み直し、年齢の注意は
  // 「確認できていない」と出す（`ageRulesChecked` が false。「注意なし」とは言わない）
  if (loaded.failures.length === 0 || !loaded.failures.every((failure) => failure.part === "children")) return loaded
  const fallback = await loadMealContext(supabase, householdId, {
    include: PLAN_PAGE_PARTS_WITHOUT_CHILDREN,
    planRange: { from, to },
    today,
  })
  if (!fallback.ok) return fallback
  const view = buildDinnerPlanView(fallback.context, { startDate: range.from, days: PLAN_VIEW_DAYS })
  if (view === null) return { ok: false, failures: [{ part: "plan", kind: "query" }] }
  return { ok: true, view, extras: buildPlanPageExtras(fallback.context, view, userId) }
}
