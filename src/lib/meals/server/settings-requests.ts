/**
 * ごはんの設定・使わない食材（必須除外）・好み・食後評価の Server Action
 * （`src/app/(main)/chores/meals/settings/actions.ts`）の要求と応答の型、要求の形の検査。
 *
 * 境界指令を持たない中立モジュール（食材辞書・レシピのカタログを import しない。
 * Client Component から値 import してよい — 端末の控えを読むときの `isPayload` に使う）。
 *
 * ## 契約
 * - 世帯 ID は要求に無い。個人の好み・食後評価の**持ち主も要求に無い**（DB が呼び手に固定する）。
 *   余分な項目（`householdId` `profileId` …）を持つ要求は、無視ではなく拒否する。
 * - 行 ID はクライアントが最初の操作の時点で 1 回だけ採番し、payload の中に固定する（X-09）。
 * - カタログに在る ID か（食材・アレルゲン・レシピ・タグ）は Server Action が確かめる。
 */

import { isRecord } from "@/lib/domain/child-sharing"
import type { RpcStatus } from "@/lib/domain/rpc-outcome"
import { isTimestamptzText } from "@/lib/domain/timestamptz-text"

import { GUARDIAN_MEAL_STAGES, type GuardianMealStage } from "../child-serving"
import type { DishVerdict, UnverifiableReason } from "../exclusions"
import type { DishRole, ExclusionReason, FoodExclusion, FoodPreference, PlanEntryStatus } from "../types"
import { hasOnlyKeys, isCatalogIdText, isMealLabel, isMealUuid, isOneOf } from "./meal-input"
import {
  DINNER_SERVINGS_MAX,
  DINNER_SERVINGS_MIN,
  type DinnerSettings,
  type StoredFoodExclusion,
  type StoredFoodPreference,
} from "./rows"

// ── 設定 ───────────────────────────────────────────────────────────

/** 調理時間の上限（分）の範囲（DB の CHECK と同じ）。 */
export const MAX_COOK_MINUTES_MIN = 5
export const MAX_COOK_MINUTES_MAX = 180
/** 常備品の件数の上限（DB の CHECK と同じ）。 */
export const STAPLES_MAX = 200
/** 食事段階を設定できる子どもの数の上限（DB の検証と同じ）。 */
export const CHILD_STAGES_MAX = 20
/** 自由入力の「使わない食材」の上限（文字数。DB の CHECK と同じ）。 */
export const EXCLUSION_LABEL_MAX = 30

export interface SaveDinnerSettingsRequest {
  /** 開いた時点の版。設定が未登録の世帯は null。 */
  version: string | null
  servings: number
  includeSoup: boolean
  /** null は上限なし。 */
  maxCookMinutes: number | null
  /** 常備品の食材 ID（世帯が選んだものだけ。初期値を捏造しない）。 */
  stapleIngredientIds: string[]
  /** child_id → 保護者が設定した食事段階。未設定の子は鍵を持たない。 */
  childStages: Record<string, GuardianMealStage>
}

export type SettingsInputIssue =
  | "shape"
  | "id"
  | "version"
  | "servings"
  | "max_cook_minutes"
  | "staples"
  | "child_stages"
  | "reason"
  | "target"
  | "label"
  | "subject"
  | "scope"
  | "sentiment"

export const SETTINGS_INPUT_MESSAGES: Readonly<Record<SettingsInputIssue, string>> = {
  shape: "入力内容を確認してください。",
  id: "入力内容を確認してください。再読み込みして、もう一度お試しください。",
  version: "画面が古いため保存できませんでした。再読み込みしてからもう一度お試しください。",
  servings: `人数は${DINNER_SERVINGS_MIN}〜${DINNER_SERVINGS_MAX}人で入力してください。`,
  max_cook_minutes: `調理時間の上限は${MAX_COOK_MINUTES_MIN}〜${MAX_COOK_MINUTES_MAX}分で入力するか、上限なしにしてください。`,
  staples: "常備品の選び方を確認してください。",
  child_stages: "子どもの食事の段階を選び直してください。",
  reason: "アレルギーか苦手かを選び直してください。",
  target: "対象の選び方を確認してください。",
  label: `使わない食材の名前は1〜${EXCLUSION_LABEL_MAX}文字で入力してください。`,
  subject: "誰の設定かを選び直してください。",
  scope: "家族共通か個人かを選び直してください。",
  sentiment: "好きか苦手かを選び直してください。",
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
}

