/**
 * ごはんの DB 行（`supabase/migrations/20261111100003_dinner_tables.sql`）とアプリの型
 * （`src/lib/meals/types.ts`）の間の写像。
 *
 * 境界指令を持たない中立モジュール（Supabase も Next も import しない。カタログのデータも
 * import しない）。PostgREST の SELECT の行と、RPC が `to_jsonb(行)` で返す行の両方を受ける。
 *
 * ## 規則
 * - 入力は `unknown`。**throw しない**。
 * - 版（`updated_at`）は**文字列のまま**運ぶ（`new Date()` を通すとマイクロ秒が落ち、以後の保存が
 *   すべて衝突する）。
 * - `text + CHECK` 由来の値は DB が先に増えうる（クライアントの型は遅れて追随する）。
 *   - 表示・補助にだけ使う値が未知 → 退化させて行を残す（`issues` に `degraded` として記録）。
 *   - 判別に使う必須値（在庫の状態、献立の区分・状態、除外の対象の種類 …）が読めない →
 *     その行は「読めない行」として**件数と ID を返す**（黙って捨てない・既知の値へ言い換えない）。
 * - numeric / bigint は PostgREST が文字列で返しうる。数値として読めるものだけ数値にする。
 * - RPC の「行が既に無い」印 `{ id, deleted: true }` は `isDeletedEntity` で先に見分ける
 *   （列を持たないので、行の写像へ渡すと「読めない行」になる）。
 *
 * 逆方向（アプリの型 → RPC の引数）もここに置く。DB の CHECK・RPC の検証と同じ丸め・上限を
 * 送る前に当て、**送れない値は黙って切り捨てず**呼び出し側へ返す。
 */

import { isRecord } from "@/lib/domain/child-sharing"
import type { Database, Json } from "@/lib/types/database"
import { isValidYmd } from "@/lib/utils/date-jst"

import { STORE_SECTIONS } from "../catalog/sections"
import type { ExistingGroceryItem } from "../grocery"
import type {
  DishFeedback,
  DishRole,
  ExclusionReason,
  ExclusionTarget,
  FoodExclusion,
  FoodPreference,
  GroceryNeed,
  GrocerySource,
  PantryItem,
  PantryStatus,
  PantryStorage,
  PlanEntry,
  PlanEntryStatus,
  Quantity,
  RecipeIngredient,
  StoreSection,
  UnitId,
} from "../types"
import { UNIT_LABELS, areUnitsCompatible, roundAmount, toBaseAmount } from "../units"

// ── 保存済みの行の型（アプリの型 + 版） ─────────────────────────────

/** 版（`updated_at` の表記そのまま）を伴う保存済みの値。 */
export type Stored<T> = T & { version: string }

export type StoredPantryItem = Stored<PantryItem>
export type StoredFoodExclusion = Stored<FoodExclusion>
export type StoredFoodPreference = Stored<FoodPreference>
/** 食後評価。料理名は手動料理（`recipeId` が null）の表示に要る。 */
export type StoredDishFeedback = Stored<DishFeedback> & { dishTitle: string }
/**
 * 献立の 1 枠。`priorStatus` は「作った」「作らなかった」にする直前の状態（取り消しで戻す先。DB の `prior_status`）。
 * 作った・作らなかった枠にだけ入る。記録が無い（この列より前の行・読めない値）ときは null / 省略 = 確定へ戻す。
 */
export type StoredPlanEntry = Stored<PlanEntry> & { priorStatus?: "proposed" | "confirmed" | null }

/**
 * 買い物の 1 項目。`ExistingGroceryItem`（`mergeWithExisting` / `remainingToBuy` の入力）に、
 * 画面と保存に要る列を足したもの。
 */
export interface StoredGroceryItem extends ExistingGroceryItem {
  version: string
  origin: "auto" | "manual"
  ingredientId: string | null
  /** 項目の単位（必要量・購入量・補充量に共通）。未知の単位・未設定は null。 */
  unit: UnitId | null
  /** 「適量」「少々」など数値化しなかった分の表記。 */
  requiredNote: string | null
  needsStockCheck: boolean
  sources: GrocerySource[]
  /** false = 献立からは不要になったが、購入・メモ・補充の記録があるので残っている自動項目。 */
  stillNeeded: boolean
  purchasedAt: string | null
  /** 在庫へ反映した回数（`restock_ids` の件数）。 */
  restockCount: number
  /** この項目を最後に計算したときの献立の版。 */
  planRevision: number | null
}

export const DINNER_SERVINGS_MIN = 1
/** DB の CHECK（`dinner_settings.servings` / `dinner_plan_entries.servings`）と同じ上限。 */
export const DINNER_SERVINGS_MAX = 12
export const DINNER_SERVINGS_DEFAULT = 2

export interface DinnerSettings {
  servings: number
  includeSoup: boolean
  /** 調理時間の上限（分）。null は上限なし。 */
  maxCookMinutes: number | null
  /** 世帯が設定した常備品の食材 ID。 */
  stapleIngredientIds: string[]
  /** child_id → 保護者が設定した食事段階（値の検証は `child-serving.ts` が行う）。 */
  childStages: Record<string, string>
  /** 行が無い世帯（未設定）は null。 */
  version: string | null
}

/**
 * 設定の行が無い世帯の既定値（呼ぶたびに新しい値を返す。配列を世帯間で共有しない）。
 * 画面は「標準の人数で計算している」ことを明示する。常備品は捏造しない（空）。
 */
export function defaultDinnerSettings(): DinnerSettings {
  return {
    servings: DINNER_SERVINGS_DEFAULT,
    includeSoup: false,
    maxCookMinutes: null,
    stapleIngredientIds: [],
    childStages: {},
    version: null,
  }
}

/** 献立全体の版。行が無い世帯は 0。 */
export interface DinnerPlanState {
  revision: number
  /** 買い物の自動項目を最後に同期したときの献立の版。未同期は null。 */
  groceryRevision: number | null
}

export const EMPTY_DINNER_PLAN_STATE: DinnerPlanState = Object.freeze({ revision: 0, groceryRevision: null })

// ── 写像の結果 ─────────────────────────────────────────────────────

export type MealTable =
  | "dinner_settings"
  | "pantry_items"
  | "food_exclusions"
  | "food_preferences"
  | "dish_feedback"
  | "dinner_plan_state"
  | "dinner_plan_entries"
  | "grocery_items"

