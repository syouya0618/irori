import type { AuthContext } from "@/lib/supabase/auth-context"
import type { ItemCategory } from "@/lib/types/database"
import { getNextSortOrder } from "@/lib/supabase/shopping-queries"
import { calculateDailyRate, estimateRemainingDays } from "@/lib/domain"
import { todayJstString, shiftYmd } from "@/lib/utils/date-jst"

/**
 * 低在庫アイテムの買い物リスト自動追加ロジック本体。
 *
 * - 認証 (getAuthContext) と revalidatePath は呼び出し側 actions.ts の責務。
 *   ここでは `supabase: AuthContext["supabase"]` を第一引数で受け取るのみ。
 * - 残日数が3日以下のアイテムを対象とし、既に買い物リストにあるものは除外する。
 * - insert に成功した場合のみ addedItems が非空になる（呼び出し側はこれで
 *   revalidatePath の要否を判定できる）。
 */

// ─── Helper: 低在庫アイテムを買い物リストへ自動追加 ───────
export async function autoAddLowStockItems(
  supabase: AuthContext["supabase"],
  householdId: string,
  userId: string,
): Promise<{ error: string | null; addedItems: string[] }> {
  const now = new Date()
  const today = todayJstString(now)
  const weekAgo = shiftYmd(today, -7)

  // 独立クエリを並列実行（authコンテキストを共有して重複排除）
  const [householdResult, logsResult, stockResult, shoppingResult] =
    await Promise.all([
      supabase
        .from("households")
        .select("auto_stock_categories")
        .eq("id", householdId)
        .single(),
      supabase
        .from("baby_logs")
        .select("log_type, logged_at, amount_ml")
        .eq("household_id", householdId)
        .in("log_type", ["diaper", "feeding"])
        .gte("logged_at", `${weekAgo}T00:00:00`)
        .limit(500),
      supabase
        .from("stock_items")
        .select("id, name, category, quantity")
        .eq("household_id", householdId),
      supabase
        .from("shopping_items")
        .select("name")
        .eq("household_id", householdId)
        .eq("is_checked", false),
    ])

  if (
    householdResult.error ||
    logsResult.error ||
    stockResult.error ||
    shoppingResult.error ||
    !householdResult.data
  ) {
    return { error: null, addedItems: [] }
  }

  const autoCategories = householdResult.data.auto_stock_categories as string[]
  if (!Array.isArray(autoCategories) || autoCategories.length === 0) {
    return { error: null, addedItems: [] }
  }

  const diaperRate = calculateDailyRate(logsResult.data ?? [], "diaper", now)
  const rates: Record<string, number | null> = { baby: diaperRate }

  // 残日数≤3のアイテムを抽出
  const lowStockItems = (stockResult.data ?? []).filter((item) => {
    if (!autoCategories.includes(item.category)) return false
    const rate = rates[item.category]
    if (rate == null) return false
    const remaining = estimateRemainingDays(item.quantity, rate)
    return remaining !== null && remaining <= 3
  })

  if (lowStockItems.length === 0) return { error: null, addedItems: [] }

  const existingNames = new Set(
    (shoppingResult.data ?? []).map((i) => i.name.toLowerCase()),
  )

  const toAdd = lowStockItems.filter(
    (item) => !existingNames.has(item.name.toLowerCase()),
  )

  if (toAdd.length === 0) return { error: null, addedItems: [] }

  // sort_order の最大値 + 1 を取得 (log scope は stock)
  let nextOrder = await getNextSortOrder(supabase, householdId, "stock")

  const insertRows = toAdd.map((item) => ({
    household_id: householdId,
    name: item.name,
    category: item.category as ItemCategory,
    store_type: "drugstore" as const,
    created_by: userId,
    sort_order: nextOrder++,
  }))

  const { error: insertError } = await supabase
    .from("shopping_items")
    .insert(insertRows)

  if (insertError) {
    return { error: "買い物リストへの追加に失敗しました", addedItems: [] }
  }

  return { error: null, addedItems: toAdd.map((i) => i.name) }
}
