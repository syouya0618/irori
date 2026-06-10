import type { ItemCategory } from "@/lib/types/database"

/** parseStockFormData の成功時パース結果 */
export type ParsedStockFields = {
  name: string
  category: ItemCategory
  quantity: number
  unit: string | null
  expires_at: string | null
}

/**
 * 在庫フォームの FormData を stock_items の insert/update 用フィールドへ
 * パースする純関数。
 *
 * - name: 必須。空文字・空白のみはエラー。前後空白は trim する
 * - category: 未指定・空文字は "other_food"
 * - quantity: Number() で変換し、falsy (欠落 / "" / "0" / NaN) は 1 に倒す
 * - unit / expires_at: 空文字・欠落は null（値の trim は行わない）
 */
export function parseStockFormData(
  formData: FormData,
): ParsedStockFields | { error: string } {
  const name = formData.get("name")
  if (typeof name !== "string" || name.trim().length === 0) {
    return { error: "アイテム名を入力してください" }
  }

  const unit = formData.get("unit")
  const expiresAt = formData.get("expires_at")

  return {
    name: name.trim(),
    category: (formData.get("category") as ItemCategory) || "other_food",
    quantity: Number(formData.get("quantity")) || 1,
    unit: typeof unit === "string" && unit.length > 0 ? unit : null,
    expires_at:
      typeof expiresAt === "string" && expiresAt.length > 0 ? expiresAt : null,
  }
}
