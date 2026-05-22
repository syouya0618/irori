"use server"

import { revalidatePath } from "next/cache"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { getCurrentWeekRange } from "@/lib/utils/date"
import type { AuthContext } from "@/lib/supabase/auth-context"
import type { ItemCategory, StoreType } from "@/lib/types/database"

// ─── Helper: 今週の献立から新しい食材を取得 ──────────────────
async function getNewIngredientsForWeek(
  supabase: AuthContext["supabase"],
  householdId: string
) {
  const { startDate, endDate } = getCurrentWeekRange()

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
async function getNextSortOrder(
  supabase: AuthContext["supabase"],
  householdId: string
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
    logSupabaseError("shopping", "sort_order lookup failed", error, {
      householdId,
    })
  }
  return (data?.sort_order ?? 0) + 1
}

// ─── アイテム追加 ────────────────────────────────────────
export async function addItem(formData: FormData) {
  const name = formData.get("name")
  if (typeof name !== "string" || name.trim().length === 0) {
    return { error: "アイテム名を入力してください" }
  }

  const category = (formData.get("category") as ItemCategory) || "other_food"
  const storeType = (formData.get("store_type") as StoreType) || "supermarket"
  const quantity = (formData.get("quantity") as string) || null

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId, householdId } = result.context

  // sort_order は既存の最大値 + 1
  const sortOrder = await getNextSortOrder(supabase, householdId)

  const { error } = await supabase.from("shopping_items").insert({
    household_id: householdId,
    name: name.trim(),
    quantity,
    category,
    store_type: storeType,
    created_by: userId,
    sort_order: sortOrder,
  })

  if (error) {
    return { error: "アイテムの追加に失敗しました" }
  }

  revalidatePath("/shopping")
  return { success: true }
}

// ─── チェック切り替え ────────────────────────────────────
export async function toggleItem(itemId: string, isChecked: boolean) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId, householdId } = result.context

  // 世帯に属するアイテムか確認してから更新（名前とカテゴリも取得）
  const { data: updatedItem, error } = await supabase
    .from("shopping_items")
    .update({
      is_checked: isChecked,
      checked_by: isChecked ? userId : null,
      checked_at: isChecked ? new Date().toISOString() : null,
    })
    .eq("id", itemId)
    .eq("household_id", householdId)
    .select("name, category")
    .single()

  if (error) {
    return { error: "更新に失敗しました" }
  }

  // 在庫自動追加: チェックON時のみ
  let autoStocked = false
  let autoStockedName: string | null = null

  if (isChecked && updatedItem) {
    try {
      const stocked = await autoAddToStock(
        supabase,
        householdId,
        userId,
        updatedItem.name,
        updatedItem.category as ItemCategory,
      )
      if (stocked) {
        autoStocked = true
        autoStockedName = updatedItem.name
      }
    } catch {
      // auto-stockの失敗はチェック操作自体には影響させない
    }
  }

  revalidatePath("/shopping")
  if (autoStocked) revalidatePath("/stock")
  return { success: true, autoStocked, autoStockedName }
}

// ─── Helper: 在庫自動追加 ─────────────────────────────────
async function autoAddToStock(
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

// ─── アイテム削除 ────────────────────────────────────────
export async function deleteItem(itemId: string) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  const { error } = await supabase
    .from("shopping_items")
    .delete()
    .eq("id", itemId)
    .eq("household_id", householdId)

  if (error) {
    return { error: "削除に失敗しました" }
  }

  revalidatePath("/shopping")
  return { success: true }
}

