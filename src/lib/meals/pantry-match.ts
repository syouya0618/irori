/**
 * レシピ × 在庫の突き合わせ。充足を 3 段で返す。
 *
 * - `ready`: 必須材料が全てあり、数量も足りる（または世帯が設定した常備品）。
 * - `check`: あるが、数量不明・残り少ない・単位を換算できない・最終確認が古い。
 * - `buy`  : 必須材料が欠ける（在庫に無い・使い切った・期限超過・量が足りない）。
 *
 * 規則:
 * - 突き合わせは食材 ID の一致だけ。辞書に解決できていない在庫（`ingredientId: null`）は数えない。
 * - 総称で登録された在庫（「豚肉」「きのこ」。辞書の `generic`）は、部位・種類と**同一視しない**
 *   （数量を引き当てず、「揃う」にもしない）。ただし「在庫に無い」とも言わない: その総称に由来する
 *   材料が他に揃わないときは `uncertain`（確認が必要）にし、どの在庫かを `genericStock` で返す。
 * - 期限は**食べる予定日**時点で判定する。期限超過と「使い切った」は材料に数えない
 *   （旧 Irori の欠陥 (a)「期限超過への加点」を直したもの。期限の判定はこのモジュールの 1 関数だけ）。
 * - 未登録の油・調味料を在庫ありと見なさない。充足扱いにするのは世帯が設定した常備品だけ。
 * - 数量不明・古い在庫を「十分ある」と断定しない（`check` に留め、理由を返す）。
 * - 在庫は変更しない。消費の見込みは `consumption` として返し、複数日の引当は `reserved` で渡す。
 */

import { daysBetweenYmd, isValidYmd } from "@/lib/utils/date-jst"

import { ingredientNameOf, lineageOf } from "./lookup"
import type { IngredientIndex } from "./normalize"
import type { PantryItem, PantryStorage, Quantity, RecipeIngredient } from "./types"
import {
  areUnitsCompatible,
  baseUnitOf,
  roundAmount,
  scaleQuantity,
  scaleToBaseAmount,
  toBaseAmount,
  unitFamily,
} from "./units"

/** 期限が「近い」とみなす日数（食べる予定日から数えて 0〜この日数）。 */
export const EXPIRY_SOON_DAYS = 3

/**
 * 最終確認からこの日数を超えた在庫は「古い」として確認を促す（保管場所別）。
 * 公的な基準ではなく、確認を促すための Irori の既定値。
 */
export const STALE_AFTER_DAYS: Readonly<Record<PantryStorage | "unknown", number>> = {
  fridge: 7,
  freezer: 30,
  pantry: 60,
  unknown: 7,
}

export type ExpiryState = "none" | "fresh" | "soon" | "expired"

/**
 * 期限の状態を 1 か所で決める。`onDate` は食べる予定日。
 * 当日までは使える（`soon`）。前日以前は `expired`。期限の値が不正なら使えない側へ倒す。
 */
export function expiryStateOn(expiresOn: string | null, onDate: string): ExpiryState {
  if (expiresOn === null) return "none"
  if (!isValidYmd(expiresOn)) return "expired"
  const days = daysBetweenYmd(onDate, expiresOn)
  if (days === null || days < 0) return "expired"
  return days <= EXPIRY_SOON_DAYS ? "soon" : "fresh"
}

/** 最終確認が古いか。確認日が不正なら古い側へ倒す。未来の確認日は古くない。 */
export function isStale(item: Pick<PantryItem, "confirmedOn" | "storage">, today: string): boolean {
  const days = daysBetweenYmd(item.confirmedOn, today)
  if (days === null || !isValidYmd(item.confirmedOn)) return true
  return days > STALE_AFTER_DAYS[item.storage ?? "unknown"]
}

export type Sufficiency = "ready" | "check" | "buy"

