/**
 * 献立・買い物・食後評価の Server Action が受け取る値と返す値の型、および入力の型ガード。
 *
 * 境界指令を持たない中立モジュール（`"use server"` のファイルは関数しか export できないので、
 * 型・定数・純関数はここへ置く）。食材辞書・レシピのカタログも Supabase も import しない —
 * **Client Component から値 import してよい**（`useChoreSave` の `isPayload` に渡す）。
 *
 * ## 契約
 * - 世帯 ID は受け取らない（Action が `getAuthContext()` から導出する）。
 * - 行 ID・操作 ID はクライアントが 1 回だけ採番して payload に固定する（再送は同じ値）。
 * - 版（`version`）は `updated_at` の表記そのまま（`new Date()` を通さない）。
 * - ここの型ガードは**形**だけを見る。カタログ・必須除外・今日との前後は Action が検証する。
 */

import { isRecord } from "@/lib/domain/child-sharing"
import type { ChoreSaveFailure, ChoreSaveSuccess } from "@/lib/domain/rpc-outcome"
import { isValidYmd } from "@/lib/utils/date-jst"

import type { GapReason, PinRejection } from "../planner"
import type { DishRole, UnitId, WishConstraints } from "../types"
import { UNIT_LABELS } from "../units"
import { hasOnlyKeys, isMealLabel as isLabel, isMealUuid as isClientId } from "./meal-input"

// ── 上限・範囲（Action と画面が共有する） ───────────────────────────

/** 献立を作り始められるのは今日から何日先までか。 */
export const DINNER_PLAN_START_MAX_AHEAD_DAYS = 21
/** 手動料理・移動・記録で扱える過去の日数（「昨日作った」を残せる幅）。 */
export const DINNER_ENTRY_PAST_DAYS = 7
/** 買い物の自動計算が対象にする日数（今日を含む）。開始の上限 + 7 日を覆う。 */
export const GROCERY_HORIZON_DAYS = 28
/** AI 補助の世帯 1 日あたりの上限（DB の RPC の上限と同じ）。 */
export const DINNER_AI_DAILY_LIMIT = 10
export const CUSTOM_DISH_TITLE_MAX = 60
export const CUSTOM_DISH_INGREDIENTS_MAX = 30
export const CUSTOM_DISH_INGREDIENT_NAME_MAX = 40
export const GROCERY_NAME_MAX = 40
export const GROCERY_NOTE_MAX = 200
export const DISH_TITLE_MAX = 60
export const WISH_INPUT_MAX = 400
/** 料理後にまとめて更新できる食材の数。 */
export const COOKED_PANTRY_UPDATES_MAX = 30

const DISH_ROLES: readonly DishRole[] = ["main", "side", "staple", "soup"]
const RECIPE_ID = /^[a-z0-9_-]{1,64}$/
const TAG_ID = /^[a-z0-9_-]{1,24}$/

// ── 小さな検査 ─────────────────────────────────────────────────────

function isVersion(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= 64
}

function isNullableVersion(value: unknown): value is string | null {
  return value === null || isVersion(value)
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isDays(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 7
}

function isYmd(value: unknown): value is string {
  return typeof value === "string" && isValidYmd(value)
}

function isNullableLabel(value: unknown, max: number): value is string | null {
  return value === null || isLabel(value, max)
}

function isRole(value: unknown): value is DishRole {
  return typeof value === "string" && (DISH_ROLES as readonly string[]).includes(value)
}

export function isUnitId(value: unknown): value is UnitId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(UNIT_LABELS, value)
}

function isPositiveAmount(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max
}

function isServings(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 12
}

/**
 * 要求の外枠。**余分な項目を持つ要求は拒む**（`householdId` や `profileId` を紛れ込ませた要求を、
 * 無視ではなく拒否する。世帯と本人は Action が `getAuthContext()` から、DB が `auth.uid()` から決める）。
 */
function isRequest(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && hasOnlyKeys(value, keys)
}

function isStringList(value: unknown, pattern: RegExp, max: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every((item) => typeof item === "string" && pattern.test(item)) &&
    new Set(value).size === value.length
  )
}

// ── 希望の解釈（保存しない） ───────────────────────────────────────

export interface InterpretWishRequest {
  wish: string
  startDate: string
  days: number
}

export function isInterpretWishRequest(value: unknown): value is InterpretWishRequest {
  return (
    isRequest(value, ["wish", "startDate", "days"]) &&
    typeof value.wish === "string" &&
    value.wish.length <= WISH_INPUT_MAX &&
    isYmd(value.startDate) &&
    isDays(value.days)
  )
}

