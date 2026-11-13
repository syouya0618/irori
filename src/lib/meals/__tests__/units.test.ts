import { describe, expect, it } from "vitest"

import type { UnitId } from "../types"
import {
  addQuantities,
  areUnitsCompatible,
  baseUnitOf,
  ceilForPurchase,
  compareQuantities,
  formatQuantity,
  scaleQuantity,
  scaleToBaseAmount,
  subtractQuantities,
  toBaseQuantity,
  unitFamily,
  unitFamilyKey,
} from "../units"
import { q } from "./fixtures"

describe("単位の族", () => {
  it("g/kg は mass、ml/l/小さじ/大さじ/カップは volume、適量・少々は none", () => {
    expect(unitFamily("g")).toBe("mass")
    expect(unitFamily("kg")).toBe("mass")
    for (const unit of ["ml", "l", "tsp", "tbsp", "cup"] as UnitId[]) {
      expect(unitFamily(unit)).toBe("volume")
    }
    expect(unitFamily("to_taste")).toBe("none")
    expect(unitFamily("pinch")).toBe("none")
  })

  it("個数系は単位ごとに別の鍵（個とパックを同じ族にしない）", () => {
    expect(unitFamily("piece")).toBe("count")
    expect(unitFamilyKey("piece")).toBe("count:piece")
    expect(unitFamilyKey("pack")).toBe("count:pack")
    expect(unitFamilyKey("piece")).not.toBe(unitFamilyKey("pack"))
    expect(unitFamilyKey("g")).toBe(unitFamilyKey("kg"))
    expect(baseUnitOf("bunch")).toBe("bunch")
    expect(baseUnitOf("to_taste")).toBeNull()
  })

  it("互換なのは同じ鍵の数値単位だけ（個↔g、個↔パック、適量どうしは不可）", () => {
    expect(areUnitsCompatible("g", "kg")).toBe(true)
    expect(areUnitsCompatible("tsp", "cup")).toBe(true)
    expect(areUnitsCompatible("piece", "piece")).toBe(true)
    expect(areUnitsCompatible("piece", "g")).toBe(false)
    expect(areUnitsCompatible("piece", "pack")).toBe(false)
    expect(areUnitsCompatible("ml", "g")).toBe(false)
    expect(areUnitsCompatible("to_taste", "to_taste")).toBe(false)
  })
})

describe("換算（明示した組だけ）", () => {
  it.each([
    [q(1, "kg"), q(1000, "g")],
    [q(1.5, "l"), q(1500, "ml")],
    [q(1, "tsp"), q(5, "ml")],
    [q(1, "tbsp"), q(15, "ml")],
    [q(1, "cup"), q(200, "ml")],
    [q(3, "piece"), q(3, "piece")],
  ])("%o → %o", (input, expected) => {
    expect(toBaseQuantity(input)).toEqual(expected)
  })

  it("適量・少々・量が null / 負 / 非有限は数値化しない", () => {
    expect(toBaseQuantity(q(null, "to_taste"))).toBeNull()
    expect(toBaseQuantity(q(null, "pinch"))).toBeNull()
    expect(toBaseQuantity(q(null, "g"))).toBeNull()
    expect(toBaseQuantity(q(-1, "g"))).toBeNull()
    expect(toBaseQuantity(q(Number.NaN, "g"))).toBeNull()
  })

  it("量 0 は 0 として通す（欠品の判定は呼び出し側）", () => {
    expect(toBaseQuantity(q(0, "g"))).toEqual(q(0, "g"))
  })
})

describe("加算・減算・比較", () => {
  it("g と kg を合算する", () => {
    expect(addQuantities(q(300, "g"), q(0.5, "kg"))).toEqual(q(800, "g"))
  })

  it("大さじ 1 + 小さじ 1 = 20ml", () => {
    expect(addQuantities(q(1, "tbsp"), q(1, "tsp"))).toEqual(q(20, "ml"))
  })

  it("個 + g、個 + パック、適量 + 適量は合算しない（null）", () => {
    expect(addQuantities(q(1, "piece"), q(100, "g"))).toBeNull()
    expect(addQuantities(q(1, "piece"), q(1, "pack"))).toBeNull()
    expect(addQuantities(q(null, "to_taste"), q(null, "to_taste"))).toBeNull()
  })

  it("浮動小数の誤差を残さない（0.1 + 0.2 = 0.3）", () => {
    expect(addQuantities(q(0.1, "g"), q(0.2, "g"))).toEqual(q(0.3, "g"))
  })

  it("減算は 0 未満にしない。同量ちょうどは 0", () => {
    expect(subtractQuantities(q(500, "g"), q(300, "g"))).toEqual(q(200, "g"))
    expect(subtractQuantities(q(300, "g"), q(300, "g"))).toEqual(q(0, "g"))
    expect(subtractQuantities(q(300, "g"), q(1, "kg"))).toEqual(q(0, "g"))
  })

  it("互換でない減算は 0 ではなく null（「足りている」と区別する）", () => {
    expect(subtractQuantities(q(2, "piece"), q(100, "g"))).toBeNull()
  })

  it("比較: 同量 0、不足 -1、超過 1、互換でなければ null", () => {
    expect(compareQuantities(q(1, "kg"), q(1000, "g"))).toBe(0)
    expect(compareQuantities(q(999, "g"), q(1, "kg"))).toBe(-1)
    expect(compareQuantities(q(1, "cup"), q(1, "tbsp"))).toBe(1)
    expect(compareQuantities(q(1, "piece"), q(1, "g"))).toBeNull()
  })
})

