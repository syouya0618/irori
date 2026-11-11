/**
 * 食材（在庫）の Server Action（`src/app/(main)/chores/meals/pantry/actions.ts`）の要求と応答の型、
 * 要求の形の検査。
 *
 * 境界指令を持たない中立モジュール（食材辞書・レシピのカタログを import しない。
 * Client Component から値 import してよい — 端末の控えを読むときの `isPayload` に使う）。
 *
 * ## 契約
 * - 行 ID はクライアントが最初の操作の時点で 1 回だけ採番し、要求（payload）の中に入れて固定する。
 *   再送は同じ payload をそのまま送る（X-09）。まとめ入力は 1 件ごとに ID を持つ。
 * - 最終確認日（`confirmedOn`）も payload に入れて固定する。サーバーが「今日」を埋めると、日付を
 *   跨いだ再送が「同じ ID・別の内容」になり、まとめ入力では全体が拒まれる。
 *   画面は Server Component が渡した JST の今日を初期値に使うこと（端末の時計が進んでいると、
 *   未来の確認日として拒まれる）。
 * - 世帯 ID は要求に無い（`getAuthContext()` と DB の `auth.uid()` が決める）。
 */

import { isRecord } from "@/lib/domain/child-sharing"
import type { RpcStatus } from "@/lib/domain/rpc-outcome"
import { isTimestamptzText } from "@/lib/domain/timestamptz-text"
import { isValidYmd } from "@/lib/utils/date-jst"

import type { PantryStatus, PantryStorage, UnitId } from "../types"
import { UNIT_LABELS, unitFamily } from "../units"
import { hasOnlyKeys, isCatalogIdText, isMealLabel, isMealUuid, isOneOf } from "./meal-input"
import { PANTRY_QUANTITY_MAX, type StoredPantryItem } from "./rows"

/** 食材名の上限（文字数。DB の CHECK と同じ）。 */
export const PANTRY_NAME_MAX = 40
/** まとめ入力で 1 回に登録できる件数（DB の `add_pantry_items` と同じ）。 */
export const PANTRY_BULK_MAX = 50
/** まとめ入力の文の上限（文字数）。 */
export const PANTRY_TEXT_MAX = 2000
/** 日付の下限（DB の検証と同じ）。 */
export const PANTRY_DATE_MIN = "2000-01-01"
/** 期限の上限（DB の検証と同じ）。 */
export const PANTRY_EXPIRES_MAX = "2100-12-31"
/** 数量の下限（小数 2 桁へ丸めて 0 にならない最小の量）。 */
export const PANTRY_QUANTITY_MIN = 0.01

export const PANTRY_STATUSES: readonly PantryStatus[] = ["have", "low", "out"]
export const PANTRY_STORAGES: readonly PantryStorage[] = ["fridge", "freezer", "pantry"]

/** 在庫の数量（数えられる単位と正の量）。「適量」「少々」は在庫の数量にしない。 */
export interface PantryQuantityInput {
  amount: number
  unit: UnitId
}

/** 在庫 1 件の内容（ID・版を除く）。 */
export interface PantryItemFields {
  /**
   * 食材辞書の ID。null は「名前から解決する」（正規化後の完全一致だけ。解決できなければ
   * 名前のまま保存し、提案の材料に数えない）。null でない値はサーバーが辞書に在ることを確かめる。
   */
  ingredientId: string | null
  name: string
  /** null は「数量不明」。 */
  quantity: PantryQuantityInput | null
  status: PantryStatus
  useSoon: boolean
  storage: PantryStorage | null
  /** YYYY-MM-DD。null は期限なし。 */
  expiresOn: string | null
  /** 最終確認日 YYYY-MM-DD（今日以前）。 */
  confirmedOn: string
}

export type PantryNewItem = PantryItemFields & { id: string }

/** まとめ入力の登録（1 トランザクション。1 件でも拒まれたら全体を登録しない）。 */
export interface AddPantryItemsRequest {
  items: PantryNewItem[]
}

/** 1 件の作成（`version: null`）・編集（開いた時点の版）。 */
export interface SavePantryItemRequest {
  id: string
  version: string | null
  item: PantryItemFields
}

export interface DeletePantryItemRequest {
  id: string
  version: string
}