/** 希望（`WishConstraints`）の形。カタログとの照合は Action が行う。 */
export function isWishConstraintsShape(value: unknown): value is WishConstraints {
  if (!isRecord(value)) return false
  if (!hasOnlyKeys(value, ["pins", "preferTags", "avoidTags", "maxMinutes", "preferRecipeIds"])) return false
  const { pins, maxMinutes } = value
  if (!Array.isArray(pins) || pins.length > 28) return false
  for (const pin of pins) {
    if (!isRecord(pin) || !hasOnlyKeys(pin, ["date", "recipeId"])) return false
    if (!isYmd(pin.date) || typeof pin.recipeId !== "string" || !RECIPE_ID.test(pin.recipeId)) return false
  }
  if (!isStringList(value.preferTags, TAG_ID, 20) || !isStringList(value.avoidTags, TAG_ID, 20)) return false
  if (!isStringList(value.preferRecipeIds, RECIPE_ID, 20)) return false
  if (maxMinutes !== null) {
    if (typeof maxMinutes !== "number" || !Number.isInteger(maxMinutes) || maxMinutes < 5 || maxMinutes > 180) {
      return false
    }
  }
  return true
}

/** AI の状態（画面は状態ごとに正直な文言を出す。モックの結果を AI の回答として出さない）。 */
export type MealAiState =
  /** env が揃っておらず、AI 補助は使えない（自動献立は動く）。 */
  | "not_configured"
  | "available"
  /** 本日の世帯の上限に達した。 */
  | "household_limit"
  /** 無料枠が終了し、次の再開時刻まで全体で止めている。 */
  | "provider_exhausted"
  /** 今回の呼出しが失敗した（timeout・不正な出力・一時的な混雑）。 */
  | "temporary_failure"
  /** 状態を確認できなかった。 */
  | "unknown"

export interface MealAiStatusView {
  state: MealAiState
  /** 無料枠の再開時刻（ISO）。`provider_exhausted` のときだけ。 */
  resetsAt: string | null
  /** 再開時刻の JST 表記（例: 「11月12日 9:00」）。 */
  resetsAtLabel: string | null
  /** 利用者向けの 1 文。 */
  message: string
}

/** 解釈できた希望の 1 項目（料理名・タグ名はサーバーで表示名へ直してある）。 */
export type WishSummaryItem =
  | { kind: "pin"; date: string; dateLabel: string; recipeId: string; title: string }
  | { kind: "prefer_tag" | "avoid_tag"; tag: string; label: string }
  | { kind: "prefer_recipe"; recipeId: string; title: string }
  | { kind: "max_minutes"; minutes: number }

/**
 * 同じ日・同じ区分に先の固定があったため、固定にしなかった希望（「金曜はカレー、金曜はハンバーグ」の 2 つ目）。
 * どちらを採るかはサーバーが決めない — 先の固定を残し、利用者に入れ直してもらう。
 */
export interface WishPinConflictNotice {
  /** 希望の原文（その部分）。`unparsed` にも同じ文が入る。 */
  text: string
  date: string
  /** 「11/13（金）」。 */
  dateLabel: string
  /** 固定にしなかった料理。 */
  recipeId: string
  title: string
  /** 先に固定した料理（こちらを `constraints.pins` に残した）。 */
  keptRecipeId: string
  keptTitle: string
  /** 利用者向けの 1 文。 */
  message: string
}

export type InterpretWishResult =
  | {
      ok: true
      /** `ai` = 生成 AI の補助で構造化した。`rules` = 規則だけで解釈した（自動）。 */
      via: "ai" | "rules"
      constraints: WishConstraints
      summary: WishSummaryItem[]
      /**
       * 規則で解釈できなかった部分（原文）。AI が残りを構造化したときは、固定にしなかった希望
       * （`pinConflicts`）の原文だけが残る。
       */
      unparsed: string[]
      /**
       * 同じ日・同じ区分への 2 つ目の固定で、固定にしなかった希望。`interpretDinnerWish` は必ず入れる
       * （無ければ空。型が省略可なのは、画面のテストの既存の fixture を壊さないため）。
       */
      pinConflicts?: WishPinConflictNotice[]
      /** 長さの上限で切り捨てた。 */
      truncated: boolean
      ai: MealAiStatusView
      /** この解釈の基にした献立の版（`generateDinnerPlan` の `expectedRevision` に渡す）。 */
      revision: number
      /** 希望どおりに固定できない日（固定済み・作った料理がある）。 */
      pinNotices: string[]
    }
  | { ok: false; error: string }

// ── 献立の保存 ─────────────────────────────────────────────────────

export type DinnerPlanMode = "auto" | "ai_assisted"

export interface GenerateDinnerPlanRequest {
  operationId: string
  expectedRevision: number
  startDate: string
  days: number
  /** `interpretDinnerWish` が返した希望。希望なしは null。 */
  constraints: WishConstraints | null
  /** 希望を AI 補助で構造化したか（`interpretDinnerWish` の `via` が `ai` なら `ai_assisted`）。 */
  mode: DinnerPlanMode
  /** 今回だけ人数を変える（省略時は設定の人数。未設定なら標準の 2 人分）。 */
  servings?: number
  /** 主食の枠を足す（主食を含む料理の日は足さない）。既定 false。 */
  includeStaple?: boolean
}