export interface RowIssue {
  table: MealTable
  /** 行の ID（読めたときだけ）。 */
  id: string | null
  /** `unreadable` = 行を結果に含めていない。`degraded` = 値を退化させて含めた。 */
  kind: "unreadable" | "degraded"
  /** 原因の列。 */
  field: string
}

export type RowResult<T> =
  | { ok: true; value: T; degraded: string[] }
  | { ok: false; id: string | null; field: string }

export interface MappedRows<T> {
  rows: T[]
  /** 読めなかった行の数（`issues` のうち `unreadable` の件数）。 */
  unreadable: number
  issues: RowIssue[]
}

/** 行の配列を写す。配列でない入力は「1 件も読めなかった」ではなく null（取得の失敗として扱うこと）。 */
export function mapRows<T>(
  table: MealTable,
  rows: unknown,
  mapOne: (row: unknown) => RowResult<T>,
): MappedRows<T> | null {
  if (!Array.isArray(rows)) return null
  const mapped: T[] = []
  const issues: RowIssue[] = []
  let unreadable = 0
  for (const row of rows) {
    const result = mapOne(row)
    if (!result.ok) {
      unreadable += 1
      issues.push({ table, id: result.id, kind: "unreadable", field: result.field })
      continue
    }
    mapped.push(result.value)
    const id = idOf(row)
    for (const field of result.degraded) issues.push({ table, id, kind: "degraded", field })
  }
  return { rows: mapped, unreadable, issues }
}

/** RPC が「版つきで届いたが行が既に無い」ときに返す印（`{ id, deleted: true }`）か。 */
export function isDeletedEntity(value: unknown): value is { id: string; deleted: true } {
  return isRecord(value) && value.deleted === true && typeof value.id === "string"
}

// ── 値の読み取り ───────────────────────────────────────────────────

const NUMERIC_TEXT = /^-?\d+(\.\d+)?$/

/** 有限の数値、または数値の文字列（numeric / bigint）だけを数値にする。それ以外は null。 */
export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string" && NUMERIC_TEXT.test(value)) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toInteger(value: unknown): number | null {
  const parsed = toFiniteNumber(value)
  return parsed !== null && Number.isInteger(parsed) ? parsed : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null
}

function idOf(row: unknown): string | null {
  return isRecord(row) ? nonEmptyString(row.id) : null
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null
}

/** アプリが知っている単位か。未知の単位（DB が先に増えた場合）は null。 */
export function toUnitId(value: unknown): UnitId | null {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(UNIT_LABELS, value)
    ? (value as UnitId)
    : null
}

/** 売場。未知の値は「その他」へ寄せる（定義は `catalog/sections.ts` が正本）。 */
function toStoreSection(value: unknown): StoreSection {
  return STORE_SECTIONS.find((def) => def.id === value)?.id ?? "other"
}

/** 正の量と既知の単位が揃うときだけ Quantity にする。 */
function positiveQuantity(amount: unknown, unit: UnitId | null): Quantity | null {
  const parsed = toFiniteNumber(amount)
  return parsed !== null && parsed > 0 && unit !== null ? { amount: parsed, unit } : null
}

const PANTRY_STATUSES: readonly PantryStatus[] = ["have", "low", "out"]
const PANTRY_STORAGES: readonly PantryStorage[] = ["fridge", "freezer", "pantry"]
const DISH_ROLES: readonly DishRole[] = ["main", "side", "staple", "soup"]
const PLAN_STATUSES: readonly PlanEntryStatus[] = ["proposed", "confirmed", "cooked", "skipped"]
const PLAN_ORIGINS: readonly PlanEntry["origin"][] = ["auto", "manual", "ai_assisted"]
const EXCLUSION_REASONS: readonly ExclusionReason[] = ["allergy", "dislike"]

const fail = <T>(row: unknown, field: string): RowResult<T> => ({ ok: false, id: idOf(row), field })

// ── 行 → アプリの型 ────────────────────────────────────────────────

/** `dinner_settings` の行。読めないとき、呼び出し側は「未設定」と言い換えず失敗として扱うこと。 */
export function dinnerSettingsFromRow(row: unknown): RowResult<DinnerSettings> {
  if (!isRecord(row)) return { ok: false, id: null, field: "row" }
  const version = nonEmptyString(row.updated_at)
  if (version === null) return { ok: false, id: null, field: "updated_at" }
  const degraded: string[] = []

  let servings = toInteger(row.servings)
  if (servings === null || servings < DINNER_SERVINGS_MIN || servings > DINNER_SERVINGS_MAX) {
    servings = DINNER_SERVINGS_DEFAULT
    degraded.push("servings")
  }
  let maxCookMinutes: number | null = null
  if (row.max_cook_minutes !== null && row.max_cook_minutes !== undefined) {
    maxCookMinutes = toInteger(row.max_cook_minutes)
    if (maxCookMinutes === null || maxCookMinutes <= 0) {
      maxCookMinutes = null
      degraded.push("max_cook_minutes")
    }
  }
  const stapleIngredientIds: string[] = []
  if (Array.isArray(row.staples)) {
    for (const value of row.staples) {
      if (typeof value === "string" && value !== "") stapleIngredientIds.push(value)
      else if (!degraded.includes("staples")) degraded.push("staples")
    }
  } else {
    degraded.push("staples")
  }
  const childStages: Record<string, string> = {}
  if (isRecord(row.child_stages)) {
    for (const [childId, stage] of Object.entries(row.child_stages)) {
      if (typeof stage === "string" && stage !== "") childStages[childId] = stage
      else if (!degraded.includes("child_stages")) degraded.push("child_stages")
    }
  } else {
    degraded.push("child_stages")
  }
  if (typeof row.include_soup !== "boolean") degraded.push("include_soup")

  return {
    ok: true,
    value: {
      servings,
      includeSoup: row.include_soup === true,
      maxCookMinutes,
      stapleIngredientIds,
      childStages,
      version,
    },
    degraded,
  }
}

