"use server"

import { revalidatePath } from "next/cache"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { getCachedStockItems } from "@/lib/supabase/cached-queries"
import type { ItemCategory, MealReaction } from "@/lib/types/database"
import {
  rankSuggestions,
  type RecipeSuggestion,
  type StockItemInput,
  type TemplateIngredient,
  type TemplateInput,
} from "@/lib/domain"

// ─── 在庫追加 ────────────────────────────────────────────
export async function addStockItem(formData: FormData) {
  const name = formData.get("name")
  if (typeof name !== "string" || name.trim().length === 0) {
    return { error: "アイテム名を入力してください" }
  }

  const category = (formData.get("category") as ItemCategory) || "other_food"
  const quantity = Number(formData.get("quantity")) || 1
  const unit = (formData.get("unit") as string) || null
  const expiresAt = (formData.get("expires_at") as string) || null

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId, householdId } = result.context

  const { error } = await supabase.from("stock_items").insert({
    household_id: householdId,
    name: name.trim(),
    category,
    quantity,
    unit: unit || null,
    expires_at: expiresAt || null,
    created_by: userId,
  })

  if (error) {
    return { error: "在庫の追加に失敗しました" }
  }

  revalidatePath("/stock")
  return { success: true }
}

// ─── 在庫更新 ────────────────────────────────────────────
export async function updateStockItem(itemId: string, formData: FormData) {
  const name = formData.get("name")
  if (typeof name !== "string" || name.trim().length === 0) {
    return { error: "アイテム名を入力してください" }
  }

  const category = (formData.get("category") as ItemCategory) || "other_food"
  const quantity = Number(formData.get("quantity")) || 1
  const unit = (formData.get("unit") as string) || null
  const expiresAt = (formData.get("expires_at") as string) || null

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  const { error } = await supabase
    .from("stock_items")
    .update({
      name: name.trim(),
      category,
      quantity,
      unit: unit || null,
      expires_at: expiresAt || null,
    })
    .eq("id", itemId)
    .eq("household_id", householdId)

  if (error) {
    return { error: "在庫の更新に失敗しました" }
  }

  revalidatePath("/stock")
  return { success: true }
}

// ─── 在庫削除 ────────────────────────────────────────────
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

// ─── 購入履歴からサジェスト ──────────────────────────────
export async function getStockSuggestions(query: string) {
  if (!query || query.trim().length === 0) {
    return { suggestions: [] }
  }

  const result = await getAuthContext()
  if (result.error !== null) return { suggestions: [] }
  const { supabase, householdId } = result.context

  const { data, error } = await supabase
    .from("purchase_history")
    .select("item_name, category")
    .eq("household_id", householdId)
    .ilike("item_name", `%${query.trim().replace(/[%_\\]/g, "\\$&")}%`)
    .order("purchased_at", { ascending: false })
    .limit(20)

  if (error) {
    return { suggestions: [] }
  }

  // 名前でユニーク化
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
    })),
  }
}

// ─── 在庫不足を買い物リストに追加 ────────────────────────
export async function addToShoppingList(itemId: string) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId, householdId } = result.context

  // 在庫アイテムを取得
  const { data: stockItem, error: fetchError } = await supabase
    .from("stock_items")
    .select("name, category")
    .eq("id", itemId)
    .eq("household_id", householdId)
    .single()

  if (fetchError || !stockItem) {
    return { error: "在庫アイテムが見つかりません" }
  }

  // 既に買い物リストにあるか確認
  const { data: existing } = await supabase
    .from("shopping_items")
    .select("id")
    .eq("household_id", householdId)
    .ilike("name", stockItem.name)
    .limit(1)

  if (existing && existing.length > 0) {
    return { error: "既に買い物リストにあります" }
  }

  // sort_order の最大値を取得
  const { data: maxOrder } = await supabase
    .from("shopping_items")
    .select("sort_order")
    .eq("household_id", householdId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .single()

  const sortOrder = (maxOrder?.sort_order ?? 0) + 1

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

// ─── レシピ提案 ──────────────────────────────────────────
/**
 * 在庫食材をもとにレシピ（献立テンプレート）を提案する。
 * ドメイン層の rankSuggestions を呼び出し、マッチスコア順に返す。
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

  // 在庫・テンプレート・過去リアクションを並列取得
  // 在庫は getCachedStockItems 経由で取得し、page.tsx 等と同一リクエスト内の
  // 重複フェッチを排除する。
  const [stockResult, templateResult, reactionResult] = await Promise.all([
    getCachedStockItems(householdId),
    supabase
      .from("meal_templates")
      .select("id, title, ingredients")
      .eq("household_id", householdId),
    // meals.template_id ごとの過去リアクションを取得（2段階クエリ）
    supabase
      .from("meals")
      .select("template_id, meal_reactions ( reaction )")
      .eq("household_id", householdId)
      .not("template_id", "is", null),
  ])

  if (stockResult.error || templateResult.error || reactionResult.error) {
    return { error: "レシピ提案の取得に失敗しました", data: [] }
  }

  const stockItems: StockItemInput[] = (stockResult.data ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category as ItemCategory,
    expires_at: s.expires_at,
  }))

  // template_id ごとにリアクションを集計
  // Database 型の Relationships が空のため as unknown as で型を宣言
  const reactionRows = (reactionResult.data ?? []) as unknown as Array<{
    template_id: string | null
    meal_reactions: Array<{ reaction: MealReaction }> | null
  }>
  const reactionMap = new Map<string, MealReaction[]>()
  for (const meal of reactionRows) {
    if (!meal.template_id) continue
    const existing = reactionMap.get(meal.template_id) ?? []
    for (const r of meal.meal_reactions ?? []) {
      existing.push(r.reaction)
    }
    reactionMap.set(meal.template_id, existing)
  }

  const templates: TemplateInput[] = (templateResult.data ?? []).map((t) => {
    const ingredients = Array.isArray(t.ingredients)
      ? (t.ingredients as unknown as TemplateIngredient[])
      : []
    return {
      id: t.id,
      title: t.title,
      ingredients,
      reactionHistory: reactionMap.get(t.id) ?? [],
    }
  })

  const suggestions = rankSuggestions(templates, stockItems)

  return { error: null, data: suggestions }
}