export function isGenerateDinnerPlanRequest(value: unknown): value is GenerateDinnerPlanRequest {
  return (
    isRequest(value, [
      "operationId",
      "expectedRevision",
      "startDate",
      "days",
      "constraints",
      "mode",
      "servings",
      "includeStaple",
    ]) &&
    isClientId(value.operationId) &&
    isRevision(value.expectedRevision) &&
    isYmd(value.startDate) &&
    isDays(value.days) &&
    (value.constraints === null || isWishConstraintsShape(value.constraints)) &&
    (value.mode === "auto" || value.mode === "ai_assisted") &&
    (value.servings === undefined || isServings(value.servings)) &&
    (value.includeStaple === undefined || typeof value.includeStaple === "boolean")
  )
}

/** 差替えで「もう出さない」料理の上限（画面が、直前に見送った料理を覚えて渡す）。 */
export const REPLACE_AVOID_MAX = 20

function isAvoidList(value: unknown): value is string[] | undefined {
  return value === undefined || isStringList(value, RECIPE_ID, REPLACE_AVOID_MAX)
}

export interface ReplaceDinnerDayRequest {
  operationId: string
  expectedRevision: number
  date: string
  /** 直前に見送った料理（同じ料理へ戻らないための希望。今の料理は常に候補から外れる）。 */
  avoidRecipeIds?: string[]
}

export function isReplaceDinnerDayRequest(value: unknown): value is ReplaceDinnerDayRequest {
  return (
    isRequest(value, ["operationId", "expectedRevision", "date", "avoidRecipeIds"]) &&
    isClientId(value.operationId) &&
    isRevision(value.expectedRevision) &&
    isYmd(value.date) &&
    isAvoidList(value.avoidRecipeIds)
  )
}

/** 1 枠を指す操作の共通形（枠の ID と、画面が開いた時点の版）。 */
export interface DinnerEntryRef {
  entryId: string
  version: string
}

function isEntryRef(value: unknown, extraKeys: readonly string[]): value is Record<string, unknown> & DinnerEntryRef {
  return isRequest(value, ["entryId", "version", ...extraKeys]) && isClientId(value.entryId) && isVersion(value.version)
}

export function isDinnerEntryRef(value: unknown): value is DinnerEntryRef {
  return isEntryRef(value, [])
}

export interface ReplaceDinnerDishRequest extends DinnerEntryRef {
  /** 直前に見送った料理（同じ料理へ戻らないための希望。今の料理は常に候補から外れる）。 */
  avoidRecipeIds?: string[]
}

export function isReplaceDinnerDishRequest(value: unknown): value is ReplaceDinnerDishRequest {
  return isEntryRef(value, ["avoidRecipeIds"]) && isAvoidList(value.avoidRecipeIds)
}

export interface MoveDinnerEntryRequest extends DinnerEntryRef {
  toDate: string
}

export function isMoveDinnerEntryRequest(value: unknown): value is MoveDinnerEntryRequest {
  return isEntryRef(value, ["toDate"]) && isYmd(value.toDate)
}

export interface SetDinnerPinRequest extends DinnerEntryRef {
  pinned: boolean
}

export function isSetDinnerPinRequest(value: unknown): value is SetDinnerPinRequest {
  return isEntryRef(value, ["pinned"]) && typeof value.pinned === "boolean"
}

/**
 * 1 枠の人数を変える（固定した料理・確定した料理も変えられる。作った料理は変えない）。
 * 料理・日付・固定・状態はそのまま。買い物の必要量は、新しい人数で計算し直される。
 */
export interface SetDinnerServingsRequest extends DinnerEntryRef {
  servings: number
}

export function isSetDinnerServingsRequest(value: unknown): value is SetDinnerServingsRequest {
  return isEntryRef(value, ["servings"]) && isServings(value.servings)
}

/**
 * これからの未調理の枠（今日以降の提案・確定。固定を含む）を、まとめて同じ人数にする。
 * 設定の人数を変えた後に、**利用者が選んだときだけ**送る（設定の保存は献立を書き換えない）。
 *
 * `servings` は利用者が画面で確かめた人数（サーバーは設定を読み直して別の人数へ言い換えない）。
 * 既にその人数の枠は書かないので、途中で止まった後に同じ要求を送り直すと、残りだけが続きから変わる。
 */
export interface ApplyDinnerServingsRequest {
  servings: number
}

export function isApplyDinnerServingsRequest(value: unknown): value is ApplyDinnerServingsRequest {
  return isRequest(value, ["servings"]) && isServings(value.servings)
}

/** 「これからの未調理の枠」か（今日以降の提案・確定。作った・作らなかった枠と過ぎた日は含めない）。 */
export function isUpcomingUncookedEntry(entry: { date: string; status: string }, today: string): boolean {
  return entry.date >= today && (entry.status === "proposed" || entry.status === "confirmed")
}

/** これからの未調理の枠のうち、人数が `servings` と違う枠の数（設定の人数とのずれの件数）。 */
export function countServingsMismatch(
  entries: readonly { date: string; status: string; servings: number }[],
  servings: number,
  today: string,
): number {
  return entries.filter((entry) => isUpcomingUncookedEntry(entry, today) && entry.servings !== servings).length
}

