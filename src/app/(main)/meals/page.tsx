import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { MealWeekView } from "@/components/meals/meal-week-view"
import { currentWeekRangeJst } from "@/lib/utils/date-jst"

export default async function MealsPage() {
  // layout と同一リクエスト内のため React.cache() で auth クエリは dedupe される
  const { context } = await getAuthContext()
  if (!context) return null
  const { supabase, userId, householdId } = context

  // Vercel (UTC) でもクライアント (JST) でも同じ「JST の今週」を返す
  const { startDate, endDate } = currentWeekRangeJst()

  const { data: meals, error: mealsError } = await supabase
    .from("meals")
    .select(
      `
      id, date, meal_type, title, is_eating_out, template_id,
      meal_reactions ( user_id, reaction ),
      meal_ingredients ( name, quantity, category )
    `
    )
    .eq("household_id", householdId)
    .gte("date", startDate)
    .lte("date", endDate)
    .order("date")

  if (mealsError) {
    logSupabaseError("meals", "meals lookup failed", mealsError, {
      userId,
      householdId,
    })
  }

  return (
    <MealWeekView
      initialMeals={(meals as unknown as Parameters<typeof MealWeekView>[0]["initialMeals"]) ?? []}
      householdId={householdId}
      userId={userId}
      initialWeekStart={startDate}
    />
  )
}