export type MatchReason =
  /** 在庫に登録が無い。 */
  | "not_in_pantry"
  /** 使い切った（または数量 0）。 */
  | "used_up"
  /** 食べる予定日には期限を過ぎている。 */
  | "expired"
  /** 量が足りない。 */
  | "short"
  /** 他の日の献立へ割り当て済み。 */
  | "allocated"
  /** 数量が登録されていない。 */
  | "quantity_unknown"
  /** 残り少ない。 */
  | "low"
  /** 在庫の単位とレシピの単位を換算できない。 */
  | "unit_mismatch"
  /** 最終確認が古い。 */
  | "stale"

export type LineState = "enough" | "staple" | "uncertain" | "missing"

export interface IngredientMatch {
  ingredientId: string
  name: string
  optional: boolean
  /** 作る人数に合わせた必要量（単位はレシピのまま）。 */
  required: Quantity
  state: LineState
  reasons: MatchReason[]
  /** 足りない量（基準単位）。`missing` では買う量、`uncertain` では確かめられていない量。 */
  shortBy: Quantity | null
  /** この材料に当てた在庫の ID。 */
  usedItemIds: string[]
  /** 必要量（基準単位）。「適量」などは null。 */
  requiredBase: number | null
  /** 数量の確かな在庫から当てた量（基準単位）。買い物で差し引いてよい量。 */
  stockCertain: number
  /** 最終確認が古い在庫から当てた量（基準単位）。買い物では差し引かない。 */
  stockUncertain: number
  /**
   * この材料の総称（「豚肉」「きのこ」）で登録された在庫があり、部位・種類を確かめる必要がある。
   * そのときだけ持つ（`state` は `uncertain`。数量は引き当てていない）。
   * 画面では「『豚肉』で登録されています。部位（豚こま・豚バラ など）を確認してください」のように示す。
   */
  genericStock?: { pantryItemIds: string[] }
}

export interface StockConsumption {
  pantryItemId: string
  ingredientId: string
  /** 基準単位での量。 */
  quantity: Quantity
  /** false = 最終確認が古い在庫からの見込み（買い物では差し引かない）。 */
  certain: boolean
}

export interface PantryMatch {
  level: Sufficiency
  lines: IngredientMatch[]
  /** 必須材料のうち欠けているもの。 */
  missing: IngredientMatch[]
  /** 必須材料のうち確認が必要なもの。 */
  toCheck: IngredientMatch[]
  /** 数量の分かる在庫から使う見込み（必須材料のみ）。 */
  consumption: StockConsumption[]
  /** 必須材料に当てた「早く使いたい」在庫の件数。 */
  useSoonCount: number
  /** 必須材料に当てた、期限の近い在庫の件数（期限超過は含まない）。 */
  expiringSoonCount: number
  requiredCount: number
  satisfiedCount: number
}

export interface MatchOptions {
  /** 食べる予定日（YYYY-MM-DD）。期限はこの日で判定する。 */
  eatOn: string
  /** 今日（YYYY-MM-DD）。最終確認の古さはこの日で判定する。省略時は `eatOn`。 */
  today?: string
  /** 世帯が設定した常備品の食材 ID。 */
  stapleIngredientIds?: Iterable<string>
  /** 他の日へ割り当て済みの量（在庫 ID → 基準単位の量）。 */
  reserved?: ReadonlyMap<string, number>
  /** 表示名を引くための辞書（無ければ ID を名前にする）。 */
  index?: IngredientIndex
}

export interface MatchableDish {
  ingredients: readonly RecipeIngredient[]
  /** 材料の量が何人分か。 */
  servings: number
}

interface UsableItem {
  item: PantryItem
  /** 割当後に残っている量（基準単位）。数量不明・換算不可は null。 */
  available: number | null
  mismatch: boolean
  stale: boolean
  expiry: ExpiryState
}

function byUseOrder(a: UsableItem, b: UsableItem): number {
  const aExpiry = a.item.expiresOn ?? "9999-12-31"
  const bExpiry = b.item.expiresOn ?? "9999-12-31"
  return (
    aExpiry.localeCompare(bExpiry) ||
    Number(b.item.useSoon) - Number(a.item.useSoon) ||
    a.item.confirmedOn.localeCompare(b.item.confirmedOn) ||
    a.item.id.localeCompare(b.item.id)
  )
}