/** `dinner_plan_state` の行。 */
export function dinnerPlanStateFromRow(row: unknown): RowResult<DinnerPlanState> {
  if (!isRecord(row)) return { ok: false, id: null, field: "row" }
  const revision = toInteger(row.revision)
  if (revision === null || revision < 0) return { ok: false, id: null, field: "revision" }
  const degraded: string[] = []
  let groceryRevision: number | null = null
  if (row.grocery_revision !== null && row.grocery_revision !== undefined) {
    groceryRevision = toInteger(row.grocery_revision)
    if (groceryRevision === null) degraded.push("grocery_revision")
  }
  return { ok: true, value: { revision, groceryRevision }, degraded }
}

/** `pantry_items` の行。 */
export function pantryItemFromRow(row: unknown): RowResult<StoredPantryItem> {
  if (!isRecord(row)) return { ok: false, id: null, field: "row" }
  const id = nonEmptyString(row.id)
  if (id === null) return fail(row, "id")
  const version = nonEmptyString(row.updated_at)
  if (version === null) return fail(row, "updated_at")
  const name = nonEmptyString(row.name)
  if (name === null) return fail(row, "name")
  // 状態は充足の判定に使う。未知の値を「ある」へ言い換えると在庫を過大に数える
  const status = oneOf(row.status, PANTRY_STATUSES)
  if (status === null) return fail(row, "status")
  if (!isValidYmd(typeof row.confirmed_on === "string" ? row.confirmed_on : null)) {
    return fail(row, "confirmed_on")
  }
  // 期限が入っているのに読めない行を「期限なし」と言い換えると、期限超過を材料に数えうる
  let expiresOn: string | null = null
  if (row.expires_on !== null && row.expires_on !== undefined) {
    if (typeof row.expires_on !== "string" || !isValidYmd(row.expires_on)) return fail(row, "expires_on")
    expiresOn = row.expires_on
  }
  const degraded: string[] = []

  let ingredientId: string | null = null
  if (row.ingredient_id !== null && row.ingredient_id !== undefined) {
    ingredientId = nonEmptyString(row.ingredient_id)
    if (ingredientId === null) degraded.push("ingredient_id")
  }
  // 数量が読めない・単位が未知 → 「数量不明」（充足は「分量要確認」へ倒れる）
  let quantity: Quantity | null = null
  if (row.quantity !== null && row.quantity !== undefined) {
    quantity = positiveQuantity(row.quantity, toUnitId(row.unit))
    if (quantity === null) degraded.push(toUnitId(row.unit) === null ? "unit" : "quantity")
  }
  let storage: PantryStorage | null = null
  if (row.storage !== null && row.storage !== undefined) {
    storage = oneOf(row.storage, PANTRY_STORAGES)
    if (storage === null) degraded.push("storage")
  }
  if (typeof row.use_soon !== "boolean") degraded.push("use_soon")

  return {
    ok: true,
    value: {
      id,
      ingredientId,
      name,
      quantity,
      status,
      useSoon: row.use_soon === true,
      storage,
      expiresOn,
      confirmedOn: row.confirmed_on as string,
      version,
    },
    degraded,
  }
}

function exclusionTargetOf(row: Record<string, unknown>): ExclusionTarget | null {
  const targetId = nonEmptyString(row.target_id)
  if (row.target_kind === "allergen") return targetId === null ? null : { kind: "allergen", allergenId: targetId }
  if (row.target_kind === "ingredient") return targetId === null ? null : { kind: "ingredient", ingredientId: targetId }
  if (row.target_kind === "custom") {
    const label = nonEmptyString(row.custom_label)
    return label === null ? null : { kind: "custom", label }
  }
  return null
}

/**
 * `food_exclusions` の行。
 *
 * 必須除外は安全に関わるので、退化は**厳しい側**へだけ倒す:
 * - 対象（何を除くか）が読めない → 読めない行（呼び出し側は「除外を全部は読めていない」として扱う）。
 * - 理由が未知 → `allergy`（原材料の確認が要る側）。
 * - 対象者が未知 → 世帯全体（判定は世帯の和集合なので結果は変わらない。表示だけが退化する）。
 */
export function foodExclusionFromRow(row: unknown): RowResult<StoredFoodExclusion> {
  if (!isRecord(row)) return { ok: false, id: null, field: "row" }
  const id = nonEmptyString(row.id)
  if (id === null) return fail(row, "id")
  const target = exclusionTargetOf(row)
  if (target === null) return fail(row, "target_kind")
  const degraded: string[] = []

  let reason = oneOf(row.reason, EXCLUSION_REASONS)
  if (reason === null) {
    reason = "allergy"
    degraded.push("reason")
  }
  let subject: FoodExclusion["subject"] = { kind: "household" }
  const profileId = nonEmptyString(row.subject_profile_id)
  const childId = nonEmptyString(row.subject_child_id)
  if (row.subject_kind === "member" && profileId !== null) subject = { kind: "member", profileId }
  else if (row.subject_kind === "child" && childId !== null) subject = { kind: "child", childId }
  else if (row.subject_kind !== "household") degraded.push("subject_kind")

  // 除外は「登録して消す」だけで編集しない。版が無くても読める行として扱う
  const version = nonEmptyString(row.updated_at) ?? ""
  if (version === "") degraded.push("updated_at")
  return { ok: true, value: { id, reason, target, subject, version }, degraded }
}

/** `food_preferences` の行。採点にだけ使うので、読めない行は数えずに件数を返す。 */
export function foodPreferenceFromRow(row: unknown): RowResult<StoredFoodPreference> {
  if (!isRecord(row)) return { ok: false, id: null, field: "row" }
  const id = nonEmptyString(row.id)
  if (id === null) return fail(row, "id")
  const version = nonEmptyString(row.updated_at)
  if (version === null) return fail(row, "updated_at")
  const scope = oneOf(row.scope, ["household", "personal"] as const)
  if (scope === null) return fail(row, "scope")
  const targetKind = oneOf(row.target_kind, ["recipe", "ingredient", "tag"] as const)
  const targetId = nonEmptyString(row.target_id)
  if (targetKind === null || targetId === null) return fail(row, "target_kind")
  const sentiment = oneOf(row.sentiment, ["like", "dislike"] as const)
  if (sentiment === null) return fail(row, "sentiment")
  const profileId = nonEmptyString(row.profile_id)
  // 個人の好みは持ち主が要る（誰のものか分からない行を家族共通へ言い換えない）
  if (scope === "personal" && profileId === null) return fail(row, "profile_id")
  return {
    ok: true,
    value: {
      id,
      scope,
      profileId: scope === "personal" ? profileId : null,
      target: { kind: targetKind, id: targetId },
      sentiment,
      version,
    },
    degraded: [],
  }
}

