import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { BabyDashboard } from "@/components/baby/baby-dashboard"
import { PUMPING_INTERVAL_DEFAULT } from "@/lib/domain/baby-pumping"
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

  // 今日のログ + 最新の完了済み睡眠 + 未終了睡眠 + 前夜開始の overlap 睡眠
  // + 週間サマリー用ログ + 赤ちゃんプロフィールを並列取得
  const [
    { data: logs, error: logsError },
    { data: lastSleepData, error: lastSleepError },
    { data: activeSleepData, error: activeSleepError },
    { data: overlapSleepLogs, error: overlapSleepError },
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
      // 未終了睡眠（B-01: 日跨ぎアクティブ睡眠の袋小路対策）。
      // 前夜開始の未終了睡眠は今日窓のクエリに現れないため、別途取得して
      // dashboard へフォールバックとして渡す。UNIQUE 部分 index
      // idx_one_active_sleep（20260410000001_baby_logs.sql）により高々 1 件。
      supabase
        .from("baby_logs")
        .select(
          "id, log_type, logged_at, logged_by, feeding_type, amount_ml, diaper_type, ended_at, temperature, weight_g, height_cm, duration_min, memo, created_at",
        )
        .eq("household_id", householdId)
        .eq("log_type", "sleep")
        .is("ended_at", null)
        .order("logged_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      // 前夜開始・当日終了の overlap 睡眠（B-02: 今日のまとめの按分入力）。
      // logged_at が前日以前のため today 窓（logs）には現れない完了睡眠を別 prop で渡し、
      // summarizeTodayCounts の入力にのみ合流させる（timeline = logs の意味は不変）。
      // ended_at が null の未終了睡眠は activeSleepFallback（B-01）が担い、按分には
      // 寄与しない（完了セッションのみ集計）ため、ここは ended_at 非 null に限定して二重取得を避ける。
      supabase
        .from("baby_logs")
        .select(
          "id, log_type, logged_at, logged_by, feeding_type, amount_ml, diaper_type, ended_at, temperature, weight_g, height_cm, duration_min, memo, created_at",
        )
        .eq("household_id", householdId)
        .eq("log_type", "sleep")
        .lt("logged_at", todayStart)
        .gte("ended_at", todayStart)
        .order("logged_at", { ascending: false }),
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
        .select("baby_name, baby_birth_date, pumping_interval_min")
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

  if (activeSleepError) {
    logSupabaseError("baby", "active sleep lookup failed", activeSleepError, {
      householdId,
    })
  }

  if (overlapSleepError) {
    logSupabaseError("baby", "overlap sleep lookup failed", overlapSleepError, {
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
      initialOverlapLogs={overlapSleepLogs ?? []}
      initialWeeklyLogs={weeklyLogs ?? []}
      initialGrowthLogs={growthLogs ?? []}
      householdId={householdId}
      userId={userId}
      initialDate={todayJst}
      lastSleepEndedAt={lastSleepData?.ended_at ?? null}
      activeSleepFallback={activeSleepData ?? null}
      babyName={household?.baby_name ?? null}
      babyBirthDate={household?.baby_birth_date ?? null}
      pumpingIntervalMin={
        household?.pumping_interval_min ?? PUMPING_INTERVAL_DEFAULT
      }
    />
  )
}
