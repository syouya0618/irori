import { getAuthContext } from "@/lib/supabase/auth-context"
import { BabyDashboard } from "@/components/baby/baby-dashboard"
import { todayJstString, shiftYmd } from "@/lib/utils/date-jst"

export default async function BabyPage() {
  const result = await getAuthContext()
  if (result.error !== null) return null
  const { supabase, userId, householdId } = result.context

  const todayJst = todayJstString()

  const { data: logs } = await supabase
    .from("baby_logs")
    .select(
      "id, log_type, logged_at, logged_by, feeding_type, amount_ml, diaper_type, ended_at, memo, created_at",
    )
    .eq("household_id", householdId)
    .gte("logged_at", `${todayJst}T00:00:00+09:00`)
    .lt("logged_at", `${shiftYmd(todayJst, 1)}T00:00:00+09:00`)
    .order("logged_at", { ascending: false })

  return (
    <BabyDashboard
      initialLogs={logs ?? []}
      householdId={householdId}
      userId={userId}
      initialDate={todayJst}
    />
  )
}