function pushReason(reasons: MatchReason[], reason: MatchReason): void {
  if (!reasons.includes(reason)) reasons.push(reason)
}

interface LineContext {
  pantry: readonly PantryItem[]
  eatOn: string
  today: string
  staples: ReadonlySet<string>
  /** 割当済み + この料理の中で既に使った量。 */
  taken: Map<string, number>
  index: IngredientIndex | undefined
}

interface Classified {
  usable: UsableItem[]
  reasons: MatchReason[]
  rowCount: number
}

function classifyRows(ingredient: RecipeIngredient, ctx: LineContext): Classified {
  const rows = ctx.pantry.filter((item) => item.ingredientId === ingredient.ingredientId)
  const usable: UsableItem[] = []
  const reasons: MatchReason[] = []
  for (const item of rows) {
    const expiry = expiryStateOn(item.expiresOn, ctx.eatOn)
    if (item.status === "out") {
      pushReason(reasons, "used_up")
      continue
    }
    if (expiry === "expired") {
      pushReason(reasons, "expired")
      continue
    }
    const stale = isStale(item, ctx.today)
    if (item.quantity === null) {
      usable.push({ item, available: null, mismatch: false, stale, expiry })
      continue
    }
    const total = toBaseAmount(item.quantity)
    if (unitFamily(item.quantity.unit) === "none" || total === null) {
      usable.push({ item, available: null, mismatch: false, stale, expiry })
      continue
    }
    if (total <= 0) {
      pushReason(reasons, "used_up")
      continue
    }
    const available = roundAmount(total - (ctx.taken.get(item.id) ?? 0))
    if (available <= 0) {
      pushReason(reasons, "allocated")
      continue
    }
    if (!areUnitsCompatible(item.quantity.unit, ingredient.quantity.unit)) {
      // 「適量」の材料は量を比べない。数値の材料で単位の族が違えば換算せず、確認へ回す
      const numericNeed = unitFamily(ingredient.quantity.unit) !== "none"
      usable.push({ item, available: null, mismatch: numericNeed, stale, expiry })
      continue
    }
    usable.push({ item, available, mismatch: false, stale, expiry })
  }
  if (rows.length === 0) pushReason(reasons, "not_in_pantry")
  return { usable: usable.sort(byUseOrder), reasons, rowCount: rows.length }
}

interface LineResult {
  match: IngredientMatch
  consumption: StockConsumption[]
  used: UsableItem[]
}

function matchNonNumeric(base: IngredientMatch, usable: UsableItem[]): LineResult {
  const solid = usable.find((u) => u.item.status !== "low" && !u.stale)
  if (solid) {
    return { match: { ...base, state: "enough", usedItemIds: [solid.item.id] }, consumption: [], used: [solid] }
  }
  const reasons: MatchReason[] = []
  if (usable.some((u) => u.item.status === "low")) pushReason(reasons, "low")
  if (usable.some((u) => u.stale)) pushReason(reasons, "stale")
  return {
    match: { ...base, state: "uncertain", reasons, usedItemIds: usable.map((u) => u.item.id) },
    consumption: [],
    used: usable,
  }
}