function toRating(value: unknown): 1 | 2 | 3 | null | undefined {
  if (value === null || value === undefined) return null
  const parsed = toInteger(value)
  return parsed === 1 || parsed === 2 || parsed === 3 ? parsed : undefined
}

/** `dish_feedback` の行。評価した本人（`profile_id`）を失わない。 */
export function dishFeedbackFromRow(row: unknown): RowResult<StoredDishFeedback> {
  if (!isRecord(row)) return { ok: false, id: null, field: "row" }
  const id = nonEmptyString(row.id)
  if (id === null) return fail(row, "id")
  const version = nonEmptyString(row.updated_at)
  if (version === null) return fail(row, "updated_at")
  const profileId = nonEmptyString(row.profile_id)
  if (profileId === null) return fail(row, "profile_id")
  if (typeof row.eaten_on !== "string" || !isValidYmd(row.eaten_on)) return fail(row, "eaten_on")
  const degraded: string[] = []

  let recipeId: string | null = null
  if (row.recipe_id !== null && row.recipe_id !== undefined) {
    recipeId = nonEmptyString(row.recipe_id)
    if (recipeId === null) degraded.push("recipe_id")
  }
  // 範囲外の評価は「未回答」へ（低評価・高評価のどちらにも言い換えない）
  let taste = toRating(row.taste)
  if (taste === undefined) {
    taste = null
    degraded.push("taste")
  }
  let effort = toRating(row.effort)
  if (effort === undefined) {
    effort = null
    degraded.push("effort")
  }
  let again: boolean | null = null
  if (typeof row.again === "boolean") again = row.again
  else if (row.again !== null && row.again !== undefined) degraded.push("again")
  // 印が読めない評価は、好みへ反映しない側へ倒す
  let excludeFromLearning = true
  if (typeof row.exclude_from_learning === "boolean") excludeFromLearning = row.exclude_from_learning
  else degraded.push("exclude_from_learning")

  return {
    ok: true,
    value: {
      id,
      profileId,
      recipeId,
      eatenOn: row.eaten_on,
      taste,
      effort,
      again,
      excludeFromLearning,
      dishTitle: typeof row.dish_title === "string" ? row.dish_title : "",
      version,
    },
    degraded,
  }
}

function quantityFromJson(value: unknown): Quantity | null {
  if (!isRecord(value)) return null
  const unit = toUnitId(value.unit)
  if (unit === null) return null
  if (value.amount === null) return { amount: null, unit }
  const amount = toFiniteNumber(value.amount)
  return amount !== null && amount > 0 ? { amount, unit } : null
}

/** 手動料理の材料（jsonb）。1 件でも読めなければ null（一部だけを材料として数えない）。 */
export function recipeIngredientsFromJson(value: unknown): RecipeIngredient[] | null {
  if (!Array.isArray(value)) return null
  const result: RecipeIngredient[] = []
  for (const element of value) {
    if (!isRecord(element)) return null
    const ingredientId = nonEmptyString(element.ingredientId)
    const quantity = quantityFromJson(element.quantity)
    if (ingredientId === null || quantity === null) return null
    const ingredient: RecipeIngredient = { ingredientId, quantity }
    if (element.optional === true) ingredient.optional = true
    if (typeof element.note === "string" && element.note !== "") ingredient.note = element.note
    result.push(ingredient)
  }
  return result
}

/**
 * 出所のうち、台帳（`consumptions`）に数えておる（`on`）充当の記録がある枠の量（`buy`）の合計（項目の単位）。
 * 同期はその出所を必要量から外すが、同期の前は必要量に残る（`ExistingGroceryItem.settledRequired`）。
 * 読めない要素は数えない（必要量を減らす側へ倒さない）。台帳を選んでいない読みでは 0。
 */
export function settledSourceAmount(sources: unknown, consumptions: unknown): number {
  if (!Array.isArray(sources) || !Array.isArray(consumptions)) return 0
  const settled = new Set<string>()
  for (const record of consumptions) {
    if (isRecord(record) && record.on === true && typeof record.k === "string" && record.k !== "settled") {
      settled.add(record.k)
    }
  }
  let total = 0
  for (const source of sources) {
    if (!isRecord(source) || typeof source.entryId !== "string" || !settled.has(source.entryId)) continue
    const buy = toFiniteNumber(source.buy)
    if (buy !== null && buy > 0) total += buy
  }
  return roundAmount(total)
}

/** 買い物項目の出所（jsonb）。読めない要素は落とし、落としたことを返す。 */
export function grocerySourcesFromJson(value: unknown): { sources: GrocerySource[]; dropped: number } {
  if (!Array.isArray(value)) return { sources: [], dropped: value === null || value === undefined ? 0 : 1 }
  const sources: GrocerySource[] = []
  let dropped = 0
  for (const element of value) {
    const quantity = isRecord(element) ? quantityFromJson(element.quantity) : null
    if (
      !isRecord(element) ||
      quantity === null ||
      typeof element.date !== "string" ||
      !isValidYmd(element.date) ||
      typeof element.title !== "string"
    ) {
      dropped += 1
      continue
    }
    sources.push({
      date: element.date,
      recipeId: typeof element.recipeId === "string" ? element.recipeId : null,
      title: element.title,
      quantity,
    })
  }
  return { sources, dropped }
}