export function saveDinnerSettingsIssue(value: unknown): SettingsInputIssue | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "servings", "includeSoup", "maxCookMinutes", "stapleIngredientIds", "childStages"])
  ) {
    return "shape"
  }
  if (value.version !== null && !isTimestamptzText(value.version)) return "version"
  if (!isIntegerIn(value.servings, DINNER_SERVINGS_MIN, DINNER_SERVINGS_MAX)) return "servings"
  if (typeof value.includeSoup !== "boolean") return "shape"
  if (value.maxCookMinutes !== null && !isIntegerIn(value.maxCookMinutes, MAX_COOK_MINUTES_MIN, MAX_COOK_MINUTES_MAX)) {
    return "max_cook_minutes"
  }
  const staples = value.stapleIngredientIds
  if (!Array.isArray(staples) || staples.length > STAPLES_MAX || !staples.every(isCatalogIdText)) return "staples"
  const stages = value.childStages
  if (!isRecord(stages)) return "child_stages"
  const entries = Object.entries(stages)
  if (entries.length > CHILD_STAGES_MAX) return "child_stages"
  for (const [childId, stage] of entries) {
    // 段階の値はロジック（`child-serving.ts`）の語彙だけ。未知の値を保存しない
    if (!isMealUuid(childId) || !isOneOf(stage, GUARDIAN_MEAL_STAGES)) return "child_stages"
  }
  return null
}

export function isSaveDinnerSettingsRequest(value: unknown): value is SaveDinnerSettingsRequest {
  return saveDinnerSettingsIssue(value) === null
}

// ── 使わない食材（必須除外） ───────────────────────────────────────

const EXCLUSION_REASONS: readonly ExclusionReason[] = ["allergy", "dislike"]

/** 登録する除外。対象: アレルゲン・食材・自由入力。対象者: 家族全体・メンバー・子ども。 */
export interface SaveFoodExclusionRequest {
  id: string
  reason: ExclusionReason
  target: FoodExclusion["target"]
  subject: FoodExclusion["subject"]
}

export interface DeleteFoodExclusionRequest {
  id: string
}

function exclusionTargetIssue(target: unknown): SettingsInputIssue | null {
  if (!isRecord(target)) return "target"
  if (target.kind === "allergen") {
    return hasOnlyKeys(target, ["kind", "allergenId"]) && isCatalogIdText(target.allergenId) ? null : "target"
  }
  if (target.kind === "ingredient") {
    return hasOnlyKeys(target, ["kind", "ingredientId"]) && isCatalogIdText(target.ingredientId) ? null : "target"
  }
  if (target.kind === "custom") {
    if (!hasOnlyKeys(target, ["kind", "label"])) return "target"
    return isMealLabel(target.label, EXCLUSION_LABEL_MAX) ? null : "label"
  }
  return "target"
}

function exclusionSubjectIssue(subject: unknown): SettingsInputIssue | null {
  if (!isRecord(subject)) return "subject"
  if (subject.kind === "household") return hasOnlyKeys(subject, ["kind"]) ? null : "subject"
  if (subject.kind === "member") {
    return hasOnlyKeys(subject, ["kind", "profileId"]) && isMealUuid(subject.profileId) ? null : "subject"
  }
  if (subject.kind === "child") {
    return hasOnlyKeys(subject, ["kind", "childId"]) && isMealUuid(subject.childId) ? null : "subject"
  }
  return "subject"
}

