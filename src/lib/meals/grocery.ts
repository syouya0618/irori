/**
 * 自動買い物リスト。
 *
 * 規則:
 * - 対象は**確定した枠**（status = confirmed）だけ。提案・作り終えた枠・作らなかった枠は含めない。
 *   確定でも、使わない食材の設定での判定が「問題なし」でない枠（`heldEntryIds`）は入れず、`held` に返す。
 * - 必要量は「元レシピ量 ×（枠の人数 ÷ レシピの人数）」を一度だけ計算する。
 * - 合算するのは、食材 ID と単位の族が同じものだけ（g↔kg、ml↔L↔小さじ・大さじ・カップ）。
 *   個数系は単位ごとに別。個↔g、束、適量、少々を推測で数値化しない。
 * - 在庫は**一度だけ**差し引く（日付順の台帳で、同じ在庫を 2 つの料理から引かない）。
 *   数量不明・単位を換算できない・最終確認が古い在庫は差し引かず、`needsStockCheck` を立てる。
 *   期限超過・使い切った在庫は差し引かない。常備品（世帯の設定）は買い物に出さない。
 * - 任意材料は自動の買い物に入れない。
 * - 自動項目は `itemKey`（食材 ID + 単位の族）で突き合わせ、購入量・メモ・売場の変更・手動項目を保持する。
 *   同じ入力で何度計算しても結果は同じで、項目は増えない。
 * - 「購入済み」と「在庫へ補充」と「作った料理への充当」は別の事実。
 *   残り = 必要量 −（購入量 − 在庫へ反映済みの量 − 作った料理へ充当した量）（後者は 0 未満にしない）。
 */

import { STORE_SECTIONS, storeSectionOrder } from "./catalog/sections"
import { type CatalogInput, type CatalogView, ingredientNameOf, toCatalogView } from "./lookup"
import { type MatchableDish, matchDishToPantry, reserveConsumption } from "./pantry-match"
import type {
  GroceryNeed,
  GrocerySource,
  PantryItem,
  PlanEntry,
  Quantity,
  StoreSection,
  UnitId,
} from "./types"
import {
  areUnitsCompatible,
  baseUnitOf,
  formatQuantity,
  roundAmount,
  toBaseAmount,
  unitFamily,
  unitFamilyKey,
} from "./units"

/** 未知の売場（データが先に増えた場合）は「その他」へ寄せる。売場の定義は `catalog/sections.ts` が正本。 */
export function normalizeSection(section: string | null | undefined): StoreSection {
  return STORE_SECTIONS.find((def) => def.id === section)?.id ?? "other"
}

/** 自動項目の鍵（食材 ID + 単位の族）。 */
export function groceryItemKey(ingredientId: string, unit: UnitId): string {
  return `${ingredientId}:${unitFamilyKey(unit)}`
}

export interface GroceryNeedDetail extends GroceryNeed {
  /** 在庫を差し引く前の必要量（基準単位）。`required` は差し引いた後の「買う量」。 */
  gross: Quantity | null
  /** 在庫でまかなう量（数量の確かな在庫だけ。基準単位）。 */
  fromStock: Quantity | null
}

export interface UncomputedDish {
  entryId: string
  date: string
  title: string
  /** `no_ingredients` = 材料が未登録の手動料理。`unknown_recipe` = カタログに無いレシピ。 */
  reason: "no_ingredients" | "unknown_recipe"
}

/** 使わない食材の設定で判定が「問題なし」でないため、材料を買い物に入れなかった確定の枠。 */
export interface HeldDish {
  entryId: string
  date: string
  title: string
}

export interface GroceryResult {
  /** 買う必要があるもの（売場順）。 */
  needs: GroceryNeedDetail[]
  /** 確定だが、使わない食材の設定に当たる・確かめられないため材料を入れなかった枠（`heldEntryIds` の範囲内）。 */
  held: HeldDish[]
  /** 在庫でまかなえるもの（買い物には出さないが、確認できるように返す）。 */
  covered: GroceryNeedDetail[]
  bySection: { section: StoreSection; label: string; items: GroceryNeedDetail[] }[]
  /** 自動計算の対象外の料理（材料の追加へつなげる）。 */
  uncomputed: UncomputedDish[]
  /** 常備品として買い物に出さなかった食材。 */
  stapleAssumed: { ingredientId: string; name: string }[]
  /** 予定に記録された版と今のレシピの版が違う枠（今の版で計算している）。 */
  versionMismatches: { entryId: string; recipeId: string; plannedVersion: number | null; currentVersion: number }[]
}