/** `dinner_plan_entries` の行。 */
export function planEntryFromRow(row: unknown): RowResult<StoredPlanEntry> {
  if (!isRecord(row)) return { ok: false, id: null, field: "row" }
  const id = nonEmptyString(row.id)
  if (id === null) return fail(row, "id")
  const version = nonEmptyString(row.updated_at)
  if (version === null) return fail(row, "updated_at")
  if (typeof row.plan_date !== "string" || !isValidYmd(row.plan_date)) return fail(row, "plan_date")
  const role = oneOf(row.role, DISH_ROLES)
  if (role === null) return fail(row, "role")
  // 状態は買い物の対象・上書きの可否を決める。未知の値を既知の状態へ言い換えない
  const status = oneOf(row.status, PLAN_STATUSES)
  if (status === null) return fail(row, "status")
  const position = toInteger(row.position)
  if (position === null || position < 0) return fail(row, "position")
  const servings = toFiniteNumber(row.servings)
  if (servings === null || servings <= 0) return fail(row, "servings")
  const recipeId = nonEmptyString(row.recipe_id)
  const customTitle = nonEmptyString(row.custom_title)
  if (recipeId === null && customTitle === null) return fail(row, "recipe_id")
  const degraded: string[] = []

  let recipeVersion: number | null = null
  if (recipeId !== null) {
    recipeVersion = toInteger(row.recipe_version)
    if (recipeVersion === null) degraded.push("recipe_version")
  }
  let customIngredients: RecipeIngredient[] | null = null
  if (recipeId === null && row.custom_ingredients !== null && row.custom_ingredients !== undefined) {
    customIngredients = recipeIngredientsFromJson(row.custom_ingredients)
    // 読めない材料を「一部だけ」数えると必要量を少なく見せる。材料なし（自動計算の対象外）へ倒す
    if (customIngredients === null) degraded.push("custom_ingredients")
  }
  // 固定の印が読めない枠は、上書きされない側（固定）へ倒す
  let pinned = true
  if (typeof row.pinned === "boolean") pinned = row.pinned
  else degraded.push("pinned")
  // 出所は表示にだけ使う。未知の値を「自動」「AI 補助」と名乗らせない
  let origin = oneOf(row.origin, PLAN_ORIGINS)
  if (origin === null) {
    origin = "manual"
    degraded.push("origin")
  }
  // 取り消しで戻す先。読めない値は「記録なし」（確定へ戻す）へ倒す（提案を確定と言い換えるのは取り消しの時だけ）
  let priorStatus: "proposed" | "confirmed" | null = null
  if (row.prior_status !== null && row.prior_status !== undefined) {
    priorStatus = oneOf(row.prior_status, ["proposed", "confirmed"] as const)
    if (priorStatus === null) degraded.push("prior_status")
  }

  const value: StoredPlanEntry = {
    id,
    date: row.plan_date,
    role,
    position,
    recipeId,
    recipeVersion,
    customTitle: recipeId === null ? customTitle : null,
    customIngredients,
    servings,
    pinned,
    status,
    origin,
    version,
  }
  if (priorStatus !== null) value.priorStatus = priorStatus
  return { ok: true, value, degraded }
}

/** DB の自動項目の鍵（`食材ID|単位族`）→ ロジックの鍵（`食材ID:単位族`）。 */
export function groceryLogicKeyOfDbKey(dbKey: string): string {
  const at = dbKey.indexOf("|")
  return at < 0 ? dbKey : `${dbKey.slice(0, at)}:${dbKey.slice(at + 1)}`
}

/** ロジックの鍵（`食材ID:単位族`）→ DB の鍵（`食材ID|単位族`）。鍵が食材 ID で始まらなければ null。 */
export function groceryDbKeyOfLogicKey(logicKey: string, ingredientId: string): string | null {
  const prefix = `${ingredientId}:`
  if (ingredientId === "" || !logicKey.startsWith(prefix)) return null
  const family = logicKey.slice(prefix.length)
  return /^[a-z0-9_:-]{1,24}$/.test(family) ? `${ingredientId}|${family}` : null
}

/**
 * `grocery_items` の行。
 *
 * @param defaultSectionOf 売場の上書きが無い項目の売場（食材辞書の既定）を引く関数。
 *   渡さない・引けないときは「その他」。
 */
export function groceryItemFromRow(
  row: unknown,
  defaultSectionOf?: (ingredientId: string) => string | null | undefined,
): RowResult<StoredGroceryItem> {
  if (!isRecord(row)) return { ok: false, id: null, field: "row" }
  const id = nonEmptyString(row.id)
  if (id === null) return fail(row, "id")
  const version = nonEmptyString(row.updated_at)
  if (version === null) return fail(row, "updated_at")
  const name = nonEmptyString(row.name)
  if (name === null) return fail(row, "name")
  // 自動か手動かは、再計算で消してよいかを決める。未知の値をどちらかへ言い換えない
  const origin = oneOf(row.origin, ["auto", "manual"] as const)
  if (origin === null) return fail(row, "origin")
  const dbKey = nonEmptyString(row.item_key)
  if (origin === "auto" && dbKey === null) return fail(row, "item_key")
  // 購入量が読めない行を「未購入」と言い換えない（買い直しを促してしまう）
  const purchasedAmount = toFiniteNumber(row.purchased_quantity ?? 0)
  if (purchasedAmount === null || purchasedAmount < 0) return fail(row, "purchased_quantity")
  const restockedAmount = toFiniteNumber(row.restocked_quantity ?? 0)
  if (restockedAmount === null || restockedAmount < 0) return fail(row, "restocked_quantity")
  if (typeof row.purchased !== "boolean") return fail(row, "purchased")
  // 作った料理へ充当した量。読めないまま 0 と読むと、使った分を「まだある」と見せる（買い漏れ）。行ごと止める
  const consumedAmount = toFiniteNumber(row.consumed_quantity ?? 0)
  if (consumedAmount === null || consumedAmount < 0) return fail(row, "consumed_quantity")
  // 列を選んでいない読み（古い fixture）は「使い終えていない」。在るのに真偽でなければ読めない行
  if (row.purchase_consumed !== undefined && typeof row.purchase_consumed !== "boolean") {
    return fail(row, "purchase_consumed")
  }
  const purchaseConsumed = row.purchase_consumed === true
  const degraded: string[] = []

  const ingredientId = nonEmptyString(row.ingredient_id)
  const unit = toUnitId(row.unit)
  if (unit === null && row.unit !== null && row.unit !== undefined) degraded.push("unit")
  let required: Quantity | null = null
  if (row.required_quantity !== null && row.required_quantity !== undefined) {
    required = positiveQuantity(row.required_quantity, unit)
    if (required === null && unit !== null) degraded.push("required_quantity")
  }
  const sectionOverridden = row.section !== null && row.section !== undefined
  const section = toStoreSection(
    sectionOverridden ? row.section : ingredientId !== null ? defaultSectionOf?.(ingredientId) : null,
  )
  const { sources, dropped } = grocerySourcesFromJson(row.sources)
  if (dropped > 0) degraded.push("sources")
  // 必要かどうかの印が読めない自動項目は、消さない側（必要）へ倒す
  let stillNeeded = true
  if (typeof row.still_needed === "boolean") stillNeeded = row.still_needed
  else degraded.push("still_needed")
  let planRevision: number | null = null
  if (row.plan_revision !== null && row.plan_revision !== undefined) {
    planRevision = toInteger(row.plan_revision)
    if (planRevision === null) degraded.push("plan_revision")
  }
  if (typeof row.needs_stock_check !== "boolean") degraded.push("needs_stock_check")

  return {
    ok: true,
    value: {
      id,
      itemKey: origin === "auto" && dbKey !== null ? groceryLogicKeyOfDbKey(dbKey) : null,
      name,
      section,
      sectionOverridden,
      required,
      purchased: positiveQuantity(purchasedAmount, unit),
      restocked: positiveQuantity(restockedAmount, unit),
      consumed: positiveQuantity(consumedAmount, unit),
      // 同期の前（判定できないアレルギーで止めている間など）に、作った枠の出所が必要量に残っている分
      settledRequired: origin === "auto" ? positiveQuantity(settledSourceAmount(row.sources, row.consumptions), unit) : null,
      // 画面の印は「購入の印があり、作った料理で使い終えていない」
      checked: row.purchased && !purchaseConsumed,
      note: nonEmptyString(row.note),
      version,
      origin,
      ingredientId,
      unit,
      requiredNote: nonEmptyString(row.required_note),
      // 読めないときは「在庫量を確認」を出す側へ倒す
      needsStockCheck: row.needs_stock_check !== false,
      sources,
      stillNeeded,
      purchasedAt: nonEmptyString(row.purchased_at),
      restockCount: Array.isArray(row.restock_ids) ? row.restock_ids.length : 0,
      planRevision,
    },
    degraded,
  }
}