export function saveFoodExclusionIssue(value: unknown): SettingsInputIssue | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "reason", "target", "subject"])) return "shape"
  if (!isMealUuid(value.id)) return "id"
  if (!isOneOf(value.reason, EXCLUSION_REASONS)) return "reason"
  return exclusionTargetIssue(value.target) ?? exclusionSubjectIssue(value.subject)
}

export function isSaveFoodExclusionRequest(value: unknown): value is SaveFoodExclusionRequest {
  return saveFoodExclusionIssue(value) === null
}

/** ID だけを持つ要求（除外・好み・食後評価の削除）の形。 */
export function idOnlyIssue(value: unknown): SettingsInputIssue | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id"])) return "shape"
  return isMealUuid(value.id) ? null : "id"
}

export function isIdOnlyRequest(value: unknown): value is { id: string } {
  return idOnlyIssue(value) === null
}

// ── 好み（採点にだけ使う） ─────────────────────────────────────────

const PREFERENCE_SCOPES: readonly FoodPreference["scope"][] = ["household", "personal"]
const PREFERENCE_TARGET_KINDS: readonly FoodPreference["target"]["kind"][] = ["recipe", "ingredient", "tag"]
const PREFERENCE_SENTIMENTS: readonly FoodPreference["sentiment"][] = ["like", "dislike"]

/**
 * 好みの登録・変更。`scope: "personal"` の持ち主は**常に呼び手**（要求に持ち主の項目は無い）。
 * 登録済みの好みで変えられるのは `sentiment` だけ（対象と範囲は DB が不変として守る）。
 */
export interface SaveFoodPreferenceRequest {
  id: string
  /** 新規は null。変更は開いた時点の版。 */
  version: string | null
  scope: FoodPreference["scope"]
  target: FoodPreference["target"]
  sentiment: FoodPreference["sentiment"]
}

export interface DeleteFoodPreferenceRequest {
  id: string
}

export interface DeleteDishFeedbackRequest {
  id: string
}

export function saveFoodPreferenceIssue(value: unknown): SettingsInputIssue | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "version", "scope", "target", "sentiment"])) return "shape"
  if (!isMealUuid(value.id)) return "id"
  if (value.version !== null && !isTimestamptzText(value.version)) return "version"
  if (!isOneOf(value.scope, PREFERENCE_SCOPES)) return "scope"
  const target = value.target
  if (
    !isRecord(target) ||
    !hasOnlyKeys(target, ["kind", "id"]) ||
    !isOneOf(target.kind, PREFERENCE_TARGET_KINDS) ||
    !isCatalogIdText(target.id)
  ) {
    return "target"
  }
  if (!isOneOf(value.sentiment, PREFERENCE_SENTIMENTS)) return "sentiment"
  return null
}

export function isSaveFoodPreferenceRequest(value: unknown): value is SaveFoodPreferenceRequest {
  return saveFoodPreferenceIssue(value) === null
}

// ── 応答 ───────────────────────────────────────────────────────────

/**
 * 設定の保存の成功応答。`conflict` は「家族が先に変えていたので上書きしていない」
 * （`settings` は DB の最新）。`deleted: true` は、版つきで届いたが設定の行が既に無い。
 */
export interface DinnerSettingsSaveSuccess {
  status: RpcStatus
  settings: DinnerSettings | null
  deleted: boolean
  /**
   * 保存した人数と違う人数のまま残っている、これからの未調理の枠（今日以降の提案・確定。固定を含む）の数。
   * **設定の保存は献立を書き換えない。** 0 より大きければ、画面は「これからの献立 n 品も m 人分にしますか」と
   * 尋ね、利用者が選んだときだけ献立の `servings_upcoming`（`plan/actions.ts`）を送る。
   * null は「確かめられなかった」（0 件という意味ではない）。conflict のときは数えない（null）。
   */
  planServingsMismatch?: number | null
}