export type PantryInputIssue =
  | "shape"
  | "id"
  | "version"
  | "name"
  | "ingredient"
  | "quantity"
  | "unit"
  | "status"
  | "storage"
  | "expires_on"
  | "confirmed_on"
  | "count"
  | "duplicate_id"

export const PANTRY_INPUT_MESSAGES: Readonly<Record<PantryInputIssue, string>> = {
  shape: "入力内容を確認してください。",
  id: "入力内容を確認してください。再読み込みして、もう一度お試しください。",
  version: "画面が古いため保存できませんでした。再読み込みしてからもう一度お試しください。",
  name: `食材の名前は1〜${PANTRY_NAME_MAX}文字で入力してください。`,
  ingredient: "食材の選び方を確認してください。",
  quantity: `数量は${PANTRY_QUANTITY_MIN}以上の数で入力してください。分からないときは空欄（数量不明）にできます。`,
  unit: "数量の単位を選び直してください。「適量」「少々」は在庫の数量にできません。",
  status: "食材の状態を選び直してください。",
  storage: "保管場所を選び直してください。",
  expires_on: "期限の日付を確認してください。",
  confirmed_on: "最終確認日の日付を確認してください。",
  count: `一度に登録できるのは${PANTRY_BULK_MAX}件までです。分けて登録してください。`,
  duplicate_id: "入力内容を確認してください。再読み込みして、もう一度お試しください。",
}

const FIELD_KEYS = [
  "ingredientId",
  "name",
  "quantity",
  "status",
  "useSoon",
  "storage",
  "expiresOn",
  "confirmedOn",
] as const

function isKnownUnit(value: unknown): value is UnitId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(UNIT_LABELS, value)
}

function isPantryDate(value: unknown, max: string): value is string {
  return typeof value === "string" && isValidYmd(value) && value >= PANTRY_DATE_MIN && value <= max
}

/** 在庫 1 件の内容の形と範囲。問題が無ければ null。`extraKeys` は ID など、内容の外に許す項目。 */
function fieldsIssue(value: unknown, extraKeys: readonly string[]): PantryInputIssue | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [...FIELD_KEYS, ...extraKeys])) return "shape"
  if (!isMealLabel(value.name, PANTRY_NAME_MAX)) return "name"
  if (value.ingredientId !== null && !isCatalogIdText(value.ingredientId)) return "ingredient"
  if (value.quantity !== null) {
    const quantity = value.quantity
    if (!isRecord(quantity) || !hasOnlyKeys(quantity, ["amount", "unit"])) return "quantity"
    // 未知の単位・数えない単位（適量・少々）を、黙って「数量不明」へ言い換えない
    if (!isKnownUnit(quantity.unit) || unitFamily(quantity.unit) === "none") return "unit"
    const amount = quantity.amount
    if (
      typeof amount !== "number" ||
      !Number.isFinite(amount) ||
      amount < PANTRY_QUANTITY_MIN ||
      amount > PANTRY_QUANTITY_MAX
    ) {
      return "quantity"
    }
  }
  if (!isOneOf(value.status, PANTRY_STATUSES)) return "status"
  if (typeof value.useSoon !== "boolean") return "shape"
  if (value.storage !== null && !isOneOf(value.storage, PANTRY_STORAGES)) return "storage"
  if (value.expiresOn !== null && !isPantryDate(value.expiresOn, PANTRY_EXPIRES_MAX)) return "expires_on"
  // 「今日以前か」は Server Action と DB が見る（ここは時計に依らない）
  if (!isPantryDate(value.confirmedOn, "9999-12-31")) return "confirmed_on"
  return null
}

export function addPantryItemsIssue(value: unknown): PantryInputIssue | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["items"]) || !Array.isArray(value.items)) return "shape"
  if (value.items.length < 1 || value.items.length > PANTRY_BULK_MAX) return "count"
  const seen = new Set<string>()
  for (const item of value.items) {
    const issue = fieldsIssue(item, ["id"])
    if (issue !== null) return issue
    const id = (item as { id: unknown }).id
    if (!isMealUuid(id)) return "id"
    if (seen.has(id)) return "duplicate_id"
    seen.add(id)
  }
  return null
}

