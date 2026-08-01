import { cache } from "react"
import { createClient } from "@/lib/supabase/server"
import { STOCK_ITEM_COLUMNS } from "@/lib/domain/stock-item-columns"

/**
 * 同一リクエスト内で在庫クエリを共有するためのReact cache()ラッパー。
 *
 * page.tsx と getRecipeSuggestions() の両方で在庫を必要とする場合、
 * 通常は2回クエリが発行される。この関数でラップすることで
 * 同一リクエスト内では1回のみクエリが発行される。
 *
 * 関連する学習記録:
 * - [HIGH] layouts/pages間のDBクエリ重複はReact cache()で排除する
 */
export const getCachedStockItems = cache(async (householdId: string) => {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("stock_items")
    .select(STOCK_ITEM_COLUMNS)
    .eq("household_id", householdId)
    .order("name")

  if (error) {
    return { data: null, error }
  }
  return { data: data ?? [], error: null }
})