/** 手動料理の材料 1 件。`ingredientId` か `name` のどちらかで食材を指す（名前はサーバーが辞書へ解決する）。 */
export interface CustomIngredientInput {
  ingredientId?: string
  name?: string
  /** 「適量」「少々」は null。 */
  amount: number | null
  unit: UnitId
  optional?: boolean
}

function isCustomIngredientInput(value: unknown): value is CustomIngredientInput {
  if (!isRecord(value) || !hasOnlyKeys(value, ["ingredientId", "name", "amount", "unit", "optional"])) return false
  const hasId = typeof value.ingredientId === "string" && RECIPE_ID.test(value.ingredientId)
  const hasName = isLabel(value.name, CUSTOM_DISH_INGREDIENT_NAME_MAX)
  if (!hasId && !hasName) return false
  if (value.ingredientId !== undefined && !hasId) return false
  if (value.name !== undefined && !hasName) return false
  if (!isUnitId(value.unit)) return false
  const nonNumeric = value.unit === "to_taste" || value.unit === "pinch"
  if (nonNumeric ? value.amount !== null : !isPositiveAmount(value.amount, 9_999_999)) return false
  return value.optional === undefined || typeof value.optional === "boolean"
}

export interface SaveCustomDishRequest {
  /** 枠の ID（新規はクライアントが採番）。 */
  id: string
  /** 新規は null。編集は開いた時点の版。 */
  version: string | null
  date: string
  role: DishRole
  title: string
  /** 省略時は設定の人数。 */
  servings?: number
  /** null = 材料を登録しない（買い物の自動計算の対象外）。 */
  ingredients: CustomIngredientInput[] | null
}

export function isSaveCustomDishRequest(value: unknown): value is SaveCustomDishRequest {
  if (!isRequest(value, ["id", "version", "date", "role", "title", "servings", "ingredients"])) return false
  const { ingredients } = value
  return (
    isClientId(value.id) &&
    isNullableVersion(value.version) &&
    isYmd(value.date) &&
    isRole(value.role) &&
    isLabel(value.title, CUSTOM_DISH_TITLE_MAX) &&
    (value.servings === undefined || isServings(value.servings)) &&
    (ingredients === null ||
      (Array.isArray(ingredients) &&
        ingredients.length <= CUSTOM_DISH_INGREDIENTS_MAX &&
        ingredients.every(isCustomIngredientInput)))
  )
}

/** 1 日に置ける枠の位置（0〜9。DB の CHECK と同じ）。 */
export const DINNER_SLOT_POSITIONS = 10

/**
 * 一覧のレシピ 1 品を、指定の日の献立へ**足す**（「今あるもので」・レシピ詳細から。R48 / 2026-11-11 ④）。
 *
 * - その日の既存の料理・固定枠には触れない（差し替え・作り直しではない）。空いている枠へ「固定・手動」で 1 行足す。
 * - **最初の押下で、枠の ID・区分・位置・人数・状態を固定する**（再送は同じ ID・同じ内容）。サーバーで位置や状態を
 *   計算し直すと、同じ ID で別の内容になり、再送が replayed ではなく conflict になる（応答を失った追加を
 *   確かめ直せない）。固定した値は、新しく足すときだけサーバーが今の献立と照らす（枠が埋まった・その日の状態が
 *   変わった・同じ料理が既に入った → 上書きせず conflict）。
 * - `status` はその日の状態に合わせる（`addedDishStatus`。確定済みの日へ足す料理を提案のままにすると、
 *   買い物に入らない）。
 * - `expectedRevision` は押した時点の献立の版（2026-11-11 レビュー[中 5]）。その ID の行が無いとき、版が違えば
 *   書かない — 先の送信が成立した後に別の端末がその料理を消していても（削除の印は残らない）、追加・削除のどちらも
 *   版を進めるので見分けられる。版が同じなら、押した後に何も起きていない = 先の送信は成立していない。
 */
export interface AddDinnerRecipeRequest {
  /** 足す枠の ID（最初の押下で 1 回だけ採番。同じ ID の再送は二重に足さない）。 */
  id: string
  /** 押した時点の献立の版（`dinner_plan_state.revision`）。 */
  expectedRevision: number
  /** 今日以降（買い物の対象の最後の日まで）。 */
  date: string
  recipeId: string
  /** レシピの区分（サーバーがカタログと照らす）。 */
  role: DishRole
  /** 押した時点で空いていた位置（0〜9）。 */
  position: number
  /** 押した時点の設定の人数。 */
  servings: number
  /** 押した時点のその日の状態（`addedDishStatus`）。 */
  status: "proposed" | "confirmed"
}

