import { StockList } from "@/components/stock/stock-list"
import {
  getRecipeSuggestions,
  getConsumptionRates,
} from "@/app/(main)/stock/actions"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { getCachedStockItems } from "@/lib/supabase/cached-queries"

export default async function StockPage() {
  const result = await getAuthContext()
  if (result.error !== null) return null
  const { householdId } = result.context

  const [itemsResult, suggestionsResult, ratesResult] = await Promise.all([
    getCachedStockItems(householdId),
    getRecipeSuggestions(),
    getConsumptionRates(),
  ])

  return (
    <StockList
      initialItems={itemsResult.data ?? []}
      initialSuggestions={suggestionsResult.data}
      consumptionRates={ratesResult.rates}
      householdId={householdId}
    />
  )
}