/** 除外の設定を変えた後に、既存の献立（提案・確定の枠）と重なった 1 件。**置換はしていない。** */
export interface PlanConflictView {
  entryId: string
  date: string
  role: DishRole
  title: string
  /** 固定した枠か。固定でも新しい除外を無視せず、ここに挙げる（選び直すのは利用者）。 */
  pinned: boolean
  status: PlanEntryStatus
  /** `blocked` = 使わない食材を含む。`label_check` = 原材料を確かめられない。 */
  verdict: Exclude<DishVerdict, "ok">
  /** 該当した材料の表示名。 */
  ingredientNames: string[]
  /** 該当した除外の ID。 */
  exclusionIds: string[]
  /** 原材料を確かめられない理由。 */
  unverifiable: UnverifiableReason[]
  /** true = 今回登録した除外（または同じ内容の登録済みの除外）に当たっている。 */
  causedByThisChange: boolean
}

export interface PlanConflictReport {
  /** 確かめた献立の範囲（両端を含む）。 */
  from: string
  to: string
  conflicts: PlanConflictView[]
  /** 読めなかった献立の枠の数（0 でなければ、全部は確かめられていない）。 */
  unreadableEntries: number
  /**
   * 判定できないアレルギーの除外があり、どの料理も自動では確定しない状態のときの説明文（除外の名前を挙げる）。
   * このとき `conflicts` には提案・確定の全ての枠が `label_check`（`unverifiable` は空でありうる）で並ぶ。
   * そうでなければ null。`buildPlanConflictReport` は必ず入れる。
   */
  holdMessage?: string | null
}

/**
 * 登録した除外が、今のカタログで何に解決したか（`exclusions.ts` の `resolveExclusionLabel` の結果）。
 *
 * - `status` … `resolved` = アレルゲン・食材へ解決した / `name_only` = 名前に入力を含む食材・料理だけを外す /
 *   `undetermined` = どこにも当たらない（判定できない。**何も外せていない**）。
 * - `effect` … `excludes` = 該当する料理を外す / `holds_auto_confirm` = 判定できないアレルギー。どの料理も
 *   自動では確定しなくなる / `no_effect` = 判定できない苦手。**何も除外されない**。
 *   後ろ 2 つのとき、画面は「必ず外します」と言わず、一覧から選び直すよう促すこと。
 */
export interface ExclusionResolutionView {
  status: "resolved" | "name_only" | "undetermined"
  effect: "excludes" | "holds_auto_confirm" | "no_effect"
  /** 解決した先のアレルゲン・食材の表示名（`resolved` のとき。自由入力が何として扱われるかの確認用）。 */
  targetNames: string[]
  /** 画面へそのまま出せる 1 文。 */
  message: string
}

/**
 * 除外の登録の成功応答。
 * - `conflict` … 同じ内容の除外が別の ID で登録済みだった（`exclusion` はその行）。
 * - `planConflicts` … 今日以降の献立との重なり。**null は「確かめられなかった」**（重なりが無いという
 *   意味ではない。画面は献立を開いて確かめるよう促すこと）。
 * - `resolution` … 保存された除外（`exclusion`）が何に解決したか。`saveFoodExclusion` は必ず入れる
 *   （型が省略可なのは、画面のテストの既存の fixture を壊さないため）。
 */
export interface FoodExclusionSaveSuccess {
  status: RpcStatus
  exclusion: StoredFoodExclusion
  planConflicts: PlanConflictReport | null
  resolution?: ExclusionResolutionView
}

/** 除外の削除の成功応答。`planConflicts` は残っている除外との重なり（null は確かめられなかった）。 */
export interface FoodExclusionDeleteSuccess {
  status: RpcStatus
  id: string
  planConflicts: PlanConflictReport | null
}

/**
 * 好みの保存の成功応答。`conflict` は「同じ対象の好みが既に在る・家族が先に変えていた」
 * （`preference` は DB の最新）。`deleted: true` は、変更しようとした好みが既に削除されていた。
 */
export interface FoodPreferenceSaveSuccess {
  status: RpcStatus
  preference: StoredFoodPreference | null
  deleted: boolean
}

/** 好み・食後評価の削除の成功応答。既に無い行の削除は `replayed`。 */
export interface MealDeleteSuccess {
  status: RpcStatus
  id: string
}
