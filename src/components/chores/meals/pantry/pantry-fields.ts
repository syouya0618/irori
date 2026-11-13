/**
 * 食材の入力欄と、Server Action へ送る内容（`PantryItemFields`）の間の変換。
 *
 * 境界指令を持たない中立モジュール（純関数だけ。食材辞書・レシピのカタログを import しない）。
 * 入力の最終の検査は Server Action と DB が行う。ここは「届く前に分かる誤り」を利用者の言葉で返す。
 */

import {
  PANTRY_QUANTITY_MIN,
  type PantryItemFields,
  type PantryQuantityInput,
} from "@/lib/meals/server/pantry-requests"
import { PANTRY_QUANTITY_MAX } from "@/lib/meals/server/rows"
import type { PantryStatus, PantryStorage, Quantity, UnitId } from "@/lib/meals/types"
import { UNIT_LABELS, unitFamily } from "@/lib/meals/units"

import type { PantryItemView } from "./pantry-item-view"

/** 在庫の数量に選べる単位（数えられる単位だけ。「適量」「少々」は在庫の数量にしない）。 */
export const PANTRY_UNIT_OPTIONS: readonly { value: UnitId; label: string }[] = (Object.keys(UNIT_LABELS) as UnitId[])
  .filter((unit) => unitFamily(unit) !== "none")
  .map((unit) => ({ value: unit, label: UNIT_LABELS[unit] }))

export function isPantryUnit(value: string): value is UnitId {
  return PANTRY_UNIT_OPTIONS.some((option) => option.value === value)
}

export type AmountParse =
  /** 空欄 = 数量不明（`amount: null`）。 */
  | { ok: true; amount: number | null }
  | { ok: false; message: string }

/**
 * 数量の入力欄の文字を数へ読む。空欄は「数量不明」（0 や「十分ある」にしない）。
 * 全角の数字・小数点は半角として読む。小数は 2 桁へ丸める（DB の持ち方と同じ）。
 */
export function parseAmountText(text: string): AmountParse {
  const normalized = text.normalize("NFKC").trim()
  if (normalized === "") return { ok: true, amount: null }
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return { ok: false, message: "数量は数字で入力してください。分からないときは空欄（数量不明）にできます。" }
  }
  const amount = Math.round(Number(normalized) * 100) / 100
  if (!Number.isFinite(amount) || amount < PANTRY_QUANTITY_MIN || amount > PANTRY_QUANTITY_MAX) {
    return {
      ok: false,
      message: `数量は${PANTRY_QUANTITY_MIN}以上の数で入力してください。分からないときは空欄（数量不明）にできます。`,
    }
  }
  return { ok: true, amount }
}

/** 保存済みの数量を、送る形へ写す。量を持たない・数えない単位は「数量不明」。 */
export function quantityInputOf(quantity: Quantity | null): PantryQuantityInput | null {
  if (quantity === null || quantity.amount === null || !isPantryUnit(quantity.unit)) return null
  return { amount: quantity.amount, unit: quantity.unit }
}

/** 入力欄の初期値（数量の文字）。数量不明は空欄。 */
export function amountTextOf(quantity: Quantity | null): string {
  const input = quantityInputOf(quantity)
  return input === null ? "" : String(input.amount)
}

/**
 * 一覧の 1 行を、そのまま送れる内容へ写す（状態の切替・「今日確認した」などの 1 項目の変更で使う）。
 *
 * 食材の一覧に無い ID（古い記録）は `ingredientId: null` にして、名前から解決し直させる
 * （サーバーは一覧に無い ID を拒む。そのまま送ると、その食材だけ状態を変えられなくなる）。
 */
export function fieldsOfPantryItem(item: PantryItemView): PantryItemFields {
  return {
    ingredientId: item.catalogName === null ? null : item.ingredientId,
    name: item.name,
    quantity: quantityInputOf(item.quantity),
    status: item.status,
    useSoon: item.useSoon,
    storage: item.storage,
    expiresOn: item.expiresOn,
    confirmedOn: item.confirmedOn,
  }
}

export const PANTRY_STATUS_ORDER: readonly PantryStatus[] = ["have", "low", "out"]
export const PANTRY_STORAGE_ORDER: readonly (PantryStorage | null)[] = ["fridge", "freezer", "pantry", null]
export const PANTRY_STORAGE_UNSET_LABEL = "保管場所なし"
