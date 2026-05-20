import { createClient } from "@/lib/supabase/server"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { MealWeekView } from "@/components/meals/meal-week-view"
import { getMonday, addDays, formatDateKey } from "@/lib/utils/date"

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

  const monday = getMonday(new Date())
  const sunday = addDays(monday, 6)
  const startStr = formatDateKey(monday)
  const endStr = formatDateKey(sunday)

  const { data: meals } = await supabase
    .from("meals")
    .select(
      `
      id, date, meal_type, title, is_eating_out, template_id,
      meal_reactions ( user_id, reaction ),
      meal_ingredients ( name, quantity, category )
    `
    )
    .eq("household_id", profile.household_id)
    .gte("date", startStr)
    .lte("date", endStr)
    .order("date")

  return (
    <MealWeekView
      initialMeals={(meals as unknown as Parameters<typeof MealWeekView>[0]["initialMeals"]) ?? []}
      householdId={profile!.household_id!}
      userId={user!.id}
      initialWeekStart={startStr}
    />
  )
}
