import { logSupabaseError } from "@/lib/supabase/log-error"
import { currentWeekRangeJst } from "@/lib/utils/date-jst"
import type { AuthContext } from "@/lib/supabase/auth-context"

/**
 * shopping 系 Server Actions の DB 読み取りロジック置き場。
 *
 * - 認証 (getAuthContext) と revalidatePath は呼び出し側 actions.ts の責務。
 *   ここでは `supabase: AuthContext["supabase"]` を第一引数で受け取るのみ。
 * - エラーは握り潰さず、呼び出し側が分岐できる形 (error フィールド) か
 *   logSupabaseError による構造化ログで残す。
 */

// ─── Helper: 今週の献立から新しい食材を取得 ──────────────────
export async function getNewIngredientsForWeek(
  supabase: AuthContext["supabase"],
  householdId: string
) {
  const { startDate, endDate } = currentWeekRangeJst()

  // 今週の献立（外食を除く）を取得
  const { data: meals, error: mealsError } = await supabase
    .from("meals")
    .select("id")
    .eq("household_id", householdId)
    .eq("is_eating_out", false)
    .gte("date", startDate)
    .lte("date", endDate)

  if (mealsError) {
    return { error: "献立の取得に失敗しました" as const, newIngredients: [], existingCount: 0 }
  }

  if (!meals || meals.length === 0) {
    return { error: "no_meals" as const, newIngredients: [], existingCount: 0 }
  }

  const mealIds = meals.map((m) => m.id)

  const { data: ingredients, error: ingredientsError } = await supabase
    .from("meal_ingredients")
    .select("name, quantity, category, meal_id")
    .in("meal_id", mealIds)

  if (ingredientsError) {
    return { error: "食材の取得に失敗しました" as const, newIngredients: [], existingCount: 0 }
  }

  if (!ingredients || ingredients.length === 0) {
    return { error: "no_ingredients" as const, newIngredients: [], existingCount: 0 }
  }

  // 既存の買い物リストに同名のアイテムがないかチェック
  const { data: existingItems, error: existingItemsError } = await supabase
    .from("shopping_items")
    .select("name")
    .eq("household_id", householdId)

  if (existingItemsError) {
    logSupabaseError("shopping", "existing items lookup failed", existingItemsError, {
      householdId,
    })
  }

  const existingNames = new Set(
    (existingItems ?? []).map((i) => i.name.toLowerCase())
  )

  // 重複を除外
  const newIngredients = ingredients.filter(
    (ing) => !existingNames.has(ing.name.toLowerCase())
  )

  const existingCount = ingredients.length - newIngredients.length

  return { error: null, newIngredients, existingCount }
}

// ─── Helper: 次のsort_orderを取得 ──────────────────────
/**
 * `logScope` は logSupabaseError の scope 文言。shopping 側の既存呼び出しは
 * 既定値 "shopping" のまま挙動不変。stock 側 (R4) からは "stock" を渡す。
 */
export async function getNextSortOrder(
  supabase: AuthContext["supabase"],
  householdId: string,
  logScope = "shopping"
): Promise<number> {
  // 空リスト (0 行) は正常系ゆえ maybeSingle
  const { data, error } = await supabase
    .from("shopping_items")
    .select("sort_order")
    .eq("household_id", householdId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    logSupabaseError(logScope, "sort_order lookup failed", error, {
      householdId,
    })
  }
  return (data?.sort_order ?? 0) + 1
}

// ─── Helper: 購入履歴の部分一致検索（サジェスト本体） ─────────
/**
 * purchase_history を部分一致検索し、名前でユニーク化した行を返す。
 *
 * shopping の getSuggestions の本体。stock 側 getStockSuggestions も同一の
 * 検索ロジックを持つため、store_type を含む全カラムを返し、呼び出し側が
 * 必要なフィールドだけを map する設計（R4 で stock 側からも再利用予定）。
 * query の空チェックは呼び出し側 (認証前の早期 return) の責務。
 */
export async function searchPurchaseHistory(
  supabase: AuthContext["supabase"],
  householdId: string,
  query: string
) {
  const { data, error } = await supabase
    .from("purchase_history")
    .select("item_name, category, store_type")
    .eq("household_id", householdId)
    .ilike("item_name", `%${query.trim().replace(/[%_\\]/g, "\\$&")}%`)
    .order("purchased_at", { ascending: false })
    .limit(20)

  if (error) {
    return { error, items: [] }
  }

  // 名前でユニーク化（最新の履歴を優先）
  const seen = new Set<string>()
  const items = (data ?? []).filter((item) => {
    const key = item.item_name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return { error: null, items }
}