// ── アプリの型 → RPC の引数 ────────────────────────────────────────

type DinnerFunctions = Database["public"]["Functions"]

/**
 * 10 進の桁で四捨五入する（Postgres の numeric の round と同じ結果にする）。
 * `Math.round(1.005 * 100)` は 2 進の誤差で 100 になるため、10 進の表記のまま桁をずらす。
 */
function roundTo(value: number, digits: number): number {
  const shifted = Number(`${value}e${digits}`)
  if (Number.isFinite(shifted)) return Number(`${Math.round(shifted)}e-${digits}`)
  // 指数表記（1e-7 など）になる極端な値は、通常の計算で丸める
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** DB の `dinner_qty` と同じ規則（scale 桁へ丸めて 0 < n <= max）。合わなければ null。 */
function dbQuantity(amount: number | null | undefined, max: number, digits: number): number | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > max) return null
  const rounded = roundTo(amount, digits)
  return rounded > 0 ? rounded : null
}

export type PantryItemInput = Omit<PantryItem, "id">

/** `save_pantry_item` の `p_item`、`add_pantry_items` の要素（`id` を足して使う）。 */
export interface PantryItemRpc {
  ingredient_id: string | null
  name: string
  quantity: number | null
  unit: string | null
  status: PantryStatus
  use_soon: boolean
  storage: PantryStorage | null
  expires_on: string | null
  confirmed_on: string
}

export const PANTRY_QUANTITY_MAX = 9_999_999.99

/**
 * 在庫 1 件 → `p_item`。数量は小数 2 桁（DB の numeric(9,2)）。数値にならない量
 * （適量・少々・量なし・丸めて 0）は「数量不明」（quantity / unit とも null）として送る。
 */
export function pantryItemToRpc(item: PantryItemInput): PantryItemRpc {
  const quantity = item.quantity ? dbQuantity(item.quantity.amount, PANTRY_QUANTITY_MAX, 2) : null
  return {
    ingredient_id: item.ingredientId,
    name: item.name.trim(),
    quantity,
    unit: quantity !== null && item.quantity ? item.quantity.unit : null,
    status: item.status,
    use_soon: item.useSoon,
    storage: item.storage,
    expires_on: item.expiresOn,
    confirmed_on: item.confirmedOn,
  }
}

export type PlanEntryInput = Pick<
  PlanEntry,
  | "date"
  | "role"
  | "position"
  | "recipeId"
  | "recipeVersion"
  | "customTitle"
  | "customIngredients"
  | "servings"
  | "pinned"
  | "status"
  | "origin"
>

/** `save_dinner_entry` の `p_entry`。`apply_dinner_plan` の要素はこれに `id` を足した形。 */
export interface PlanEntryRpc {
  plan_date: string
  role: DishRole
  position: number
  recipe_id: string | null
  recipe_version: number | null
  custom_title: string | null
  custom_ingredients: Json | null
  servings: number
  pinned: boolean
  status: PlanEntryStatus
  origin: PlanEntry["origin"]
}

function recipeIngredientToJson(ingredient: RecipeIngredient): Json {
  const json: { [key: string]: Json } = {
    ingredientId: ingredient.ingredientId,
    quantity: { amount: ingredient.quantity.amount, unit: ingredient.quantity.unit },
  }
  if (ingredient.optional === true) json.optional = true
  if (ingredient.note !== undefined && ingredient.note !== "") json.note = ingredient.note
  return json
}

/**
 * 献立 1 枠 → `p_entry`。余分なプロパティ（採点・在庫の突き合わせ等）は写さない。
 * カタログのレシピの枠は `custom_*` を必ず null にする（DB の CHECK と同じ排他）。
 */
export function planEntryToRpc(entry: PlanEntryInput): PlanEntryRpc {
  const isRecipe = entry.recipeId !== null
  return {
    plan_date: entry.date,
    role: entry.role,
    position: entry.position,
    recipe_id: entry.recipeId,
    recipe_version: isRecipe ? entry.recipeVersion : null,
    custom_title: isRecipe ? null : (entry.customTitle?.trim() ?? null),
    custom_ingredients:
      isRecipe || entry.customIngredients === null ? null : entry.customIngredients.map(recipeIngredientToJson),
    servings: entry.servings,
    pinned: entry.pinned,
    status: entry.status,
    origin: entry.origin,
  }
}

/** `apply_dinner_plan` の `p_entries` の 1 要素（行 ID は呼び出し側が 1 回だけ採番して固定する）。 */
export function planEntryToRpcWithId(id: string, entry: PlanEntryInput): PlanEntryRpc & { id: string } {
  return { id, ...planEntryToRpc(entry) }
}