// ─── チェック済みを削除 + 購入履歴に記録 ─────────────────
export async function clearChecked() {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  // チェック済みアイテムを取得
  const { data: checkedItems, error: fetchError } = await supabase
    .from("shopping_items")
    .select("name, category, store_type")
    .eq("household_id", householdId)
    .eq("is_checked", true)

  if (fetchError) {
    return { error: "チェック済みアイテムの取得に失敗しました" }
  }

  if (!checkedItems || checkedItems.length === 0) {
    return { error: "チェック済みのアイテムがありません" }
  }

  // 購入履歴に記録
  const historyItems = checkedItems.map((item) => ({
    household_id: householdId,
    item_name: item.name,
    category: item.category,
    store_type: item.store_type,
  }))

  const { error: historyError } = await supabase
    .from("purchase_history")
    .insert(historyItems)

  if (historyError) {
    // 履歴の記録に失敗しても削除は続行
    logSupabaseError("shopping", "購入履歴の記録に失敗", historyError, {
      householdId,
      itemCount: historyItems.length,
    })
  }

  // チェック済みアイテムを削除
  const { error: deleteError } = await supabase
    .from("shopping_items")
    .delete()
    .eq("household_id", householdId)
    .eq("is_checked", true)

  if (deleteError) {
    return { error: "チェック済みアイテムの削除に失敗しました" }
  }

  revalidatePath("/shopping")
  return { success: true, count: checkedItems.length }
}

// ─── 献立から食材を生成 ──────────────────────────────────
export async function generateFromMeals() {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId, householdId } = result.context

  const ingredientResult = await getNewIngredientsForWeek(supabase, householdId)

  if (ingredientResult.error === "no_meals") {
    return { error: "今週の献立が登録されていません", count: 0 }
  }
  if (ingredientResult.error === "no_ingredients") {
    return { error: "今週の献立に食材が登録されていません", count: 0 }
  }
  if (ingredientResult.error) {
    return { error: ingredientResult.error }
  }

  const { newIngredients } = ingredientResult

  if (newIngredients.length === 0) {
    return { error: "追加できる新しい食材がありません", count: 0 }
  }

  // sort_order の最大値を取得
  let sortOrder = await getNextSortOrder(supabase, householdId)

  // 名前で重複をまとめる（同じ食材が複数の献立に含まれる場合）
  const uniqueMap = new Map<
    string,
    { name: string; quantity: string | null; category: ItemCategory; meal_id: string }
  >()
  for (const ing of newIngredients) {
    const key = ing.name.toLowerCase()
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, ing)
    }
  }

  const itemsToInsert = Array.from(uniqueMap.values()).map((ing) => ({
    household_id: householdId,
    name: ing.name,
    quantity: ing.quantity,
    category: ing.category,
    store_type: "supermarket" as StoreType,
    created_by: userId,
    meal_id: ing.meal_id,
    sort_order: sortOrder++,
  }))

  const { error: insertError } = await supabase
    .from("shopping_items")
    .insert(itemsToInsert)

  if (insertError) {
    return { error: "食材の追加に失敗しました" }
  }

  revalidatePath("/shopping")
  return { success: true, count: itemsToInsert.length }
}

// ─── 食材数のプレビュー（確認ダイアログ用） ─────────────
export async function previewMealIngredients() {
  const result = await getAuthContext()
  if (result.error !== null) return { count: 0 }
  const { supabase, householdId } = result.context

  const ingredientResult = await getNewIngredientsForWeek(supabase, householdId)

  if (ingredientResult.error) {
    return { count: 0 }
  }

  // 名前でユニーク化
  const uniqueNames = new Set<string>()
  for (const ing of ingredientResult.newIngredients) {
    uniqueNames.add(ing.name.toLowerCase())
  }

  return { count: uniqueNames.size }
}

// ─── 購入履歴からサジェスト ──────────────────────────────
export async function getSuggestions(query: string) {
  if (!query || query.trim().length === 0) {
    return { suggestions: [] }
  }

  const result = await getAuthContext()
  if (result.error !== null) return { suggestions: [] }
  const { supabase, householdId } = result.context

  const { data, error } = await supabase
    .from("purchase_history")
    .select("item_name, category, store_type")
    .eq("household_id", householdId)
    .ilike("item_name", `%${query.trim().replace(/[%_\\]/g, "\\$&")}%`)
    .order("purchased_at", { ascending: false })
    .limit(20)

  if (error) {
    return { suggestions: [] }
  }

  // 名前でユニーク化（最新の履歴を優先）
  const seen = new Set<string>()
  const unique = (data ?? []).filter((item) => {
    const key = item.item_name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return {
    suggestions: unique.map((item) => ({
      name: item.item_name,
      category: item.category,
      storeType: item.store_type,
    })),
  }
}
