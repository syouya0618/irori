/**
 * 食材（/chores/meals/pantry）と設定（/chores/meals/settings）の保存操作の合併型と、その振り分け。
 *
 * 境界指令を持たない中立モジュール（食材辞書・レシピのカタログを import しない）。
 *
 * ## なぜ 2 画面で 1 つにまとめるか
 * `useChoreSave` は 1 つの `run` と 1 つの `isPayload` を取り、端末の控えを種類（`"meal"`）ごとに読む。
 * 画面ごとに別の型ガードを渡すと、もう一方の画面の「結果不明の控え」が**読めない控え**に数えられ、
 * 保存が塞がるうえ、確かめ直す手段が無いまま破棄だけができてしまう。
 *
 * 画面（食材・設定）は、この合併型をさらに献立・買い物と束ねた `MealRequest`
 * （`../plan/meal-request.ts` の `isMealRequest` / `runMealRequest`）を `useChoreSave` へ渡す。
 * ごはんのどの画面で結果不明になった操作でも、開いている画面から「同じ操作で確認」できる。
 *
 * `op` は献立（`DinnerRequest`）・買い物（`GroceryRequest`）の `op` と重ならない名前にする
 * （`delete` のような共通の名前を使わない。重なると、束ねた型ガードがどの操作かを決められない）。
 */

import {
  addPantryItems,
  deletePantryItem,
  savePantryItem,
} from "@/app/(main)/chores/meals/pantry/actions"
import {
  deleteDishFeedback,
  deleteFoodExclusion,
  deleteFoodPreference,
  saveDinnerSettings,
  saveFoodExclusion,
  saveFoodPreference,
} from "@/app/(main)/chores/meals/settings/actions"
import { isRecord } from "@/lib/domain/child-sharing"
import { CHORE_PENDING_LABEL_MAX } from "@/lib/domain/chore-pending"
import { isChoreSaveSuccess, type ChoreSaveFailure, type ChoreSaveSuccess } from "@/lib/domain/rpc-outcome"
import {
  isAddPantryItemsRequest,
  isDeletePantryItemRequest,
  isSavePantryItemRequest,
  type AddPantryItemsRequest,
  type DeletePantryItemRequest,
  type PantryBulkSaveSuccess,
  type PantryDeleteSuccess,
  type PantryItemSaveSuccess,
  type SavePantryItemRequest,
} from "@/lib/meals/server/pantry-requests"
import {
  isIdOnlyRequest,
  isSaveDinnerSettingsRequest,
  isSaveFoodExclusionRequest,
  isSaveFoodPreferenceRequest,
  type DeleteDishFeedbackRequest,
  type DeleteFoodExclusionRequest,
  type DeleteFoodPreferenceRequest,
  type DinnerSettingsSaveSuccess,
  type FoodExclusionDeleteSuccess,
  type FoodExclusionSaveSuccess,
  type FoodPreferenceSaveSuccess,
  type MealDeleteSuccess,
  type SaveDinnerSettingsRequest,
  type SaveFoodExclusionRequest,
  type SaveFoodPreferenceRequest,
} from "@/lib/meals/server/settings-requests"

export type MealBasicsRequest =
  | ({ op: "pantry_add" } & AddPantryItemsRequest)
  | ({ op: "pantry_save" } & SavePantryItemRequest)
  | ({ op: "pantry_delete" } & DeletePantryItemRequest)
  | ({ op: "settings_save" } & SaveDinnerSettingsRequest)
  | ({ op: "exclusion_save" } & SaveFoodExclusionRequest)
  | ({ op: "exclusion_delete" } & DeleteFoodExclusionRequest)
  | ({ op: "preference_save" } & SaveFoodPreferenceRequest)
  | ({ op: "preference_delete" } & DeleteFoodPreferenceRequest)
  | ({ op: "feedback_delete" } & DeleteDishFeedbackRequest)

export type MealBasicsOp = MealBasicsRequest["op"]

/** 成功応答。どの操作の応答かを `op` で見分ける（画面は `op` で絞ってから中身を読む）。 */
export type MealBasicsSuccess =
  | ({ op: "pantry_add" } & PantryBulkSaveSuccess)
  | ({ op: "pantry_save" } & PantryItemSaveSuccess)
  | ({ op: "pantry_delete" } & PantryDeleteSuccess)
  | ({ op: "settings_save" } & DinnerSettingsSaveSuccess)
  | ({ op: "exclusion_save" } & FoodExclusionSaveSuccess)
  | ({ op: "exclusion_delete" } & FoodExclusionDeleteSuccess)
  | ({ op: "preference_save" } & FoodPreferenceSaveSuccess)
  | ({ op: "preference_delete" } & MealDeleteSuccess)
  | ({ op: "feedback_delete" } & MealDeleteSuccess)

const GUARDS: Readonly<Record<MealBasicsOp, (value: unknown) => boolean>> = {
  pantry_add: isAddPantryItemsRequest,
  pantry_save: isSavePantryItemRequest,
  pantry_delete: isDeletePantryItemRequest,
  settings_save: isSaveDinnerSettingsRequest,
  exclusion_save: isSaveFoodExclusionRequest,
  exclusion_delete: isIdOnlyRequest,
  preference_save: isSaveFoodPreferenceRequest,
  preference_delete: isIdOnlyRequest,
  feedback_delete: isIdOnlyRequest,
}

