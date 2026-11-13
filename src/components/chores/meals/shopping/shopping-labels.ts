/**
 * 買い物リストの操作の呼び名・結果の文言・量の読み下し（正本）。
 *
 * 境界指令を持たない中立モジュール。量の計算はしない — 残りは サーバーが作った表示
 * （`ShoppingItemView.remainingText`。正本は `grocery.ts` の `remainingToBuy`）をそのまま使う。
 */

import { formatQuantityJa } from "@/lib/meals/server/format"
import type { GroceryRequest, GrocerySaveSuccess } from "@/lib/meals/server/plan-requests"
import type { ShoppingItemView } from "@/lib/meals/server/plan-views"

/** 項目 ID から名前を引く（見つからなければ空文字）。 */
export type ItemNameOf = (itemId: string) => string

function quoted(name: string): string {
  return `「${name === "" ? "項目" : name}」`
}

/**
 * 数量で追える項目の「購入済み 300g・あと 200g」。
 * 購入が無く残りだけのときは「あと 500g」。数量で追えない項目は null（チェックだけで示す）。
 * 購入済みは**買った事実の合計**。作った料理に使った分・在庫へ足した分は内訳として添える（どちらも残りの計算に効く）。
 */
export function purchaseProgressText(
  item: Pick<
    ShoppingItemView,
    "numeric" | "unit" | "purchasedAmount" | "restockedAmount" | "consumedAmount" | "remainingText"
  >,
): string | null {
  const { unit } = item
  if (!item.numeric || unit === null) return null
  const format = (amount: number) => formatQuantityJa({ amount, unit })
  const parts: string[] = []
  if (item.purchasedAmount > 0) parts.push(`購入済み ${format(item.purchasedAmount)}`)
  // 作った料理に使った分は、これからの料理には充てない（「作った」を取り消すと戻る）
  if (item.consumedAmount > 0) parts.push(`うち作った料理に使用 ${format(item.consumedAmount)}`)
  // 在庫へ足した分は「手元の購入分」から外れる（残りの計算に効く）ので、内訳として添える
  if (item.restockedAmount > 0) parts.push(`うち在庫へ追加 ${format(item.restockedAmount)}`)
  if (item.remainingText !== null) parts.push(`あと ${item.remainingText}`)
  return parts.length === 0 ? null : parts.join("・")
}

/** 端末の控えに残す名前（体言止め）。 */
export function labelOfGroceryRequest(request: GroceryRequest, nameOf: ItemNameOf): string {
  switch (request.op) {
    case "sync":
      return "買い物リストを献立から更新"
    case "purchase": {
      const name = quoted(nameOf(request.id))
      if (request.purchase.kind === "full") return `${name}を購入済みに変更`
      if (request.purchase.kind === "check") {
        return request.purchase.checked ? `${name}を購入済みに変更` : `${name}の購入済みを取り消し`
      }
      return `${name}の買った量を変更`
    }
    case "manual_item":
      return request.version === null
        ? `${quoted(request.name.trim())}を買い物リストへ追加`
        : `${quoted(request.name.trim())}を変更`
    case "meta":
      return `${quoted(nameOf(request.id))}のメモ・売場を変更`
    case "delete":
      return `${quoted(nameOf(request.id))}を買い物リストから削除`
    case "restock":
      return `${quoted(nameOf(request.groceryId))}を在庫へ追加`
  }
}

/** 保存が成立したとき（saved / replayed）の文。 */
export function successTextOfGroceryRequest(request: GroceryRequest, nameOf: ItemNameOf): string {
  switch (request.op) {
    case "sync":
      return "買い物リストを、今の献立と食材から計算し直しました。購入の記録・メモ・手動の項目はそのままです。"
    case "purchase": {
      const name = quoted(nameOf(request.id))
      if (request.purchase.kind === "full") return `${name}を購入済みにしました。在庫は変えていません。`
      if (request.purchase.kind === "check") {
        return request.purchase.checked
          ? `${name}を購入済みにしました。在庫は変えていません。`
          : `${name}の購入済みを取り消しました。`
      }
      return `${name}の買った量を記録しました。在庫は変えていません。`
    }
    case "manual_item":
      return request.version === null
        ? `${quoted(request.name.trim())}を買い物リストへ追加しました。`
        : `${quoted(request.name.trim())}を変更しました。`
    case "meta":
      return `${quoted(nameOf(request.id))}のメモ・売場を変更しました。`
    case "delete":
      return "項目を買い物リストから削除しました。"
    case "restock":
      return `${quoted(nameOf(request.groceryId))}を在庫へ追加しました。購入の記録はそのままです。`
  }
}

export const SHOPPING_CONFLICT_TEXTS = {
  gone: "この項目は、他の端末で既に削除されています。最新の買い物リストを確認してください。",
  row_changed: "他の端末で先に変更されていました。上書きはしていません。最新の内容を確認してください。",
  stale_plan: "献立が他の端末で変更されました。最新の内容を確認してから、もう一度お試しください。",
} as const

/** conflict（上書きしていない）のときの文。 */
export function conflictTextOfGrocery(result: Pick<GrocerySaveSuccess, "detail">): string {
  const detail = result.detail ?? "row_changed"
  return Object.prototype.hasOwnProperty.call(SHOPPING_CONFLICT_TEXTS, detail)
    ? SHOPPING_CONFLICT_TEXTS[detail]
    : SHOPPING_CONFLICT_TEXTS.row_changed
}
