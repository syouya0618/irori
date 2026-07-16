import type { ItemCategory } from "@/lib/types/database"
import { categoryDisplayOrder } from "@/lib/utils/categories"

const MAX_NAME_LENGTH = 100

const VALID_CATEGORIES = new Set<string>(categoryDisplayOrder)

/** レシート手動補助フォームの1行分（UI ドラフト） */
export interface ReceiptDraftItem {
  name: string
  category: ItemCategory
  quantity: number
}

/** DB 追加に使える正規化済みアイテム */
export interface ReceiptItem {
  name: string
  category: ItemCategory
  quantity: number
}

/**
 * レシートドラフトをサーバ保存前に正規化・検証する。
 * - 名前は trim。空・空白のみの行は除外（誤って空行を保存しない）
 * - 名前は 100 文字に切り詰め
 * - 数量は 0 以上の有限数のみ許容（0 は「切らした」記録として有効）、それ以外は 1
 * - カテゴリが enum 外なら other_food
 */
export function sanitizeReceiptItems(items: ReceiptDraftItem[]): ReceiptItem[] {
  const result: ReceiptItem[] = []
  for (const item of items) {
    const name = item.name.trim().slice(0, MAX_NAME_LENGTH)
    if (name === "") continue

    const quantity =
      Number.isFinite(item.quantity) && item.quantity >= 0 ? item.quantity : 1

    const category = VALID_CATEGORIES.has(item.category)
      ? item.category
      : "other_food"

    result.push({ name, category, quantity })
  }
  return result
}
