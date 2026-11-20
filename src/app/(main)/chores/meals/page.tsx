import { loadPlanPageData } from "@/app/(main)/chores/meals/plan/plan-page-data"
import { resolveScheduleStart } from "@/components/chores/meals/schedule/schedule-query"
import { ScheduleView } from "@/components/chores/meals/schedule/schedule-view"
import { KeepLastGood } from "@/components/chores/shared/keep-last-good"
import { MealContextError } from "@/lib/meals/server/context"
import { buildScheduleDishDetails } from "@/lib/meals/server/schedule-details"
import { mealToday } from "@/lib/meals/server/today"
import { getAuthContext } from "@/lib/supabase/auth-context"

/** 自動献立のServer Actionと同じ実行上限。 */
export const maxDuration = 30

/**
 * ごはんの新しい入口: 月曜から日曜までの献立を一画面に表示する。
 * 明細は既存の献立ロジックで取得し、材料名だけサーバーで表示用に組み立てる。
 * 読込失敗時は空の週として偽らず、最後に読めた表示を守る。
 */
export default async function MealsSchedulePage({
  searchParams,
}: {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>
} = {}) {
  const { context } = await getAuthContext()
  if (!context) return null
  const { supabase, userId, householdId } = context
  const today = mealToday()
  const query = searchParams ? await searchParams : {}
  const startDate = resolveScheduleStart(query.start, today)
  const data = await loadPlanPageData(supabase, householdId, userId, { startDate, today })
  const scope = `schedule:${userId}:${householdId}:${startDate}`
  if (!data.ok) return <KeepLastGood scope={scope} failure={new MealContextError(data.failures).message} />
  return (
    <KeepLastGood scope={scope}>
      <ScheduleView
        key={`${userId}:${householdId}:${startDate}`}
        owner={{ userId, householdId }}
        view={data.view}
        details={buildScheduleDishDetails(data.view, data.extras)}
      />
    </KeepLastGood>
  )
}