export function isAddDinnerRecipeRequest(value: unknown): value is AddDinnerRecipeRequest {
  return (
    isRequest(value, ["id", "expectedRevision", "date", "recipeId", "role", "position", "servings", "status"]) &&
    isClientId(value.id) &&
    isRevision(value.expectedRevision) &&
    isYmd(value.date) &&
    typeof value.recipeId === "string" &&
    RECIPE_ID.test(value.recipeId) &&
    isRole(value.role) &&
    typeof value.position === "number" &&
    Number.isInteger(value.position) &&
    value.position >= 0 &&
    value.position < DINNER_SLOT_POSITIONS &&
    isServings(value.servings) &&
    (value.status === "proposed" || value.status === "confirmed")
  )
}

/**
 * その日へ 1 品を足すときの状態（純関数。画面とサーバーで同じ規則）。その日の提案・確定の料理が全て「確定」なら
 * 「確定」（確定済みの日の買い物に入る）、それ以外（提案が混じる・料理が無い・作った／作らなかっただけ）は「提案」。
 */
export function addedDishStatus(dayEntries: readonly { status: string }[]): "proposed" | "confirmed" {
  const active = dayEntries.filter((entry) => entry.status === "proposed" || entry.status === "confirmed")
  return active.length > 0 && active.every((entry) => entry.status === "confirmed") ? "confirmed" : "proposed"
}

/** その日の空いている最初の位置（区分を問わない。0〜9）。埋まっていれば null。 */
export function firstFreePosition(dayEntries: readonly { position: number }[]): number | null {
  const taken = new Set(dayEntries.map((entry) => entry.position))
  for (let position = 0; position < DINNER_SLOT_POSITIONS; position += 1) {
    if (!taken.has(position)) return position
  }
  return null
}

export interface ConfirmDinnerPlanRequest {
  expectedRevision: number
  startDate: string
  days: number
}

export function isConfirmDinnerPlanRequest(value: unknown): value is ConfirmDinnerPlanRequest {
  return (
    isRequest(value, ["expectedRevision", "startDate", "days"]) &&
    isRevision(value.expectedRevision) &&
    isYmd(value.startDate) &&
    isDays(value.days)
  )
}

/** 料理後に利用者が選んだ食材 1 件の更新。選ばなかった食材は送らない（自動では減らさない）。 */
export interface CookedPantryUpdate {
  id: string
  version: string
  status: "have" | "low" | "out"
  /** 残量を登録し直すときだけ渡す。null = 数量不明にする。省略 = 数量は変えない。 */
  quantity?: { amount: number; unit: UnitId } | null
}

export interface ApplyCookedPantryUpdatesRequest {
  updates: CookedPantryUpdate[]
}

function isCookedPantryUpdate(value: unknown): value is CookedPantryUpdate {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "version", "status", "quantity"])) return false
  if (!isClientId(value.id) || !isVersion(value.version)) return false
  if (value.status !== "have" && value.status !== "low" && value.status !== "out") return false
  const { quantity } = value
  if (quantity === undefined || quantity === null) return true
  return (
    isRecord(quantity) &&
    hasOnlyKeys(quantity, ["amount", "unit"]) &&
    isPositiveAmount(quantity.amount, 9_999_999.99) &&
    isUnitId(quantity.unit) &&
    quantity.unit !== "to_taste" &&
    quantity.unit !== "pinch"
  )
}

export function isApplyCookedPantryUpdatesRequest(value: unknown): value is ApplyCookedPantryUpdatesRequest {
  if (!isRequest(value, ["updates"]) || !Array.isArray(value.updates)) return false
  const { updates } = value
  if (updates.length === 0 || updates.length > COOKED_PANTRY_UPDATES_MAX) return false
  if (!updates.every(isCookedPantryUpdate)) return false
  return new Set(updates.map((update) => update.id)).size === updates.length
}

export interface SaveDishFeedbackRequest {
  id: string
  version: string | null
  /** カタログのレシピ。手動料理は null。 */
  recipeId: string | null
  dishTitle: string
  eatenOn: string
  taste: 1 | 2 | 3 | null
  effort: 1 | 2 | 3 | null
  again: boolean | null
  /** その日の気分など、好みに反映しない記録。 */
  excludeFromLearning: boolean
}

function isRating(value: unknown): value is 1 | 2 | 3 | null {
  return value === null || value === 1 || value === 2 || value === 3
}

export function isSaveDishFeedbackRequest(value: unknown): value is SaveDishFeedbackRequest {
  return (
    isRequest(value, [
      "id",
      "version",
      "recipeId",
      "dishTitle",
      "eatenOn",
      "taste",
      "effort",
      "again",
      "excludeFromLearning",
    ]) &&
    isClientId(value.id) &&
    isNullableVersion(value.version) &&
    (value.recipeId === null || (typeof value.recipeId === "string" && RECIPE_ID.test(value.recipeId))) &&
    isLabel(value.dishTitle, DISH_TITLE_MAX) &&
    isYmd(value.eatenOn) &&
    isRating(value.taste) &&
    isRating(value.effort) &&
    (value.again === null || typeof value.again === "boolean") &&
    typeof value.excludeFromLearning === "boolean"
  )
}

// ── 買い物 ─────────────────────────────────────────────────────────

