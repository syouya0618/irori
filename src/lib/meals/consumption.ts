/**
 * 調理後に「実際に使った量」を、登録された食材の残量に反映する純粋計算。
 *
 * ユーザーが明示した量だけ引く。レシピの推定量から自動で減らさない。
 * 元の単位は保持し、数量不明・換算不能・在庫超過は勝手に補正せず拒む。
 * DBへの書き込みは、元のupdated_atを添えたsave_pantry_itemで行う。
 */

import type { PantryStatus, Quantity } from "./types"
import { areUnitsCompatible, roundAmount, toBaseAmount } from "./units"

export type ConsumptionIssue = "no_stock" | "unknown_quantity" | "invalid_amount" | "unit_mismatch" | "overuse"

export const CONSUMPTION_ISSUE_LABELS: Readonly<Record<ConsumptionIssue, string>> = {
  no_stock: "使い切った食材です。新しく在庫を登録するか、状態を確認してください。",
  unknown_quantity: "残量が不明です。先に在庫画面で数量を確認してください。",
  invalid_amount: "使った量は0より大きい数で指定してください。",
  unit_mismatch: "在庫と使った量の単位を換算できません。同じ種類の単位で入力してください。",
  overuse: "在庫より多い量は差し引けません。在庫の数量を確認してください。",
}

export type ConsumptionPreview =
  | { ok: true; remaining: Quantity | null; status: PantryStatus }
  | { ok: false; issue: ConsumptionIssue }

/** 数量が0になればstatus=out / quantity=null。残りがあれば元のhave/lowを維持する。 */
export function deductPantryUse(
  item: Pick<{ status: PantryStatus; quantity: Quantity | null }, "status" | "quantity">,
  used: Quantity,
): ConsumptionPreview {
  if (item.status === "out") return { ok: false, issue: "no_stock" }
  const original = item.quantity
  if (original === null || original.amount === null || original.amount <= 0) {
    return { ok: false, issue: "unknown_quantity" }
  }
  if (used.amount === null || !Number.isFinite(used.amount) || used.amount <= 0) {
    return { ok: false, issue: "invalid_amount" }
  }
  if (!areUnitsCompatible(original.unit, used.unit)) return { ok: false, issue: "unit_mismatch" }

  const currentBase = toBaseAmount(original)
  const usedBase = toBaseAmount(used)
  const oneBase = toBaseAmount({ amount: 1, unit: original.unit })
  if (currentBase === null || usedBase === null || oneBase === null || oneBase <= 0) {
    return { ok: false, issue: "unit_mismatch" }
  }
  if (usedBase > currentBase) return { ok: false, issue: "overuse" }
  const remaining = roundAmount((currentBase - usedBase) / oneBase)
  if (remaining === 0) return { ok: true, remaining: null, status: "out" }
  if (remaining < 0) return { ok: false, issue: "overuse" }
  return { ok: true, remaining: { amount: remaining, unit: original.unit }, status: item.status }
}
