import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { CalendarView } from "@/components/calendar/calendar-view"
import type { CalendarEventRecord } from "@/components/calendar/use-month-events"
import { CALENDAR_EVENT_COLUMNS } from "@/lib/domain/calendar-event-columns"
import { currentMonthFirstJst, gridRangeOf } from "@/lib/domain/calendar-grid"
import { maybeScheduleSync } from "@/lib/google/sync-trigger"

/**
 * `maybeScheduleSync` が `after()` で背景同期を走らせるため、ページの上限を明示する
 * （同梱 docs: 「after will run for the platform's default or configured max
 * duration of your route」）。既定に委ねると同期が無言で打ち切られる。
 */
export const maxDuration = 30

export default async function CalendarPage() {
  const { context } = await getAuthContext()
  if (!context) return null
  const { supabase, householdId } = context

  const monthFirst = currentMonthFirstJst()
  const { gridStart, gridEnd } = gridRangeOf(monthFirst)

  // 同期トリガは **getAuthContext を通った後**に置く。同梱 docs の
  // 「after will be executed even if the response didn't complete successfully.
  //  Including when an error is thrown or when notFound or redirect is called」
  // ゆえ、手前に置くと未所属で弾かれる利用者でも同期が走ってしまう。
  //
  // 月グリッドの取得と並行に走らせる（直列にすると TTFB が 1 往復ぶん伸びる）。
  // `after()` の予約は描画スコープ内で起きるためこの形でよい。
  const [{ data: events, error }, sync] = await Promise.all([
    supabase
      .from("calendar_events")
      .select(CALENDAR_EVENT_COLUMNS)
      .eq("household_id", householdId)
      .lte("start_date", gridEnd) // 重なり判定: start_date <= gridEnd
      .gte("end_date", gridStart) //           AND end_date >= gridStart
      .order("start_date"),
    maybeScheduleSync(supabase, householdId),
  ])

  if (error) {
    logSupabaseError("calendar", "month lookup failed", error, { householdId })
  }

  return (
    <CalendarView
      initialEvents={(events as unknown as CalendarEventRecord[]) ?? []}
      householdId={householdId}
      initialMonthFirst={monthFirst}
      // V7: Realtime を使わぬ代わりに、同期を予約したときだけ client が
      // last_synced_at の前進をポーリングして refetch する。削除のみの
      // 同期サイクルは calendar_events に INSERT/UPDATE を生まぬため、
      // これが Google 側の削除を画面へ反映する唯一の担保じゃ。
      syncScheduled={sync.syncScheduled}
      initialGoogleSyncedAt={sync.lastSyncedAt}
    />
  )
}
