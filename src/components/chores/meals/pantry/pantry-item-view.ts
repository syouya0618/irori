/**
 * 食材の一覧の 1 行ぶんの表示用の値（Server Component が組み立て、Client Component へ渡す）。
 *
 * 境界指令を持たない中立モジュール。期限・確認の古さの判定はロジック（`pantry-match.ts`）の関数を
 * そのまま使う（画面で別の基準を作らない。提案と同じ日数で「古い」と言う）。
 * 「今日」は呼び出し側（サーバーの JST の今日）が渡す。端末の時計を読まない。
 */

import { type ExpiryState, expiryStateOn, isStale } from "@/lib/meals/pantry-match"
import type { StoredPantryItem } from "@/lib/meals/server/rows"
import type { IngredientDef } from "@/lib/meals/types"

export interface PantryItemView extends StoredPantryItem {
  /**
   * 食材の一覧の表示名。一覧へ解決できていない（名前のまま持っている）・一覧に無い ID は null。
   * null の食材は提案の材料に数えない。
   */
  catalogName: string | null
  /** 期限の状態（`none` = 期限なし）。 */
  expiry: ExpiryState
  /** true = 最後の確認から日が経っている（提案では「分量要確認」になる）。 */
  stale: boolean
  /**
   * 総称（「豚肉」「鶏肉」「牛肉」「きのこ」）で登録されている。部位・種類が分からないので、
   * 提案・献立・買い物では**材料として数えていない**（当たりそうな料理は「確認が必要」になる）。
   * null は総称ではない。`examples` は、具体的な名前の例（「豚こま切れ肉」など。無ければ空）。
   */
  generic: { examples: string[] } | null
}

/** 食材の一覧の表示名を引く関数（`lookup.index.byId.get(id)?.name`）。 */
export type CatalogNameOf = (ingredientId: string) => string | undefined

/** 総称の食材かどうかと、具体的な名前の例を引く関数（総称でなければ null）。 */
export type GenericInfoOf = (ingredientId: string) => { examples: string[] } | null

/** 具体的な名前の例として挙げる数。 */
const GENERIC_EXAMPLES = 3

/**
 * 食材辞書から、総称の食材（`generic`）の「具体的な名前の例」を引く関数を作る。
 * 例は、その総称に由来する食材（「豚肉」→「豚こま切れ肉」）。総称と同じ頭の名前を先に挙げる
 * （「豚肉」には「豚…」を先に。「ベーコン」のような加工品は後ろ）。
 */
export function genericInfoFrom(byId: ReadonlyMap<string, IngredientDef>): GenericInfoOf {
  return (ingredientId) => {
    const def = byId.get(ingredientId)
    if (def?.generic !== true) return null
    const head = def.name.replace(/肉$/u, "")
    const children = [...byId.values()].filter(
      (candidate) => candidate.generic !== true && (candidate.derivedFrom ?? []).includes(ingredientId),
    )
    const sameHead = children.filter((candidate) => head !== "" && candidate.name.startsWith(head))
    const rest = children.filter((candidate) => !sameHead.includes(candidate))
    return { examples: [...sameHead, ...rest].slice(0, GENERIC_EXAMPLES).map((candidate) => candidate.name) }
  }
}

export function toPantryItemView(
  item: StoredPantryItem,
  today: string,
  catalogNameOf: CatalogNameOf,
  genericInfoOf?: GenericInfoOf,
): PantryItemView {
  return {
    ...item,
    catalogName: item.ingredientId === null ? null : (catalogNameOf(item.ingredientId) ?? null),
    expiry: expiryStateOn(item.expiresOn, today),
    stale: isStale(item, today),
    generic: item.ingredientId === null || genericInfoOf === undefined ? null : genericInfoOf(item.ingredientId),
  }
}

export function toPantryItemViews(
  items: readonly StoredPantryItem[],
  today: string,
  catalogNameOf: CatalogNameOf,
  genericInfoOf?: GenericInfoOf,
): PantryItemView[] {
  return items.map((item) => toPantryItemView(item, today, catalogNameOf, genericInfoOf))
}

/** 総称で登録した食材に添える文（食材の画面と「今あるもので」で同じ文を使う）。 */
export const GENERIC_STOCK_TEXT =
  "総称で登録されています。部位・種類が分からないため、提案・献立・買い物の材料に数えていません。"

/** 具体的な名前の例を添えた、直し方の文。 */
export function genericFixText(examples: readonly string[]): string {
  return examples.length > 0
    ? `${examples.map((name) => `「${name}」`).join("")}のように、具体的な名前に直すと材料に数えます。`
    : "具体的な名前（部位・種類）に直すと材料に数えます。"
}
