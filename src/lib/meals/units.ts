/**
 * 単位の族・換算・加減算・人数スケール・日本語表記。
 *
 * 規則（テストで固定）:
 * - 換算するのは明示した組だけ: g↔kg、ml↔l、小さじ=5ml、大さじ=15ml、カップ=200ml。
 * - 個数系（個・パック・束 …）は単位ごとに別の族。互いにも、g / ml とも換算しない。
 * - 適量・少々は数値化しない（加減算・比較は null を返す）。
 * - 計算値は 1e-6 に丸めて保持する（浮動小数の誤差だけを消す。意味のある丸めはしない）。
 * - 人数スケールは「元レシピ量 ×（作る人数 ÷ レシピの人数）」を一度だけ。結果を再スケールしない。
 * - 表示の丸めは `formatQuantity` だけが行う（保持している値は変えない）。
 */

import type { Quantity, UnitFamily, UnitId } from "./types"

const MASS_TO_GRAM: Partial<Record<UnitId, number>> = { g: 1, kg: 1000 }
const VOLUME_TO_ML: Partial<Record<UnitId, number>> = {
  ml: 1,
  l: 1000,
  tsp: 5,
  tbsp: 15,
  cup: 200,
}
const NON_NUMERIC: ReadonlySet<UnitId> = new Set<UnitId>(["to_taste", "pinch"])

/** 日本語表記。`tsp` `tbsp` `cup` は数値の前に置く（「大さじ1」）。 */
export const UNIT_LABELS: Readonly<Record<UnitId, string>> = {
  g: "g",
  kg: "kg",
  ml: "ml",
  l: "L",
  tsp: "小さじ",
  tbsp: "大さじ",
  cup: "カップ",
  piece: "個",
  pack: "パック",
  bunch: "束",
  slice: "切れ",
  clove: "かけ",
  can: "缶",
  sheet: "枚",
  stalk: "本",
  bag: "袋",
  block: "丁",
  bowl: "杯",
  to_taste: "適量",
  pinch: "少々",
}

const PREFIX_UNITS: ReadonlySet<UnitId> = new Set<UnitId>(["tsp", "tbsp", "cup"])
const PRECISION = 1e6

/** 浮動小数の誤差を消すための丸め（1e-6）。 */
export function roundAmount(value: number): number {
  return Math.round(value * PRECISION) / PRECISION
}

export function unitFamily(unit: UnitId): UnitFamily {
  if (unit in MASS_TO_GRAM) return "mass"
  if (unit in VOLUME_TO_ML) return "volume"
  if (NON_NUMERIC.has(unit)) return "none"
  return "count"
}

/**
 * 合算できる範囲を表す鍵。個数系は単位ごとに別の鍵（`count:piece` と `count:pack` は別）。
 * 買い物の `item_key` と在庫の突き合わせは、この鍵が一致するものだけを数値で扱う。
 */
export function unitFamilyKey(unit: UnitId): string {
  const family = unitFamily(unit)
  return family === "count" ? `count:${unit}` : family
}

/** 族の基準単位（mass → g、volume → ml、個数系 → その単位自身）。数値化しない単位は null。 */
export function baseUnitOf(unit: UnitId): UnitId | null {
  const family = unitFamily(unit)
  if (family === "mass") return "g"
  if (family === "volume") return "ml"
  if (family === "count") return unit
  return null
}

function factorToBase(unit: UnitId): number | null {
  const mass = MASS_TO_GRAM[unit]
  if (mass !== undefined) return mass
  const volume = VOLUME_TO_ML[unit]
  if (volume !== undefined) return volume
  return unitFamily(unit) === "count" ? 1 : null
}

function isUsableAmount(amount: number | null): amount is number {
  return typeof amount === "number" && Number.isFinite(amount) && amount >= 0
}

/**
 * 基準単位での量。数値化しない単位・不正な量（null / 負 / 非有限）は null。
 * 0 は「量が 0」として通す（呼び出し側が欠品として扱う）。
 */
export function toBaseAmount(quantity: Quantity): number | null {
  const factor = factorToBase(quantity.unit)
  if (factor === null || !isUsableAmount(quantity.amount)) return null
  return roundAmount(quantity.amount * factor)
}

/** 基準単位の Quantity へ。数値化できなければ null。 */
export function toBaseQuantity(quantity: Quantity): Quantity | null {
  const amount = toBaseAmount(quantity)
  const unit = baseUnitOf(quantity.unit)
  if (amount === null || unit === null) return null
  return { amount, unit }
}

/** 数値で足し引きできる組か（族の鍵が同じで、どちらも数値化できる単位）。 */
export function areUnitsCompatible(a: UnitId, b: UnitId): boolean {
  return unitFamily(a) !== "none" && unitFamilyKey(a) === unitFamilyKey(b)
}

/** 合算（基準単位で返す）。互換でない・数値化できないときは null。 */
export function addQuantities(a: Quantity, b: Quantity): Quantity | null {
  if (!areUnitsCompatible(a.unit, b.unit)) return null
  const left = toBaseAmount(a)
  const right = toBaseAmount(b)
  const unit = baseUnitOf(a.unit)
  if (left === null || right === null || unit === null) return null
  return { amount: roundAmount(left + right), unit }
}

