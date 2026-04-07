import { createClient } from "@/lib/supabase/server"
import { ShoppingList } from "@/components/shopping/shopping-list"

export default async function ShoppingPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from("profiles")
    .select("household_id")
    .eq("id", user.id)
    .single()

  if (!profile?.household_id) return null
  const householdId = profile.household_id

  // 買い物アイテムを取得
  const { data: items } = await supabase
    .from("shopping_items")
    .select(
      "id, name, quantity, category, store_type, is_checked, checked_by, checked_at, sort_order"
    )
    .eq("household_id", householdId)
    .order("sort_order", { ascending: true })

  // 世帯メンバーを取得（チェック者の表示名用）
  const { data: membersData } = await supabase
    .from("profiles")
    .select("id, display_name")
    .eq("household_id", householdId)

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
