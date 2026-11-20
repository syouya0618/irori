import { MemoView } from "@/components/chores/meals/memo/memo-view"
import { KeepLastGood } from "@/components/chores/shared/keep-last-good"
import { MealContextError } from "@/lib/meals/server/context"
import { loadShoppingView } from "@/lib/meals/server/plan-views"
import { getAuthContext } from "@/lib/supabase/auth-context"

/**
 * 既存の手動買い物項目を、自由入力の共有メモとして表示する。
 * 読み込めなければ空のメモに見せず、最後に読めた内容を維持する。
 */
export default async function MealMemoPage() {
  const { context } = await getAuthContext()
  if (!context) return null
  const { supabase, userId, householdId } = context
  const loaded = await loadShoppingView(supabase, householdId)
  const scope = `memo:${userId}:${householdId}`
  if (!loaded.ok) return <KeepLastGood scope={scope} failure={new MealContextError(loaded.failures).message} />
  return (
    <KeepLastGood scope={scope}>
      <MemoView
        key={`${userId}:${householdId}`}
        owner={{ userId, householdId }}
        view={loaded.view}
      />
    </KeepLastGood>
  )
}