function matchNumeric(
  base: IngredientMatch,
  ingredient: RecipeIngredient,
  need: number,
  usable: UsableItem[],
  blockedReasons: readonly MatchReason[],
): LineResult {
  const unit = baseUnitOf(ingredient.quantity.unit) ?? ingredient.quantity.unit
  const consumption: StockConsumption[] = []
  const used: UsableItem[] = []
  let remaining = need
  let usedStale = false
  const take = (candidates: UsableItem[], certain: boolean) => {
    for (const candidate of candidates) {
      if (remaining <= 0 || candidate.available === null) continue
      const amount = roundAmount(Math.min(candidate.available, remaining))
      remaining = roundAmount(remaining - amount)
      used.push(candidate)
      if (!certain) usedStale = true
      consumption.push({
        pantryItemId: candidate.item.id,
        ingredientId: ingredient.ingredientId,
        quantity: { amount, unit },
        certain,
      })
    }
  }
  take(usable.filter((u) => u.available !== null && !u.stale), true)
  take(usable.filter((u) => u.available !== null && u.stale), false)

  const reasons: MatchReason[] = []
  if (usedStale) pushReason(reasons, "stale")
  const usedItemIds = () => used.map((u) => u.item.id)
  if (remaining <= 0) {
    const state: LineState = usedStale ? "uncertain" : "enough"
    return { match: { ...base, state, reasons, usedItemIds: usedItemIds() }, consumption, used }
  }
  const unknown = usable.filter((u) => u.available === null)
  const shortBy: Quantity = { amount: remaining, unit }
  if (unknown.length > 0) {
    if (unknown.some((u) => !u.mismatch)) pushReason(reasons, "quantity_unknown")
    if (unknown.some((u) => u.mismatch)) pushReason(reasons, "unit_mismatch")
    if (unknown.some((u) => u.item.status === "low")) pushReason(reasons, "low")
    if (unknown.some((u) => u.stale)) pushReason(reasons, "stale")
    used.push(...unknown)
    return {
      match: { ...base, state: "uncertain", reasons, shortBy, usedItemIds: usedItemIds() },
      consumption,
      used,
    }
  }
  for (const reason of blockedReasons) pushReason(reasons, reason)
  if (used.length > 0) pushReason(reasons, "short")
  return {
    match: { ...base, state: "missing", reasons, shortBy, usedItemIds: usedItemIds() },
    consumption,
    used,
  }
}

function matchLine(ingredient: RecipeIngredient, dish: MatchableDish, servings: number, ctx: LineContext): LineResult {
  const required = scaleQuantity(ingredient.quantity, dish.servings, servings)
  const need = scaleToBaseAmount(ingredient.quantity, dish.servings, servings)
  const base: IngredientMatch = {
    ingredientId: ingredient.ingredientId,
    name: ctx.index ? ingredientNameOf(ingredient.ingredientId, ctx.index) : ingredient.ingredientId,
    optional: ingredient.optional === true,
    required,
    state: "missing",
    reasons: [],
    shortBy: null,
    usedItemIds: [],
    requiredBase: need,
    stockCertain: 0,
    stockUncertain: 0,
  }
  const { usable, reasons, rowCount } = classifyRows(ingredient, ctx)
  const isStaple = ctx.staples.has(ingredient.ingredientId)
  // 常備品は充足扱い。ただし在庫に「使い切った」「期限超過」と登録されているなら、その記録を優先する
  if (isStaple && (rowCount === 0 || usable.length > 0)) {
    return { match: { ...base, state: "staple" }, consumption: [], used: [] }
  }
  if (usable.length === 0) {
    const shortBy =
      need === null ? null : { amount: need, unit: baseUnitOf(ingredient.quantity.unit) ?? ingredient.quantity.unit }
    return withGenericStock({ match: { ...base, state: "missing", reasons, shortBy }, consumption: [], used: [] }, ingredient, ctx)
  }
  if (need === null) return matchNonNumeric(base, usable)
  return withGenericStock(matchNumeric(base, ingredient, need, usable, reasons), ingredient, ctx)
}

/** 総称（`generic`）で登録された、使える在庫のうち、この材料の由来に当たるもの。 */
function genericStockFor(ingredient: RecipeIngredient, ctx: LineContext): UsableItem[] {
  const index = ctx.index
  if (!index) return []
  const ancestors = lineageOf(ingredient.ingredientId, index).ancestors
  if (ancestors.length === 0) return []
  const found: UsableItem[] = []
  for (const item of ctx.pantry) {
    if (item.ingredientId === null || !ancestors.includes(item.ingredientId)) continue
    if (index.byId.get(item.ingredientId)?.generic !== true) continue
    const expiry = expiryStateOn(item.expiresOn, ctx.eatOn)
    if (item.status === "out" || expiry === "expired") continue
    // 数量は引き当てない（部位・種類が合うかを確かめられていない）
    found.push({ item, available: null, mismatch: false, stale: isStale(item, ctx.today), expiry })
  }
  return found.sort(byUseOrder)
}

