import { getCachedStockItems } from "@/lib/supabase/cached-queries"
import type { AuthContext } from "@/lib/supabase/auth-context"
import type { ItemCategory, MealReaction } from "@/lib/types/database"
import {
  rankSuggestions,
  type RecipeSuggestion,
  type StockItemInput,
  type TemplateIngredient,
  type TemplateInput,
} from "@/lib/domain"

/**
 * レシピ提案 (getRecipeSuggestions) の DB 取得・整形ロジック置き場。
 *
 * - 認証 (getAuthContext) は呼び出し側 actions.ts の責務。
 *   ここでは `supabase: AuthContext["supabase"]` を第一引数で受け取るのみ。
 * - 在庫の取得は必ず getCachedStockItems 経由を維持すること。React cache の
 *   同一リクエスト内重複排除 (page.tsx と本関数で在庫クエリ 1 回) が挙動の
 *   一部であり、素の select に置き換えると挙動が変わる。
 */

// ─── Helper: 在庫からレシピ提案を取得・整形 ───────────────
export async function fetchRecipeSuggestions(
  supabase: AuthContext["supabase"],
  householdId: string,
): Promise<{ error: string | null; data: RecipeSuggestion[] }> {
  // 在庫は getCachedStockItems 経由で取得し、page.tsx との同一リクエスト内の
  // 重複フェッチを排除する。
  const [stockResult, templateResult, reactionResult] = await Promise.all([
    getCachedStockItems(householdId),
    supabase
      .from("meal_templates")
      .select("id, title, ingredients")
      .eq("household_id", householdId),
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
