import { createClient } from "@/lib/supabase/server"
import { StockList } from "@/components/stock/stock-list"
import { getRecipeSuggestions } from "@/app/(main)/stock/actions"
import { getCachedStockItems } from "@/lib/supabase/cached-queries"

export default async function StockPage() {
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

  // getCachedStockItems と getRecipeSuggestions の両方が内部で
  // getCachedStockItems を呼ぶが、React.cache() により同一リクエスト内では
  // 実際の Supabase クエリは1回のみ発行される。
  const [itemsResult, suggestionsResult] = await Promise.all([
    getCachedStockItems(householdId),
    getRecipeSuggestions(),
  ])

  return (
    <StockList
      initialItems={itemsResult.data ?? []}
      initialSuggestions={suggestionsResult.data}
      householdId={householdId}
    />
  )
}
