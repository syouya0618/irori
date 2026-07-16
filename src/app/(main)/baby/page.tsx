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

  // 今日のログ + 最新の完了済み睡眠 + 週間サマリー用ログ + 赤ちゃんプロフィールを並列取得
  const [
    { data: logs, error: logsError },
    { data: lastSleepData, error: lastSleepError },
    { data: weeklyLogs, error: weeklyLogsError },
    { data: household, error: householdError },
    { data: growthLogs, error: growthLogsError },
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
      supabase
        .from("households")
        .select("baby_name, baby_birth_date")
        .eq("id", householdId)
        .maybeSingle(),
      // 成長曲線用: 成長ログを古い順に全件（低頻度データ・1000 未満想定、順序を昇順で決定化）
      supabase
        .from("baby_logs")
        .select(
          "id, log_type, logged_at, logged_by, feeding_type, amount_ml, diaper_type, ended_at, temperature, weight_g, height_cm, duration_min, memo, created_at",
        )
        .eq("household_id", householdId)
        .eq("log_type", "growth")
        .order("logged_at", { ascending: true }),
    ])

  if (logsError) {
    logSupabaseError("baby", "today logs lookup failed", logsError, {
      householdId,
    })
  }

  if (lastSleepError) {
    logSupabaseError("baby", "last sleep lookup failed", lastSleepError, {
      householdId,
    })
  }

  if (weeklyLogsError) {
    logSupabaseError("baby", "weekly logs lookup failed", weeklyLogsError, {
      householdId,
    })
  }

  if (householdError) {
    logSupabaseError("baby", "household profile lookup failed", householdError, {
      householdId,
    })
  }

  if (growthLogsError) {
    logSupabaseError("baby", "growth logs lookup failed", growthLogsError, {
      householdId,
    })
  }

  return (
    <BabyDashboard
      initialLogs={logs ?? []}
      initialWeeklyLogs={weeklyLogs ?? []}
      initialGrowthLogs={growthLogs ?? []}
      householdId={householdId}
      userId={userId}
      initialDate={todayJst}
      lastSleepEndedAt={lastSleepData?.ended_at ?? null}
      babyName={household?.baby_name ?? null}
      babyBirthDate={household?.baby_birth_date ?? null}
    />
  )
}
