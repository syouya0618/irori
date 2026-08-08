import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { CalendarView } from "@/components/calendar/calendar-view"
import type { CalendarEventRecord } from "@/components/calendar/use-month-events"
import { CALENDAR_EVENT_COLUMNS } from "@/lib/domain/calendar-event-columns"
import { gridRangeOf } from "@/lib/domain/calendar-grid"
import {
  resolveCalendarDateView,
  type CalendarSearchParams,
} from "@/lib/domain/calendar-link"
import { maybeScheduleSync } from "@/lib/google/sync-trigger"

/**
 * `maybeScheduleSync` が `after()` で背景同期を走らせるため、ページの上限を明示する
 * （同梱 docs: 「after will run for the platform's default or configured max
 * duration of your route」）。既定に委ねると同期が無言で打ち切られる。
 */
export const maxDuration = 30

/**
 * B-6: 通知の着地先。`?date=YYYY-MM-DD` でその日のカレンダーを開く。
 *
 * **サーバ側で読む**のが要点じゃ（`settings/page.tsx` の `?google=` と同じ判断）:
 * 選択日は月グリッドの取得範囲そのものを決めるゆえ、client で
 * `useSearchParams()` してから直すと、**必ず一度は違う月を描いて**から
 * 差し替わる（＝ 通知から開いた瞬間に今月がちらつき、範囲外の日を
 * 「予定はありません」と見せる窓が空く）。
 *
 * Next.js 16 では `searchParams` は **Promise** じゃ（await 必須）。
 * 一次情報: node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md
 * > "Since the `searchParams` prop is a promise. You must use `async/await` or
 * >  React's `use` function to access the values."
 *
 * 検証は `resolveCalendarDateView` に閉じてある（不正な日付は今日へ倒れ、
 * 月は必ず選択日から導かれる）。ここで日と月を別々に決めてはならぬ。
 *
 * **クエリ名もここでは書かぬ。** `searchParams` を丸ごと渡し、綴りは
 * `calendar-link.ts`（書く側と同じモジュール）に決めさせる。ここで添字を
 * リテラルで書くと、定数を改名しても全テストが緑のまま通知の着地が全件
 * 今日へ戻る（読み側が契約の外に出るゆえ）。
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<CalendarSearchParams>
}) {
  const { context } = await getAuthContext()
  if (!context) return null
  const { supabase, householdId, userId } = context

  const view = resolveCalendarDateView(await searchParams)
  const { gridStart, gridEnd } = gridRangeOf(view.monthFirst)

  // 同期トリガは **getAuthContext を通った後**に置く。同梱 docs の
  // 「after will be executed even if the response didn't complete successfully.
  //  Including when an error is thrown or when notFound or redirect is called」
  // ゆえ、手前に置くと未所属で弾かれる利用者でも同期が走ってしまう。
  //
  // 月グリッドの取得と並行に走らせる（直列にすると TTFB が 1 往復ぶん伸びる）。
  // `after()` の予約は描画スコープ内で起きるためこの形でよい。
  const [{ data: events, error }, sync, { data: prefs, error: prefsError }] =
    await Promise.all([
      supabase
        .from("calendar_events")
        .select(CALENDAR_EVENT_COLUMNS)
        .eq("household_id", householdId)
        .lte("start_date", gridEnd) // 重なり判定: start_date <= gridEnd
        .gte("end_date", gridStart) //           AND end_date >= gridStart
        .order("start_date"),
      maybeScheduleSync(supabase, householdId),
      // B-2: 新規予定の通知の既定値。**ユーザー単位**の好みゆえ userId で引く
      // (通知そのものは世帯単位だが、既定でどれを選ぶかは個人の設定)。
      // 未設定なら行が無いのが正常ゆえ maybeSingle で 0 行を error にせぬ。
      supabase
        .from("notification_preferences")
        .select("event_default_minutes")
        .eq("user_id", userId)
        .maybeSingle(),
    ])

  if (error) {
    logSupabaseError("calendar", "month lookup failed", error, { householdId })
  }
  if (prefsError) {
    // 既定値が引けぬだけで画面は成立する(「なし」へ退化)。倒さず log に残す。
    logSupabaseError("calendar", "notification prefs lookup failed", prefsError, {
      userId,
    })
  }

  return (
    <CalendarView
      initialEvents={(events as unknown as CalendarEventRecord[]) ?? []}
      householdId={householdId}
      // B-6: `?date=` の着地日と月グリッド。**1 本の値で渡す**
      // （別々の prop にすると片方だけ渡す実装＝月跨ぎの割れが表現可能になる）。
      initialView={view}
      // V7: Realtime を使わぬ代わりに、同期を予約したときだけ client が
      // last_synced_at の前進をポーリングして refetch する。削除のみの
      // 同期サイクルは calendar_events に INSERT/UPDATE を生まぬため、
      // これが Google 側の削除を画面へ反映する唯一の担保じゃ。
      syncScheduled={sync.syncScheduled}
      initialGoogleSyncedAt={sync.lastSyncedAt}
      defaultReminderMinutes={prefs?.event_default_minutes ?? null}
    />
  )
}
