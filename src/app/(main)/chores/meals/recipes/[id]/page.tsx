import { notFound } from "next/navigation"

import { RecipeDetail } from "@/components/chores/meals/recipes/recipe-detail"
import { AddToPlanProvider } from "@/components/chores/meals/shared/add-to-plan"
import { loadAddToPlanSlots } from "@/components/chores/meals/shared/add-to-plan-load"
import { getMealLookup, loadMealContext, requireMealContext } from "@/lib/meals/server/context"
import { isCatalogIdText } from "@/lib/meals/server/meal-input"
import { mealToday } from "@/lib/meals/server/today"
import { RECIPE_DETAIL_PARTS, buildRecipeDetailView } from "@/lib/meals/server/views"
import { getAuthContext } from "@/lib/supabase/auth-context"

/** `?servings=` の値を整数へ読む。読めなければ undefined（世帯の設定の人数を使う）。 */
function servingsOf(value: string | string[] | undefined): number | undefined {
  if (typeof value !== "string" || !/^\d{1,2}$/.test(value)) return undefined
  return Number(value)
}

/**
 * レシピ詳細（/chores/meals/recipes/[id]）。世帯の人数に合わせた材料・手順・含まれるアレルゲン・
 * 世帯の「使わない食材」に触れる場合の警告・子どもごとの取り分け案内（または未対応の理由）・
 * 年齢の制約の警告を出す。
 *
 * - `params` / `searchParams` は Promise（Next 16。
 *   `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md`）。
 * - カタログに無い ID・ID の形でない値は `notFound()`。世帯のデータを読む前に確かめる。
 * - 表示する人数は世帯の設定（未設定なら標準の人数と明示）。献立の枠から開くときは
 *   `?servings=` でその枠の人数を渡せる（範囲外・不正な値は無視して設定の人数にする）。
 * - 読めなければ throw（ごはんの error boundary が受ける）。使わない食材を読めないまま、
 *   警告の無い詳細を出さない。
 */
export default async function MealRecipePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ servings?: string | string[] }>
}) {
  const { context } = await getAuthContext()
  if (!context) return null
  const { supabase, userId, householdId } = context

  const [{ id }, query] = await Promise.all([params, searchParams])
  if (!isCatalogIdText(id) || !getMealLookup().recipeById.has(id)) notFound()

  const today = mealToday()
  const [loaded, slots] = await Promise.all([
    loadMealContext(supabase, householdId, { include: RECIPE_DETAIL_PARTS, today }),
    // この料理を献立へ入れる操作（R48）のための、今日からの献立の空き。読めなくても詳細は出す
    // （その場合は「献立に入れる」の釦を出さないだけ）
    loadAddToPlanSlots(supabase, householdId, today),
  ])
  const view = buildRecipeDetailView(requireMealContext(loaded), id, { servings: servingsOf(query.servings) })
  if (view === null) notFound()

  if (slots === null) return <RecipeDetail view={view} />
  return (
    <AddToPlanProvider
      // 持ち主（利用者・世帯）が替われば、保存の手順ごと作り直す
      key={`${userId}:${householdId}`}
      owner={{ userId, householdId }}
      slots={slots}
    >
      <RecipeDetail view={view} />
    </AddToPlanProvider>
  )
}