/** `sync_grocery_auto_items` の `p_items` の 1 要素。 */
export interface GroceryAutoItemRpc {
  item_key: string
  ingredient_id: string
  name: string
  required_quantity: number | null
  unit: string | null
  required_note: string | null
  needs_stock_check: boolean
  sources: Json
}

export const GROCERY_QUANTITY_MAX = 9_999_999
export const GROCERY_SOURCES_MAX = 40
export const GROCERY_ITEMS_MAX = 200
const GROCERY_NOTE_MAX = 200
const DISH_TITLE_MAX = 60
const ITEM_NAME_MAX = 40

export type GroceryNeedRejection = "item_key" | "name" | "quantity_too_large" | "too_many_items"

/**
 * 出所を献立の枠へ結び付けるのに要る、枠の最小の形（`buildGroceryNeeds` へ渡したのと同じ献立）。
 * 買い物へ載るのは確定した枠だけなので、照合も確定した枠だけで行う。
 */
export type GrocerySourceEntry = Pick<PlanEntry, "id" | "date" | "recipeId" | "customTitle" | "position" | "status">

/**
 * 出所 1 件に足す、作った料理への充当（`sync_grocery_auto_items` の台帳 `consumptions`）の手がかり。
 * 充当は枠ごとに記録し、「作った」の取り消しではその枠の記録だけを外す（購入の事実は書き換えない）。
 */
export interface GrocerySourceAllocation {
  /** この必要量を生んだ献立の枠。特定できなければ null（DB は出所の日付で判定する）。 */
  entryId: string | null
  /** その枠が買い物へ載せた正味量（必要量 − 在庫でまかなう量。項目の単位）。数値化しない分は null。 */
  buy: number | null
}

function grocerySourceToJson(source: GrocerySource, allocation: GrocerySourceAllocation): Json {
  const amount = source.quantity.amount
  const title = source.title.trim().slice(0, DISH_TITLE_MAX)
  return {
    date: source.date,
    recipeId: source.recipeId,
    // 料理名が空の出所は DB が拒む。名前が無いことを隠さない語を入れる
    title: title === "" ? "名前のない料理" : title,
    quantity: {
      amount: typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? amount : null,
      unit: source.quantity.unit,
    },
    entryId: allocation.entryId,
    buy: allocation.buy,
  }
}

const sourceEntryKey = (date: string, recipeId: string | null, title: string) =>
  recipeId === null ? `${date}|t:${title}` : `${date}|r:${recipeId}`

/**
 * 出所ごとの枠の ID。出所は `buildGroceryNeeds` が枠の順（日付 → 位置 → ID）に積む。
 * 同じ日に同じ料理の枠が複数あるときは、出所を枠の数で等分できる場合だけ順に割り当てる
 * （割り切れなければ決めつけず null。DB は出所の日付で判定する）。
 */
function sourceEntryIds(sources: readonly GrocerySource[], entries: readonly GrocerySourceEntry[]): (string | null)[] {
  const candidates = new Map<string, string[]>()
  const confirmed = entries
    .filter((entry) => entry.status === "confirmed")
    .sort((a, b) => a.date.localeCompare(b.date) || a.position - b.position || a.id.localeCompare(b.id))
  for (const entry of confirmed) {
    const key = sourceEntryKey(entry.date, entry.recipeId, entry.customTitle ?? "")
    candidates.set(key, [...(candidates.get(key) ?? []), entry.id])
  }
  const indexesByKey = new Map<string, number[]>()
  sources.forEach((source, index) => {
    const key = sourceEntryKey(source.date, source.recipeId, source.title)
    indexesByKey.set(key, [...(indexesByKey.get(key) ?? []), index])
  })
  const ids: (string | null)[] = sources.map(() => null)
  for (const [key, indexes] of indexesByKey) {
    const owners = candidates.get(key) ?? []
    if (owners.length === 0 || indexes.length % owners.length !== 0) continue
    const perOwner = indexes.length / owners.length
    indexes.forEach((index, order) => {
      ids[index] = owners[Math.floor(order / perOwner)]
    })
  }
  return ids
}

/**
 * 出所ごとの「買い物へ載せた正味量」（項目の単位。小数 3 桁）。**合計は必要量に一致する。**
 *
 * 在庫は日付順に一度だけ差し引かれる（`grocery.ts`）ので、在庫でまかなう量（= 出所の量の合計 − 必要量）は
 * 早い枠から順に充てたものとして割り戻す。在庫でまかなった料理を作っても、購入の記録は減らさないための値。
 */
function sourceBuys(need: GroceryNeed): (number | null)[] {
  const required = need.required
  const requiredAmount = required === null ? null : dbQuantity(required.amount, GROCERY_QUANTITY_MAX, 3)
  if (required === null) return need.sources.map(() => null)
  const milli = (value: number) => Math.round(Number(`${value}e3`))
  const gross = need.sources.map((source) => {
    if (source.quantity.amount === null || !areUnitsCompatible(source.quantity.unit, required.unit)) return null
    const base = toBaseAmount(source.quantity)
    return base === null || !Number.isFinite(base) || base <= 0 ? null : milli(base)
  })
  const requiredMilli = requiredAmount === null ? 0 : milli(requiredAmount)
  let stock = Math.max(0, gross.reduce<number>((sum, value) => sum + (value ?? 0), 0) - requiredMilli)
  const buys = gross.map((value) => {
    if (value === null) return null
    const covered = Math.min(value, stock)
    stock -= covered
    return value - covered
  })
  // 丸めの端数は最後の数値の出所へ寄せる（合計 = 必要量 を保つ）
  let last = buys.length - 1
  while (last >= 0 && buys[last] === null) last -= 1
  if (last >= 0) {
    const total = buys.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    buys[last] = Math.max(0, (buys[last] as number) + requiredMilli - total)
  }
  return buys.map((value) => (value === null ? null : Number(`${value}e-3`)))
}

/**
 * 必要な材料 1 件 → 自動項目。送れない値は切り捨てず、理由を返す。
 * - 必要量は小数 3 桁（DB の numeric(12,3)）。0（在庫でまかなえるが確認が要る）と数値化しない分は null。
 * - 出所は先頭 40 件まで（DB の上限。必要量には影響しない）。
 * - 出所には枠の ID と正味量を足す（`entries` = 計算に使った献立。渡さなければ枠は特定しない）。
 */
