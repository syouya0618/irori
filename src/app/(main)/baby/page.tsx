import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { BabyDashboard } from "@/components/baby/baby-dashboard"
import { FEEDING_INTERVAL_DEFAULT } from "@/lib/domain/baby-feeding-interval"
import { BABY_LOG_COLUMNS } from "@/lib/domain/baby-log-columns"
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

  // 今日のログ + 週間サマリー用ログ + 赤ちゃんプロフィールを並列取得
  const [
    { data: logs, error: logsError },
    { data: weeklyLogs, error: weeklyLogsError },
    { data: household, error: householdError },
    { data: growthLogs, error: growthLogsError },
    { data: todayDiary, error: diaryError },
    { data: lastFeedingData, error: lastFeedingError },
    { data: lastNursingData, error: lastNursingError },
  ] = await Promise.all([
      supabase
        .from("baby_logs")
        .select(BABY_LOG_COLUMNS)
        .eq("household_id", householdId)
        .gte("logged_at", todayStart)
        .lt("logged_at", tomorrowStart)
        .order("logged_at", { ascending: false }),
      supabase
        .from("baby_logs")
        .select(BABY_LOG_COLUMNS)
        .eq("household_id", householdId)
        .gte("logged_at", weeklyStart)
        .lt("logged_at", tomorrowStart)
        .order("logged_at", { ascending: false }),
      supabase
        .from("households")
        .select("baby_name, baby_birth_date, feeding_interval_min")
        .eq("id", householdId)
        .maybeSingle(),
      // 成長曲線用: 成長ログを古い順に全件（低頻度データ・1000 未満想定、順序を昇順で決定化）
      supabase
        .from("baby_logs")
        .select(BABY_LOG_COLUMNS)
        .eq("household_id", householdId)
        .eq("log_type", "growth")
        .order("logged_at", { ascending: true }),
      // 今日の育児日記（1日1本・無い日は正常系ゆえ maybeSingle）
      supabase
        .from("baby_diaries")
        .select("id, diary_date, content, updated_at")
        .eq("household_id", householdId)
        .eq("diary_date", todayJst)
        .maybeSingle(),
      // 今日より前の最後の授乳（批判レビュー P3: 最終授乳フォールバック）。
      // logged_at の開始時刻セマンティクスにより、深夜を跨いだサイクルは前日行に
      // なって今日窓の logs に現れない。当日にまだ授乳が無い間「最終授乳 ---」へ
      // 落ちないよう、別クエリで取ってフォールバックとして渡す。
      supabase
        .from("baby_logs")
        .select(BABY_LOG_COLUMNS)
        .eq("household_id", householdId)
        .eq("log_type", "feeding")
        .lt("logged_at", todayStart)
        .order("logged_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      // 今日より前の最後の「授乳」（搾乳を除く）。次の授乳の目安の起点フォールバック。
      // 上のクエリ（最終授乳表示用）と分けているのは、あちらが搾乳を含む契約だから
      // — 流用すると「搾乳しただけで目安が飛ぶ」（本 issue の主訴）が残る。
      // `.neq` で pumped だけを外す（`.in(...)` で列挙すると DB 側 ENUM に新しい
      // 授乳種別が増えたとき無音で目安から漏れる）。feeding 行の feeding_type は
      // NOT NULL 相当（20260410000001_baby_logs.sql の CHECK）ゆえ neq で落ちる穴はない。
      supabase
        .from("baby_logs")
        .select(BABY_LOG_COLUMNS)
        .eq("household_id", householdId)
        .eq("log_type", "feeding")
        .neq("feeding_type", "pumped")
        .lt("logged_at", todayStart)
        .order("logged_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

  if (logsError) {
    logSupabaseError("baby", "today logs lookup failed", logsError, {
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

  if (diaryError) {
    logSupabaseError("baby", "today diary lookup failed", diaryError, {
      householdId,
    })
  }

  if (lastFeedingError) {
    logSupabaseError("baby", "last feeding lookup failed", lastFeedingError, {
      householdId,
    })
  }

  if (lastNursingError) {
    logSupabaseError("baby", "last nursing lookup failed", lastNursingError, {
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
      initialDiary={todayDiary ?? null}
      lastFeedingFallback={lastFeedingData ?? null}
      lastNursingFallback={lastNursingData ?? null}
      babyName={household?.baby_name ?? null}
      babyBirthDate={household?.baby_birth_date ?? null}
      feedingIntervalMin={
        household?.feeding_interval_min ?? FEEDING_INTERVAL_DEFAULT
      }
    />
  )
}