export interface GroceryInput {
  entries: readonly PlanEntry[]
  /** 対象の日付範囲（両端を含む。YYYY-MM-DD）。 */
  from: string
  to: string
  pantry: readonly PantryItem[]
  /** 今日（在庫の最終確認の古さを判定する日）。省略時は `from`。 */
  today?: string
  stapleIngredientIds?: readonly string[]
  catalog: CatalogInput
  /**
   * 確定でも材料を入れない枠: 使わない食材の設定での判定が「問題なし」でない（当たる・確かめられない）もの。
   * 献立の状態は変えない（設定の保存は献立を書き換えない）。判定は呼び出し側（`groceryHeldConflicts`）が行う。
   * 除外を読めなかったときは呼び出し側が計算そのものを止める（空の集合を「問題なし」として渡さない）。
   */
  heldEntryIds?: ReadonlySet<string>
}

interface Accumulator {
  itemKey: string
  ingredientId: string
  unit: UnitId | null
  gross: number
  fromStock: number
  nonNumeric: string[]
  needsStockCheck: boolean
  sources: GrocerySource[]
}

interface ResolvedDish {
  dish: MatchableDish
  title: string
}

function resolveDish(entry: PlanEntry, view: CatalogView): ResolvedDish | UncomputedDish["reason"] {
  if (entry.recipeId !== null) {
    const recipe = view.recipeById.get(entry.recipeId)
    return recipe ? { dish: recipe, title: recipe.title } : "unknown_recipe"
  }
  if (!entry.customIngredients || entry.customIngredients.length === 0) return "no_ingredients"
  // 手動料理の材料は、その枠の人数ぶんとして登録されている
  return {
    dish: { ingredients: entry.customIngredients, servings: entry.servings },
    title: entry.customTitle ?? "",
  }
}

function accumulatorFor(map: Map<string, Accumulator>, ingredientId: string, unit: UnitId): Accumulator {
  const numeric = unitFamily(unit) !== "none"
  const itemKey = numeric ? groceryItemKey(ingredientId, unit) : `${ingredientId}:none`
  const existing = map.get(itemKey)
  if (existing) return existing
  const created: Accumulator = {
    itemKey,
    ingredientId,
    unit: numeric ? baseUnitOf(unit) : null,
    gross: 0,
    fromStock: 0,
    nonNumeric: [],
    needsStockCheck: false,
    sources: [],
  }
  map.set(itemKey, created)
  return created
}

function toDetail(acc: Accumulator, view: CatalogView): GroceryNeedDetail {
  const def = view.index.byId.get(acc.ingredientId)
  const numeric = acc.unit !== null
  const required = numeric ? Math.max(0, roundAmount(acc.gross - acc.fromStock)) : null
  return {
    itemKey: acc.itemKey,
    ingredientId: acc.ingredientId,
    name: ingredientNameOf(acc.ingredientId, view.index),
    section: normalizeSection(def?.section),
    required: acc.unit !== null && required !== null ? { amount: required, unit: acc.unit } : null,
    nonNumeric: [...acc.nonNumeric],
    needsStockCheck: acc.needsStockCheck,
    sources: acc.sources,
    gross: acc.unit !== null ? { amount: roundAmount(acc.gross), unit: acc.unit } : null,
    fromStock: acc.unit !== null ? { amount: roundAmount(acc.fromStock), unit: acc.unit } : null,
  }
}

function compareNeeds(a: GroceryNeedDetail, b: GroceryNeedDetail): number {
  return (
    storeSectionOrder(a.section) - storeSectionOrder(b.section) ||
    a.ingredientId.localeCompare(b.ingredientId) ||
    a.itemKey.localeCompare(b.itemKey)
  )
}

/** 「適量」などの項目を、同じ食材の数値の項目があればそこへ寄せる（行を増やさない）。 */
function foldNonNumeric(details: GroceryNeedDetail[]): GroceryNeedDetail[] {
  const numericByIngredient = new Map<string, GroceryNeedDetail>()
  for (const detail of [...details].sort(compareNeeds)) {
    if (detail.required !== null && !numericByIngredient.has(detail.ingredientId)) {
      numericByIngredient.set(detail.ingredientId, detail)
    }
  }
  const result: GroceryNeedDetail[] = []
  for (const detail of details) {
    const host = detail.required === null ? numericByIngredient.get(detail.ingredientId) : undefined
    if (!host) {
      result.push(detail)
      continue
    }
    host.nonNumeric = [...host.nonNumeric, ...detail.nonNumeric]
    host.needsStockCheck = host.needsStockCheck || detail.needsStockCheck
    host.sources = [...host.sources, ...detail.sources]
  }
  return result
}