export function groceryNeedToRpc(
  need: GroceryNeed,
  entries: readonly GrocerySourceEntry[] = [],
): { ok: true; item: GroceryAutoItemRpc } | { ok: false; reason: GroceryNeedRejection } {
  const itemKey = groceryDbKeyOfLogicKey(need.itemKey, need.ingredientId)
  if (itemKey === null) return { ok: false, reason: "item_key" }
  const name = need.name.trim()
  if (name === "" || name.length > ITEM_NAME_MAX) return { ok: false, reason: "name" }
  const amount = need.required?.amount ?? null
  if (typeof amount === "number" && amount > GROCERY_QUANTITY_MAX) return { ok: false, reason: "quantity_too_large" }
  const note = need.nonNumeric.join("、").slice(0, GROCERY_NOTE_MAX)
  const entryIds = sourceEntryIds(need.sources, entries)
  const buys = sourceBuys(need)
  return {
    ok: true,
    item: {
      item_key: itemKey,
      ingredient_id: need.ingredientId,
      name,
      required_quantity: dbQuantity(amount, GROCERY_QUANTITY_MAX, 3),
      unit: need.required?.unit ?? null,
      required_note: note === "" ? null : note,
      needs_stock_check: need.needsStockCheck,
      sources: need.sources
        .slice(0, GROCERY_SOURCES_MAX)
        .map((source, index) => grocerySourceToJson(source, { entryId: entryIds[index], buy: buys[index] })),
    },
  }
}

/**
 * 必要な材料の一覧 → `p_items`。同じ入力からは常に同じ並び・同じ値を返す
 * （RPC は payload の内容で再送を照合する）。1 件でも送れなければ `rejected` に入る —
 * **呼び出し側は `rejected` が空でないとき同期を送らないこと**（一部だけ送ると、送らなかった
 * 自動項目を RPC が「不要になった」として消す）。
 *
 * @param entries 必要量の計算に使った献立（出所へ枠の ID を結び付ける。同期では必ず渡すこと —
 *   渡さないと、DB は「作った」料理ぶんの購入の記録を、日付が過ぎるまで使い終えたと判定できない）。
 */
export function groceryNeedsToRpc(
  needs: readonly GroceryNeed[],
  entries: readonly GrocerySourceEntry[] = [],
): {
  items: GroceryAutoItemRpc[]
  rejected: { itemKey: string; reason: GroceryNeedRejection }[]
} {
  const items: GroceryAutoItemRpc[] = []
  const rejected: { itemKey: string; reason: GroceryNeedRejection }[] = []
  const seen = new Set<string>()
  for (const need of needs) {
    const result = groceryNeedToRpc(need, entries)
    if (!result.ok) {
      rejected.push({ itemKey: need.itemKey, reason: result.reason })
      continue
    }
    if (seen.has(result.item.item_key)) {
      rejected.push({ itemKey: need.itemKey, reason: "item_key" })
      continue
    }
    seen.add(result.item.item_key)
    items.push(result.item)
  }
  if (items.length > GROCERY_ITEMS_MAX) {
    return {
      items: [],
      rejected: [...rejected, ...items.map((item) => ({ itemKey: item.item_key, reason: "too_many_items" as const }))],
    }
  }
  items.sort((a, b) => (a.item_key < b.item_key ? -1 : a.item_key > b.item_key ? 1 : 0))
  return { items, rejected }
}

export type DinnerSettingsInput = Omit<DinnerSettings, "version">

/** 設定 → `save_dinner_settings` の引数。常備品は重複を除き昇順（DB が保存する形と同じ）。 */
export function dinnerSettingsToRpcArgs(
  settings: DinnerSettingsInput,
  version: string | null,
): DinnerFunctions["save_dinner_settings"]["Args"] {
  return {
    p_version: version,
    p_servings: settings.servings,
    p_include_soup: settings.includeSoup,
    p_max_cook_minutes: settings.maxCookMinutes,
    p_staples: [...new Set(settings.stapleIngredientIds)].sort(),
    p_child_stages: { ...settings.childStages },
  }
}

/** 必須除外 → `save_food_exclusion` の引数（除外は登録と削除だけで、版を持たない）。 */
export function foodExclusionToRpcArgs(
  id: string,
  exclusion: Omit<FoodExclusion, "id">,
): DinnerFunctions["save_food_exclusion"]["Args"] {
  const { subject, target } = exclusion
  return {
    p_id: id,
    p_subject_kind: subject.kind,
    p_subject_profile_id: subject.kind === "member" ? subject.profileId : null,
    p_subject_child_id: subject.kind === "child" ? subject.childId : null,
    p_reason: exclusion.reason,
    p_target_kind: target.kind,
    p_target_id:
      target.kind === "allergen" ? target.allergenId : target.kind === "ingredient" ? target.ingredientId : null,
    p_custom_label: target.kind === "custom" ? target.label.trim() : null,
  }
}

/** 好み → `save_food_preference` の引数。個人の好みの持ち主は DB が呼び手に固定する（送らない）。 */
export function foodPreferenceToRpcArgs(
  id: string,
  version: string | null,
  preference: Pick<FoodPreference, "scope" | "target" | "sentiment">,
): DinnerFunctions["save_food_preference"]["Args"] {
  return {
    p_id: id,
    p_version: version,
    p_scope: preference.scope,
    p_target_kind: preference.target.kind,
    p_target_id: preference.target.id,
    p_sentiment: preference.sentiment,
  }
}

export type DishFeedbackInput = Omit<DishFeedback, "id" | "profileId"> & { dishTitle: string }

/** 食後評価 → `save_dish_feedback` の引数。評価した本人は DB が呼び手に固定する（送らない）。 */
export function dishFeedbackToRpcArgs(
  id: string,
  version: string | null,
  feedback: DishFeedbackInput,
): DinnerFunctions["save_dish_feedback"]["Args"] {
  return {
    p_id: id,
    p_version: version,
    p_recipe_id: feedback.recipeId,
    p_dish_title: feedback.dishTitle.trim(),
    p_eaten_on: feedback.eatenOn,
    p_taste: feedback.taste,
    p_effort: feedback.effort,
    p_again: feedback.again,
    p_exclude_from_learning: feedback.excludeFromLearning,
  }
}
