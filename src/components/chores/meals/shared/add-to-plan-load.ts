/**
 * 「献立に入れる」のための、今日からの献立の空きの読み込み。
 *
 * **サーバー専用**（食材辞書・レシピのカタログを使う `context.ts` を import する。Client Component から
 * 値 import しない）。今あるもので・レシピ詳細の page が呼ぶ。
 *
 * 読めなかったときは null（「空いている」と偽らない。呼び出し側は「献立に入れる」の釦を出さない）。
 * 足す料理の人数に設定の人数を使うので、設定も読む（未設定なら標準の人数）。
 */

import { type MealSupabase, loadMealContext } from "@/lib/meals/server/context"

import { type AddToPlanSlots, addToPlanRange, buildAddToPlanSlots } from "./add-to-plan-data"

export async function loadAddToPlanSlots(
  supabase: MealSupabase,
  householdId: string,
  today: string,
): Promise<AddToPlanSlots | null> {
  const loaded = await loadMealContext(supabase, householdId, {
    include: ["plan", "settings"],
    planRange: addToPlanRange(today),
    today,
  })
  if (!loaded.ok) return null
  const { plan, lookup, unreadable, settings } = loaded.context
  return buildAddToPlanSlots(
    {
      today,
      revision: plan.revision,
      servings: settings.servings,
      entries: plan.entries,
      unreadableEntries: unreadable.plan ?? 0,
    },
    (recipeId) => lookup.recipeById.get(recipeId)?.title,
  )
}