/**
 * 減算 `a − b`（基準単位で返す）。差が 0 以下なら amount は 0。
 * 互換でない・数値化できないときは null（0 と区別する）。
 */
export function subtractQuantities(a: Quantity, b: Quantity): Quantity | null {
  if (!areUnitsCompatible(a.unit, b.unit)) return null
  const left = toBaseAmount(a)
  const right = toBaseAmount(b)
  const unit = baseUnitOf(a.unit)
  if (left === null || right === null || unit === null) return null
  return { amount: Math.max(0, roundAmount(left - right)), unit }
}

/** 大小比較（a<b → -1、同量 → 0、a>b → 1）。互換でなければ null。 */
export function compareQuantities(a: Quantity, b: Quantity): -1 | 0 | 1 | null {
  if (!areUnitsCompatible(a.unit, b.unit)) return null
  const left = toBaseAmount(a)
  const right = toBaseAmount(b)
  if (left === null || right === null) return null
  if (left === right) return 0
  return left < right ? -1 : 1
}

function isValidServings(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

/**
 * 人数スケール（単位は元のまま）。**元レシピの量**を渡すこと（スケール済みの値を再度渡さない）。
 * 適量・少々はそのまま返す。人数が不正なら RangeError。
 */
export function scaleQuantity(
  original: Quantity,
  recipeServings: number,
  targetServings: number,
): Quantity {
  if (!isValidServings(recipeServings) || !isValidServings(targetServings)) {
    throw new RangeError("servings must be a positive finite number")
  }
  if (unitFamily(original.unit) === "none" || !isUsableAmount(original.amount)) {
    return { amount: null, unit: original.unit }
  }
  return {
    amount: roundAmount((original.amount * targetServings) / recipeServings),
    unit: original.unit,
  }
}

/**
 * 人数スケールした量を基準単位で返す（合算用）。元の単位で丸めてから換算すると
 * 「大さじ 1/3 → 4.99999ml」のように誤差が乗るため、基準単位で一度だけ計算する。
 */
export function scaleToBaseAmount(
  original: Quantity,
  recipeServings: number,
  targetServings: number,
): number | null {
  if (!isValidServings(recipeServings) || !isValidServings(targetServings)) {
    throw new RangeError("servings must be a positive finite number")
  }
  const factor = factorToBase(original.unit)
  if (factor === null || !isUsableAmount(original.amount)) return null
  return roundAmount((original.amount * factor * targetServings) / recipeServings)
}

/**
 * 買うときの量。個数系は切り上げ（1.5 個 → 2 個）、g / ml はそのまま。
 * 必要量そのもの（残りの計算に使う値）は変えず、表示用にだけ使う。
 */
export function ceilForPurchase(quantity: Quantity): Quantity {
  if (unitFamily(quantity.unit) !== "count" || !isUsableAmount(quantity.amount)) {
    return quantity
  }
  return { amount: Math.ceil(roundAmount(quantity.amount)), unit: quantity.unit }
}

const FRACTIONS: readonly { value: number; label: string }[] = [
  { value: 1 / 4, label: "1/4" },
  { value: 1 / 3, label: "1/3" },
  { value: 1 / 2, label: "1/2" },
  { value: 2 / 3, label: "2/3" },
  { value: 3 / 4, label: "3/4" },
]
const FRACTION_TOLERANCE = 0.005

function trimDecimal(value: number, digits: number): string {
  return String(Number(value.toFixed(digits)))
}

/** 小さじ・大さじ・カップ・個数系の数値表記（1/2 などの分数を優先、他は小数 2 桁まで）。 */
function formatCountLike(amount: number): string {
  const whole = Math.floor(amount + FRACTION_TOLERANCE)
  const rest = amount - whole
  if (Math.abs(rest) < FRACTION_TOLERANCE) return String(whole)
  const fraction = FRACTIONS.find((f) => Math.abs(f.value - rest) < FRACTION_TOLERANCE)
  if (!fraction) return trimDecimal(amount, 2)
  return whole === 0 ? fraction.label : `${whole}と${fraction.label}`
}

/**
 * 日本語表記。
 * - 適量・少々: 語だけ。
 * - g / ml: 1000 以上は kg / L（小数 2 桁まで）、未満は小数 1 桁まで。
 * - 小さじ・大さじ・カップ: 「大さじ1と1/2」。
 * - 個数系: 「1/2個」「2個」。
 * - 量が不明（null）な数値単位: 「量不明」。
 */
export function formatQuantity(quantity: Quantity): string {
  const label = UNIT_LABELS[quantity.unit]
  if (unitFamily(quantity.unit) === "none") return label
  if (!isUsableAmount(quantity.amount)) return "量不明"
  const amount = quantity.amount
  if (quantity.unit === "g" || quantity.unit === "ml") {
    if (amount >= 1000) {
      return `${trimDecimal(amount / 1000, 2)}${quantity.unit === "g" ? "kg" : "L"}`
    }
    return `${trimDecimal(amount, 1)}${label}`
  }
  if (quantity.unit === "kg" || quantity.unit === "l") {
    return `${trimDecimal(amount, 2)}${label}`
  }
  if (PREFIX_UNITS.has(quantity.unit)) return `${label}${formatCountLike(amount)}`
  return `${formatCountLike(amount)}${label}`
}
