import { getAuthContext } from "@/lib/supabase/auth-context"
import { loadGarbagePage } from "@/lib/supabase/garbage-overview-query"
import { todayJstString } from "@/lib/utils/date-jst"
import { ChoresHeader } from "@/components/chores/shared/chores-header"
import { GarbageView } from "@/components/chores/garbage/garbage-view"

/**
 * ごみ（/chores/garbage）。次の収集日・分類した予定・予定が見つからぬ分類の整理・通知の状態。
 *
 * - 認証・承認・世帯は (main)/layout が遷移で受ける。ここでも `getAuthContext()` を呼び
 *   （React.cache で同一リクエスト内は 1 回）、文脈が無ければ何も描かぬ
 * - 読み取りは `loadGarbagePage` が持つ。**どの取得が失敗しても throw せぬ**（旗で返る）—
 *   画面は「ありません」と言わず、読めなんだ区画だけ失敗と再読込を出す
 * - 収集日そのものは予定（`calendar_events`）で、ここでは作らぬ。足すのはカレンダーから
 * - Client の state（開いておるシート・確認中の控え）は持ち主（利用者 × 世帯）で作り直す
 */
export default async function GarbagePage() {
  const { context } = await getAuthContext()
  if (!context) return null
  const { supabase, userId, householdId } = context

  const data = await loadGarbagePage(supabase, householdId, todayJstString())

  return (
    <div className="flex flex-col gap-6 px-4 pt-12 pb-8">
      <ChoresHeader
        title="ごみ"
        description="次の収集日と、ごみの日にした予定を確かめられます。分類と通知はここからも変えられます。"
      />
      <GarbageView
        key={`${userId}:${householdId}`}
        owner={{ userId, householdId }}
        data={data}
      />
    </div>
  )
}
