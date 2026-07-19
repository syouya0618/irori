import type { ItemCategory } from "@/lib/types/database"
import { categoryDisplayOrder } from "@/lib/utils/categories"
import { guessItemCategory } from "./item-category-guess"
import type { ScannedReceiptItem } from "./receipt-ocr-parse"

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
 * Server Action 経由の untrusted な引数（name が number 等）でも throw しない。
 * - 要素が object でない / name が string でない行は除外
 * - 名前は trim。空・空白のみの行は除外（誤って空行を保存しない）
 * - 名前は 100 文字に切り詰め
 * - 数量は 0 以上の有限数のみ許容（0 は「切らした」記録として有効）、それ以外は 1
 * - カテゴリが enum 外なら other_food
 */
export function sanitizeReceiptItems(items: ReceiptDraftItem[]): ReceiptItem[] {
  const result: ReceiptItem[] = []
  for (const raw of items as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue
    const item = raw as Partial<Record<keyof ReceiptDraftItem, unknown>>
    if (typeof item.name !== "string") continue

    const name = item.name.trim().slice(0, MAX_NAME_LENGTH)
    if (name === "") continue

    const quantity =
      typeof item.quantity === "number" &&
      Number.isFinite(item.quantity) &&
      item.quantity >= 0
        ? item.quantity
        : 1

    const category =
      typeof item.category === "string" && VALID_CATEGORIES.has(item.category)
        ? (item.category as ItemCategory)
        : "other_food"

    result.push({ name, category, quantity })
  }
  return result
}

/**
 * OCR で抽出した品名候補を、カテゴリ推測込みの入力ドラフト行に変換する。
 * 数量が不明（null）なら 1 とする。UI で確認・修正する前提。
 */
export function scannedItemsToDrafts(
  items: ScannedReceiptItem[],
): ReceiptDraftItem[] {
  return items.map((item) => ({
    name: item.name,
    category: guessItemCategory(item.name),
    quantity: item.quantity ?? 1,
  }))
}
