import { logSupabaseError } from "@/lib/supabase/log-error"
import type { AuthContext } from "@/lib/supabase/auth-context"
import type { ItemCategory } from "@/lib/types/database"

/**
 * 買い物チェック ON 時の在庫自動追加ロジック。
 *
 * 世帯の auto_stock_categories に含まれるカテゴリのみ対象。
 * 同名在庫があれば quantity +1、なければ quantity 1 で新規作成する。
 * 失敗は boolean (false) で返すのみで、呼び出し側のチェック操作自体には
 * 影響させない（revalidatePath は呼び出し側 actions.ts の責務）。
 */

// ─── Helper: 在庫自動追加 ─────────────────────────────────
export async function autoAddToStock(
  supabase: AuthContext["supabase"],
  householdId: string,
  userId: string,
  itemName: string,
  itemCategory: ItemCategory,
): Promise<boolean> {
  // 世帯の自動追加対象カテゴリを取得
  const { data: household, error: householdError } = await supabase
    .from("households")
    .select("auto_stock_categories")
    .eq("id", householdId)
    .single()

  if (householdError) {
    logSupabaseError("shopping", "household lookup failed", householdError, {
      householdId,
    })
  }

  if (!household) return false

  const categories = household.auto_stock_categories as string[]
  if (!Array.isArray(categories) || !categories.includes(itemCategory)) {
    return false
  }

  // 同名の在庫アイテムがあるか確認（完全一致で検索）
  const { data: matchedItems, error: matchedItemsError } = await supabase
    .from("stock_items")
    .select("id, name, quantity")
    .eq("household_id", householdId)
    .eq("name", itemName.trim())
    .limit(1)

  if (matchedItemsError) {
    logSupabaseError("shopping", "stock item match lookup failed", matchedItemsError, {
      householdId,
    })
  }

  const existing = matchedItems?.[0] ?? null

  if (existing) {
    const { error: updateError } = await supabase
      .from("stock_items")
      .update({ quantity: existing.quantity + 1 })
      .eq("id", existing.id)
    if (updateError) return false
  } else {
    const { error: insertError } = await supabase.from("stock_items").insert({
      household_id: householdId,
      name: itemName.trim(),
      category: itemCategory,
      quantity: 1,
      unit: "個",
      created_by: userId,
    })
    if (insertError) return false
  }

  return true
}
