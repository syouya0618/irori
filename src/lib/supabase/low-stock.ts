import type { PostgrestError } from "@supabase/supabase-js"
import type { AuthContext } from "@/lib/supabase/auth-context"
import type { ItemCategory } from "@/lib/types/database"
import { logSupabaseError } from "@/lib/supabase/log-error"
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
        // JST 深夜 0 時。オフセットを省くと Postgres がセッション TZ(UTC)で解釈し
        // 週窓が 9 時間ずれる(深夜の授乳・おむつ記録が漏れる)。他の日付境界と同じく
        // +09:00 を明示する。
        .gte("logged_at", `${weekAgo}T00:00:00+09:00`)
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

  // 取得失敗時は「自動追加をしない」で退化させる（呼び出し側の在庫表示自体は
  // 壊さない）。ただし理由を握り潰さず、どのクエリが落ちたかを構造化ログに残す。
  const failed: Array<[string, PostgrestError | null]> = [
    ["households", householdResult.error],
    ["baby_logs", logsResult.error],
    ["stock_items", stockResult.error],
    ["shopping_items", shoppingResult.error],
  ]
  for (const [scope, err] of failed) {
    if (err) {
      logSupabaseError("low-stock", `${scope} の取得に失敗`, err, { householdId })
    }
  }

  if (
    householdResult.error ||
    logsResult.error ||
    stockResult.error ||
    shoppingResult.error ||
    !householdResult.data
  ) {
    if (!householdResult.error && !householdResult.data) {
      console.error("[low-stock] households の行が取得できませんでした", {
        householdId,
      })
    }
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
    logSupabaseError("low-stock", "買い物リストへの自動追加に失敗", insertError, {
      householdId,
      count: insertRows.length,
    })
    return { error: "買い物リストへの追加に失敗しました", addedItems: [] }
  }

  return { error: null, addedItems: toAdd.map((i) => i.name) }
}
