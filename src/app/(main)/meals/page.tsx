import { createClient } from "@/lib/supabase/server"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { MealWeekView } from "@/components/meals/meal-week-view"
import { currentWeekRangeJst } from "@/lib/utils/date-jst"

export default async function MealsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("household_id")
    .eq("id", user.id)
    .single()

  if (profileError) {
    logSupabaseError("meals", "profile lookup failed", profileError, {
      userId: user.id,
    })
  }

  if (!profile?.household_id) return null

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
    .eq("household_id", profile.household_id)
    .gte("date", startDate)
    .lte("date", endDate)
    .order("date")

  if (mealsError) {
    logSupabaseError("meals", "meals lookup failed", mealsError, {
      userId: user.id,
      householdId: profile.household_id,
    })
  }

  return (
    <MealWeekView
      initialMeals={(meals as unknown as Parameters<typeof MealWeekView>[0]["initialMeals"]) ?? []}
      householdId={profile.household_id}
      userId={user.id}
      initialWeekStart={startDate}
    />
  )
}
