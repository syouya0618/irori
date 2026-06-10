"use server"

import { revalidatePath } from "next/cache"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { autoAddLowStockItems } from "@/lib/supabase/low-stock"
import { fetchRecipeSuggestions } from "@/lib/supabase/recipe-suggestion-queries"
import {
  getNextSortOrder,
  searchPurchaseHistory,
} from "@/lib/supabase/shopping-queries"
import {
  calculateDailyRate,
  parseStockFormData,
  type RecipeSuggestion,
} from "@/lib/domain"
import { todayJstString, shiftYmd } from "@/lib/utils/date-jst"

export async function addStockItem(formData: FormData) {
  const parsed = parseStockFormData(formData)
  if ("error" in parsed) return parsed

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId, householdId } = result.context

  const { error } = await supabase.from("stock_items").insert({
    household_id: householdId,
    ...parsed,
    created_by: userId,
  })

  if (error) {
    return { error: "在庫の追加に失敗しました" }
  }

  revalidatePath("/stock")
  return { success: true }
}

export async function updateStockItem(itemId: string, formData: FormData) {
  const parsed = parseStockFormData(formData)
  if ("error" in parsed) return parsed

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  const { error } = await supabase
    .from("stock_items")
    .update(parsed)
    .eq("id", itemId)
    .eq("household_id", householdId)

  if (error) {
    return { error: "在庫の更新に失敗しました" }
  }

  revalidatePath("/stock")
  return { success: true }
}

export async function deleteStockItem(itemId: string) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  const { error } = await supabase
    .from("stock_items")
    .delete()
    .eq("id", itemId)
    .eq("household_id", householdId)

  if (error) {
    return { error: "削除に失敗しました" }
  }

  revalidatePath("/stock")
  return { success: true }
}

export async function getStockSuggestions(query: string) {
  if (!query || query.trim().length === 0) {
    return { suggestions: [] }
  }

  const result = await getAuthContext()
  if (result.error !== null) return { suggestions: [] }
  const { supabase, householdId } = result.context

  const { items: unique, error } = await searchPurchaseHistory(
    supabase,
    householdId,
    query,
  )

  if (error) {
    return { suggestions: [] }
  }

  return {
    suggestions: unique.map((item) => ({
      name: item.item_name,
      category: item.category,
    })),
  }
}

export async function addToShoppingList(itemId: string) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId, householdId } = result.context

  const { data: stockItem, error: fetchError } = await supabase
    .from("stock_items")
    .select("name, category")
    .eq("id", itemId)
    .eq("household_id", householdId)
    .single()

  if (fetchError || !stockItem) {
    return { error: "在庫アイテムが見つかりません" }
  }

  const { data: existing, error: existingError } = await supabase
    .from("shopping_items")
    .select("id")
    .eq("household_id", householdId)
    .ilike("name", stockItem.name)
    .limit(1)

  if (existingError) {
    logSupabaseError("stock", "shopping item duplicate check failed", existingError, {
      householdId,
    })
  }

  if (existing && existing.length > 0) {
    return { error: "既に買い物リストにあります" }
  }

  // sort_order の最大値 + 1 を取得 (log scope は stock)
  const sortOrder = await getNextSortOrder(supabase, householdId, "stock")

  const { error: insertError } = await supabase
    .from("shopping_items")
    .insert({
      household_id: householdId,
      name: stockItem.name,
      category: stockItem.category,
      store_type: "supermarket",
      created_by: userId,
      sort_order: sortOrder,
    })

  if (insertError) {
    return { error: "買い物リストへの追加に失敗しました" }
  }

  revalidatePath("/stock")
  revalidatePath("/shopping")
  return { success: true }
}

/**
 * 在庫食材をもとにレシピ（献立テンプレート）を提案する。
 * 読み取り専用のため revalidatePath は呼ばない。
 */
export async function getRecipeSuggestions(): Promise<{
  error: string | null
  data: RecipeSuggestion[]
}> {
  const result = await getAuthContext()
  if (result.error !== null) {
    return { error: result.error, data: [] }
  }
  const { supabase, householdId } = result.context

  return fetchRecipeSuggestions(supabase, householdId)
}

/**
 * 育児ログから消耗品の日次消費レートを算出する。
 * 現在はおむつ（"baby"カテゴリ）のみ対応。
 */
export async function getConsumptionRates(): Promise<{
  error: string | null
  rates: Record<string, number | null>
}> {
  const result = await getAuthContext()
  if (result.error !== null) {
    return { error: result.error, rates: {} }
  }
  const { supabase, householdId } = result.context

  const now = new Date()
  const today = todayJstString(now)
  const weekAgo = shiftYmd(today, -7)

  const { data: logs, error } = await supabase
    .from("baby_logs")
    .select("log_type, logged_at, amount_ml")
    .eq("household_id", householdId)
    .in("log_type", ["diaper", "feeding"])
    .gte("logged_at", `${weekAgo}T00:00:00`)
    .order("logged_at", { ascending: false })

  if (error) {
    return { error: "消費レートの取得に失敗しました", rates: {} }
  }

  const diaperRate = calculateDailyRate(logs ?? [], "diaper", now)

  return {
    error: null,
    rates: {
      baby: diaperRate,
    },
  }
}

/**
 * 在庫が少ないアイテムを買い物リストに自動追加する。
 * 残日数が3日以下のアイテムを対象とし、既に買い物リストにあるものは除外する。
 */
export async function checkAndAutoAddLowStock(): Promise<{
  error: string | null
  addedItems: string[]
}> {
  const result = await getAuthContext()
  if (result.error !== null) {
    return { error: result.error, addedItems: [] }
  }
  const { supabase, userId, householdId } = result.context

  const outcome = await autoAddLowStockItems(supabase, householdId, userId)

  // insert 成功時のみ addedItems が非空になる（低在庫なし・重複のみ等は空のまま）
  if (outcome.addedItems.length > 0) {
    revalidatePath("/shopping")
  }
  return outcome
}