/**
 * 欠けている材料に、総称で登録された在庫があれば「確認が必要」へ回す。
 * 同一視はしない: 数量は引き当てず（買い物でも差し引かない）、足りない量もそのまま残す。
 */
function withGenericStock(result: LineResult, ingredient: RecipeIngredient, ctx: LineContext): LineResult {
  if (result.match.state !== "missing") return result
  const generic = genericStockFor(ingredient, ctx)
  if (generic.length === 0) return result
  const pantryItemIds = generic.map((u) => u.item.id)
  return {
    match: {
      ...result.match,
      state: "uncertain",
      reasons: [],
      usedItemIds: [...result.match.usedItemIds, ...pantryItemIds],
      genericStock: { pantryItemIds },
    },
    consumption: result.consumption,
    used: [...result.used, ...generic],
  }
}

/**
 * 料理 1 つを在庫と突き合わせる。`servings` は作る人数（量は元の材料から一度だけ計算する）。
 * 在庫・`reserved` は変更しない。
 */
export function matchDishToPantry(
  dish: MatchableDish,
  servings: number,
  pantry: readonly PantryItem[],
  options: MatchOptions,
): PantryMatch {
  const ctx: LineContext = {
    pantry,
    eatOn: options.eatOn,
    today: options.today ?? options.eatOn,
    staples: new Set(options.stapleIngredientIds ?? []),
    taken: new Map(options.reserved ?? []),
    index: options.index,
  }
  const lines: IngredientMatch[] = []
  const consumption: StockConsumption[] = []
  const usedForRequired = new Map<string, UsableItem>()
  // 必須材料を先に当てる（任意材料が必須材料の在庫を先取りしないように）
  const ordered = [
    ...dish.ingredients.filter((i) => i.optional !== true),
    ...dish.ingredients.filter((i) => i.optional === true),
  ]
  for (const ingredient of ordered) {
    const result = matchLine(ingredient, dish, servings, ctx)
    for (const c of result.consumption) {
      const amount = c.quantity.amount ?? 0
      if (c.certain) result.match.stockCertain = roundAmount(result.match.stockCertain + amount)
      else result.match.stockUncertain = roundAmount(result.match.stockUncertain + amount)
    }
    lines.push(result.match)
    if (result.match.optional) continue
    for (const c of result.consumption) {
      ctx.taken.set(c.pantryItemId, roundAmount((ctx.taken.get(c.pantryItemId) ?? 0) + (c.quantity.amount ?? 0)))
      consumption.push(c)
    }
    for (const u of result.used) usedForRequired.set(u.item.id, u)
  }
  const required = lines.filter((line) => !line.optional)
  const missing = required.filter((line) => line.state === "missing")
  const toCheck = required.filter((line) => line.state === "uncertain")
  // 必須材料が 1 つも無い料理は突き合わせる根拠が無い。「揃っている」とは言わない
  const level: Sufficiency =
    missing.length > 0 ? "buy" : toCheck.length > 0 || required.length === 0 ? "check" : "ready"
  const usedItems = [...usedForRequired.values()]
  return {
    level,
    lines,
    missing,
    toCheck,
    consumption,
    useSoonCount: usedItems.filter((u) => u.item.useSoon).length,
    expiringSoonCount: usedItems.filter((u) => u.expiry === "soon").length,
    requiredCount: required.length,
    satisfiedCount: required.length - missing.length - toCheck.length,
  }
}

/** 割当の台帳へ消費の見込みを足す（在庫そのものは変えない）。 */
export function reserveConsumption(
  reserved: Map<string, number>,
  consumption: readonly StockConsumption[],
): void {
  for (const c of consumption) {
    reserved.set(c.pantryItemId, roundAmount((reserved.get(c.pantryItemId) ?? 0) + (c.quantity.amount ?? 0)))
  }
}
