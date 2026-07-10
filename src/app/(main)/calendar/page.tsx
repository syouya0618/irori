import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { CalendarView } from "@/components/calendar/calendar-view"
import type { CalendarEventRecord } from "@/components/calendar/use-month-events"
import { currentMonthFirstJst, gridRangeOf } from "@/lib/domain/calendar-grid"

export default async function CalendarPage() {
  const { context } = await getAuthContext()
  if (!context) return null
  const { supabase, householdId } = context

  const monthFirst = currentMonthFirstJst()
  const { gridStart, gridEnd } = gridRangeOf(monthFirst)

  const { data: events, error } = await supabase
    .from("calendar_events")
    .select(
      "id, title, memo, is_all_day, start_date, end_date, start_at, end_at, source",
    )
    .eq("household_id", householdId)
    .lte("start_date", gridEnd) // 重なり判定: start_date <= gridEnd
    .gte("end_date", gridStart) //           AND end_date >= gridStart
    .order("start_date")

  if (error) {
    logSupabaseError("calendar", "month lookup failed", error, { householdId })
  }

  return (
    <CalendarView
      initialEvents={(events as unknown as CalendarEventRecord[]) ?? []}
      householdId={householdId}
      initialMonthFirst={monthFirst}
    />
  )
}