function isInRange(date: string, from: string, to: string): boolean {
  return date >= from && date <= to
}

/** 確定した献立から、買う必要のある材料を求める。在庫・入力は変更しない。 */
export function buildGroceryNeeds(input: GroceryInput): GroceryResult {
  const view = toCatalogView(input.catalog)
  const inRange = input.entries
    .filter((entry) => entry.status === "confirmed" && isInRange(entry.date, input.from, input.to))
    .sort((a, b) => a.date.localeCompare(b.date) || a.position - b.position || a.id.localeCompare(b.id))
  const held: HeldDish[] = []
  const confirmed: PlanEntry[] = []
  for (const entry of inRange) {
    if (input.heldEntryIds?.has(entry.id)) {
      const recipe = entry.recipeId === null ? undefined : view.recipeById.get(entry.recipeId)
      held.push({ entryId: entry.id, date: entry.date, title: recipe?.title ?? entry.customTitle ?? entry.recipeId ?? "" })
    } else {
      confirmed.push(entry)
    }
  }
  const reserved = new Map<string, number>()
  const accumulators = new Map<string, Accumulator>()
  const uncomputed: UncomputedDish[] = []
  const staples = new Map<string, string>()
  const versionMismatches: GroceryResult["versionMismatches"] = []

  for (const entry of confirmed) {
    const resolved = resolveDish(entry, view)
    if (typeof resolved === "string") {
      uncomputed.push({
        entryId: entry.id,
        date: entry.date,
        title: entry.customTitle ?? entry.recipeId ?? "",
        reason: resolved,
      })
      continue
    }
    const recipe = entry.recipeId === null ? undefined : view.recipeById.get(entry.recipeId)
    if (recipe && entry.recipeVersion !== recipe.version) {
      versionMismatches.push({
        entryId: entry.id,
        recipeId: recipe.id,
        plannedVersion: entry.recipeVersion,
        currentVersion: recipe.version,
      })
    }
    const match = matchDishToPantry(resolved.dish, entry.servings, input.pantry, {
      eatOn: entry.date,
      today: input.today ?? input.from,
      stapleIngredientIds: input.stapleIngredientIds,
      reserved,
      index: view.index,
    })
    reserveConsumption(reserved, match.consumption)
    for (const line of match.lines) {
      if (line.optional) continue
      if (line.state === "staple") {
        staples.set(line.ingredientId, line.name)
        continue
      }
      const source: GrocerySource = {
        date: entry.date,
        recipeId: entry.recipeId,
        title: resolved.title,
        quantity: line.required,
      }
      if (line.requiredBase === null) {
        // 「適量」「少々」。在庫に確かにあるなら買い物に出さない
        if (line.state === "enough") continue
        const acc = accumulatorFor(accumulators, line.ingredientId, line.required.unit)
        const label = formatQuantity(line.required)
        if (!acc.nonNumeric.includes(label)) acc.nonNumeric.push(label)
        acc.needsStockCheck = acc.needsStockCheck || line.state === "uncertain"
        acc.sources.push(source)
        continue
      }
      const acc = accumulatorFor(accumulators, line.ingredientId, line.required.unit)
      acc.gross = roundAmount(acc.gross + line.requiredBase)
      acc.fromStock = roundAmount(acc.fromStock + line.stockCertain)
      acc.needsStockCheck = acc.needsStockCheck || line.state === "uncertain"
      acc.sources.push(source)
    }
  }

  const details = foldNonNumeric([...accumulators.values()].map((acc) => toDetail(acc, view)))
  const isCovered = (d: GroceryNeedDetail) =>
    d.required !== null && d.required.amount === 0 && !d.needsStockCheck && d.nonNumeric.length === 0
  const needs = details.filter((d) => !isCovered(d)).sort(compareNeeds)
  return {
    needs,
    held,
    covered: details.filter(isCovered).sort(compareNeeds),
    bySection: groupBySection(needs),
    uncomputed,
    stapleAssumed: [...staples.entries()]
      .map(([ingredientId, name]) => ({ ingredientId, name }))
      .sort((a, b) => a.ingredientId.localeCompare(b.ingredientId)),
    versionMismatches,
  }
}

