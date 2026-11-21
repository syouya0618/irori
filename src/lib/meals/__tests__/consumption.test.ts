import { describe, expect, it } from "vitest"

import { CONSUMPTION_ISSUE_LABELS, deductPantryUse } from "../consumption"
import type { Quantity } from "../types"

function pantry(q: Quantity | null, status: "have" | "low" | "out" = "have") {
  return { quantity: q, status } as const
}

describe("調理で使った実量を冷蔵庫から減らす", () => {
  it("同じ単位で300gから100g使ったら200g残る（元データは書き換えない）", () => {
    const item = pantry({ amount: 300, unit: "g" })
    const result = deductPantryUse(item, { amount: 100, unit: "g" })
    expect(result).toEqual({ ok: true, remaining: { amount: 200, unit: "g" }, status: "have" })
    expect(item.quantity).toEqual({ amount: 300, unit: "g" })
  })

  it("1kgから250gなら単位を維持して0.75kg、残り少ない状態は勝手に解除しない", () => {
    expect(deductPantryUse(pantry({ amount: 1, unit: "kg" }, "low"), { amount: 250, unit: "g" }))
      .toEqual({ ok: true, remaining: { amount: 0.75, unit: "kg" }, status: "low" })
  })

  it("大さじ2杯から小さじ3杯を使えば大さじ1杯が残る", () => {
    expect(deductPantryUse(pantry({ amount: 2, unit: "tbsp" }), { amount: 3, unit: "tsp" }))
      .toEqual({ ok: true, remaining: { amount: 1, unit: "tbsp" }, status: "have" })
  })

  it("ぴったり使い切れば数量なし＋out。過剰消費は0へ丸めず拒否する", () => {
    expect(deductPantryUse(pantry({ amount: 2, unit: "piece" }), { amount: 2, unit: "piece" }))
      .toEqual({ ok: true, remaining: null, status: "out" })
    expect(deductPantryUse(pantry({ amount: 2, unit: "piece" }), { amount: 3, unit: "piece" }))
      .toEqual({ ok: false, issue: "overuse" })
  })

  it("異なる個数単位（本/袋）や重さと容量の変換はしない", () => {
    expect(deductPantryUse(pantry({ amount: 2, unit: "piece" }), { amount: 1, unit: "pack" }))
      .toEqual({ ok: false, issue: "unit_mismatch" })
    expect(deductPantryUse(pantry({ amount: 200, unit: "g" }), { amount: 100, unit: "ml" }))
      .toEqual({ ok: false, issue: "unit_mismatch" })
  })

  it("数量不明・使い切り済み・ゼロ/NaNは差し引かない", () => {
    expect(deductPantryUse(pantry(null), { amount: 1, unit: "g" }))
      .toEqual({ ok: false, issue: "unknown_quantity" })
    expect(deductPantryUse(pantry({ amount: null, unit: "g" }), { amount: 1, unit: "g" }))
      .toEqual({ ok: false, issue: "unknown_quantity" })
    expect(deductPantryUse(pantry({ amount: 1, unit: "g" }, "out"), { amount: 1, unit: "g" }))
      .toEqual({ ok: false, issue: "no_stock" })
    expect(deductPantryUse(pantry({ amount: 1, unit: "g" }), { amount: 0, unit: "g" }))
      .toEqual({ ok: false, issue: "invalid_amount" })
    expect(deductPantryUse(pantry({ amount: 1, unit: "g" }), { amount: Number.NaN, unit: "g" }))
      .toEqual({ ok: false, issue: "invalid_amount" })
    expect(CONSUMPTION_ISSUE_LABELS.overuse).toContain("在庫より多い")
  })
})