export interface SyncGroceryListRequest {
  operationId: string
}

export function isSyncGroceryListRequest(value: unknown): value is SyncGroceryListRequest {
  return isRequest(value, ["operationId"]) && isClientId(value.operationId)
}

/**
 * 購入の記録。
 * - `full` … 数値の項目を「必要量まで購入」にする
 * - `amount` … 数値の項目の「買った合計量」を指定する（0 で取り消し）
 * - `check` … 数値で追えない項目のチェック
 */
export type GroceryPurchaseInput =
  | { kind: "full" }
  | { kind: "amount"; amount: number }
  | { kind: "check"; checked: boolean }

export interface SetGroceryPurchaseRequest {
  id: string
  version: string
  purchase: GroceryPurchaseInput
}

function isGroceryPurchaseInput(value: unknown): value is GroceryPurchaseInput {
  if (!isRecord(value)) return false
  if (value.kind === "full") return hasOnlyKeys(value, ["kind"])
  if (value.kind === "amount") {
    return (
      hasOnlyKeys(value, ["kind", "amount"]) &&
      typeof value.amount === "number" &&
      Number.isFinite(value.amount) &&
      value.amount >= 0 &&
      value.amount <= 9_999_999
    )
  }
  if (value.kind === "check") return hasOnlyKeys(value, ["kind", "checked"]) && typeof value.checked === "boolean"
  return false
}

export function isSetGroceryPurchaseRequest(value: unknown): value is SetGroceryPurchaseRequest {
  return (
    isRequest(value, ["id", "version", "purchase"]) &&
    isClientId(value.id) &&
    isVersion(value.version) &&
    isGroceryPurchaseInput(value.purchase)
  )
}

export interface SaveGroceryManualItemRequest {
  id: string
  version: string | null
  name: string
  /** 数量は任意。渡すときは単位も要る。 */
  quantity: number | null
  unit: UnitId | null
  /** 売場（`catalog/sections.ts` の ID）。null は「その他」。 */
  section: string | null
  note: string | null
}

const SECTION_ID = /^[a-z_]{1,20}$/

function isNullableSection(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && SECTION_ID.test(value))
}

export function isSaveGroceryManualItemRequest(value: unknown): value is SaveGroceryManualItemRequest {
  if (!isRequest(value, ["id", "version", "name", "quantity", "unit", "section", "note"])) return false
  const hasQuantity = value.quantity !== null
  return (
    isClientId(value.id) &&
    isNullableVersion(value.version) &&
    isLabel(value.name, GROCERY_NAME_MAX) &&
    (hasQuantity ? isPositiveAmount(value.quantity, 9_999_999) : true) &&
    (value.unit === null || (isUnitId(value.unit) && value.unit !== "to_taste" && value.unit !== "pinch")) &&
    // 数量だけ・単位だけの片方は受けない（数値で追える項目かどうかを曖昧にしない）
    hasQuantity === (value.unit !== null) &&
    isNullableSection(value.section) &&
    isNullableLabel(value.note, GROCERY_NOTE_MAX)
  )
}

export interface UpdateGroceryItemMetaRequest {
  id: string
  version: string
  note: string | null
  /** null = 売場の変更をやめ、食材の既定の売場へ戻す。 */
  section: string | null
}

export function isUpdateGroceryItemMetaRequest(value: unknown): value is UpdateGroceryItemMetaRequest {
  return (
    isRequest(value, ["id", "version", "note", "section"]) &&
    isClientId(value.id) &&
    isVersion(value.version) &&
    isNullableLabel(value.note, GROCERY_NOTE_MAX) &&
    isNullableSection(value.section)
  )
}

export interface DeleteGroceryItemRequest {
  id: string
  version: string
}

export function isDeleteGroceryItemRequest(value: unknown): value is DeleteGroceryItemRequest {
  return isRequest(value, ["id", "version"]) && isClientId(value.id) && isVersion(value.version)
}

export interface RestockPantryFromGroceryRequest {
  groceryId: string
  version: string
  /** 作る在庫の行 ID（クライアントが 1 回だけ採番。同じ ID の再送は二重に足さない）。 */
  pantryItemId: string
  /** 確認した量（項目の単位）。null = 数量不明の在庫として足す。 */
  quantity: number | null
}

export function isRestockPantryFromGroceryRequest(value: unknown): value is RestockPantryFromGroceryRequest {
  return (
    isRequest(value, ["groceryId", "version", "pantryItemId", "quantity"]) &&
    isClientId(value.groceryId) &&
    isVersion(value.version) &&
    isClientId(value.pantryItemId) &&
    (value.quantity === null || isPositiveAmount(value.quantity, 9_999_999.99))
  )
}

// ── 1 つの `useChoreSave` で送るための合併型 ───────────────────────

/**
 * 献立の保存操作の合併型（`op` で見分ける）。`useChoreSave` は 1 つの `run` と 1 つの `isPayload` を
 * 取るので、画面は `saveDinnerRequest`（`plan/actions.ts`）へこの形で送れる。
 */
