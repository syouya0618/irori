import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { BabyDashboard } from "@/components/baby/baby-dashboard"
import { todayJstString, shiftYmd } from "@/lib/utils/date-jst"

export default async function BabyPage() {
  const result = await getAuthContext()
  if (result.error !== null) return null
  const { supabase, userId, householdId } = result.context

  const todayJst = todayJstString()
  const weeklyStartJst = shiftYmd(todayJst, -6)
  const tomorrowJst = shiftYmd(todayJst, 1)
  const todayStart = `${todayJst}T00:00:00+09:00`
  const tomorrowStart = `${tomorrowJst}T00:00:00+09:00`
  const weeklyStart = `${weeklyStartJst}T00:00:00+09:00`

  // 今日のログ + 最新の完了済み睡眠 + 週間サマリー用ログを並列取得
  const [
    { data: logs },
    { data: lastSleepData, error: lastSleepError },
    { data: weeklyLogs },
  ] = await Promise.all([
      supabase
        .from("baby_logs")
        .select(
          "id, log_type, logged_at, logged_by, feeding_type, amount_ml, diaper_type, ended_at, temperature, weight_g, height_cm, duration_min, memo, created_at",
        )
        .eq("household_id", householdId)
        .gte("logged_at", todayStart)
        .lt("logged_at", tomorrowStart)
        .order("logged_at", { ascending: false }),
      supabase
        .from("baby_logs")
        .select("ended_at")
        .eq("household_id", householdId)
        .eq("log_type", "sleep")
        .not("ended_at", "is", null)
        .order("ended_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("baby_logs")
        .select(
          "id, log_type, logged_at, logged_by, feeding_type, amount_ml, diaper_type, ended_at, temperature, weight_g, height_cm, duration_min, memo, created_at",
        )
        .eq("household_id", householdId)
        .lt("logged_at", tomorrowStart)
        .or(
          `logged_at.gte.${weeklyStart},and(log_type.eq.sleep,ended_at.gte.${weeklyStart})`,
        )
        .order("logged_at", { ascending: false }),
    ])

  if (lastSleepError) {
    logSupabaseError("baby", "last sleep lookup failed", lastSleepError, {
      householdId,
    })
  }

  return (
    <BabyDashboard
      initialLogs={logs ?? []}
      initialWeeklyLogs={weeklyLogs ?? []}
      householdId={householdId}
      userId={userId}
      initialDate={todayJst}
      lastSleepEndedAt={lastSleepData?.ended_at ?? null}
    />
  )
}