describe("人数スケール（元レシピ量から一度だけ）", () => {
  it("2 人分 200g を 4 人分にすると 400g、3 人分なら 300g", () => {
    expect(scaleQuantity(q(200, "g"), 2, 4)).toEqual(q(400, "g"))
    expect(scaleQuantity(q(200, "g"), 2, 3)).toEqual(q(300, "g"))
  })

  it("単位は元のまま（大さじ 1 を 3 人分 → 大さじ 1.5）", () => {
    expect(scaleQuantity(q(1, "tbsp"), 2, 3)).toEqual(q(1.5, "tbsp"))
  })

  it("適量・少々はスケールしない", () => {
    expect(scaleQuantity(q(null, "to_taste"), 2, 6)).toEqual(q(null, "to_taste"))
    expect(scaleQuantity(q(null, "pinch"), 2, 6)).toEqual(q(null, "pinch"))
  })

  it("元の量から一度だけ計算する: 2→3→5 と重ねた結果と 2→5 の結果は一致しない場合があるため、常に元から計算する", () => {
    const original = q(100, "g")
    const direct = scaleQuantity(original, 3, 7)
    const chained = scaleQuantity(scaleQuantity(original, 3, 5), 5, 7)
    expect(direct).toEqual(q(233.333333, "g"))
    // 重ねた計算は丸めが 2 回入り、元から計算した値とずれる（だから重ねない）
    expect(chained.amount).not.toBe(direct.amount)
  })

  it("基準単位でのスケールは、換算してから一度だけ丸める（大さじ 1 を 3 人分→1 人分で 5ml）", () => {
    expect(scaleToBaseAmount(q(1, "tbsp"), 3, 1)).toBe(5)
    expect(scaleToBaseAmount(q(null, "to_taste"), 2, 4)).toBeNull()
  })

  it("人数が 0・負・非有限なら RangeError", () => {
    expect(() => scaleQuantity(q(1, "g"), 0, 2)).toThrow(RangeError)
    expect(() => scaleQuantity(q(1, "g"), 2, -1)).toThrow(RangeError)
    expect(() => scaleToBaseAmount(q(1, "g"), 2, Number.NaN)).toThrow(RangeError)
  })

  it("買う量の切り上げは個数系だけ（1.5 個 → 2 個、150.5g はそのまま）", () => {
    expect(ceilForPurchase(q(1.5, "piece"))).toEqual(q(2, "piece"))
    expect(ceilForPurchase(q(2, "piece"))).toEqual(q(2, "piece"))
    expect(ceilForPurchase(q(150.5, "g"))).toEqual(q(150.5, "g"))
  })
})

describe("日本語表記", () => {
  it.each([
    [q(200, "g"), "200g"],
    [q(1250, "g"), "1.25kg"],
    [q(1000, "g"), "1kg"],
    [q(0.5, "kg"), "0.5kg"],
    [q(15, "ml"), "15ml"],
    [q(1500, "ml"), "1.5L"],
    [q(1, "tbsp"), "大さじ1"],
    [q(1.5, "tbsp"), "大さじ1と1/2"],
    [q(0.5, "tsp"), "小さじ1/2"],
    [q(0.333333, "cup"), "カップ1/3"],
    [q(2, "piece"), "2個"],
    [q(0.5, "piece"), "1/2個"],
    [q(1.2, "piece"), "1.2個"],
    [q(1, "bunch"), "1束"],
    [q(2, "slice"), "2切れ"],
    [q(1, "block"), "1丁"],
    [q(null, "to_taste"), "適量"],
    [q(null, "pinch"), "少々"],
    [q(null, "g"), "量不明"],
  ])("%o → %s", (input, expected) => {
    expect(formatQuantity(input)).toBe(expected)
  })

  it("表示は丸めるが、保持している値は変えない", () => {
    const value = q(233.333333, "g")
    expect(formatQuantity(value)).toBe("233.3g")
    expect(value.amount).toBe(233.333333)
  })
})