export function savePantryItemIssue(value: unknown): PantryInputIssue | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "version", "item"])) return "shape"
  if (!isMealUuid(value.id)) return "id"
  if (value.version !== null && !isTimestamptzText(value.version)) return "version"
  return fieldsIssue(value.item, [])
}

export function deletePantryItemIssue(value: unknown): PantryInputIssue | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "version"])) return "shape"
  if (!isMealUuid(value.id)) return "id"
  // 版の無い削除は受けない（家族が直した後の行を、古い画面から消さない）
  if (!isTimestamptzText(value.version)) return "version"
  return null
}

/** 端末の控えから読んだ値が、そのまま送り直せる要求か（`useChoreSave` の `isPayload` 用）。 */
export function isAddPantryItemsRequest(value: unknown): value is AddPantryItemsRequest {
  return addPantryItemsIssue(value) === null
}

export function isSavePantryItemRequest(value: unknown): value is SavePantryItemRequest {
  return savePantryItemIssue(value) === null
}

export function isDeletePantryItemRequest(value: unknown): value is DeletePantryItemRequest {
  return deletePantryItemIssue(value) === null
}

// ── 応答 ───────────────────────────────────────────────────────────

/** まとめ入力の登録の成功応答。`items` は DB に在る行（要求と同じ並び）。 */
export interface PantryBulkSaveSuccess {
  status: RpcStatus
  items: StoredPantryItem[]
  /** 今回書いた件数。 */
  saved: number
  /** 同じ内容が既に保存済みだった件数（応答を失った自分の再送）。 */
  replayed: number
}

/**
 * 1 件の保存の成功応答。
 * - `saved` / `replayed` … `item` は保存された行。
 * - `conflict` … 上書きしていない。`item` は DB の最新の行。`deleted: true` なら、別の端末が
 *   既に削除していた（`item` は null）。
 */
export interface PantryItemSaveSuccess {
  status: RpcStatus
  item: StoredPantryItem | null
  deleted: boolean
}

/**
 * 削除の成功応答。`conflict` は「別の端末が先に更新していたので消していない」
 * （`item` は DB の最新の行）。既に無い行の削除は `replayed`。
 */
export interface PantryDeleteSuccess {
  status: RpcStatus
  id: string
  item: StoredPantryItem | null
}

// ── まとめ入力の解釈（保存しない） ─────────────────────────────────

export type PantryPreviewIssue =
  /** 名前が長すぎる・使えない文字を含む（このままでは登録できない）。 */
  | "name_invalid"
  /** 食材の一覧で複数の食材に当たる名前（推測で選ばない）。 */
  | "ambiguous_name"
  /** 数量らしい部分を読み取れなかった（単位の無い数字など）。 */
  | "quantity_unreadable"
  /** 「適量」「少々」など、在庫の数量として数えない表記。 */
  | "quantity_not_countable"

export const PANTRY_PREVIEW_ISSUE_LABELS: Readonly<Record<PantryPreviewIssue, string>> = {
  name_invalid: `名前は1〜${PANTRY_NAME_MAX}文字に直してください`,
  ambiguous_name: "複数の食材に当たる名前です。食材の一覧には結び付けていません",
  quantity_unreadable: "数量を読み取れませんでした（数量不明として扱います）",
  quantity_not_countable: "数えられない量のため、数量不明として扱います",
}

export interface PantryPreviewItem {
  /** 入力された名前（表示用。書き換えない）。 */
  name: string
  /** 食材の一覧に解決できたときだけ入る（正規化後の完全一致だけ）。 */
  ingredientId: string | null
  /** 解決できた食材の表示名。 */
  ingredientName: string | null
  /** 読み取れた数量。読み取れなければ null（数量不明）。 */
  quantity: PantryQuantityInput | null
  /** 数量として読もうとした部分の原文。 */
  quantityText: string | null
  issues: PantryPreviewIssue[]
}

export type PantryPreviewResult =
  | {
      ok: true
      /** 入力の順。最大 `PANTRY_BULK_MAX` 件。 */
      items: PantryPreviewItem[]
      /** 食材の一覧に解決できた件数。 */
      resolvedCount: number
      /** 解決できなかった名前（名前のまま登録でき、提案の材料には数えない）。 */
      unresolvedNames: string[]
      /** true = 件数の上限を超えたぶんを含めていない。 */
      truncated: boolean
    }
  | { ok: false; error: string }