export type DinnerRequest =
  | ({ op: "generate" } & GenerateDinnerPlanRequest)
  | ({ op: "replace_day" } & ReplaceDinnerDayRequest)
  | ({ op: "replace_dish" } & ReplaceDinnerDishRequest)
  | ({ op: "move" } & MoveDinnerEntryRequest)
  | ({ op: "pin" } & SetDinnerPinRequest)
  | ({ op: "custom_dish" } & SaveCustomDishRequest)
  | ({ op: "confirm" } & ConfirmDinnerPlanRequest)
  | ({ op: "cooked" } & DinnerEntryRef)
  | ({ op: "skipped" } & DinnerEntryRef)
  | ({ op: "restore" } & DinnerEntryRef)
  | ({ op: "delete" } & DinnerEntryRef)
  | ({ op: "pantry_after_cooking" } & ApplyCookedPantryUpdatesRequest)
  | ({ op: "feedback" } & SaveDishFeedbackRequest)
  | ({ op: "add_recipe" } & AddDinnerRecipeRequest)

const DINNER_REQUEST_GUARDS: Readonly<Record<DinnerRequest["op"], (value: unknown) => boolean>> = {
  generate: isGenerateDinnerPlanRequest,
  replace_day: isReplaceDinnerDayRequest,
  replace_dish: isReplaceDinnerDishRequest,
  move: isMoveDinnerEntryRequest,
  pin: isSetDinnerPinRequest,
  custom_dish: isSaveCustomDishRequest,
  confirm: isConfirmDinnerPlanRequest,
  cooked: isDinnerEntryRef,
  skipped: isDinnerEntryRef,
  restore: isDinnerEntryRef,
  delete: isDinnerEntryRef,
  pantry_after_cooking: isApplyCookedPantryUpdatesRequest,
  feedback: isSaveDishFeedbackRequest,
  add_recipe: isAddDinnerRecipeRequest,
}

/** `op` を外した残り（各 Action が受け取る形）。 */
export function withoutOp<T extends { op: string }>(request: T): Omit<T, "op"> {
  const { op: _op, ...rest } = request
  void _op
  return rest
}

function isOpRequest<Op extends string>(
  value: unknown,
  guards: Readonly<Record<Op, (value: unknown) => boolean>>,
): boolean {
  if (!isRecord(value) || typeof value.op !== "string") return false
  // 許可された関数だけを選択し、外部入力から直接呼び出さない。
  const guard = Object.entries(guards).find(([name]) => name === value.op)?.[1]
  if (typeof guard !== "function") return false
  return guard(withoutOp(value as { op: string }))
}

export function isDinnerRequest(value: unknown): value is DinnerRequest {
  return isOpRequest(value, DINNER_REQUEST_GUARDS)
}

/**
 * 人数の変更の操作（R45）。`saveDinnerRequest`（`plan/actions.ts`）は `DinnerRequest` と同じ入口で受ける。
 *
 * `DinnerRequest` と分けてあるのは、画面側に `DinnerRequest["op"]` を網羅する switch
 * （`plan-labels.ts` の控えの名前・成功の文）が在るため。画面がこの操作を使い始めるときに、
 * その switch へ 2 つの case を足したうえで `DinnerRequest` へ統合してよい。
 */
export type DinnerServingsRequest =
  | ({ op: "servings" } & SetDinnerServingsRequest)
  | ({ op: "servings_upcoming" } & ApplyDinnerServingsRequest)

const DINNER_SERVINGS_REQUEST_GUARDS: Readonly<Record<DinnerServingsRequest["op"], (value: unknown) => boolean>> = {
  servings: isSetDinnerServingsRequest,
  servings_upcoming: isApplyDinnerServingsRequest,
}

export function isDinnerServingsRequest(value: unknown): value is DinnerServingsRequest {
  return isOpRequest(value, DINNER_SERVINGS_REQUEST_GUARDS)
}

/** 買い物の保存操作の合併型（`shopping/actions.ts` の `saveGroceryRequest` へ送る）。 */
export type GroceryRequest =
  | ({ op: "sync" } & SyncGroceryListRequest)
  | ({ op: "purchase" } & SetGroceryPurchaseRequest)
  | ({ op: "manual_item" } & SaveGroceryManualItemRequest)
  | ({ op: "meta" } & UpdateGroceryItemMetaRequest)
  | ({ op: "delete" } & DeleteGroceryItemRequest)
  | ({ op: "restock" } & RestockPantryFromGroceryRequest)

const GROCERY_REQUEST_GUARDS: Readonly<Record<GroceryRequest["op"], (value: unknown) => boolean>> = {
  sync: isSyncGroceryListRequest,
  purchase: isSetGroceryPurchaseRequest,
  manual_item: isSaveGroceryManualItemRequest,
  meta: isUpdateGroceryItemMetaRequest,
  delete: isDeleteGroceryItemRequest,
  restock: isRestockPantryFromGroceryRequest,
}

