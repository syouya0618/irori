import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { BabyDashboard } from "@/components/baby/baby-dashboard"
import type { CalendarEventRecord } from "@/components/calendar/use-month-events"
import { FEEDING_INTERVAL_DEFAULT } from "@/lib/domain/baby-feeding-interval"
import { decodeBottleDefault } from "@/lib/domain/bottle-default"
import { selectBottleDefault } from "@/lib/supabase/bottle-default-query"
import { resolveBabyDate, type BabySearchParams } from "@/lib/domain/baby-link"
import { CALENDAR_EVENT_COLUMNS } from "@/lib/domain/calendar-event-columns"
import {
  selectBabyLogsOfDay,
  selectBabyLogsOfWeek,
  selectGrowthLogs,
  selectLastFeedingBefore,
  selectLastNursingBefore,
} from "@/lib/supabase/baby-log-queries"
import { todayJstString, shiftYmd } from "@/lib/utils/date-jst"

/**
 * `/baby?date=YYYY-MM-DD` でその日を開く（機能 B: 日付ジャンプ・検索結果からの着地）。
 *
 * サーバ側で読む（calendar/page.tsx の `?date=` と同じ判断）: 選択日は初回の logs 取得
 * そのものを決めるゆえ、client で直すと必ず一度は今日を描いてから差し替わる。
 * Next.js 16 では `searchParams` は Promise（await 必須）。クエリ名は baby-link.ts が
 * 持つ（書く側の検索結果・日付ジャンプと同じ綴り）。
 */
export default async function BabyPage({
  searchParams,
}: {
  searchParams: Promise<BabySearchParams>
}) {
  const result = await getAuthContext()
  if (result.error !== null) return null
  const { supabase, userId, householdId } = result.context

  const todayJst = todayJstString()
  const selectedDate = resolveBabyDate(await searchParams, todayJst)
  const tomorrowJst = shiftYmd(todayJst, 1)
  // baby_logs の窓と条件は baby-log-queries.ts が正本（dashboard の取り直しと同じ組み立て）。
  // 選択日（既定は今日）の窓だけが選択日基準で、週窓・成長・フォールバックは今日基準。

  // 選択日のログ + 週間サマリー用ログ + 赤ちゃんプロフィール + 世帯員を並列取得
  const [
    { data: logs, error: logsError },
    { data: weeklyLogs, error: weeklyLogsError },
    { data: household, error: householdError },
    { data: growthLogs, error: growthLogsError },
    { data: diary, error: diaryError },
    { data: lastFeedingData, error: lastFeedingError },
    { data: lastNursingData, error: lastNursingError },
    { data: upcomingEvents, error: upcomingError },
    { data: members, error: membersError },
    bottleDefaultResult,
  ] = await Promise.all([
      selectBabyLogsOfDay(supabase, householdId, selectedDate),
      selectBabyLogsOfWeek(supabase, householdId, todayJst),
      supabase
        .from("households")
        .select("baby_name, baby_birth_date, feeding_interval_min")
        .eq("id", householdId)
        .maybeSingle(),
      selectGrowthLogs(supabase, householdId),
      // 選択日の育児日記（1日1本・無い日は正常系ゆえ maybeSingle）
      supabase
        .from("baby_diaries")
        .select("id, diary_date, content, updated_at")
        .eq("household_id", householdId)
        .eq("diary_date", selectedDate)
        .maybeSingle(),
      // 今日より前の最後の授乳（最終授乳フォールバック。搾乳を含む）と、
      // 最後の「授乳」（搾乳を除く pumped の denylist。次の授乳の目安の起点）。
      // 契約の理由（開始時刻セマンティクス・三値論理・enum drift）は baby-log-queries.ts。
      selectLastFeedingBefore(supabase, householdId, todayJst),
      selectLastNursingBefore(supabase, householdId, todayJst),
      // 今日・明日に重なる予定（CAL-4 カード。起動直後に目に入る位置 = 起動時のページ
      // が /baby になったため旧 /meals から移設）。他クエリと並列ゆえ往復は増えない。
      supabase
        .from("calendar_events")
        .select(CALENDAR_EVENT_COLUMNS)
        .eq("household_id", householdId)
        .gte("end_date", todayJst) // 重なり判定: end_date >= 今日
        .lte("start_date", tomorrowJst) //          AND start_date <= 明日
        .order("start_date"),
      // 世帯員の表示名（機能 A: 記録者の表示）。RLS の profiles_select は同じ世帯の行を
      // 読ませる。取れなかった時は記録者を出さぬだけで画面は成立する
      supabase
        .from("profiles")
        .select("id, display_name")
        .eq("household_id", householdId),
      // いつものミルク量（クイック記録の 1 タップの量）。上の households の select へ混ぜず
      // 別に読む（混ぜると migration 前の DB で赤子の名前・授乳間隔まで落ちる。
      // bottle-default-query.ts の注記）。未設定と取得失敗は decodeBottleDefault が分ける
      selectBottleDefault(supabase, householdId),
    ])

  const bottleDefault = decodeBottleDefault(bottleDefaultResult)
  if (bottleDefaultResult.error) {
    logSupabaseError("baby", "bottle default lookup failed", bottleDefaultResult.error, {
      householdId,
    })
  } else if (bottleDefault.status === "error") {
    // error 無しで読めぬ（行が見えぬ・範囲外の値）。量は出さず、画面は取得失敗として扱う
    console.error("[baby] bottle default lookup returned no usable row", { householdId })
  }

  if (logsError) {
    logSupabaseError("baby", "selected day logs lookup failed", logsError, {
      householdId,
      selectedDate,
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
    logSupabaseError("baby", "selected day diary lookup failed", diaryError, {
      householdId,
      selectedDate,
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

  if (upcomingError) {
    logSupabaseError("baby", "upcoming events lookup failed", upcomingError, {
      householdId,
    })
  }

  if (membersError) {
    logSupabaseError("baby", "household members lookup failed", membersError, {
      householdId,
    })
  }

  return (
    // 着地日ごとに作り直す（key）。`/baby?date=…` から `/baby` へ戻った時に同じ segment の
    // component が残ると、useState(initialDate) の選択日が着地日のまま居座る
    <BabyDashboard
      key={selectedDate}
      initialLogs={logs ?? []}
      initialWeeklyLogs={weeklyLogs ?? []}
      initialGrowthLogs={growthLogs ?? []}
      householdId={householdId}
      userId={userId}
      initialDate={selectedDate}
      initialDiary={diary ?? null}
      lastFeedingFallback={lastFeedingData ?? null}
      lastNursingFallback={lastNursingData ?? null}
      babyName={household?.baby_name ?? null}
      babyBirthDate={household?.baby_birth_date ?? null}
      feedingIntervalMin={
        household?.feeding_interval_min ?? FEEDING_INTERVAL_DEFAULT
      }
      initialBottleDefault={bottleDefault}
      initialUpcomingEvents={
        (upcomingEvents as unknown as CalendarEventRecord[]) ?? []
      }
      members={(members ?? []).map((m) => ({
        id: m.id,
        displayName: m.display_name ?? "",
      }))}
    />
  )
}
