"use server"

import { revalidatePath } from "next/cache"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { autoAddToStock } from "@/lib/supabase/auto-stock"
import {
  getNewIngredientsForWeek,
  getNextSortOrder,
  searchPurchaseHistory,
} from "@/lib/supabase/shopping-queries"
import type { ItemCategory, StoreType } from "@/lib/types/database"

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
      storeType: item.store_type,
    })),
  }
}
