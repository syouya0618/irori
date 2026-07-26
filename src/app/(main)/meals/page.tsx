import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { MealWeekView } from "@/components/meals/meal-week-view"
import { UpcomingEventsCard } from "@/components/meals/upcoming-events-card"
import type { CalendarEventRecord } from "@/components/calendar/use-month-events"
import { CALENDAR_EVENT_COLUMNS } from "@/lib/domain/calendar-event-columns"
import {
  currentWeekRangeJst,
  shiftYmd,
  todayJstString,
} from "@/lib/utils/date-jst"

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

  // 今日・明日に重なる予定（CAL-4）。start_url = /meals ゆえ起動直後に目に入る。
  const today = todayJstString()
  const { data: upcomingEvents, error: upcomingError } = await supabase
    .from("calendar_events")
    .select(CALENDAR_EVENT_COLUMNS)
    .eq("household_id", householdId)
    .gte("end_date", today) // 重なり判定: end_date >= 今日
    .lte("start_date", shiftYmd(today, 1)) //          AND start_date <= 明日
    .order("start_date")

  if (upcomingError) {
    logSupabaseError("meals", "upcoming events lookup failed", upcomingError, {
      userId,
      householdId,
    })
  }

  return (
    <>
      <UpcomingEventsCard
        initialEvents={(upcomingEvents as unknown as CalendarEventRecord[]) ?? []}
        householdId={householdId}
        initialToday={today}
      />
      <MealWeekView
        initialMeals={
          (meals as unknown as Parameters<
            typeof MealWeekView
          >[0]["initialMeals"]) ?? []
        }
        householdId={householdId}
        userId={userId}
        initialWeekStart={startDate}
      />
    </>
  )
}
