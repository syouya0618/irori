import { getAuthContext } from "@/lib/supabase/auth-context"
import { BabyDashboard } from "@/components/baby/baby-dashboard"
import { todayJstString, shiftYmd } from "@/lib/utils/date-jst"

export default async function BabyPage() {
  const result = await getAuthContext()
  if (result.error !== null) return null
  const { supabase, userId, householdId } = result.context

  const todayJst = todayJstString()

  // 今日のログ + 最新の完了済み睡眠（覚醒時間計算用）を並列取得
  const [{ data: logs }, { data: lastSleepData }] = await Promise.all([
    supabase
      .from("baby_logs")
      .select(
        "id, log_type, logged_at, logged_by, feeding_type, amount_ml, diaper_type, ended_at, temperature, weight_g, height_cm, duration_min, memo, created_at",
      )
      .eq("household_id", householdId)
      .gte("logged_at", `${todayJst}T00:00:00+09:00`)
      .lt("logged_at", `${shiftYmd(todayJst, 1)}T00:00:00+09:00`)
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
  ])

  return (
    <BabyDashboard
      initialLogs={logs ?? []}
      householdId={householdId}
      userId={userId}
      initialDate={todayJst}
      lastSleepEndedAt={lastSleepData?.ended_at ?? null}
    />
  )
}
