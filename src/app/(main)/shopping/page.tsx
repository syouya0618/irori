import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { ShoppingList } from "@/components/shopping/shopping-list"

export default async function ShoppingPage() {
  // layout と同一リクエスト内のため React.cache() で auth クエリは dedupe される
  const { context } = await getAuthContext()
  if (!context) return null
  const { supabase, userId, householdId } = context

  // 買い物アイテムを取得
  const { data: items, error: itemsError } = await supabase
    .from("shopping_items")
    .select(
      "id, name, quantity, category, store_type, is_checked, checked_by, checked_at, sort_order"
    )
    .eq("household_id", householdId)
    .order("sort_order", { ascending: true })

  if (itemsError) {
    logSupabaseError("shopping", "shopping items lookup failed", itemsError, {
      userId,
      householdId,
    })
  }

  // 世帯メンバーを取得（チェック者の表示名用）
  const { data: membersData, error: membersError } = await supabase
    .from("profiles")
    .select("id, display_name")
    .eq("household_id", householdId)

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