/** 売場ごとにまとめる（項目のある売場だけ、売場を回る順で返す）。 */
export function groupBySection<T extends { section: StoreSection }>(
  items: readonly T[],
): { section: StoreSection; label: string; items: T[] }[] {
  return STORE_SECTIONS.map((def) => ({
    section: def.id,
    label: def.label,
    items: items.filter((item) => normalizeSection(item.section) === def.id),
  })).filter((group) => group.items.length > 0)
}

// ── 既存の買い物リストとの突き合わせ ───────────────────────────────

export interface ExistingGroceryItem {
  id: string
  /** 自動項目の鍵。手動で足した項目は null。 */
  itemKey: string | null
  name: string
  section: StoreSection
  /** 利用者が売場を変えた（再計算で戻さない）。 */
  sectionOverridden: boolean
  required: Quantity | null
  /**
   * 購入した量の**事実の合計**。チェックだけで量が無いときは null。「作った」でも書き換わらない
   * （作った料理に使った分は `consumed`）。購入の操作はこの合計を送る。
   */
  purchased: Quantity | null
  /** 購入した量のうち、在庫へ反映済みの量。 */
  restocked: Quantity | null
  /**
   * 購入した量のうち、作った（または確定のまま日が過ぎた）料理へ充当した量。「作った」を取り消すと、
   * その料理の分だけ戻る。省略・null は 0。
   */
  consumed?: Quantity | null
  /** 画面の購入の印（印があり、作った料理で使い終えていない）。 */
  checked: boolean
  note: string | null
}

export interface GroceryUpsert {
  /** 既存の項目の ID。新しい項目は null。 */
  id: string | null
  itemKey: string
  ingredientId: string
  name: string
  section: StoreSection
  required: Quantity | null
  nonNumeric: readonly string[]
  needsStockCheck: boolean
  sources: readonly GrocerySource[]
  purchased: Quantity | null
  restocked: Quantity | null
  note: string | null
  checked: boolean
  /** まだ買っていない量（数値化できない項目は null）。 */
  remaining: Quantity | null
}

export type RetainReason = "purchased" | "note" | "checked" | "section"

export interface GroceryMergeResult {
  /** 自動項目（今も必要なもの）。 */
  upserts: GroceryUpsert[]
  /** 不要になったが、購入履歴・メモ・売場の変更があるので残す自動項目。 */
  retained: { id: string; itemKey: string; reasons: RetainReason[] }[]
  /** 不要になり、利用者の入力も無いので消してよい自動項目の ID。 */
  removals: string[]
  /** 手動で足した項目（そのまま残す）。 */
  manual: ExistingGroceryItem[]
}

function baseAmountIfCompatible(quantity: Quantity | null, unit: UnitId): number {
  if (!quantity || !areUnitsCompatible(quantity.unit, unit)) return 0
  return toBaseAmount(quantity) ?? 0
}

/**
 * 購入のうち、今の必要に充てられる量（基準単位）: 購入量 − 在庫へ反映済みの量 − 作った料理へ充当した量。0 未満にしない。
 * 補充と充当は購入の内訳なので、購入量を超えた分は数えない。
 */
function onHandBase(item: Pick<ExistingGroceryItem, "purchased" | "restocked" | "consumed">, unit: UnitId): number {
  const purchased = baseAmountIfCompatible(item.purchased, unit)
  const restocked = Math.min(purchased, baseAmountIfCompatible(item.restocked, unit))
  const consumed = Math.min(purchased - restocked, baseAmountIfCompatible(item.consumed ?? null, unit))
  return Math.max(0, roundAmount(purchased - restocked - consumed))
}

/**
 * まだ買っていない量。必要量 −（購入量 − 在庫へ反映済みの量 − 作った料理へ充当した量）。0 未満にはしない。
 * 300g 購入後に必要量が 500g へ増えたら 200g。300g 買って 300g 使う料理を作れば、次の料理の分は丸ごと残る。
 * 数値化できない項目は null。
 */
export function remainingToBuy(
  item: Pick<ExistingGroceryItem, "required" | "purchased" | "restocked" | "consumed">,
): Quantity | null {
  if (!item.required) return null
  const required = toBaseAmount(item.required)
  const unit = baseUnitOf(item.required.unit)
  if (required === null || unit === null) return null
  return { amount: Math.max(0, roundAmount(required - onHandBase(item, unit))), unit }
}

/**
 * 購入した量のうち、まだ在庫へ反映していない量（反映できる上限）。作った料理に使った分は在庫へ足せない
 * （「作った」の取り消しで在庫を増やさない・使った食材を在庫に戻さない）。
 */
