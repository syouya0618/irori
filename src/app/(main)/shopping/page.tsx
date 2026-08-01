import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { SHOPPING_ITEM_COLUMNS } from "@/lib/domain/shopping-item-columns"
import { ShoppingList } from "@/components/shopping/shopping-list"

export default async function ShoppingPage() {
  // layout と同一リクエスト内のため React.cache() で auth クエリは dedupe される
  const { context } = await getAuthContext()
  if (!context) return null
  const { supabase, userId, householdId } = context

  // 買い物アイテムと世帯メンバー（チェック者の表示名用）は互いに依存しないため並列化
  const [
    { data: items, error: itemsError },
    { data: membersData, error: membersError },
  ] = await Promise.all([
    supabase
      .from("shopping_items")
      .select(SHOPPING_ITEM_COLUMNS)
      .eq("household_id", householdId)
      .order("sort_order", { ascending: true }),
    supabase
      .from("profiles")
      .select("id, display_name")
      .eq("household_id", householdId),
  ])

  if (itemsError) {
    logSupabaseError("shopping", "shopping items lookup failed", itemsError, {
      userId,
      householdId,
    })
  }

  if (membersError) {
    logSupabaseError("shopping", "household members lookup failed", membersError, {
      userId,
      householdId,
    })
  }

  const members = (membersData ?? []).map((m) => ({
    id: m.id,
    display_name: m.display_name,
  }))

  return (
    <ShoppingList
      initialItems={items ?? []}
      householdId={householdId}
      members={members}
    />
  )
}