/** `op` を外した残り（各 Server Action が受け取る形。Action は余分な項目を持つ要求を拒む）。 */
function withoutOp<T extends { op: string }>(request: T): Omit<T, "op"> {
  const { op: _op, ...rest } = request
  void _op
  return rest
}

/**
 * 送る値・端末の控えから読んだ値が、そのまま送れる要求か（`useChoreSave` の `isPayload`）。
 * 各 Action の検査と同じ関数で中身を見る（時計には依らない）。
 */
export function isMealBasicsRequest(value: unknown): value is MealBasicsRequest {
  if (!isRecord(value) || typeof value.op !== "string") return false
  if (!Object.prototype.hasOwnProperty.call(GUARDS, value.op)) return false
  return GUARDS[value.op as MealBasicsOp](withoutOp(value as { op: string }))
}

function tagged<Op extends MealBasicsOp, S extends ChoreSaveSuccess>(
  op: Op,
  result: S | ChoreSaveFailure,
): ({ op: Op } & S) | ChoreSaveFailure {
  // 成功と読めない応答（失敗・形の合わない値）はそのまま返す。`useChoreSave` が分類する
  return isChoreSaveSuccess(result) ? { ...(result as S), op } : (result as ChoreSaveFailure)
}

/**
 * 合併型の要求を、対応する Server Action へ送る（`useChoreSave` の `run`）。
 * 認証・入力の検証・世帯の決定はすべて Action と DB が行う。ここは振り分けるだけ。
 */
export async function runMealBasicsRequest(request: MealBasicsRequest): Promise<MealBasicsSuccess | ChoreSaveFailure> {
  switch (request.op) {
    case "pantry_add":
      return tagged("pantry_add", await addPantryItems(withoutOp(request)))
    case "pantry_save":
      return tagged("pantry_save", await savePantryItem(withoutOp(request)))
    case "pantry_delete":
      return tagged("pantry_delete", await deletePantryItem(withoutOp(request)))
    case "settings_save":
      return tagged("settings_save", await saveDinnerSettings(withoutOp(request)))
    case "exclusion_save":
      return tagged("exclusion_save", await saveFoodExclusion(withoutOp(request)))
    case "exclusion_delete":
      return tagged("exclusion_delete", await deleteFoodExclusion(withoutOp(request)))
    case "preference_save":
      return tagged("preference_save", await saveFoodPreference(withoutOp(request)))
    case "preference_delete":
      return tagged("preference_delete", await deleteFoodPreference(withoutOp(request)))
    case "feedback_delete":
      return tagged("feedback_delete", await deleteDishFeedback(withoutOp(request)))
    default:
      return { error: "入力内容を確認してください。", failure: "rejected" }
  }
}

/** 控えの説明の上限（UTF-16 の長さ）に収める。長い名前は末尾を「…」にする。 */
export function clipLabel(text: string, max: number = CHORE_PENDING_LABEL_MAX): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  let out = ""
  for (const char of trimmed) {
    if (out.length + char.length > max - 1) break
    out += char
  }
  return `${out}…`
}

function quoted(name: string | undefined, fallback: string): string {
  const trimmed = name?.trim() ?? ""
  return trimmed === "" ? fallback : `「${clipLabel(trimmed, 30)}」`
}

/**
 * 端末の控えに残す、利用者向けの短い説明（「保存できたか確認できていない操作」の一覧に出る）。
 *
 * @param name 要求の中に名前を持たない操作（削除など）の対象の表示名。
 */
export function labelOfMealBasicsRequest(request: MealBasicsRequest, name?: string): string {
  switch (request.op) {
    case "pantry_add": {
      const first = request.items[0]?.name
      const rest = request.items.length - 1
      return clipLabel(
        rest > 0 ? `食材 ${request.items.length} 件を登録（${quoted(first, "食材")}ほか）` : `食材${quoted(first, "")}を登録`,
      )
    }
    case "pantry_save":
      return clipLabel(
        request.version === null ? `食材${quoted(request.item.name, "")}を登録` : `食材${quoted(request.item.name, "")}を更新`,
      )
    case "pantry_delete":
      return clipLabel(`食材${quoted(name, "")}を削除`)
    case "settings_save":
      return "ごはんの設定を保存"
    case "exclusion_save":
      return clipLabel(`使わない食材${quoted(name, "")}を登録`)
    case "exclusion_delete":
      return clipLabel(`使わない食材${quoted(name, "")}を削除`)
    case "preference_save":
      return clipLabel(request.version === null ? `好み${quoted(name, "")}を登録` : `好み${quoted(name, "")}を変更`)
    case "preference_delete":
      return clipLabel(`好み${quoted(name, "")}を削除`)
    case "feedback_delete":
      return clipLabel(`食後の評価${quoted(name, "")}を削除`)
    default:
      return "ごはんの保存"
  }
}