export function restockableAmount(
  item: Pick<ExistingGroceryItem, "purchased" | "restocked" | "consumed">,
): Quantity | null {
  if (!item.purchased) return null
  const unit = baseUnitOf(item.purchased.unit)
  if (toBaseAmount(item.purchased) === null || unit === null) return null
  return { amount: onHandBase(item, unit), unit }
}

/**
 * 在庫への補充。確認した量だけを反映し、購入量を超えては反映しない
 * （同じ操作が 2 回届いても、2 回目に反映できる量は残っていない）。
 */
export function planRestock(
  item: Pick<ExistingGroceryItem, "purchased" | "restocked" | "consumed">,
  confirmed: Quantity,
): { added: Quantity; restocked: Quantity } | null {
  const limit = restockableAmount(item)
  if (!limit || !areUnitsCompatible(confirmed.unit, limit.unit)) return null
  const wanted = toBaseAmount(confirmed)
  if (wanted === null || limit.amount === null) return null
  const added = Math.min(wanted, limit.amount)
  const already = baseAmountIfCompatible(item.restocked, limit.unit)
  return {
    added: { amount: roundAmount(added), unit: limit.unit },
    restocked: { amount: roundAmount(already + added), unit: limit.unit },
  }
}

function retainReasons(item: ExistingGroceryItem): RetainReason[] {
  const reasons: RetainReason[] = []
  if (item.purchased !== null && (toBaseAmount(item.purchased) ?? 0) > 0) reasons.push("purchased")
  if (item.note !== null && item.note.trim() !== "") reasons.push("note")
  if (item.checked) reasons.push("checked")
  if (item.sectionOverridden) reasons.push("section")
  return reasons
}

function mergeOne(need: GroceryNeed, existing: ExistingGroceryItem | undefined): GroceryUpsert {
  const purchased = existing?.purchased ?? null
  const restocked = existing?.restocked ?? null
  const remaining = remainingToBuy({ required: need.required, purchased, restocked, consumed: existing?.consumed ?? null })
  // 量で追える項目は「残り 0」を購入済みとする（必要量が増えたら未購入へ戻る）。量の無い項目はチェックを保つ
  const tracksAmount = remaining !== null && purchased !== null
  return {
    id: existing?.id ?? null,
    itemKey: need.itemKey,
    ingredientId: need.ingredientId,
    name: need.name,
    section: existing?.sectionOverridden ? existing.section : need.section,
    required: need.required,
    nonNumeric: need.nonNumeric,
    needsStockCheck: need.needsStockCheck,
    sources: need.sources,
    purchased,
    restocked,
    note: existing?.note ?? null,
    checked: tracksAmount ? remaining.amount === 0 : (existing?.checked ?? false),
    remaining,
  }
}

/**
 * 計算し直した必要量を、既存のリストと突き合わせる。
 * 同じ `needs` と、その結果を反映した既存リストでもう一度呼んでも同じ結果になる（冪等）。
 */
export function mergeWithExisting(
  needs: readonly GroceryNeed[],
  existingItems: readonly ExistingGroceryItem[],
): GroceryMergeResult {
  const sorted = [...existingItems].sort((a, b) => a.id.localeCompare(b.id))
  const manual = sorted.filter((item) => item.itemKey === null)
  const firstByKey = new Map<string, ExistingGroceryItem>()
  const leftovers: ExistingGroceryItem[] = []
  for (const item of sorted) {
    if (item.itemKey === null) continue
    if (firstByKey.has(item.itemKey)) leftovers.push(item)
    else firstByKey.set(item.itemKey, item)
  }
  const neededKeys = new Set<string>()
  const upserts: GroceryUpsert[] = []
  for (const need of needs) {
    if (neededKeys.has(need.itemKey)) continue
    neededKeys.add(need.itemKey)
    upserts.push(mergeOne(need, firstByKey.get(need.itemKey)))
  }
  for (const [key, item] of firstByKey) {
    if (!neededKeys.has(key)) leftovers.push(item)
  }
  const retained: GroceryMergeResult["retained"] = []
  const removals: string[] = []
  for (const item of leftovers.sort((a, b) => a.id.localeCompare(b.id))) {
    const reasons = retainReasons(item)
    if (reasons.length > 0) retained.push({ id: item.id, itemKey: item.itemKey as string, reasons })
    else removals.push(item.id)
  }
  return { upserts, retained, removals, manual }
}