export function isGroceryRequest(value: unknown): value is GroceryRequest {
  return isOpRequest(value, GROCERY_REQUEST_GUARDS)
}

// ── Action の応答 ──────────────────────────────────────────────────

/**
 * 献立を変えた後の、買い物の自動項目の同期の結果。
 * 同期の失敗で献立の保存の成功を失敗と偽らない（別に返す）。
 */
export type GrocerySyncReport =
  | { ok: true; status: "saved" | "replayed" }
  | { ok: false; message: string }

export const GROCERY_SYNC_FAILED_MESSAGE =
  "買い物リストを更新できませんでした。買い物の画面で「献立から更新」を押してください。"

/**
 * 判定できないアレルギーの登録のために、買い物の自動の更新を止めているときの文（要再確認）。
 * 同期の応答（`grocery-sync.ts`）と買い物の画面の帯で同じ文を使う。
 */
export function groceryAutoHoldMessage(labels: readonly string[]): string {
  const names = labels.map((label) => `「${label}」`).join("")
  return `判定できないアレルギーの登録${names === "" ? "" : `（${names}）`}があるため、買い物リストの自動の更新を止めています（要再確認）。今のリスト・購入の記録・手で足した項目はそのままです。設定で一覧から選び直すと、更新できます。`
}

export interface PlanGapNotice {
  date: string
  role: DishRole
  reason: GapReason
  /** 利用者向けの理由。 */
  message: string
}

export interface PinRejectionNotice {
  date: string
  recipeId: string
  reason: PinRejection
  message: string
}

/** 1 日の差替えで、選び直さずに献立から外した枠（黙って消さない。画面で知らせる）。 */
export interface DroppedEntryNotice {
  /** 外した枠の ID（もう献立に無い）。 */
  entryId: string
  date: string
  role: DishRole
  /** 外した料理の名前。 */
  title: string
  /** `main_includes_staple` = 主食を含む主菜（丼・カレー・麺）へ替わったので、その日の主食を外した。 */
  reason: "main_includes_staple"
  /** 利用者向けの 1 文（`notices` にも同じ文が入る）。 */
  message: string
}

/** `conflict` の内訳（画面の文言の出し分け用）。 */
export type DinnerConflictDetail =
  /** 献立の版が進んでいた（別の端末・別の操作が先に変えた）。 */
  | "stale_plan"
  /** 希望を解釈した後に、使わない食材の設定が変わった。 */
  | "constraints_changed"
  /** 対象の枠が既に無い。 */
  | "gone"
  /** 対象の行が先に更新されていた。 */
  | "row_changed"
  /** 1 品を足そうとした日の献立が先に変わっていた（枠が埋まった・状態が変わった・同じ料理が入った）。 */
  | "day_changed"

export interface DinnerSaveSuccess extends ChoreSaveSuccess {
  /** 保存後（conflict なら最新）の献立の版。読めなかったときは null。 */
  revision: number | null
  detail?: DinnerConflictDetail
  /** 利用者向けの補足（不足枠・保持した固定枠・候補なし 等）。 */
  notices: string[]
  /** 献立を変えなかった・同期を走らせなかったときは null。 */
  grocery: GrocerySyncReport | null
  /** 作成・差替えで埋められなかった枠と理由。 */
  gaps?: PlanGapNotice[]
  /** 採用しなかった希望の固定。 */
  rejectedPins?: PinRejectionNotice[]
  /** 実際にどの経路で作ったか（`ai_assisted` は AI 補助が有効な環境で、AI が構造化した希望を使ったときだけ）。 */
  via?: DinnerPlanMode
  /** 人数をまとめて変えたとき（`servings_upcoming`）に、今回書き換えた枠の数。 */
  changedEntries?: number
  /** 1 日の差替え（`replace_day`）で、選び直さずに外した枠（主食を含む主菜へ替わった日の主食）。無ければ空。 */
  droppedEntries?: DroppedEntryNotice[]
  /**
   * 判定できないアレルギーの除外のために、料理を自動では決められなかったときの説明文（除外の名前を挙げる。
   * `notices` にも同じ文が入る）。作成・差替えで、その理由の空き枠が出たときだけ。
   */
  autoConfirmHold?: string
  /**
   * 手動料理の保存（`custom_dish`）で、使わない食材に「当たる」（blocked）か「未確認」（label_check）だったとき
   * （保存は成立している = 下書き。確定はできない）。`notices` にも同じ文が入る。画面は警告として出す。
   */
  exclusionWarning?: { verdict: "blocked" | "label_check"; message: string }
}

export type DinnerSaveResult = DinnerSaveSuccess | ChoreSaveFailure

export interface GrocerySaveSuccess extends ChoreSaveSuccess {
  detail?: "gone" | "row_changed" | "stale_plan"
  notices: string[]
  /** 在庫へ足した後など、買い物の自動項目を計算し直したときの結果。 */
  grocery?: GrocerySyncReport | null
}

export type GrocerySaveResult = GrocerySaveSuccess | ChoreSaveFailure
