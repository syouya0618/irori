import { StockList } from "@/components/stock/stock-list"
import { getRecipeSuggestions } from "@/app/(main)/stock/actions"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { getCachedStockItems } from "@/lib/supabase/cached-queries"

export default async function StockPage() {
  const result = await getAuthContext()
  if (result.error !== null) return null
  const { householdId } = result.context

  // getCachedStockItems と getRecipeSuggestions の両方が内部で
  // getCachedStockItems を呼ぶが、React.cache() により同一リクエスト内では
  // 実際の Supabase クエリは1回のみ発行される。
  // getAuthContext も cache() 済みのため auth/profiles クエリも1回のみ。
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
