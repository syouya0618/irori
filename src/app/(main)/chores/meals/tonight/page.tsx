import { TonightView } from "@/components/chores/meals/tonight/tonight-view"
import { loadMealContext } from "@/lib/meals/server/context"
import { GROCERY_HORIZON_DAYS } from "@/lib/meals/server/plan-requests"
import { TONIGHT_VIEW_PARTS, buildTonightSummary } from "@/lib/meals/server/plan-views"
import { mealToday } from "@/lib/meals/server/today"
import { buildPlanConflictReport } from "@/lib/meals/server/views"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { shiftYmd } from "@/lib/utils/date-jst"

/**
 * 今夜（/chores/meals）。今日の夕食・主な 2 つの操作・まだ買うものの件数・除外との衝突の警告。
 *
 * - 献立（今日から買い物の対象の最後の日まで）・買い物・使わない食材の設定を 1 回で読む。
 *   衝突の判定はサーバーで行う（食材辞書・レシピのカタログを画面の bundle へ載せない）。
 * - **読めなくても画面は倒さない**: 主な 2 つの操作（今あるもので・献立）は読み込みに依らず使える。
 *   読めなかった区画は「読み込めませんでした」と出す（「献立なし」「0 件」と偽らない）。
 * - 見出し（h1）と外枠の余白は layout が持つ。
 *
 * 認証・承認・世帯は (main)/layout が遷移で受ける。
 */
export default async function MealsTonightPage() {
  const { context } = await getAuthContext()
  if (!context) return null
  const { supabase, householdId } = context
  const today = mealToday()

  const planRange = { from: today, to: shiftYmd(today, GROCERY_HORIZON_DAYS - 1) }
  const loaded = await loadMealContext(supabase, householdId, {
    // `children` は、今日の料理の年齢の制約の注意（1 歳未満のはちみつ等）に要る
    include: TONIGHT_VIEW_PARTS,
    planRange,
    today,
  })
  if (loaded.ok) {
    const report = buildPlanConflictReport(loaded.context)
    return (
      <TonightView
        summary={buildTonightSummary(loaded.context)}
        conflicts={report.conflicts}
        unreadableEntries={report.unreadableEntries}
      />
    )
  }
  // 子どもだけを読めなかったときは、今日の献立まで倒さない。子ども抜きで読み直し、年齢の注意は
  // 「確認できていない」と出す（`ageRulesChecked` が false。「注意なし」とは言わない）
  if (loaded.failures.length > 0 && loaded.failures.every((failure) => failure.part === "children")) {
    const fallback = await loadMealContext(supabase, householdId, {
      include: ["plan", "grocery", "exclusions"],
      planRange,
      today,
    })
    if (fallback.ok) {
      const report = buildPlanConflictReport(fallback.context)
      return (
        <TonightView
          summary={buildTonightSummary(fallback.context)}
          conflicts={report.conflicts}
          unreadableEntries={report.unreadableEntries}
        />
      )
    }
  }
  return <TonightView summary={null} conflicts={[]} unreadableEntries={0} />
}
